// Checks the code in Markdown files, such as the language guide, so that published examples
// are valid. Only fenced blocks marked `nib` are read:
//
// - A block of declarations (it starts with `import`, `fn`, `record`, an attribute and so on)
//   is checked in full, types included. Every such block in one Markdown file belongs to one
//   module, so a type declared in an early block can be used in a later one.
// - A block marked `nib standalone` is checked in full in a module of its own, for an
//   example that repeats a name another block declares, such as a second `main`.
// - A block of statements is parsed, since its names come from the prose around it.
// - A block marked `nib error` shows code that's rejected. It's checked with a copy of its
//   file's other declaration blocks, and it must produce at least one error of its own; its
//   errors aren't reported. Set NIB_SHOW_REJECTED=1 to print them, to see that each block
//   is rejected for the reason its text gives.
// - A `toml` block that declares configuration or resources (`[config]`, `[databases.main]`
//   and so on) is the manifest's host section for every block, so `env.secret("…")` and the
//   rest are checked against it. Only the fullest such block counts, the chapter that lists
//   a manifest's sections; a shorter one elsewhere shows a part of it.
// - A file that says `<!-- quotes: path -->` shows a source file a piece at a time. Its
//   declaration blocks are checked together, as that one file, and must be its code,
//   comments and blank lines aside, so the two can't drift apart.

import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { checkSources, type Diagnostic, type Manifest } from './check.ts';
import { readHostNeeds } from './host.ts';
import { parseSnippet } from './parser.ts';

interface Block {
	md: string;
	/** The line of the first line of code, 1-based. */
	line: number;
	code: string;
	error: boolean;
	standalone: boolean;
}

// Where the blocks are placed as a package of their own, which nothing reads from disk.
const ROOT = '/nib-markdown';
const DECLARATION = /^(import|pub|private|fn|record|class|interface|enum|type|alias|const|test|attribute|@)\b|^@/;

export function checkMarkdown(paths: string[]): Diagnostic[] {
	const out: Diagnostic[] = [];
	const sources: { path: string; src: string; copy?: boolean }[] = [];
	const origin = new Map<string, Block>();
	// A quoting file's blocks, checked as one source: where each starts in it.
	const joined = new Map<string, { block: Block; from: number }[]>();
	const errorExamples: { block: Block; path: string }[] = [];

	paths.forEach((md, i) => {
		const module = `doc${i}`;
		const all = blocks(md);
		const shared = all.filter((b) => !b.error && !b.standalone && isDeclarations(b.code));
		const quoted = quoteProblem(md, shared);
		if (quoted) out.push(quoted);
		const quotes = quoted !== null || /<!--\s*quotes:/.test(readFileSync(md, 'utf8'));
		if (quotes) {
			const path = join(ROOT, 'src', module, 'quoted.nibl');
			const parts: { block: Block; from: number }[] = [];
			let from = 1;
			for (const b of shared) {
				parts.push({ block: b, from });
				from += b.code.split('\n').length;
			}
			sources.push({ path, src: shared.map((b) => b.code).join('\n') });
			joined.set(path, parts);
		}
		for (const block of all) {
			if (quotes && shared.includes(block)) continue;
			if (!isDeclarations(block.code)) {
				if (block.error) {
					if (parseSnippet(block.code).length === 0) out.push(at(block, 1, 'this example is marked `nib error`, but it parses, and only declarations are checked further: write it as declarations'));
					continue;
				}
				for (const e of parseSnippet(block.code)) out.push(at(block, e.line, `in a code example: ${e.message}`, e.col));
				continue;
			}
			const file = (b: Block) => `line${b.line}${/^\s*test\s+"/m.test(b.code) ? '.test' : ''}.nibl`;
			// An error example gets a module of its own, with copies of the file's other
			// declarations, so its mistakes can't reach them.
			const dir = block.error || block.standalone ? `${module}x${block.line}` : module;
			const path = join(ROOT, 'src', dir, file(block));
			sources.push({ path, src: block.code });
			origin.set(path, block);
			if (block.error) {
				errorExamples.push({ block, path });
				for (const b of shared) sources.push({ path: join(ROOT, 'src', dir, file(b)), src: b.code, copy: true });
			}
		}
	});
	if (sources.length === 0) return out;

	const hostBlock = paths.flatMap((md) => blocks(md, 'toml')).filter((b) => HOST_SECTION.test(b.code))
		.sort((a, b) => b.code.split('\n').length - a.code.split('\n').length)[0];
	const host = hostBlock ? readHostNeeds(join(ROOT, 'nib.toml'), hostBlock.code, false) : null;
	if (hostBlock) origin.set(join(ROOT, 'nib.toml'), hostBlock);
	const manifest: Manifest = { dir: ROOT, root: 'guide', dependencies: new Set(), testModules: new Set(), packages: new Map(), host };
	const diagnostics = checkSources(sources, manifest);
	const failed = new Set(diagnostics.filter((d) => d.severity === 'error').map((d) => d.path));
	for (const d of diagnostics) {
		const parts = joined.get(d.path);
		if (parts) {
			const part = [...parts].reverse().find((p) => p.from <= d.line) ?? parts[0];
			out.push({ ...at(part.block, d.line - part.from + 1, d.message, d.col), severity: d.severity });
			continue;
		}
		const block = origin.get(d.path);
		if (!block) continue;
		if (block.error) {
			if (process.env.NIB_SHOW_REJECTED) console.error(`${block.md}:${block.line + d.line - 1}: rejected: ${d.message}`);
			continue;
		}
		out.push({ ...at(block, d.line, d.message, d.col), severity: d.severity });
	}
	for (const { block, path } of errorExamples) {
		if (!failed.has(path)) out.push(at(block, 1, 'this example is marked `nib error`, but it checks without errors'));
	}
	return out;
}

/** Where a file's quoted code differs from the source file it says it quotes. */
function quoteProblem(md: string, shared: Block[]): Diagnostic | null {
	const text = readFileSync(md, 'utf8');
	const marker = text.match(/<!--\s*quotes:\s*(\S+)\s*-->/);
	if (!marker) return null;
	const line = text.slice(0, marker.index).split('\n').length;
	const source = join(dirname(md), marker[1]);
	if (!existsSync(source)) return { path: md, line, col: 1, severity: 'error', message: `this file quotes \`${marker[1]}\`, which doesn't exist` };
	const code = (s: string) => s.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() !== '' && !l.trim().startsWith('//'));
	const want = code(readFileSync(source, 'utf8'));
	const got = code(shared.map((b) => b.code).join('\n'));
	const i = want.findIndex((l, k) => l !== got[k]);
	if (i === -1 && got.length === want.length) return null;
	const where = i === -1 ? want.length : i;
	return { path: md, line, col: 1, severity: 'error', message: `this file's code no longer matches \`${marker[1]}\`, from \`${(want[where] ?? got[where] ?? '').trim()}\`: copy the change across` };
}

function at(block: Block, line: number, message: string, col = 1): Diagnostic {
	return { path: block.md, line: block.line + line - 1, col, severity: 'error', message };
}

const HOST_SECTION = /^\[(config|databases|queues|caches|rate-limiters|directories|files)[\].]/m;

function blocks(md: string, language = 'nib'): Block[] {
	const lines = readFileSync(md, 'utf8').split('\n');
	const found: Block[] = [];
	for (let i = 0; i < lines.length; i++) {
		// A fence may be indented, inside a list item; its code is indented as much.
		const fence = lines[i].match(new RegExp(`^(\\s*)\`\`\`\\s*${language}(?:\\s+(error|standalone))?\\s*$`));
		if (!fence) {
			// Skip other fenced blocks whole, so their contents are never read as fences.
			if (/^\s*```/.test(lines[i])) while (++i < lines.length && !/^\s*```\s*$/.test(lines[i]));
			continue;
		}
		const indent = fence[1];
		const start = i + 1;
		let end = start;
		while (end < lines.length && !/^\s*```\s*$/.test(lines[end])) end++;
		const code = lines.slice(start, end).map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l.trimStart()));
		found.push({ md, line: start + 1, code: code.join('\n'), error: fence[2] === 'error', standalone: fence[2] === 'standalone' });
		i = end;
	}
	return found;
}

/** Whether a block holds declarations (a file), rather than statements. */
function isDeclarations(code: string): boolean {
	const first = code.split('\n').find((l) => l.trim() !== '' && !l.trim().startsWith('//'));
	return first !== undefined && DECLARATION.test(first.trim());
}

/** Markdown files are checked when named, or when they're in a directory called `guide`. */
export function isCheckedMarkdown(path: string, named: boolean): boolean {
	return path.endsWith('.md') && (named || path.split(/[\\/]/).includes('guide')) && basename(path) !== 'FINDINGS.md';
}
