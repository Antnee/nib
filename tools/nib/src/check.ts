// Checks parsed files: names, imports, attributes, visibility and naming case. It knows the
// declarations of the package being checked, of the stdlib (the `.d.nibl` files in `std/`)
// and of any dependency found in `packages/`, which stands in for the registry; names
// imported from other dependencies are trusted.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readHostNeeds, unusedNeeds, type HostNeeds } from './host.ts';
import { parse, parseSnippet, type Node } from './parser.ts';
import { lex, type DocLine } from './lexer.ts';
import { NUMBER_TYPES, Program, TypeChecker, type NameInfo, type Type } from './types.ts';
import { checkMarkdown, isCheckedMarkdown } from './markdown.ts';

export type { NameInfo };

export interface Diagnostic {
	path: string;
	line: number;
	col: number;
	severity: 'error' | 'warning';
	message: string;
}

export interface Manifest {
	dir: string;
	root: string;
	dependencies: Set<string>;
	/** Each dependency's registry name, by the key the manifest gives it. */
	packages: Map<string, string>;
	/** Modules that only tests can import, from `[testing] modules`. */
	testModules: Set<string>;
	/** What the package needs from its host; null where there's no real manifest. */
	host: HostNeeds | null;
}

// The prelude, used only when `std/` can't be found; otherwise it comes from
// `std/src/prelude.d.nibl`.
const PRELUDE_TYPES = new Set([
	'Int', 'Int8', 'Int16', 'Int32', 'UInt8', 'UInt16', 'UInt32', 'UInt', 'Float',
	'Float32', 'Decimal', 'Bool', 'String', 'Bytes', 'List', 'Map', 'Set', 'Result', 'Void',
	'Never', 'Error', 'HandledAtCall', 'ParseError', 'Parseable', 'Equatable', 'Comparable', 'Hashable', 'Numeric',
	'Emptiable', 'Ordering', 'Rounding', 'Sign', 'Notation', 'SourceLocation',
]);
const PRELUDE_VALUES = new Set(['print', 'panic', 'assert', 'todo', 'sameInstance']);
// Prelude names that only test files can use.
const TEST_PRELUDE_VALUES = new Set(['expectPanic']);
const PRELUDE_ATTRIBUTES = new Set(['pure', 'callerLocation', 'deprecated', 'sensitive', 'opens']);

const STD_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'std');

const STRING_TAGS = new Set(['html', 'sql', 'url', 'path', 'secret']);

// Names people and agents reach for from other languages, with what Nib does instead.
const FOREIGN_NAMES: Record<string, string> = {
	sprintf: 'Nib has no format strings: interpolate, and format numbers with `formatted`, such as `"${id.formatted(width: 6, fill: "0")}"`',
	printf: 'Nib has no format strings: use `print("…")` with interpolation, and format numbers with `formatted(…)`',
	format: 'Nib has no format strings: interpolate, and format numbers with `formatted`, such as `"${total.formatted(places: 2, rounding: Rounding.HalfToEven)}"`',
	number_format: 'format numbers with `formatted`, such as `n.formatted(grouping: true)`',
	str_pad: 'pad text with `padStart` or `padEnd`, such as `"42".padStart(6, fill: "0")`',
	Int64: '`Int` is the 64-bit signed integer',
	UInt64: '`UInt` is the 64-bit unsigned integer',
};

function unknownName(name: string): string {
	if (TEST_PRELUDE_VALUES.has(name)) return `\`${name}\` can only be used in test files`;
	return `unknown name \`${name}\`${foreignHint(name)}`;
}

function foreignHint(name: string): string {
	return Object.hasOwn(FOREIGN_NAMES, name) ? `: ${FOREIGN_NAMES[name]}` : '';
}

const PASCAL = /^[A-Z][A-Za-z0-9]*$/;
const CAMEL = /^[a-z][A-Za-z0-9]*$/;
const UPPER_SNAKE = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/;
const MODULE_NAME = /^[a-z][a-z0-9]*$/;

export interface Decl {
	name: string;
	kind: 'fn' | 'type' | 'const' | 'attribute';
	node: Node;
	file: string;
	testFile: boolean;
	private: boolean;
}

export interface Module {
	name: string;
	files: SourceFile[];
	decls: Map<string, Decl[]>;
	/** Only tests can import it. */
	testOnly: boolean;
	/** For a dependency's module, the dependency's registry name. */
	external?: string;
}

export interface SourceFile {
	path: string;
	src: string;
	testFile: boolean;
	decls: Node[];
	docs: DocLine[];
	module: Module;
	/** Code from a doc comment, where names nothing declares are ones the reader has. */
	example?: boolean;
}

export interface Binding {
	kind: 'local' | 'param' | 'module' | 'import' | 'prelude' | 'typeParam' | 'decl';
	line: number;
	col: number;
	decl?: Decl;
	module?: Module | null; // for imported modules: the module if it's in this package
	importRecord?: ImportRecord;
	/** A local's type, filled in by the type stage. */
	type?: Type;
	/** How a local was declared, where it decides whether it can be assigned. */
	declaredWith?: 'let' | 'var' | 'const';
	/** A `let` declared with a type and no value, to be set once on every path. */
	setLater?: boolean;
	/** How many closures deep it was declared. */
	closures?: number;
	/** A `var` that a closure captures with `use (mut …)`, so it can change at any time and is never narrowed. */
	mutCaptured?: boolean;
	/** A local holding a started task (`let x = start …`), and whether anything reads it. */
	task?: { name: string; read: boolean };
}

interface ImportRecord {
	name: string;
	line: number;
	col: number;
	used: boolean;
	attribute: boolean;
}

class Scope {
	parent: Scope | null;
	values = new Map<string, Binding>();
	types = new Map<string, Binding>();
	/** A function or closure boundary: locals don't shadow across it silently. */
	constructor(parent: Scope | null) {
		this.parent = parent;
	}

	lookupValue(name: string): Binding | null {
		for (let s: Scope | null = this; s; s = s.parent) {
			const b = s.values.get(name);
			if (b) return b;
		}
		return null;
	}

	lookupType(name: string): Binding | null {
		for (let s: Scope | null = this; s; s = s.parent) {
			const b = s.types.get(name);
			if (b) return b;
		}
		return null;
	}
}

// ---- entry points -----------------------------------------------------------------------

/**
 * Checks every `.nibl` file under the given paths, grouping files into packages by
 * `nib.toml`, and the code in Markdown files that are named or are in a `guide` directory.
 */
export function checkPaths(paths: string[]): Diagnostic[] {
	const files: string[] = [];
	const markdown: string[] = [];
	for (const p of paths) {
		if (statSync(p).isFile() && isCheckedMarkdown(p, true)) markdown.push(p);
		else files.push(...findSources(p));
	}
	for (const f of files.filter((f) => f.endsWith('.md'))) markdown.push(f);
	files.splice(0, files.length, ...files.filter((f) => f.endsWith('.nibl')));
	const byManifest = new Map<string, string[]>();
	const loose: string[] = [];
	for (const f of files) {
		const m = findManifest(dirname(f));
		if (m) {
			if (!byManifest.has(m)) byManifest.set(m, []);
			byManifest.get(m)!.push(f);
		} else {
			loose.push(f);
		}
	}
	const out: Diagnostic[] = [];
	for (const [manifestPath, list] of byManifest) {
		const manifest = readManifest(manifestPath);
		out.push(...checkSources(list.map((path) => ({ path, src: readFileSync(path, 'utf8') })), manifest));
		out.push(...checkModuleNames(manifest));
	}
	for (const f of loose) out.push(...checkSources([{ path: f, src: readFileSync(f, 'utf8') }], null));
	out.push(...checkMarkdown(markdown));
	return out;
}

/**
 * Checks the package that holds `path` (or the file alone, outside a package), reading
 * `overlays` in place of the files on disk, as an editor does with unsaved changes. Returns
 * the diagnostics and every file that was checked, so stale results can be cleared.
 */
export function checkPackageOf(path: string, overlays: Map<string, string>, names?: Map<string, NameInfo[]>): { diagnostics: Diagnostic[]; files: string[] } {
	const read = (f: string) => overlays.get(f) ?? readFileSync(f, 'utf8');
	const manifestPath = findManifest(dirname(path));
	if (!manifestPath) return { diagnostics: checkSources([{ path, src: read(path) }], null, names), files: [path] };
	if (dirname(manifestPath) === STD_DIR) stdCache = undefined;
	const manifest = readManifest(manifestPath);
	const files = findSources(join(manifest.dir, 'src')).filter((f) => f.endsWith('.nibl'));
	if (!files.includes(path) && (overlays.has(path) || existsSync(path))) files.push(path);
	const diagnostics = checkSources(files.map((f) => ({ path: f, src: read(f) })), manifest, names);
	diagnostics.push(...checkModuleNames(manifest));
	return { diagnostics, files };
}

function findSources(p: string): string[] {
	if (statSync(p).isFile()) return p.endsWith('.nibl') || isCheckedMarkdown(p, false) ? [p] : [];
	return readdirSync(p).sort().flatMap((name) => {
		if (name.startsWith('.') || name === 'node_modules') return [];
		return findSources(join(p, name));
	});
}

function findManifest(dir: string): string | null {
	for (let d = dir; ; d = dirname(d)) {
		const candidate = join(d, 'nib.toml');
		if (existsSync(candidate)) return candidate;
		if (dirname(d) === d) return null;
	}
}

let stdCache: Map<string, Module> | null | undefined;

/** The stdlib's modules, from its declaration files. Their own errors are reported by checking `std`. */
function loadStd(): Map<string, Module> | null {
	if (stdCache !== undefined) return stdCache;
	if (!existsSync(join(STD_DIR, 'nib.toml'))) return (stdCache = null);
	const manifest = readManifest(join(STD_DIR, 'nib.toml'));
	const modules = new Map<string, Module>();
	for (const path of findSources(join(STD_DIR, 'src'))) {
		const src = readFileSync(path, 'utf8');
		const parsed = parse(src, { testFile: false, declarationFile: path.endsWith('.d.nibl') });
		const name = moduleNameFor(manifest, path);
		if (!modules.has(name)) modules.set(name, { name, files: [], decls: new Map(), testOnly: manifest.testModules.has(name) });
		const module = modules.get(name)!;
		module.files.push({ path, src, testFile: false, decls: parsed.decls, docs: parsed.docs, module });
	}
	for (const module of modules.values()) indexModule(module, []);
	return (stdCache = modules);
}

// There's no registry yet. First-party packages live in `packages/`, and a dependency on one
// is read from there, so code that uses it is checked like code that uses the stdlib.
// The test cases set NIB_REGISTRY to a directory of their own.
const registryDir = () => process.env.NIB_REGISTRY ?? join(STD_DIR, '..', 'packages');
const registryCache = new Map<string, Map<string, Module> | null>();

/** A registry package's modules, named under its own root; null if it isn't in `packages/`. */
function loadPackage(name: string): Map<string, Module> | null {
	const dir = registryDir();
	const key = `${dir}\0${name}`;
	if (registryCache.has(key)) return registryCache.get(key)!;
	let found: Map<string, Module> | null = null;
	if (existsSync(dir)) {
		for (const entry of readdirSync(dir).sort()) {
			const manifestPath = join(dir, entry, 'nib.toml');
			if (!existsSync(manifestPath)) continue;
			const manifest = readManifest(manifestPath);
			if (readFileSync(manifestPath, 'utf8').match(/^name\s*=\s*"([^"]+)"/m)?.[1] !== name) continue;
			found = new Map();
			for (const path of findSources(join(manifest.dir, 'src')).filter((f) => f.endsWith('.nibl') && !f.endsWith('.test.nibl'))) {
				const src = readFileSync(path, 'utf8');
				const parsed = parse(src, { testFile: false, declarationFile: path.endsWith('.d.nibl') });
				const module = moduleNameFor(manifest, path);
				if (!found.has(module)) found.set(module, { name: module, files: [], decls: new Map(), testOnly: manifest.testModules.has(module), external: name });
				const m = found.get(module)!;
				m.files.push({ path, src, testFile: false, decls: parsed.decls, docs: parsed.docs, module: m });
			}
			for (const m of found.values()) indexModule(m, []);
			break;
		}
	}
	registryCache.set(key, found);
	return found;
}

/**
 * The stdlib's modules, with the modules of each dependency found in `packages/`, renamed
 * under the key the manifest gives it: `access = { package = "nib/access" }` makes its
 * root module `access`.
 */
function external(manifest: Manifest | null): Map<string, Module> | null {
	const std = loadStd();
	if (!manifest || manifest.packages.size === 0) return std;
	const all = new Map(std ?? []);
	for (const [key, name] of manifest.packages) {
		const modules = loadPackage(name);
		if (!modules) continue;
		for (const m of modules.values()) {
			const root = m.name.split('.')[0];
			const renamed = key + m.name.slice(root.length);
			all.set(renamed, root === key ? m : { ...m, name: renamed });
		}
	}
	return all;
}

/** The closest name within two edits, for "did you mean" hints. */
export function suggest(name: string, candidates: Iterable<string>): string {
	let best = '';
	let bestDistance = 3;
	for (const c of candidates) {
		const d = editDistance(name.toLowerCase(), c.toLowerCase());
		if (d < bestDistance) {
			best = c;
			bestDistance = d;
		}
	}
	return best ? `; did you mean \`${best}\`?` : '';
}

function editDistance(a: string, b: string): number {
	let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		const row = [i];
		for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
		prev = row;
	}
	return prev[b.length];
}

/**
 * Overloads are told apart by their number of arguments and their labels, never by types.
 * So two overloads may not take the same positional parameters and the same `named` ones,
 * nor differ only in parameters with defaults, which a call can leave out. Reports each such pair once.
 */
function checkOverloads(fns: Node[], report: (at: Node, message: string) => void) {
	// A call shows a `named` parameter's name, and only the position of any other.
	const shown = (p: Node) => (p.named ? `named ${p.name}` : '_');
	const required = (f: Node) => (f.params as Node[]).filter((p) => !p.defaultValue).map(shown).join(',');
	const shape = (f: Node) => (f.params as Node[]).map(shown).join(',');
	for (let i = 0; i < fns.length; i++) {
		for (let j = 0; j < i; j++) {
			const a = fns[i];
			const b = fns[j];
			if (shape(a) === shape(b)) {
				report(a, `this overload of \`${a.name}\` has the same parameters as the one on line ${b.line}, so only their types differ; overloads differ by number of arguments or by labels. Rename one, give it a label, or take an interface or enum`);
				continue;
			}
			const hasDefaults = [a, b].some((f) => (f.params as Node[]).some((p) => p.defaultValue));
			if (hasDefaults && required(a) === required(b)) {
				report(a, `this overload of \`${a.name}\` differs from the one on line ${b.line} only in parameters with defaults, so a call that leaves them out would match both`);
			}
		}
	}
}

/**
 * Interfaces whose members the compiler writes: equality and hashing for every type but a
 * class, and `parse` for a distinct type that anyone can wrap, which parses the base type.
 */
function derived(node: Node, iface: string, member: string): boolean {
	if (iface === 'Equatable' || iface === 'Hashable') return node.typeKind !== 'class';
	// An error enum's message is its variant's name in words, as `NotFound` is "not found".
	if (iface === 'Error' && member === 'message') return node.typeKind === 'enum';
	// A distinct type's text is its base value.
	if (iface === 'Sensitive') return node.typeKind === 'type';
	return iface === 'Parseable' && node.typeKind === 'type' && !node.privateWrap;
}

/** Members read through the type itself: static functions and getters, constants and variants. */
export function isStaticMember(m: Node): boolean {
	return m.kind === 'Const' || m.kind === 'Variant' || ((m.kind === 'Fn' || m.kind === 'Getter') && m.isStatic);
}

/** Reads the parts of `nib.toml` the checker needs. Not a full TOML parser. */
function readManifest(path: string): Manifest {
	const text = readFileSync(path, 'utf8');
	let section = '';
	let name = '';
	const dependencies = new Set<string>();
	const packages = new Map<string, string>();
	const testModules = new Set<string>();
	for (const raw of text.split('\n')) {
		const line = raw.trim();
		const header = line.match(/^\[([^\]]+)\]$/);
		if (header) {
			section = header[1];
			continue;
		}
		const kv = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
		if (!kv) continue;
		if (section === 'package' && kv[1] === 'name') name = kv[2].replace(/"/g, '');
		if (section === 'dependencies') {
			dependencies.add(kv[1]);
			const pkg = kv[2].match(/package\s*=\s*"([^"]+)"/);
			if (pkg) packages.set(kv[1], pkg[1]);
		}
		if (section === 'testing' && kv[1] === 'modules') for (const m of kv[2].matchAll(/"([^"]+)"/g)) testModules.add(m[1]);
	}
	return { dir: dirname(path), root: name.split('/').pop() ?? '', dependencies, packages, testModules, host: readHostNeeds(path, text) };
}

function checkModuleNames(manifest: Manifest): Diagnostic[] {
	const out: Diagnostic[] = [];
	const src = join(manifest.dir, 'src');
	if (!existsSync(src)) return out;
	const visit = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const p = join(dir, name);
			if (!statSync(p).isDirectory()) continue;
			if (!MODULE_NAME.test(name)) {
				out.push({ path: p, line: 1, col: 1, severity: 'error', message: `module \`${name}\` must be lowercase letters and digits only` });
			}
			visit(p);
		}
	};
	visit(src);
	return out;
}

/**
 * A rate limit's name is where its counts are stored, so two `Limit` constants with one name
 * in a package would share a counter without either saying so.
 */
function sharedLimits(files: SourceFile[], diagnostics: Diagnostic[]) {
	const seen = new Map<string, { path: string; name: string }>();
	for (const file of files) {
		const imported = (file.decls as Node[]).some((d) => d.kind === 'Import' && (d.path as string[]).join('.') === 'std.cache' && ((d.names ?? []) as Node[]).some((n) => n.name === 'Limit'));
		if (!imported) continue;
		for (const d of file.decls as Node[]) {
			const v = d.value as Node | null;
			if (d.kind !== 'Const' || v?.kind !== 'Call' || v.callee.kind !== 'Name' || v.callee.name !== 'Limit') continue;
			const arg = ((v.args ?? []) as Node[]).find((a) => a.name === 'name');
			const parts = arg?.value?.kind === 'Str' ? (arg.value.parts as unknown[]) : null;
			if (!parts || parts.length !== 1 || typeof parts[0] !== 'string') continue;
			const key = parts[0];
			const first = seen.get(key);
			if (first) {
				const where = first.path === file.path ? '' : ` in ${first.path}`;
				diagnostics.push({ path: file.path, line: arg.line, col: arg.col, severity: 'error', message: `\`${d.name}\` has the name "${key}", which \`${first.name}\`${where} already has, so the two limits would share one counter; give each a name of its own` });
			} else seen.set(key, { path: file.path, name: d.name });
		}
	}
}

/** Checks a set of files. With a manifest they form one package; without one, each file stands alone. */
export function checkSources(sources: { path: string; src: string; copy?: boolean }[], manifest: Manifest | null, names?: Map<string, NameInfo[]>): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const modules = new Map<string, Module>();
	const files: SourceFile[] = [];
	const broken = new Set<SourceFile>();

	for (const { path, src } of sources) {
		const testFile = path.endsWith('.test.nibl');
		const declarationFile = path.endsWith('.d.nibl');
		const parsed = parse(src, { testFile, declarationFile });
		for (const e of parsed.errors) diagnostics.push({ path, line: e.line, col: e.col, severity: 'error', message: e.message });
		const moduleName = manifest ? moduleNameFor(manifest, path) : path;
		if (!modules.has(moduleName)) modules.set(moduleName, { name: moduleName, files: [], decls: new Map(), testOnly: manifest?.testModules.has(moduleName) ?? false });
		const module = modules.get(moduleName)!;
		const file: SourceFile = { path, src, testFile, decls: parsed.decls, docs: parsed.docs, module };
		module.files.push(file);
		files.push(file);
		if (parsed.errors.length > 0) broken.add(file);
	}

	for (const module of modules.values()) indexModule(module, diagnostics);
	if (manifest) checkImportCycles(modules, diagnostics);
	const checkers = files.map((file) => new FileChecker(file, modules, manifest, diagnostics));
	for (const checker of checkers) checker.run();
	const host = manifest?.host ?? null;
	const program = new Program(modules, external(manifest), host);
	for (const checker of checkers) {
		// A file that didn't parse would only add errors that follow from its syntax error.
		if (broken.has(checker.file)) continue;
		const types = new TypeChecker(program, checker.file, diagnostics, checker.locals);
		types.run();
		names?.set(checker.file.path, types.names);
	}
	// A guide's error example gets copies of its chapter's declarations, which aren't second
	// declarations of their own.
	const copies = new Set(sources.filter((s) => s.copy).map((s) => s.path));
	sharedLimits(files.filter((f) => !copies.has(f.path)), diagnostics);
	if (host && manifest) {
		for (const d of host.resources.get('databases')!.values()) {
			const migrations = d.keys.get('migrations');
			if (typeof migrations === 'string' && !modules.has(migrations)) host.problems.push({ line: d.line, severity: 'error', message: `\`migrations = "${migrations}"\` names a module this package doesn't have` });
		}
		// Declarations nothing uses can only be told apart once every file has been read.
		const src = join(manifest.dir, 'src');
		const all = existsSync(src) ? findSources(src).filter((f) => f.endsWith('.nibl')) : [];
		const whole = broken.size === 0 && all.every((f) => files.some((x) => x.path === f));
		const problems = [...host.problems, ...(whole ? unusedNeeds(host) : [])];
		for (const p of problems) diagnostics.push({ path: host.path, line: p.line, col: 1, severity: p.severity, message: p.message });
	}
	checkDocExamples(files.filter((f) => !broken.has(f)), modules, manifest, program, diagnostics);
	for (const file of files) checkWidth(file, diagnostics);
	return diagnostics.sort((a, b) => (a.path === b.path ? a.line - b.line || a.col - b.col : a.path < b.path ? -1 : 1));
}

/** Warns at each import that closes a cycle between a package's modules. A cycle is allowed,
 * since nothing runs at import, but it means neither module can be read without the other. */
function checkImportCycles(modules: Map<string, Module>, out: Diagnostic[]) {
	const edges = new Map<string, { to: string; file: SourceFile; at: Node }[]>();
	for (const module of modules.values()) {
		if (module.testOnly || module.external) continue;
		const list: { to: string; file: SourceFile; at: Node }[] = [];
		for (const file of module.files) {
			if (file.testFile) continue;
			for (const d of file.decls) {
				if (d.kind !== 'Import') continue;
				const to = (d.path as string[]).join('.');
				const target = modules.get(to);
				if (to !== module.name && target && !target.testOnly && !target.external) list.push({ to, file, at: d });
			}
		}
		edges.set(module.name, list);
	}
	// Tarjan's algorithm: each strongly connected component of two or more modules is a cycle.
	const index = new Map<string, number>();
	const low = new Map<string, number>();
	const stack: string[] = [];
	const onStack = new Set<string>();
	const component = new Map<string, number>();
	let next = 0;
	let count = 0;
	const visit = (name: string) => {
		index.set(name, next);
		low.set(name, next++);
		stack.push(name);
		onStack.add(name);
		for (const { to } of edges.get(name) ?? []) {
			if (!index.has(to)) {
				visit(to);
				low.set(name, Math.min(low.get(name)!, low.get(to)!));
			} else if (onStack.has(to)) low.set(name, Math.min(low.get(name)!, index.get(to)!));
		}
		if (low.get(name) === index.get(name)) {
			const members: string[] = [];
			let m: string;
			do {
				m = stack.pop()!;
				onStack.delete(m);
				members.push(m);
			} while (m !== name);
			if (members.length > 1) for (const member of members) component.set(member, count);
			count++;
		}
	};
	for (const name of edges.keys()) if (!index.has(name)) visit(name);
	// The shortest way back from `from` to `to`, for the message.
	const pathBack = (from: string, to: string): string[] => {
		const previous = new Map<string, string>([[from, from]]);
		const queue = [from];
		while (queue.length > 0) {
			const m = queue.shift()!;
			if (m === to) break;
			for (const e of edges.get(m) ?? []) {
				if (previous.has(e.to) || component.get(e.to) !== component.get(from)) continue;
				previous.set(e.to, m);
				queue.push(e.to);
			}
		}
		const path = [to];
		while (path[0] !== from) path.unshift(previous.get(path[0])!);
		return path;
	};
	for (const [name, list] of edges) {
		const c = component.get(name);
		if (c === undefined) continue;
		for (const { to, file, at } of list) {
			if (component.get(to) !== c) continue;
			const cycle = [name, ...pathBack(to, name)].map((m) => `\`${m}\``).join(' → ');
			out.push({
				path: file.path,
				line: at.line,
				col: at.col,
				severity: 'warning',
				message: `this import makes a cycle, ${cycle}, so neither module can be read without the other: move what they share into one of them, or into a module of its own`,
			});
		}
	}
}

function moduleNameFor(manifest: Manifest, path: string): string {
	const rel = relative(join(manifest.dir, 'src'), dirname(path));
	const parts = rel === '' ? [] : rel.split(sep);
	return [manifest.root, ...parts].join('.');
}

function declKind(node: Node): Decl['kind'] | null {
	if (node.kind === 'Fn') return 'fn';
	if (node.kind === 'Const') return 'const';
	if (node.kind === 'TypeDecl') return node.typeKind === 'attribute' ? 'attribute' : 'type';
	return null;
}

function testFileOnly(name: string): string {
	return `\`${name}\` is declared in a test file, so only tests can use it`;
}

function indexModule(module: Module, diagnostics: Diagnostic[]) {
	for (const file of module.files) {
		for (const node of file.decls) {
			const kind = declKind(node);
			if (!kind) continue;
			const decl: Decl = {
				name: node.name,
				kind,
				node,
				file: file.path,
				testFile: file.testFile,
				private: node.vis === 'private',
			};
			const existing = module.decls.get(node.name) ?? [];
			// Overloads share a name; anything else may not.
			const clash = existing.find((d) => !(d.kind === 'fn' && kind === 'fn') && d.testFile === decl.testFile);
			if (clash) {
				diagnostics.push({
					path: file.path, line: node.line, col: node.col, severity: 'error',
					message: `\`${node.name}\` is already declared in this module (${basename(clash.file)}:${clash.node.line})`,
				});
			}
			existing.push(decl);
			module.decls.set(node.name, existing);
		}
	}
	for (const [, decls] of module.decls) {
		const fns = decls.filter((d) => d.kind === 'fn');
		if (fns.length > 1) checkOverloads(fns.map((d) => d.node), (at, message) => {
			const file = fns.find((d) => d.node === at)!.file;
			diagnostics.push({ path: file, line: at.line, col: at.col, severity: 'error', message });
		});
	}
}

// ---- per-file checks --------------------------------------------------------------------

class FileChecker {
	file: SourceFile;
	modules: Map<string, Module>;
	manifest: Manifest | null;
	out: Diagnostic[];
	imports: ImportRecord[] = [];
	tasks: Binding[] = [];
	moduleScope: Scope;
	importedAttributes = new Map<string, ImportRecord>();
	/** The stdlib's modules and those of the dependencies that can be read. */
	std: Map<string, Module> | null;
	preludeAttributes = new Set<string>();
	/** Whether `this` is available: inside instance methods, getters and lazy fields. */
	thisAvailable = false;
	labels: string[] = [];
	/** Set while a `let`, `var` or `const` declares its names. */
	declaring: Binding['declaredWith'] | undefined;
	/** The closures being checked, innermost last, with the `var`s each captures with `use (mut …)`. */
	closures: Set<Binding>[] = [];
	/** Every local and parameter, by where it is declared, for the type stage. */
	locals = new Map<string, Binding[]>();

	constructor(file: SourceFile, modules: Map<string, Module>, manifest: Manifest | null, out: Diagnostic[]) {
		this.file = file;
		this.modules = modules;
		this.manifest = manifest;
		this.std = external(manifest);
		this.out = out;
		this.moduleScope = new Scope(null);
	}

	error(node: { line: number; col: number }, message: string) {
		this.out.push({ path: this.file.path, line: node.line, col: node.col, severity: 'error', message });
	}

	warning(node: { line: number; col: number }, message: string) {
		this.out.push({ path: this.file.path, line: node.line, col: node.col, severity: 'warning', message });
	}

	run() {
		const prelude = new Scope(null);
		const preludeModule = this.std?.get('std');
		if (preludeModule) {
			for (const [name, decls] of preludeModule.decls) {
				const d = decls[0];
				if (TEST_PRELUDE_VALUES.has(name) && !this.file.testFile) continue;
				const b: Binding = { kind: 'prelude', line: 0, col: 0, decl: d };
				if (d.kind === 'type') prelude.types.set(name, b);
				else if (d.kind === 'attribute') this.preludeAttributes.add(name);
				else prelude.values.set(name, b);
			}
		} else {
			for (const t of PRELUDE_TYPES) prelude.types.set(t, { kind: 'prelude', line: 0, col: 0 });
			for (const v of PRELUDE_VALUES) prelude.values.set(v, { kind: 'prelude', line: 0, col: 0 });
			if (this.file.testFile) for (const v of TEST_PRELUDE_VALUES) prelude.values.set(v, { kind: 'prelude', line: 0, col: 0 });
			for (const a of PRELUDE_ATTRIBUTES) this.preludeAttributes.add(a);
		}
		this.moduleScope = new Scope(prelude);

		for (const [name, decls] of this.file.module.decls) {
			const visible = decls.filter((d) => this.file.testFile || !d.testFile);
			if (visible.length === 0) continue;
			const d = visible[0];
			const b: Binding = { kind: 'decl', line: d.node.line, col: d.node.col, decl: d };
			if (d.kind === 'type') this.moduleScope.types.set(name, b);
			else if (d.kind !== 'attribute') this.moduleScope.values.set(name, b);
		}

		for (const node of this.file.decls) if (node.kind === 'Import') this.importDecl(node);
		for (const node of this.file.decls) if (node.kind !== 'Import') this.topLevel(node);
		this.mainIsPub();
		this.oneMigration();

		for (const record of this.imports) {
			if (!record.used) this.warning(record, `\`${record.attribute ? '@' : ''}${record.name}\` is imported but never used`);
		}
		// A task is waited for where it's read, so one that's never read hides its result and its failure.
		for (const b of this.tasks) {
			if (!b.task!.read) this.error(b, `\`${b.task!.name}\` is started but never read, so its result and any failure would be lost: read it, or write \`let _ = start …\` to run it for its effect`);
		}
	}

	/** The host calls a program's `main` from outside the package, so it's `pub`, like everything else reached from there. */
	mainIsPub() {
		if (this.file.testFile || this.file.path.endsWith('.d.nibl')) return;
		if (this.manifest && this.file.module.name !== this.manifest.root) return;
		for (const node of this.file.decls) {
			if (node.kind === 'Fn' && node.name === 'main' && node.vis !== 'pub') {
				this.error(node, 'the host calls `main` from outside the package, so it is `pub`: `pub fn main(…)`');
			}
		}
	}

	/** The migration runner finds each migration as the one type in its file that implements `Migration`. */
	oneMigration() {
		if (this.file.testFile || !this.manifest?.host) return;
		const modules = [...this.manifest.host.resources.get('databases')!.values()].map((d) => d.keys.get('migrations'));
		if (!modules.includes(this.file.module.name)) return;
		const found = (this.file.decls as Node[]).filter((d) => d.kind === 'TypeDecl' && (d.implements as Node[]).some((t) => t.kind === 'NamedType' && t.path[t.path.length - 1] === 'Migration'));
		const at = found[1] ?? this.file.decls[0] ?? { line: 1, col: 1 };
		if (found.length === 0) this.error(at, 'a migration file declares one type that implements `Migration`, which is how the runner finds it, but this file has none');
		else if (found.length > 1) this.error(at, `a migration file declares one type that implements \`Migration\`, but this file has ${found.length}: \`${found[0].name}\` and \`${found[1].name}\`; give each its own file, named for the order it runs in`);
	}

	// ---- imports ----------------------------------------------------------------------

	importDecl(node: Node) {
		const path: string[] = node.path;
		const root = path[0];
		const own = this.manifest && root === this.manifest.root;
		if (root !== 'std' && !own && !(this.manifest?.dependencies.has(root))) {
			this.error(node, this.manifest
				? `unknown package \`${root}\`: add it to [dependencies] in nib.toml`
				: `unknown package \`${root}\`: only \`std\` is available outside a package`);
			return;
		}
		let target: Module | null = null;
		if (own) {
			target = this.modules.get(path.join('.')) ?? null;
			if (!target) {
				this.error(node, `there is no module \`${path.join('.')}\` in this package`);
				return;
			}
		} else if (root !== 'std' && this.std && [...this.std.keys()].some((n) => n === root || n.startsWith(`${root}.`))) {
			target = this.std.get(path.join('.')) ?? null;
			if (!target) {
				this.error(node, `the package \`${this.manifest?.packages.get(root) ?? root}\` has no module \`${path.join('.')}\``);
				return;
			}
		} else if (root === 'std' && this.std && path.length > 1) {
			target = this.std.get(path.join('.')) ?? null;
			if (!target) {
				const names = [...this.std.keys()].filter((n) => n !== 'std');
				this.error(node, `the standard library has no module \`${path.join('.')}\`${suggest(path.join('.'), names)}`);
				// Bind its names anyway, so one wrong import doesn't flag every use.
			}
		}
		if (target?.testOnly && !this.file.testFile && !this.file.module.testOnly) {
			this.error(node, `\`${target.name}\` is for tests, so only test files can import it`);
		}
		if (!node.names || node.withModule) {
			const local = node.alias ?? path[path.length - 1];
			if (path.length === 1 && root === 'std') {
				this.error(node, 'import a module of the standard library, such as `import std.http`');
				return;
			}
			const record: ImportRecord = { name: local, line: node.line, col: node.col, used: false, attribute: false };
			this.addImport(record);
			this.bindImport(this.moduleScope.values, local, { kind: 'import', line: node.line, col: node.col, module: target, importRecord: record }, node);
			if (!node.names) return;
		}
		for (const item of node.names as Node[]) {
			const record: ImportRecord = { name: item.name, line: item.line, col: item.col, used: false, attribute: item.attribute };
			this.addImport(record);
			if (item.attribute) {
				if (target) {
					const decl = target.decls.get(item.name)?.find((d) => d.kind === 'attribute' && !d.testFile);
					if (!decl) this.error(item, `module \`${target.name}\` has no attribute \`@${item.name}\``);
				}
				this.importedAttributes.set(item.name, record);
				continue;
			}
			let decl: Decl | undefined;
			if (target) {
				const all = target.decls.get(item.name) ?? [];
				decl = all.find((d) => !d.testFile || this.file.testFile);
				if (!decl && all.length > 0) {
					this.error(item, testFileOnly(item.name));
					continue;
				}
				if (!decl) {
					this.error(item, `module \`${target.name}\` has no \`${item.name}\`${suggest(item.name, target.decls.keys())}`);
					continue;
				}
				if (decl.private) this.error(item, `\`${item.name}\` is private to ${basename(decl.file)}`);
				else if (target.external && decl.node.vis !== 'pub') this.error(item, `\`${item.name}\` isn't \`pub\`, so the package \`${target.external}\` doesn't export it`);
				if (decl.kind === 'fn') {
					const moduleName = target.name.split('.').pop();
					this.error(item, `functions are called through their module, not imported by name: \`import ${target.name}\`, then \`${moduleName}.${item.name}(…)\``);
					continue;
				}
				if (decl.kind === 'attribute') {
					this.error(item, `\`${item.name}\` is an attribute: import it as \`@${item.name}\``);
					continue;
				}
			}
			const binding: Binding = { kind: 'import', line: item.line, col: item.col, decl, importRecord: record };
			const isType = decl ? decl.kind === 'type' : PASCAL.test(item.name) && /[a-z]/.test(item.name);
			if (isType) this.bindImport(this.moduleScope.types, item.name, binding, item);
			else this.bindImport(this.moduleScope.values, item.name, binding, item);
		}
	}

	addImport(record: ImportRecord) {
		const dup = this.imports.find((r) => r.name === record.name && r.attribute === record.attribute);
		if (dup) this.warning(record, `\`${record.name}\` is already imported on line ${dup.line}`);
		this.imports.push(record);
	}

	bindImport(map: Map<string, Binding>, name: string, binding: Binding, at: Node) {
		const existing = map.get(name);
		if (existing && existing.kind === 'decl') {
			this.error(at, `the import of \`${name}\` clashes with \`${name}\` declared in this module`);
			return;
		}
		map.set(name, binding);
	}

	// ---- declarations -----------------------------------------------------------------

	topLevel(node: Node) {
		this.attributes(node);
		switch (node.kind) {
			case 'Fn':
				this.caseRule(node, node.name, 'camel', 'function');
				this.fn(node, this.moduleScope, false);
				break;
			case 'Const':
				this.caseRule(node, node.name, 'upper', 'constant');
				if (node.type) this.type(node.type, this.moduleScope);
				if (node.value) this.expr(node.value, this.moduleScope);
				break;
			case 'TypeDecl':
				this.typeDecl(node, this.moduleScope);
				break;
			case 'Test': {
				const scope = new Scope(this.moduleScope);
				if (node.iterable) {
					this.expr(node.iterable, scope);
					this.bindPattern(node.pattern, scope);
				}
				this.block(node.body, scope);
				break;
			}
		}
	}

	attributes(node: Node) {
		for (const attr of (node.attrs ?? []) as Node[]) {
			const imported = this.importedAttributes.get(attr.name);
			const declared = this.file.module.decls.get(attr.name)?.some((d) => d.kind === 'attribute');
			if (imported) imported.used = true;
			else if (!this.preludeAttributes.has(attr.name) && !declared) {
				const from = [...(this.std?.values() ?? [])].find((m) => m.decls.get(attr.name)?.some((d) => d.kind === 'attribute'))?.name;
				this.error(attr, from
					? `\`@${attr.name}\` isn't imported: add \`import ${from}.{@${attr.name}}\``
					: `unknown attribute \`@${attr.name}\``);
			}
			for (const arg of (attr.args ?? []) as Node[]) {
				if (arg.punned) this.lookupValue(arg, arg.name, this.moduleScope);
				else if (arg.value) this.expr(arg.value, this.moduleScope);
			}
		}
	}

	typeDecl(node: Node, outer: Scope) {
		const what = node.typeKind === 'attribute' ? 'attribute' : 'type';
		this.caseRule(node, node.name, node.typeKind === 'attribute' ? 'camel' : 'pascal', what);
		const scope = new Scope(outer);
		this.typeParams(node.typeParams, scope);
		scope.types.set('This', { kind: 'typeParam', line: node.line, col: node.col });
		if (node.backing) this.type(node.backing, scope);
		if (node.base) this.type(node.base, scope);
		if (node.target) this.type(node.target, scope);
		for (const t of node.implements) this.type(t, scope);
		this.members(node.members, scope, node.typeKind);
		if (node.typeKind !== 'interface' && node.typeKind !== 'attribute') {
			this.implementations(node, scope);
			this.causes(node, scope);
			this.ownMessage(node, scope);
		}
	}

	/**
	 * A member that implements an interface's member is marked `override`, and one that isn't
	 * marked doesn't share a name with one. That keeps a rename in an interface from silently
	 * turning an implementation into a plain member, or a plain member into an implementation.
	 * Every interface member without a default is defined, except in a declaration file, which
	 * may leave out what its `implements` already says.
	 */
	implementations(node: Node, scope: Scope) {
		const wanted = new Map<string, { iface: string; member: Node }[]>();
		// An interface from a dependency can't be read, so an `override` may implement it.
		let unseen = false;
		// An interface's own interfaces count too (`ToResponse implements Error`).
		const queue: Decl[] = [];
		for (const t of node.implements as Node[]) {
			const iface = this.interfaceFor(t, scope);
			if (iface) queue.push(iface);
			else unseen = true;
		}
		// So do the interfaces a prelude attribute gives (`@sensitive` gives `Sensitive`).
		for (const attr of (node.attrs ?? []) as Node[]) {
			if (!this.preludeAttributes.has(attr.name) || this.importedAttributes.has(attr.name)) continue;
			const decl = this.std?.get('std')?.decls.get(attr.name)?.find((d) => d.kind === 'attribute');
			for (const t of (decl?.node.implements ?? []) as Node[]) {
				const iface = t.kind === 'NamedType' ? this.findTypeDecl(t.path[t.path.length - 1], decl!) : null;
				if (iface?.node.typeKind === 'interface') queue.push(iface);
			}
		}
		const seenIfaces = new Set<Decl>();
		while (queue.length > 0) {
			const iface = queue.shift()!;
			if (seenIfaces.has(iface)) continue;
			seenIfaces.add(iface);
			for (const t of iface.node.implements as Node[]) {
				const parent = t.kind === 'NamedType' ? this.findTypeDecl(t.path[t.path.length - 1], iface) : null;
				if (parent?.node.typeKind === 'interface') queue.push(parent);
				else unseen = true;
			}
			for (const m of iface.node.members as Node[]) {
				if (m.kind !== 'Fn' && m.kind !== 'Getter') continue;
				const list = wanted.get(m.name) ?? [];
				if (!list.some((x) => x.iface === iface.name)) list.push({ iface: iface.name, member: m });
				wanted.set(m.name, list);
			}
		}
		const own = (node.members as Node[]).filter((m) => m.kind === 'Fn' || m.kind === 'Getter' || m.kind === 'Field');
		const defined = new Set(own.map((m) => m.name));
		const undefinedNames = [...wanted.keys()].filter((n) => !defined.has(n));
		for (const m of own) {
			const matches = wanted.get(m.name);
			if (matches && !m.isOverride) {
				this.error(m, `\`${m.name}\` implements \`${matches[0].iface}.${m.name}\`, so it is marked \`override\``);
			} else if (matches && m.kind === 'Fn') {
				this.sameParameters(m, matches[0]);
			} else if (!matches && m.isOverride && !unseen) {
				const named = (node.implements as Node[]).length > 0 ? 'none of the interfaces it implements has' : `\`${node.name}\` implements no interfaces, so nothing has`;
				this.error(m, `\`${m.name}\` is marked \`override\`, but ${named} a \`${m.name}\`${suggest(m.name, undefinedNames)}`);
			}
		}
		const declarationFile = this.file.path.endsWith('.d.nibl');
		for (const [name, list] of wanted) {
			if (defined.has(name)) continue;
			const defaults = list.filter((x) => x.member.body);
			if (defaults.length > 1) {
				this.error(node, `\`${node.name}\` gets a default \`${name}\` from both \`${defaults[0].iface}\` and \`${defaults[1].iface}\`, so it defines \`${name}\` itself to say which it wants`);
			} else if (defaults.length === 0 && !declarationFile && !derived(node, list[0].iface, name)) {
				this.error(node, `\`${node.name}\` implements \`${list[0].iface}\` but doesn't define \`${name}\``);
			}
		}
	}

	/**
	 * An implementation keeps which parameters are `named`, and their names, because callers
	 * label them and shouldn't need to know which type they call through. Any other parameter
	 * may take a name that suits the implementation. `_` may stand for a parameter the
	 * implementation doesn't use; its label is still the interface's.
	 */
	sameParameters(m: Node, wanted: { iface: string; member: Node }) {
		if (wanted.member.kind !== 'Fn') return;
		const mine = m.params as Node[];
		const theirs = wanted.member.params as Node[];
		if (mine.length !== theirs.length) return;
		for (let i = 0; i < mine.length; i++) {
			const p = mine[i];
			const q = theirs[i];
			if (p.name === '_') {
				p.label = q.name;
			} else if (p.name !== q.name && q.named) {
				this.error(p, `\`${wanted.iface}.${m.name}\` calls this \`named\` parameter \`${q.name}\`, so an implementation does too, because callers label it; write \`_\` if it isn't used`);
				continue;
			}
			if (!!p.named !== !!q.named) {
				const which = q.named ? 'is `named`, so it is here too' : "isn't `named`, so it isn't here either";
				this.error(p, `\`${q.name}\` in \`${wanted.iface}.${m.name}\` ${which}`);
			}
		}
	}

	/** The interface a type in an `implements` list names, if the checker can find it. */
	interfaceFor(t: Node, scope: Scope): Decl | null {
		const decl = this.typeFor(t, scope);
		return decl?.node.typeKind === 'interface' ? decl : null;
	}

	/** The declaration a written type names, if the checker can find it. */
	typeFor(t: Node, scope: Scope): Decl | null {
		if (t.kind !== 'NamedType') return null;
		let decl: Decl | null = null;
		if (t.path.length === 1) {
			decl = this.typeDeclFor(scope.lookupType(t.path[0]));
		} else {
			const b = scope.lookupValue(t.path[0]);
			decl = b?.module?.decls.get(t.path[1])?.find((d) => d.kind === 'type') ?? null;
			if (!decl && b?.kind === 'import') {
				for (const m of this.std?.values() ?? []) decl ??= m.decls.get(t.path[1])?.find((d) => d.kind === 'type') ?? null;
			}
		}
		return decl;
	}

	/**
	 * An error's `message` describes its own layer: whatever prints it follows the chain of
	 * causes, so a message that reads another error's `message` would print it twice.
	 */
	ownMessage(node: Node, scope: Scope) {
		if (!(node.implements as Node[]).some((t) => this.interfaceFor(t, scope)?.name === 'Error')) return;
		const getter = (node.members as Node[]).find((m) => m.kind === 'Getter' && m.name === 'message' && m.body);
		if (!getter) return;
		const visit = (n: unknown) => {
			if (!n || typeof n !== 'object') return;
			if (Array.isArray(n)) return n.forEach(visit);
			const e = n as Node;
			if (e.kind === 'Member' && e.name === 'message') {
				this.warning(e, `\`${node.name}.message\` reads another error's \`message\`; describe this layer only, because a log or a failed \`main\` prints each cause's message after it`);
			}
			for (const [k, v] of Object.entries(e)) if (k !== 'line' && k !== 'col') visit(v);
		};
		visit(getter.body);
	}

	/**
	 * In an enum that implements `Error`, each `from` variant's payload is its `cause`, so the
	 * payload implements `Error` too; otherwise the chain would stop there without a word.
	 */
	causes(node: Node, scope: Scope) {
		// Through the interfaces it implements, so a `ToResponse` or a `HandledAtCall` is an `Error`.
		const implementsError = (implemented: Node[], depth = 0): boolean => depth < 10 && implemented.some((t) => {
			const i = this.interfaceFor(t, scope);
			return i?.name === 'Error' || (i ? implementsError(i.node.implements as Node[], depth + 1) : false);
		});
		const isError = (decl: Decl) => implementsError(decl.node.implements as Node[]);
		const self = implementsError(node.implements as Node[]);
		if (node.typeKind !== 'enum' || !self) return;
		for (const v of node.members as Node[]) {
			if (v.kind !== 'Variant' || !v.from) continue;
			const payload = this.typeFor(v.from, scope);
			if (payload && payload.node.typeKind !== 'interface' && !isError(payload)) {
				this.error(v, `\`${v.name}\` wraps \`${payload.name}\`, which doesn't implement \`Error\`, so \`${node.name}\`'s chain of causes would stop there; implement \`Error\` on \`${payload.name}\`, or give the variant a named field instead of \`from\``);
			}
		}
	}

	/**
	 * A class's constructor sets every field that has no default and isn't declared by a
	 * parameter. A class without one is built with `new Type()`, so its fields all need
	 * defaults, and an empty `construct() {}` says nothing more.
	 */
	constructorFields(members: Node[]) {
		if (this.file.path.endsWith('.d.nibl')) return;
		const ctor = members.find((m) => m.isConstructor);
		if (ctor && ctor.params.length === 0 && ctor.vis !== 'private' && ctor.body?.body?.length === 0 && (ctor.attrs ?? []).length === 0) {
			this.warning(ctor, 'a class without a constructor is built with `new Type()`, so an empty `construct() {}` says nothing: leave it out');
		}
		const fields = members.filter((m) => m.kind === 'Field');
		const required = fields.filter((f) => !f.promoted && !f.lazy && !f.init);
		if (!ctor) {
			for (const f of required) this.error(f, `nothing sets \`${f.name}\`: give it a default, or give the class a constructor, \`construct(…) { … }\`, that sets it`);
			return;
		}
		if (!ctor.body) return;
		const walk = (n: any) => {
			if (!n || typeof n !== 'object') return;
			if (Array.isArray(n)) return n.forEach(walk);
			if (n.kind === 'Closure') return;
			if (n.kind === 'Return' || n.kind === 'ReturnExpr') this.error(n, 'a constructor ends where its body ends, so it has no `return`');
			for (const [k, v] of Object.entries(n)) if (k !== 'ref' && k !== 'ty' && k !== 'decl' && k !== 'type') walk(v);
		};
		walk(ctor.body.body);
		const names = new Set(fields.map((f) => f.name));
		for (const f of required) new FieldSetOnce(f.name, names, (at, message) => this.error(at, message)).run(f, ctor.body.body);
	}

	members(members: Node[], scope: Scope, owner: string) {
		if (owner === 'class') this.constructorFields(members);
		const methods = new Map<string, Node[]>();
		for (const m of members) if (m.kind === 'Fn') methods.set(`${m.isStatic}:${m.name}`, [...(methods.get(`${m.isStatic}:${m.name}`) ?? []), m]);
		for (const fns of methods.values()) if (fns.length > 1) checkOverloads(fns, (at, message) => this.error(at, message));
		const seen = new Map<string, Node>();
		for (const m of members) {
			this.attributes(m);
			if (m.kind !== 'Fn') {
				const prev = seen.get(m.name);
				if (prev) this.error(m, `\`${m.name}\` is already declared on line ${prev.line}`);
				seen.set(m.name, m);
			}
			const saved = this.thisAvailable;
			try {
				switch (m.kind) {
					case 'Field': {
						// A field is always reached through something (`this.passwords`), so it can
						// share an imported module's name; only locals and parameters can hide one.
						this.caseRule(m, m.name, 'camel', 'field');
						this.type(m.type, scope);
						this.thisAvailable = m.lazy;
						if (m.init) this.expr(m.init, scope);
						break;
					}
					case 'Getter':
						this.caseRule({ line: m.nameLine, col: m.nameCol }, m.name, 'camel', 'property');
						this.type(m.type, scope);
						this.thisAvailable = !m.isStatic;
						if (m.body) this.body(m.body, new Scope(scope));
						break;
					case 'Fn':
						this.caseRule(m, m.name, 'camel', 'method');
						this.fn(m, scope, !m.isStatic || !!m.isConstructor);
						break;
					case 'Const':
						this.caseRule(m, m.name, 'upper', 'constant');
						if (m.type) this.type(m.type, scope);
						this.thisAvailable = false;
						if (m.value) this.expr(m.value, scope);
						break;
					case 'Variant': {
						this.caseRule(m, m.name, 'pascal', 'enum variant');
						// `Payment(Declined(_))` should say whether it's a variant or the `Payment` type.
						// The prelude's names are known to every reader, and an interface can't be tested in a pattern.
						const type = scope.lookupType(m.name);
						if (type && type.kind !== 'typeParam' && type.kind !== 'prelude') {
							const isError = members.some((x) => x.kind === 'Getter' && x.name === 'message');
							const fix = isError ? `name it for what happened, such as \`${m.name}Failed\`` : 'rename the variant or the type';
							this.warning(m, `the variant \`${m.name}\` has the name of the type \`${m.name}\`, so a pattern such as \`${m.name}(…)\` reads as either: ${fix}`);
						}
						if (m.held) this.type(m.held, scope);
						const isErrorType = members.some((x) => x.kind === 'Getter' && x.name === 'message');
						for (const f of m.payload ?? []) {
							this.caseRule(f, f.name, 'camel', 'payload field');
							// An error's `message` is its getter, for logs; a payload with that name reads as the same thing.
							if (isErrorType && f.name === 'message') this.error(f, "an error's `message` is its getter, so a payload can't share the name: call the text `reason`, or name it for what it holds");
							this.type(f.type, scope);
							if (f.init) this.expr(f.init, scope);
						}
						if (m.value) this.expr(m.value, scope);
						break;
					}
				}
			} finally {
				this.thisAvailable = saved;
			}
		}
		void owner;
	}

	typeParams(params: Node[], scope: Scope) {
		for (const p of params) {
			this.caseRule(p, p.name, 'pascal', 'type parameter');
			scope.types.set(p.name, { kind: 'typeParam', line: p.line, col: p.col });
		}
		for (const p of params) for (const c of p.constraints) this.type(c, scope);
		for (const p of params) if (p.defaultType) this.type(p.defaultType, scope);
	}

	/**
	 * The "boolean trap": a bare `true` at a call doesn't say what it means, nor do two numbers
	 * side by side. Only a `named` parameter is labelled, so the declaration is where it's fixed.
	 */
	trap(node: Node) {
		const params = (node.params as Node[]).filter((p) => !(p.attrs ?? []).some((a: Node) => a.name === 'callerLocation'));
		if (params.length < 2) return;
		const typeName = (p: Node) => (p.type?.kind === 'NamedType' && p.type.path.length === 1 ? p.type.path[0] : null);
		params.forEach((p, i) => {
			if (p.named || p.name === '_') return;
			// The first is what the call is about, as in `assert(count > 0)`.
			if (typeName(p) === 'Bool' && i > 0) {
				this.warning({ line: p.nameLine, col: p.nameCol }, `a bare \`true\` or \`false\` at a call doesn't say what it means: make it \`named ${p.name}: Bool\`, so calls say \`${p.name}: true\``);
				return;
			}
			const before = params[i - 1];
			const t = typeName(p);
			if (before && !before.named && before.name !== '_' && t && NUMBER_TYPES.has(t) && typeName(before) === t) {
				this.warning({ line: p.nameLine, col: p.nameCol }, `two \`${t}\` parameters side by side are easy to swap at a call: make them \`named\`, so calls say \`${before.name}: …, ${p.name}: …\``);
			}
		});
	}

	/** A function that returns nothing leaves out `-> Void`, and one that can fail writes `else E` after its parameters. */
	voidArrow(node: Node) {
		if (node.ret?.kind !== 'NamedType' || node.ret.path.length !== 1 || node.ret.path[0] !== 'Void') return;
		if (node.err) this.warning(node.ret, 'a function that returns nothing leaves out `-> Void`, even when it can fail: write `else …` straight after the parameters');
		else this.warning(node.ret, 'a function that returns nothing leaves out the `->`: drop `-> Void`');
	}

	fn(node: Node, outer: Scope, instance: boolean) {
		const scope = new Scope(outer);
		this.typeParams(node.typeParams, scope);
		for (const p of node.params) {
			// A default is evaluated at each call, before the parameters exist.
			if (p.defaultValue) this.expr(p.defaultValue, outer);
		}
		for (const p of node.params) {
			this.attributes(p);
			if (p.name !== '_') this.caseRule({ line: p.nameLine, col: p.nameCol }, p.name, 'camel', 'parameter');
			this.type(p.type, scope);
			this.declareLocal(scope, p.name, { line: p.nameLine, col: p.nameCol }, 'param');
		}
		if (!node.isOverride) this.trap(node);
		this.voidArrow(node);
		if (node.ret) this.type(node.ret, scope);
		if (node.err) this.type(node.err, scope);
		for (const w of node.when) {
			if (!scope.lookupType(w.name)) this.error(w, `\`${w.name}\` isn't a type parameter here`);
			for (const c of w.constraints) this.type(c, scope);
		}
		const saved = this.thisAvailable;
		const savedLabels = this.labels;
		this.thisAvailable = instance;
		this.labels = [];
		if (node.body) this.block(node.body, scope, true);
		this.thisAvailable = saved;
		this.labels = savedLabels;
	}

	// ---- types ------------------------------------------------------------------------

	type(t: Node, scope: Scope) {
		switch (t.kind) {
			case 'NullableType':
				this.type(t.inner, scope);
				return;
			case 'FnType':
				for (const p of t.params) this.type(p, scope);
				if (t.ret) this.type(t.ret, scope);
				if (t.err) this.type(t.err, scope);
				return;
			case 'TupleType':
				for (const i of t.items) this.type(i, scope);
				return;
			case 'NamedType': {
				for (const a of t.args) this.type(a, scope);
				const head: string = t.path[0];
				if (t.path.length === 1) {
					const b = scope.lookupType(head);
					if (!b) {
						this.error(t, head === 'This' ? '`This` is only meaningful inside a type or interface' : `unknown type \`${head}\`${foreignHint(head)}`);
						return;
					}
					this.use(b, t);
					return;
				}
				const b = scope.lookupValue(head);
				if (!b || !(b.kind === 'import' && !b.decl)) {
					this.error(t, `\`${head}\` isn't an imported module, so \`${t.path.join('.')}\` can't be found`);
					return;
				}
				this.use(b, t);
				if (b.module) this.moduleMember(t, b.module, t.path[1]);
				return;
			}
		}
	}

	use(b: Binding, at: { line: number; col: number }) {
		if (b.importRecord) b.importRecord.used = true;
		if (b.task) b.task.read = true;
		if (b.decl) this.checkAccess(b.decl, at);
	}

	checkAccess(decl: Decl, at: { line: number; col: number }) {
		if (decl.private && decl.file !== this.file.path) {
			this.error(at, `\`${decl.name}\` is private to ${basename(decl.file)}`);
		}
	}

	moduleMember(at: Node, module: Module, name: string): Decl | null {
		const all = module.decls.get(name) ?? [];
		const decls = all.filter((d) => !d.testFile || this.file.testFile);
		if (decls.length === 0 && all.length > 0) {
			this.error(at, testFileOnly(name));
			return null;
		}
		if (decls.length === 0) {
			this.error(at, `module \`${module.name}\` has no \`${name}\`${suggest(name, module.decls.keys())}`);
			return null;
		}
		this.checkAccess(decls[0], at);
		return decls[0];
	}

	/** Checks `Type.name`, where `Type` is a declared type: the member must be static. */
	staticMember(at: { line: number; col: number }, decl: Decl, name: string) {
		if (decl.kind !== 'type' || decl.node.typeKind === 'alias') return;
		const names = this.staticMembersOf(decl, new Set());
		if (!names || names.has(name)) return;
		const instance = (decl.node.members as Node[]).some((m) => m.name === name && !isStaticMember(m));
		this.error(at, instance
			? `\`${name}\` is an instance member of \`${decl.name}\`: use it on a value, not on the type`
			: `\`${decl.name}\` has no static member \`${name}\`${suggest(name, names)}`);
	}

	/** The static members of a type, including its interfaces'; null if an interface can't be found. */
	staticMembersOf(decl: Decl, seen: Set<Decl>): Set<string> | null {
		const names = new Set<string>();
		if (seen.has(decl)) return names;
		seen.add(decl);
		for (const m of decl.node.members as Node[]) if (isStaticMember(m)) names.add(m.name);
		// A `@form` record has a `fields` schema, which the compiler writes.
		if (((decl.node.attrs ?? []) as Node[]).some((a) => a.name === 'form')) names.add('fields');
		// A backed enum implements `BackedEnum` without saying so.
		const implemented: Node[] = [...decl.node.implements];
		if (decl.node.typeKind === 'enum' && decl.node.backing) implemented.push({ kind: 'NamedType', path: ['BackedEnum'], line: 0, col: 0 });
		// A codec attribute makes the type it marks implement the attribute's interfaces.
		for (const a of (decl.node.attrs ?? []) as Node[]) {
			const attr = this.findTypeDecl(a.name, decl, 'attribute');
			if (attr) implemented.push(...attr.node.implements);
		}
		for (const t of implemented) {
			const iface = t.kind === 'NamedType' ? this.findTypeDecl(t.path[t.path.length - 1], decl) : null;
			if (!iface) return null;
			const inherited = this.staticMembersOf(iface, seen);
			if (!inherited) return null;
			for (const n of inherited) names.add(n);
		}
		return names;
	}

	/** Finds a type (or attribute) by name from where `from` is declared: its module, then the stdlib. */
	findTypeDecl(name: string, from: Decl, kind: 'type' | 'attribute' = 'type'): Decl | null {
		const local = (this.modules.get(this.moduleOf(from)) ?? this.std?.get(this.moduleOf(from)))?.decls.get(name)?.find((d) => d.kind === kind);
		if (local) return local;
		for (const m of this.std?.values() ?? []) {
			const d = m.decls.get(name)?.find((x) => x.kind === kind);
			if (d) return d;
		}
		return null;
	}

	moduleOf(decl: Decl): string {
		for (const m of [...this.modules.values(), ...(this.std?.values() ?? [])]) {
			if (m.files.some((f) => f.path === decl.file)) return m.name;
		}
		return '';
	}

	/** The declaration a type name refers to here, if it's one the checker knows. */
	typeDeclFor(b: Binding | null): Decl | null {
		return b?.decl && b.decl.kind === 'type' ? b.decl : null;
	}

	// ---- statements -------------------------------------------------------------------

	block(block: Node, outer: Scope, reuse = false) {
		const scope = reuse ? outer : new Scope(outer);
		for (const s of block.body) this.statement(s, scope);
		block.body.forEach((s: Node, i: number) => {
			if (s.kind !== 'Let' || s.init || s.pattern.kind !== 'BindPattern') return;
			const b = scope.values.get(s.pattern.name);
			if (b?.setLater) new SetOnce(s.pattern.name, b, (at, message) => this.error(at, message)).check(s, block.body.slice(i + 1));
		});
	}

	body(body: Node, scope: Scope) {
		if (body.kind === 'Block') this.block(body, scope, true);
		else if (body.kind === 'Assign' || body.kind === 'IncDec') this.statement(body, scope);
		else this.expr(body, scope);
	}

	statement(s: Node, scope: Scope) {
		switch (s.kind) {
			case 'Let':
				if (s.type) this.type(s.type, scope);
				if (s.init) this.expr(s.init, scope);
				this.declaring = s.mutable ? 'var' : 'let';
				this.bindPattern(s.pattern, scope);
				this.declaring = undefined;
				if (!s.init) {
					const b = scope.values.get(s.pattern.name);
					if (b) b.setLater = true;
				}
				if (s.init?.kind === 'Start' && s.pattern.kind === 'BindPattern') {
					const b = scope.values.get(s.pattern.name);
					if (b) {
						b.task = { name: s.pattern.name, read: false };
						this.tasks.push(b);
					}
				}
				return;
			case 'Const':
				this.caseRule(s, s.name, 'upper', 'constant');
				if (s.type) this.type(s.type, scope);
				this.expr(s.value, scope);
				this.declaring = 'const';
				this.declareLocal(scope, s.name, s, 'local');
				this.declaring = undefined;
				return;
			case 'Return':
			case 'Fail':
			case 'Yield':
			case 'Expect':
			case 'ExprStmt':
			case 'Defer':
				if (s.value) this.expr(s.value, scope);
				return;
			case 'Break':
			case 'Continue':
				if (s.label && !this.labels.includes(s.label)) this.error(s, `there is no enclosing loop labelled \`${s.label}\``);
				return;
			case 'If': {
				const bindings = this.expr(s.cond, scope);
				const thenScope = new Scope(scope);
				this.declareAll(thenScope, bindings);
				this.block(s.then, thenScope, true);
				if (s.otherwise) {
					if (s.otherwise.kind === 'If') this.statement(s.otherwise, scope);
					else this.block(s.otherwise, scope);
				}
				return;
			}
			case 'For': {
				this.expr(s.iterable, scope);
				const inner = new Scope(scope);
				this.bindPattern(s.pattern, inner);
				this.loop(s, () => this.block(s.body, inner, true));
				return;
			}
			case 'While': {
				const bindings = this.expr(s.cond, scope);
				const inner = new Scope(scope);
				this.declareAll(inner, bindings);
				this.loop(s, () => this.block(s.body, inner, true));
				return;
			}
			case 'DoWhile':
				this.loop(s, () => this.block(s.body, scope));
				this.expr(s.cond, scope);
				return;
			case 'Assign':
			case 'IncDec':
				this.expr(s.target, scope);
				if (s.value) this.expr(s.value, scope);
				if (s.target.kind === 'Name' && s.target.ref) this.assigned(s.target, s.target.ref);
				return;
		}
	}

	/** Only a `var` can be assigned, and a closure assigns one it captured only through `use (mut …)`. */
	assigned(at: Node, b: Binding) {
		const name = at.name;
		if (b.declaredWith === 'let' && b.setLater) {
			if (b.closures !== undefined && b.closures < this.closures.length) this.error(at, `\`${name}\` is set once, in the code around it, so a closure can't set it`);
			return;
		}
		if (b.declaredWith === 'let') {
			this.error(at, `\`${name}\` is declared with \`let\`, so it can't be assigned: declare it with \`var\` if it changes`);
			return;
		}
		if (b.declaredWith === 'const') {
			this.error(at, `\`${name}\` is a constant, so it can't be assigned`);
			return;
		}
		if (b.kind === 'param') {
			this.error(at, `\`${name}\` is a parameter, and parameters can't be assigned: copy it to a \`var\` if it changes`);
			return;
		}
		if (b.closures === undefined) return;
		for (let depth = b.closures; depth < this.closures.length; depth++) {
			if (this.closures[depth].has(b)) continue;
			this.error(at, `a closure can only read the \`${name}\` it captures: write \`use (mut ${name})\` after the parameters to change it`);
			return;
		}
	}

	loop(s: Node, body: () => void) {
		if (s.label) {
			this.caseRule(s, s.label, 'camel', 'label');
			this.labels.push(s.label);
		}
		body();
		if (s.label) this.labels.pop();
	}

	declareLocal(scope: Scope, name: string, at: { line: number; col: number }, kind: 'local' | 'param') {
		if (name === '_') return;
		const existing = scope.lookupValue(name);
		if (existing) {
			if (existing.kind === 'local' || existing.kind === 'param') {
				// An `is` pattern reports its own shadowing, wherever it is.
				if (!(at as Node).shadowChecked) this.error(at, `\`${name}\` is already declared on line ${existing.line}; locals and parameters can't shadow each other`);
			} else if (existing.kind === 'import' && !existing.decl) {
				this.error(at, `\`${name}\` is the name of an imported module; choose another name, or import the type by name instead`);
			} else if (existing.kind === 'decl' || existing.kind === 'prelude') {
				this.warning(at, `\`${name}\` shadows ${existing.kind === 'prelude' ? 'the prelude\'s' : 'the module\'s'} \`${name}\``);
			}
		}
		const binding: Binding = { kind, line: at.line, col: at.col, declaredWith: kind === 'local' ? this.declaring : undefined, closures: this.closures.length };
		scope.values.set(name, binding);
		const key = `${at.line}:${at.col}`;
		this.locals.set(key, [...(this.locals.get(key) ?? []), binding]);
	}

	declareAll(scope: Scope, bindings: Node[]) {
		for (const b of bindings) this.declareLocal(scope, b.name, b, 'local');
	}

	/** Declares the names a pattern binds. */
	bindPattern(p: Node, scope: Scope) {
		for (const b of this.patternBindings(p, scope)) this.declareLocal(scope, b.name, b, 'local');
	}

	patternBindings(p: Node, scope: Scope): Node[] {
		switch (p.kind) {
			case 'BindPattern':
				this.caseRule(p, p.name, 'camel', 'variable');
				return [p];
			case 'WildcardPattern':
				return [];
			case 'LiteralPattern':
				this.expr(p.value, scope);
				return [];
			case 'TuplePattern':
				return p.items.flatMap((i: Node) => this.patternBindings(i, scope));
			case 'OrPattern': {
				const sets = p.alternatives.map((a: Node) => this.patternBindings(a, scope));
				const names = (s: Node[]) => s.map((b) => b.name).sort().join(',');
				for (const s of sets.slice(1)) {
					if (names(s) !== names(sets[0])) this.error(p, 'every alternative of an `or` pattern must bind the same names');
				}
				return sets[0];
			}
			case 'CtorPattern': {
				if (p.path.length > 1) {
					// `Status.NOT_FOUND`, `PaymentError.Declined(…)`: the head is a type or a module.
					const head = p.path[0];
					const t = scope.lookupType(head);
					const v = scope.lookupValue(head);
					if (t) {
						this.use(t, p);
						const decl = this.typeDeclFor(t);
						if (decl && p.path.length === 2) this.staticMember(p, decl, p.path[1]);
					} else if (v) {
						this.use(v, p);
						if (v.kind === 'import' && !v.decl && v.module) {
							const decl = this.moduleMember(p, v.module, p.path[1]);
							if (decl && decl.kind === 'type' && p.path.length === 3) this.staticMember(p, decl, p.path[2]);
						}
					} else this.error(p, `unknown type \`${head}\`${foreignHint(head)}`);
				} else {
					// A bare name is a variant of the matched type or a type test; mark a matching
					// type as used, but don't require one.
					const t = scope.lookupType(p.path[0]);
					if (t) this.use(t, p);
				}
				const out: Node[] = [];
				for (const a of p.args ?? []) out.push(...this.patternBindings(a.pattern, scope));
				if (p.binding) {
					this.caseRule({ line: p.bindingLine, col: p.bindingCol }, p.binding, 'camel', 'variable');
					out.push({ kind: 'BindPattern', name: p.binding, line: p.bindingLine, col: p.bindingCol });
				}
				return out;
			}
		}
		return [];
	}

	// ---- expressions ------------------------------------------------------------------

	lookupValue(at: Node, name: string, scope: Scope): Binding | null {
		const b = scope.lookupValue(name);
		at.ref = b ?? undefined;
		if (!b) {
			if (scope.lookupType(name)) return scope.lookupType(name);
			this.error(at, unknownName(name));
			return null;
		}
		this.use(b, at);
		return b;
	}

	/** Resolves an expression. Returns the names bound by `is` patterns in it, for the code they guard. */
	expr(e: Node, scope: Scope): Node[] {
		switch (e.kind) {
			case 'Int':
			case 'Decimal':
			case 'Bool':
			case 'Null':
				return [];
			case 'This':
				// An example's statements may be from inside a method.
				if (!this.thisAvailable && !this.file.example) this.error(e, '`this` is only available in instance methods, getters and `lazy` fields');
				return [];
			case 'Name': {
				const b = scope.lookupValue(e.name) ?? scope.lookupType(e.name);
				if (!b) {
					this.error(e, PASCAL.test(e.name) ? `unknown type \`${e.name}\`${foreignHint(e.name)}` : unknownName(e.name));
					return [];
				}
				e.ref = b;
				this.use(b, e);
				return [];
			}
			case 'Str':
				if (e.tag && !STRING_TAGS.has(e.tag)) this.error(e, `unknown string tag \`${e.tag}\`: the tags are ${[...STRING_TAGS].map((t) => `\`${t}\``).join(', ')}, and \`r\` for raw`);
				// No HTML at all has one spelling, which says so.
				if (e.tag === 'html' && !e.secret && e.parts.every((x: unknown) => x === '')) this.error(e, 'an empty `html""` is written `Html.EMPTY`');
				for (const part of e.parts) if (typeof part !== 'string') this.expr(part, scope);
				return [];
			case 'Member': {
				const at = { line: e.nameLine, col: e.nameCol } as Node;
				if (e.object.kind === 'Name') {
					const b = scope.lookupValue(e.object.name);
					e.object.ref = b ?? scope.lookupType(e.object.name) ?? undefined;
					if (b && b.kind === 'import' && !b.decl) {
						this.use(b, e);
						if (b.module) this.moduleMember(at, b.module, e.name);
						return [];
					}
					const t = b ? null : scope.lookupType(e.object.name);
					if (t) {
						this.use(t, e.object);
						const decl = this.typeDeclFor(t);
						if (decl) this.staticMember(at, decl, e.name);
						return [];
					}
				}
				if (e.object.kind === 'Member' && e.object.object.kind === 'Name') {
					// `module.Type.member`
					const b = scope.lookupValue(e.object.object.name);
					if (b && b.kind === 'import' && !b.decl) e.object.object.ref = b;
					if (b && b.kind === 'import' && !b.decl && b.module) {
						this.use(b, e);
						const decl = this.moduleMember({ line: e.object.nameLine, col: e.object.nameCol } as Node, b.module, e.object.name);
						if (decl && decl.kind === 'type') this.staticMember(at, decl, e.name);
						return [];
					}
				}
				this.expr(e.object, scope);
				return [];
			}
			case 'Call':
				this.expr(e.callee, scope);
				for (const t of e.typeArgs) this.type(t, scope);
				for (const a of e.args) {
					if (a.punned) this.lookupValue(a, a.name, scope);
					else this.expr(a.value, scope);
				}
				return [];
			case 'TypeApply':
				this.expr(e.callee, scope);
				for (const t of e.typeArgs) this.type(t, scope);
				return [];
			case 'Index':
				this.expr(e.object, scope);
				this.expr(e.index, scope);
				return [];
			case 'RecordLit':
				this.expr(e.type, scope);
				for (const t of e.typeArgs) this.type(t, scope);
				this.fieldInits(e.fields, scope);
				return [];
			case 'With':
				this.expr(e.value, scope);
				this.fieldInits(e.fields, scope);
				return [];
			case 'ListLit':
			case 'Tuple':
				for (const i of e.items) this.expr(i, scope);
				return [];
			case 'MapLit':
				for (const entry of e.entries) {
					this.expr(entry.key, scope);
					this.expr(entry.value, scope);
				}
				return [];
			case 'Paren':
				return this.expr(e.value, scope);
			case 'Closure': {
				this.voidArrow(e);
				const inner = new Scope(scope);
				for (const p of e.params) {
					if (p.type) this.type(p.type, scope);
					if (p.name !== '_') this.caseRule({ line: p.nameLine, col: p.nameCol }, p.name, 'camel', 'parameter');
					this.declareLocal(inner, p.name, { line: p.nameLine, col: p.nameCol }, 'param');
				}
				if (e.ret) this.type(e.ret, scope);
				if (e.err) this.type(e.err, scope);
				const captured = new Set<Binding>();
				for (const u of e.uses) {
					this.lookupValue(u, u.name, scope);
					const b: Binding | undefined = u.ref;
					if (b?.declaredWith && b.declaredWith !== 'var') this.error(u, `\`${u.name}\` is declared with \`${b.declaredWith}\`, so there's nothing to change: \`use (mut …)\` is for a \`var\``);
					if (b) {
						captured.add(b);
						b.mutCaptured = true;
					}
				}
				const savedLabels = this.labels;
				this.labels = [];
				this.closures.push(captured);
				this.body(e.body, inner);
				this.closures.pop();
				this.labels = savedLabels;
				return [];
			}
			case 'Match': {
				this.expr(e.subject, scope);
				for (const arm of e.arms) {
					const inner = new Scope(scope);
					this.bindPattern(arm.pattern, inner);
					if (arm.guard) this.declareAll(inner, this.expr(arm.guard, inner));
					this.body(arm.body, inner);
				}
				return [];
			}
			case 'New': {
				this.type(e.type, scope);
				if (e.args) {
					for (const a of e.args) {
						if (a.punned) this.lookupValue(a, a.name, scope);
						else this.expr(a.value, scope);
					}
					return [];
				}
				const saved = this.thisAvailable;
				this.members(e.members, scope, 'new');
				this.thisAvailable = saved;
				// A one-off implementation follows the same rules as a declared one.
				this.implementations({ ...e, name: `new ${(e.type.path ?? []).join('.')}`, implements: [e.type] }, scope);
				return [];
			}
			case 'Is': {
				this.expr(e.value, scope);
				const bindings = this.patternBindings(e.pattern, scope);
				// The names are declared only where the test guards code, but they can't shadow anywhere.
				for (const b of bindings) {
					const existing = scope.lookupValue(b.name);
					if (existing && (existing.kind === 'local' || existing.kind === 'param')) {
						this.error(b, `\`${b.name}\` is already declared on line ${existing.line}; locals and parameters can't shadow each other`);
					}
					b.shadowChecked = true;
				}
				return e.negated ? [] : bindings;
			}
			case 'Binary': {
				const left = this.expr(e.left, scope);
				if (e.op === 'and' && left.length > 0) {
					const inner = new Scope(scope);
					this.declareAll(inner, left);
					return [...left, ...this.expr(e.right, inner)];
				}
				this.expr(e.right, scope);
				return [];
			}
			case 'Ternary': {
				const bindings = this.expr(e.cond, scope);
				const inner = new Scope(scope);
				this.declareAll(inner, bindings);
				this.expr(e.then, inner);
				this.expr(e.otherwise, scope);
				return [];
			}
			case 'Else': {
				this.expr(e.value, scope);
				const inner = new Scope(scope);
				if (e.binding && e.binding !== '_') {
					this.caseRule({ line: e.bindingLine, col: e.bindingCol }, e.binding, 'camel', 'variable');
					this.declareLocal(inner, e.binding, { line: e.bindingLine, col: e.bindingCol }, 'local');
				}
				this.block(e.handler, inner, true);
				return [];
			}
			case 'Coalesce':
				this.expr(e.left, scope);
				// A block that only leaves says no more than `?? return …` or `?? fail …`.
				if (e.right.kind === 'Block' && e.right.body.length === 1 && (e.right.body[0].kind === 'Return' || e.right.body[0].kind === 'Fail')) {
					const word = e.right.body[0].kind === 'Return' ? 'return' : 'fail';
					this.warning(e.right, `a block that only leaves can be written on the line: \`${e.op} ${word} …\``);
				}
				if (e.right.kind === 'Block') this.block(e.right, scope);
				else this.expr(e.right, scope);
				return [];
			case 'Pipe':
				this.expr(e.left, scope);
				this.expr(e.right, scope);
				return [];
			case 'Range':
				this.expr(e.left, scope);
				this.expr(e.right, scope);
				return [];
			case 'Try':
			case 'Start':
			case 'Not':
			case 'Unary':
			case 'FailExpr':
			case 'ReturnExpr':
				if (e.value) this.expr(e.value, scope);
				return [];
		}
		return [];
	}

	fieldInits(fields: Node[], scope: Scope) {
		for (const f of fields) {
			if (f.punned) this.lookupValue(f, f.name, scope);
			else this.expr(f.value, scope);
		}
	}

	// ---- naming case ------------------------------------------------------------------

	caseRule(at: { line: number; col: number }, name: string, rule: 'pascal' | 'camel' | 'upper', what: string) {
		let ok: boolean;
		let expected: string;
		// The unsigned integer types keep their usual spelling: `U` is a word, not an acronym.
		const unsigned = /^(to)?UInt(8|16|32)?$/.test(name);
		if (rule === 'pascal') {
			ok = PASCAL.test(name) && (!/[A-Z]{2}/.test(name) || unsigned);
			expected = 'PascalCase, with acronyms written as words (`HttpClient`)';
		} else if (rule === 'camel') {
			ok = CAMEL.test(name) && (!/[A-Z]{2}/.test(name) || unsigned);
			expected = 'camelCase, with acronyms written as words (`userId`)';
		} else {
			ok = UPPER_SNAKE.test(name);
			expected = 'UPPER_SNAKE_CASE';
		}
		if (!ok) this.error(at, `the ${what} \`${name}\` must be ${expected}`);
	}
}

// ---- line width ------------------------------------------------------------------------

/**
 * Lines should fit in 120 columns and must fit in 150, counting a tab as four. Editors show
 * tabs at different widths, so the limits are measured one way for everyone.
 */
function checkWidth(file: SourceFile, out: Diagnostic[]) {
	const lines = file.src.split('\n');
	let kinds: ((offset: number, line: number) => 'comment' | 'string' | null) | null = null;
	let start = 0;
	lines.forEach((line, i) => {
		const width = line.replace(/\t/g, '    ').length;
		const lineStart = start;
		start += line.length + 1;
		if (width <= 120) return;
		kinds ??= whatIsAt(file.src);
		// What sits at the 121st column says what to do: `fmt` breaks code, but never rewraps
		// a comment or splits a string.
		let col = 0;
		let at = 0;
		while (at < line.length && col < 120) col += line[at++] === '\t' ? 4 : 1;
		const what = kinds(lineStart + at, i + 1);
		const fix = what === 'comment'
			? '. `fmt` never rewraps a comment, so break it onto more lines yourself'
			: what === 'string'
			? '. `fmt` never splits a string: give the text a line of its own, in a `let` or a constant, or write it as a `"""` string over several lines where line breaks don\'t matter, as in HTML'
			: '';
		if (width > 150) out.push({ path: file.path, line: i + 1, col: 151, severity: 'error', message: `this line is ${width} columns wide, over the limit of 150 (a tab counts as four): break it up${fix}` });
		else out.push({ path: file.path, line: i + 1, col: 121, severity: 'warning', message: `this line is ${width} columns wide; lines should fit in 120 (a tab counts as four)${fix}` });
	});
}

/** Whether a source offset falls in a comment or a string literal, or `null` for code. */
function whatIsAt(src: string): (offset: number, line: number) => 'comment' | 'string' | null {
	let lexed: ReturnType<typeof lex>;
	try {
		lexed = lex(src);
	} catch {
		return () => null;
	}
	const docLines = new Set(lexed.docs.map((d) => d.line));
	return (offset, line) => {
		if (docLines.has(line) || lexed.comments.some((c) => c.start <= offset && offset < c.end)) return 'comment';
		if (lexed.tokens.some((t) => t.kind === 'string' && t.start !== undefined && t.end !== undefined && t.start <= offset && offset < t.end)) return 'string';
		return null;
	};
}

// ---- doc-comment examples ---------------------------------------------------------------

interface CodeLine {
	line: number;
	col: number;
	text: string;
}

/** The code blocks in a file's `///` comments: fenced (plain or `nib`) or indented. */
function docExamples(file: SourceFile): CodeLine[][] {
	const groups: DocLine[][] = [];
	for (const d of file.docs) {
		const last = groups[groups.length - 1];
		if (last && last[last.length - 1].line === d.line - 1) last.push(d);
		else groups.push([d]);
	}
	const examples: CodeLine[][] = [];
	for (const group of groups) {
		const lines = group.map((d) => ({ line: d.line, col: d.col, text: d.text.startsWith(' ') ? d.text.slice(1) : d.text }));
		let k = 0;
		while (k < lines.length) {
			const fence = lines[k].text.match(/^```\s*(\w*)\s*$/);
			if (fence) {
				const start = k + 1;
				let end = start;
				while (end < lines.length && !/^```\s*$/.test(lines[end].text)) end++;
				if (fence[1] === '' || fence[1] === 'nib') examples.push(lines.slice(start, end));
				k = end + 1;
				continue;
			}
			const indented = (t: string) => t.startsWith('    ') || t.startsWith('\t');
			const previousBlank = k === 0 || lines[k - 1].text.trim() === '';
			if (indented(lines[k].text) && previousBlank) {
				let end = k;
				while (end < lines.length && (indented(lines[end].text) || lines[end].text.trim() === '')) end++;
				examples.push(lines.slice(k, end).map((l) => ({ ...l, text: l.text.replace(/^( {4}|\t)/, '') })));
				k = end;
				continue;
			}
			k++;
		}
	}
	return examples.filter((e) => e.length > 0);
}

const EXAMPLE_DECLARATION = /^(import|pub|private|fn|record|class|interface|enum|type|alias|const|attribute|@)\b|^@/;
const IMPORT_LINE = /^import [^\n{]*(\{[^}]*\})?[^\n]*/gm;

/**
 * Code in `///` comments illustrates and isn't run, but it's checked as far as it can be.
 * Each example is a file of its own in its file's module, with that file's imports: one of
 * declarations as it is, and one of statements inside a function that may return or fail
 * with anything. A name or type it uses without declaring, such as `db`, is one the reader is
 * assumed to have, so it's unknown rather than an error, and only errors are reported.
 */
function checkDocExamples(files: SourceFile[], modules: Map<string, Module>, manifest: Manifest | null, program: Program, out: Diagnostic[]) {
	// The stdlib's types by name, for those declared in only one module: an example may use
	// one without importing it, as a reader would look it up.
	const homes = new Map<string, string[]>();
	for (const [name, m] of new Map([...(program.std ?? []), ...modules])) {
		if (!name.startsWith('std.')) continue;
		for (const [n, decls] of m.decls) {
			for (const kind of ['type', 'attribute'] as const) {
				const key = kind === 'attribute' ? `@${n}` : n;
				if (decls.some((d) => d.kind === kind && !d.private)) homes.set(key, [...(homes.get(key) ?? []), name]);
			}
		}
	}
	for (const file of files) {
		const imports = file.src.match(IMPORT_LINE) ?? [];
		const imported = new Set(imports.flatMap((i) => i.match(/@?\b[A-Za-z]\w*/g) ?? []));
		for (const code of docExamples(file)) {
			const first = code.find((c) => c.text.trim() !== '' && !c.text.trim().startsWith('//'));
			if (!first) continue;
			const declarations = EXAMPLE_DECLARATION.test(first.text.trim());
			const body = code.map((c) => c.text);
			const ownImports = body.filter((l) => l.startsWith('import '));
			const text = body.filter((l) => !l.startsWith('import ')).join('\n');
			const declared = new Set([...text.matchAll(/\b(?:record|class|enum|interface|type|alias|attribute) ([A-Z]\w*)/g)].map((m) => m[1]));
			const used = new Set([...(text.match(/\b[A-Z][a-z]\w*/g) ?? []), ...(text.match(/@[a-z]\w*/g) ?? [])].filter((n) => !declared.has(n)));
			const found = [...used].filter((n) => !imported.has(n) && !ownImports.some((l) => l.includes(n)) && !file.module.decls.has(n.replace('@', '')) && homes.get(n)?.length === 1 && homes.get(n)![0] !== file.module.name && !program.prelude(n.replace('@', '')));
			const header = [...imports.join('\n').split('\n').filter((l) => l !== ''), ...found.map((n) => `import ${homes.get(n)![0]}.{${n}}`)];
			const lines = declarations ? [...header.filter((l) => !ownImports.includes(l)), ...body] : [...header, 'fn example() {', ...body, '}'];
			const offset = lines.length - body.length - (declarations ? 0 : 1);
			const report = (d: { line: number; col: number; message: string }) => {
				const at = code[Math.min(Math.max(d.line - offset - 1, 0), code.length - 1)];
				out.push({ path: file.path, line: at.line, col: at.col, severity: 'error', message: `in a doc-comment example: ${d.message}` });
			};
			const path = `${file.path}#${first.line}`;
			const parsed = parse(lines.join('\n'), { testFile: false, declarationFile: false });
			const errors = parsed.errors.filter((e) => e.line > offset);
			if (errors.length > 0) {
				for (const e of errors) report(e);
				continue;
			}
			if (parsed.errors.length > 0) continue;
			if (!declarations) {
				const fn = parsed.decls[parsed.decls.length - 1];
				if (fn?.kind === 'Fn') fn.example = true;
			}
			// A copy of the module, so the example sees its declarations and the module never
			// sees the example's.
			const module: Module = { ...file.module, files: [], decls: new Map([...file.module.decls].map(([k, v]) => [k, [...v]])) };
			const example: SourceFile = { path, src: lines.join('\n'), testFile: false, decls: parsed.decls, docs: [], module, example: true };
			module.files.push(example);
			program.files.set(path, example);
			const problems: Diagnostic[] = [];
			indexModule(module, problems);
			const checker = new FileChecker(example, modules, manifest, problems);
			checker.run();
			new TypeChecker(program, example, problems, checker.locals).run();
			for (const d of problems) {
				if (d.path !== path || d.severity !== 'error' || d.line <= offset) continue;
				if (/^unknown (name|type) /.test(d.message)) continue;
				report(d);
			}
		}
	}
}

const UNSET = 0;
const SET = 1;
const MAYBE = 2;
const EXITS = 3;
type Flow = typeof UNSET | typeof SET | typeof MAYBE | typeof EXITS;

/**
 * A `let` declared with a type and no value is set exactly once on every path before it's
 * read. This walks the statements after it, tracking whether it's set, not set, or set on only
 * some paths. A loop could set it more than once, so a loop can't set it at all.
 */
class SetOnce {
	reported = false;
	everSet = false;

	name: string;
	binding: Binding;
	report: (at: Node, message: string) => void;

	constructor(name: string, binding: Binding, report: (at: Node, message: string) => void) {
		this.name = name;
		this.binding = binding;
		this.report = report;
	}

	check(decl: Node, rest: Node[]) {
		this.statements(rest, UNSET);
		if (!this.everSet && !this.reported) this.report(decl.pattern, `\`${this.name}\` is declared without a value, and nothing sets it`);
	}

	say(what: 'set' | 'maybeSet' | 'loop' | 'inner' | 'unset' | 'maybeUnset'): string {
		const n = `\`${this.name}\``;
		switch (what) {
			case 'set': return `${n} is a \`let\`, and it's already set here`;
			case 'maybeSet': return `${n} is a \`let\`, and it may already be set here`;
			case 'loop': return `${n} is a \`let\`, so it can't be set in a loop, which could set it more than once`;
			case 'inner': return `${n} is set once, in the code around it, so it can't be set in here`;
			case 'unset': return `${n} is read before it's set`;
			case 'maybeUnset': return `${n} is set on only some paths before this, so it may not be set yet`;
		}
	}

	/** A node that hands on what's being set before it's set; `true` skips its children. */
	escapes(_n: Node, _state: Flow): boolean {
		return false;
	}

	error(at: Node, message: string) {
		if (this.reported) return;
		this.reported = true;
		this.report(at, message);
	}

	statements(list: Node[], state: Flow): Flow {
		for (const s of list) {
			state = this.statement(s, state);
			if (state === EXITS) return EXITS;
		}
		return state;
	}

	merge(a: Flow, b: Flow): Flow {
		if (a === EXITS) return b;
		if (b === EXITS) return a;
		return a === b ? a : MAYBE;
	}

	isTarget(e: Node): boolean {
		return e.kind === 'Name' && e.ref === this.binding;
	}

	statement(s: Node, state: Flow): Flow {
		switch (s.kind) {
			case 'Assign':
				if (!this.isTarget(s.target)) {
					this.reads(s.target, state);
					this.reads(s.value, state);
					return state;
				}
				this.reads(s.value, state);
				if (s.op !== '=') this.reads(s.target, state);
				else if (state === SET) this.error(s.target, this.say('set'));
				else if (state === MAYBE) this.error(s.target, this.say('maybeSet'));
				this.everSet = true;
				return SET;
			case 'Return':
			case 'Fail':
				if (s.value) this.reads(s.value, state);
				return EXITS;
			case 'Break':
			case 'Continue':
				return EXITS;
			case 'If': {
				this.reads(s.cond, state);
				const then = this.statements(s.then.body, state);
				const otherwise = !s.otherwise ? state : s.otherwise.kind === 'If' ? this.statement(s.otherwise, state) : this.statements(s.otherwise.body, state);
				return this.merge(then, otherwise);
			}
			case 'ExprStmt':
				if (s.value.kind === 'Match') return this.match(s.value, state);
				this.reads(s.value, state);
				return s.value.kind === 'ReturnExpr' || s.value.kind === 'FailExpr' ? EXITS : state;
			case 'For':
			case 'While':
			case 'DoWhile':
				this.reads(s.iterable ?? s.cond, state);
				this.inLoop(s.body, state);
				return state;
			default:
				this.reads(s, state);
				return state;
		}
	}

	match(m: Node, state: Flow): Flow {
		this.reads(m.subject, state);
		let out: Flow = EXITS;
		for (const arm of m.arms as Node[]) {
			if (arm.guard) this.reads(arm.guard, state);
			const body: Node = arm.body;
			const after = body.kind === 'Block' ? this.statements(body.body, state) : this.statement(body.kind === 'Assign' || body.kind === 'IncDec' ? body : ({ kind: 'ExprStmt', value: body } as Node), state);
			out = this.merge(out, after);
		}
		return out;
	}

	/** A loop body may run many times, so it reads the `let` only once it's set, and can't set it. */
	inLoop(body: Node, state: Flow) {
		this.walk(body, (n) => {
			if (n.kind === 'Assign' && this.isTarget(n.target)) {
				this.error(n.target, this.say('loop'));
				return true;
			}
			return false;
		});
		this.reads(body, state);
	}

	reads(e: Node | null, state: Flow) {
		if (!e) return;
		this.walk(e, (n) => {
			if (n.kind === 'Assign' && this.isTarget(n.target)) {
				this.error(n.target, this.say('inner'));
				return true;
			}
			if (this.isTarget(n) && state !== SET) {
				this.error(n, this.say(state === UNSET ? 'unset' : 'maybeUnset'));
			}
			return this.escapes(n, state);
		});
	}

	/** Calls `visit` on each node under `e`; a `true` result skips that node's children. */
	walk(e: Node, visit: (n: Node) => boolean) {
		if (visit(e)) return;
		for (const [key, value] of Object.entries(e)) {
			if (key === 'ref' || key === 'ty' || key === 'chosen' || key === 'decl' || key === 'type') continue;
			for (const child of Array.isArray(value) ? value : [value]) {
				if (child && typeof child === 'object' && typeof child.kind === 'string' && typeof child.line === 'number') this.walk(child, visit);
			}
		}
	}
}

/**
 * A field the constructor sets: once on every path through its body, before anything reads
 * it, and before `this` is handed on or its methods are called, since they may read it.
 */
class FieldSetOnce extends SetOnce {
	fields: Set<string>;

	constructor(name: string, fields: Set<string>, report: (at: Node, message: string) => void) {
		super(name, {} as Binding, report);
		this.fields = fields;
	}

	override isTarget(e: Node): boolean {
		return e.kind === 'Member' && e.object.kind === 'This' && e.name === this.name;
	}

	run(field: Node, body: Node[]) {
		const end = this.statements(body, UNSET);
		if (this.reported) return;
		if (!this.everSet) this.report(field, `the constructor never sets \`${this.name}\`: set it in the constructor's body, give it a default, or declare it with a parameter marked \`private\`, \`pub\` or \`var\``);
		else if (end === MAYBE) this.report(field, `the constructor sets \`${this.name}\` on only some paths: set it on every one`);
	}

	override say(what: 'set' | 'maybeSet' | 'loop' | 'inner' | 'unset' | 'maybeUnset'): string {
		const n = `\`this.${this.name}\``;
		switch (what) {
			case 'set': return `${n} is already set here, and it isn't a \`var\`, so the constructor sets it once`;
			case 'maybeSet': return `${n} may already be set here, and it isn't a \`var\`, so the constructor sets it once`;
			case 'loop': return `${n} can't be set in a loop, which could set it more than once`;
			case 'inner': return `${n} is set by the constructor's own statements, so it can't be set in here`;
			case 'unset': return `${n} is read before the constructor sets it`;
			case 'maybeUnset': return `${n} is set on only some paths before this, so it may not be set yet`;
		}
	}

	override escapes(n: Node, state: Flow): boolean {
		if (state === SET) return false;
		// `this.otherField` is fine; `this` on its own, or a method or getter, could read this field.
		if (n.kind === 'Member' && n.object.kind === 'This') {
			if (this.fields.has(n.name)) return true;
			this.error(n, `\`this.${n.name}\` is used before the constructor sets \`${this.name}\`, which it could read: set every field first`);
			return true;
		}
		if (n.kind === 'This') this.error(n, `\`this\` is handed on before the constructor sets \`${this.name}\`: set every field first`);
		return false;
	}
}
