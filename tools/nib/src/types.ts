// The type stage. It runs after the name pass, reusing the bindings that pass resolved, and
// works out the type of each expression. With types it checks instance members
// (`value.name`), record literals and `with`, and the arguments of calls: their number and
// labels, against overloads told apart by arity and labels.
//
// Anything it can't type is `unknown`, which fits everywhere and reports nothing. A gap here
// means a check that doesn't happen, never an error in valid code; and one wrong name
// becomes one error, not a cascade.

import { basename, resolve } from 'node:path';
import { RESOURCE_NOUN, type HostNeeds, type ResourceKind } from './host.ts';
import type { Node } from './parser.ts';
import { isStaticMember, suggest, type Binding, type Decl, type Diagnostic, type Module, type SourceFile } from './check.ts';

export type Type =
	| { k: 'unknown' }
	| { k: 'named'; decl: Decl; args: Type[] }
	| { k: 'param'; name: string }
	| { k: 'nullable'; inner: Type }
	| { k: 'fn'; params: Type[]; ret: Type }
	| { k: 'tuple'; items: Type[] }
	| { k: 'null' }
	/** An imported module used as a value, as in `mail.send`; null for a dependency's. */
	| { k: 'module'; module: Module | null }
	/** A type used as a value, as in `Money.of` or `Money { … }`. */
	| { k: 'static'; decl: Decl; args: Type[] };

const UNKNOWN: Type = { k: 'unknown' };

/** Where a type written in a declaration is resolved: its file, and what its type parameters stand for. */
interface Ctx {
	file: SourceFile | null;
	params: Map<string, Type>;
	self: Type | null;
}

interface Member {
	node: Node;
	owner: Decl;
	ctx: Ctx;
}

interface MemberSet {
	members: Map<string, Member[]>;
	/** False when an interface or attribute couldn't be found, so a missing name proves nothing. */
	complete: boolean;
}

/** What a hover shows and where go-to-definition goes, for one name in a file. */
export interface NameInfo {
	line: number;
	col: number;
	length: number;
	/** What a hover shows: `name: Type`, a function's signature, or a type's kind and name. */
	detail: string | null;
	def: { path: string; line: number; col: number } | null;
}

type Imported = { module: Module | null } | { decl: Decl | null } | { attribute: Decl | null };

/** The declarations that types are resolved against: the package's and the stdlib's. */
/** The `Env` methods that read a configuration variable. */
const CONFIG_READS = new Set(['string', 'int', 'url', 'secret']);

export class Program {
	modules: Map<string, Module>;
	std: Map<string, Module> | null;
	files = new Map<string, SourceFile>();
	imports = new Map<string, Map<string, Imported>>();
	memberCache = new Map<string, MemberSet>();
	/** What the package's manifest says it needs from its host; null outside a package. */
	host: HostNeeds | null;

	constructor(modules: Map<string, Module>, std: Map<string, Module> | null, host: HostNeeds | null = null) {
		this.modules = modules;
		this.std = std;
		this.host = host;
		for (const m of [...(std?.values() ?? []), ...modules.values()]) for (const f of m.files) this.files.set(f.path, f);
	}

	module(name: string): Module | null {
		return this.modules.get(name) ?? this.std?.get(name) ?? null;
	}

	fileOf(decl: Decl): SourceFile | null {
		return this.files.get(decl.file) ?? null;
	}

	moduleOf(decl: Decl): Module | null {
		return this.fileOf(decl)?.module ?? null;
	}

	private schemas = new Map<Decl, Type>();

	/**
	 * A `@form` record's `fields`: a value with a `FormField` for each of the record's fields,
	 * which the compiler writes. Its type is declared beside `FormField`, so it needs no import.
	 */
	formFields(form: Decl): Type | null {
		if (!((form.node.attrs ?? []) as Node[]).some((a) => a.name === 'form')) return null;
		const known = this.schemas.get(form);
		if (known) return known;
		const field = this.std?.get('std.forms')?.decls.get('FormField')?.find((d) => d.kind === 'type');
		if (!field) return null;
		const getters = ((form.node.members ?? []) as Node[]).filter((m) => m.kind === 'Field').map((f) => ({
			kind: 'Getter', name: f.name, type: { kind: 'NamedType', path: ['FormField'], args: [], line: f.line, col: f.col }, body: null, line: f.line, col: f.col,
		} as unknown as Node));
		const node = { kind: 'TypeDecl', typeKind: 'record', name: `${form.name}.fields`, members: getters, implements: [], attrs: [], typeParams: [], line: form.node.line, col: form.node.col } as unknown as Node;
		const t: Type = { k: 'named', decl: { ...field, name: `${form.name}.fields`, node }, args: [] };
		this.schemas.set(form, t);
		return t;
	}

	prelude(name: string): Decl | null {
		return this.std?.get('std')?.decls.get(name)?.find((d) => d.kind === 'type') ?? null;
	}

	preludeType(name: string, args: Type[] = []): Type {
		const decl = this.prelude(name);
		return decl ? { k: 'named', decl, args } : UNKNOWN;
	}

	stdType(module: string, name: string, args: Type[] = []): Type {
		const decl = this.std?.get(module)?.decls.get(name)?.find((d) => d.kind === 'type');
		return decl ? { k: 'named', decl, args } : UNKNOWN;
	}

	importsOf(file: SourceFile): Map<string, Imported> {
		const cached = this.imports.get(file.path);
		if (cached) return cached;
		const map = new Map<string, Imported>();
		for (const node of file.decls) {
			if (node.kind !== 'Import') continue;
			const target = this.module(node.path.join('.'));
			if (!node.names || node.withModule) {
				map.set(node.alias ?? node.path[node.path.length - 1], { module: target });
				if (!node.names) continue;
			}
			for (const item of node.names as Node[]) {
				const decls = (target?.decls.get(item.name) ?? []).filter((d) => !d.testFile || file.testFile);
				if (item.attribute) map.set(`@${item.name}`, { attribute: decls.find((d) => d.kind === 'attribute') ?? null });
				else map.set(item.name, { decl: decls.find((d) => d.kind === 'type') ?? decls[0] ?? null });
			}
		}
		this.imports.set(file.path, map);
		return map;
	}

	/** The type declaration a name means in a file: its own module's, an imported one, or the prelude's. */
	findType(name: string, file: SourceFile | null): Decl | null {
		if (!file) return this.prelude(name);
		const own = file.module.decls.get(name)?.find((d) => d.kind === 'type' && (file.testFile || !d.testFile));
		if (own) return own;
		const imported = this.importsOf(file).get(name);
		if (imported) return 'decl' in imported && imported.decl?.kind === 'type' ? imported.decl : null;
		return this.prelude(name);
	}

	findAttribute(name: string, file: SourceFile | null): Decl | null | undefined {
		const own = file?.module.decls.get(name)?.find((d) => d.kind === 'attribute');
		if (own) return own;
		const imported = file ? this.importsOf(file).get(`@${name}`) : undefined;
		if (imported && 'attribute' in imported) return imported.attribute;
		return this.std?.get('std')?.decls.get(name)?.find((d) => d.kind === 'attribute');
	}

	/** The type a written type means in a context. */
	resolve(t: Node | null, ctx: Ctx): Type {
		if (!t) return UNKNOWN;
		switch (t.kind) {
			case 'NullableType':
				return nullable(this.resolve(t.inner, ctx));
			case 'TupleType':
				return { k: 'tuple', items: t.items.map((i: Node) => this.resolve(i, ctx)) };
			case 'FnType': {
				const ret = t.ret ? this.resolve(t.ret, ctx) : this.preludeType('Void');
				return { k: 'fn', params: t.params.map((p: Node) => this.resolve(p, ctx)), ret: t.err ? this.fallible(ret, this.resolve(t.err, ctx)) : ret };
			}
			case 'NamedType': {
				const args = (t.args as Node[]).map((a) => this.resolve(a, ctx));
				const head: string = t.path[0];
				let decl: Decl | null = null;
				if (t.path.length === 1) {
					if (ctx.params.has(head)) return ctx.params.get(head)!;
					if (head === 'This') return ctx.self ?? UNKNOWN;
					decl = this.findType(head, ctx.file);
				} else if (t.path.length === 2 && ctx.file) {
					const imported = this.importsOf(ctx.file).get(head);
					if (imported && 'module' in imported) decl = imported.module?.decls.get(t.path[1])?.find((d) => d.kind === 'type') ?? null;
				}
				return decl ? this.instantiate(decl, args) : UNKNOWN;
			}
		}
		return UNKNOWN;
	}

	/**
	 * A declared type with arguments; an alias becomes what it stands for. A written type that
	 * leaves out trailing arguments gets their defaults (`Iterator<T>` is `Iterator<T, Never>`),
	 * and so does one with none, when every parameter has a default (`Secret` is `Secret<String>`).
	 */
	instantiate(decl: Decl, args: Type[]): Type {
		const params = (decl.node.typeParams ?? []) as Node[];
		const full: Type[] = [];
		const defaults = args.length > 0 || params.every((p) => p.defaultType);
		params.forEach((p, i) => {
			if (args[i]) full.push(args[i]);
			else if (defaults && p.defaultType) full.push(this.resolve(p.defaultType, { file: this.fileOf(decl), params: new Map(params.slice(0, i).map((q, j) => [q.name, full[j]])), self: null }));
			else full.push(UNKNOWN);
		});
		if (decl.node.typeKind === 'alias') {
			return this.resolve(decl.node.target, { file: this.fileOf(decl), params: new Map(params.map((p, i) => [p.name, full[i]])), self: null });
		}
		return { k: 'named', decl, args: full };
	}

	/** The result of a fallible call: a `Result`, unless the error type is `Never`. */
	fallible(value: Type, error: Type): Type {
		if (isNamed(error, 'Never')) return value;
		return this.preludeType('Result', [value, error]);
	}

	/** The context a member of `decl` is resolved in, as a member of `self`. */
	ctxFor(decl: Decl, args: Type[], self: Type | null): Ctx {
		const params = ((decl.node.typeParams ?? []) as Node[]).map((p, i): [string, Type] => [p.name, args[i] ?? UNKNOWN]);
		return { file: this.fileOf(decl), params: new Map(params), self };
	}

	/** Every member of a named type: its own, then its interfaces', then a distinct type's base's. */
	membersOf(t: Type & { k: 'named' }): MemberSet {
		const key = typeKey(t);
		const cached = this.memberCache.get(key);
		if (cached) return cached;
		const set: MemberSet = { members: new Map(), complete: true };
		this.memberCache.set(key, set);
		this.collect(t.decl, t.args, t, set, new Set());
		return set;
	}

	collect(decl: Decl, args: Type[], self: Type, set: MemberSet, seen: Set<string>) {
		const key = declKey(decl);
		if (seen.has(key)) return;
		seen.add(key);
		const ctx = this.ctxFor(decl, args, self);
		const own = new Map<string, Member[]>();
		for (const m of decl.node.members as Node[]) {
			if (!['Fn', 'Getter', 'Field', 'Const', 'Variant'].includes(m.kind)) continue;
			own.set(m.name, [...(own.get(m.name) ?? []), { node: m, owner: decl, ctx }]);
		}
		for (const [name, list] of own) if (!set.members.has(name)) set.members.set(name, list);

		const { interfaces, base, complete } = this.parents(decl, args, self);
		if (!complete) set.complete = false;
		for (const i of interfaces) {
			if (i.k === 'named') this.collect(i.decl, i.args, self, set, seen);
			else set.complete = false;
		}
		if (base?.k === 'named') this.collect(base.decl, base.args, base, set, seen);
	}

	/**
	 * What a type implements, written or not, and a distinct type's base. `complete` is false
	 * when an attribute or interface couldn't be found.
	 */
	parents(decl: Decl, args: Type[], self: Type): { interfaces: Type[]; base: Type | null; complete: boolean } {
		const ctx = this.ctxFor(decl, args, self);
		const node = decl.node;
		let complete = true;
		const interfaces: Type[] = (node.implements as Node[]).map((i) => this.resolve(i, ctx));
		// What a type implements without saying so. The prelude's own types say everything.
		// A secret has no equality (it would leak through timing), no text and no base to widen to.
		const secret = isSensitive(decl);
		if (!isPrelude(decl) && !secret && (node.typeKind === 'record' || node.typeKind === 'enum' || node.typeKind === 'type')) {
			interfaces.push(this.preludeType('Equatable'), this.preludeType('Hashable'));
		}
		if (node.typeKind === 'enum' && node.backing) interfaces.push(this.preludeType('BackedEnum', [this.resolve(node.backing, ctx)]));
		if (!secret && ((node.typeKind === 'enum' && node.backing) || node.typeKind === 'type')) interfaces.push(this.preludeType('Stringable'));
		for (const a of (node.attrs ?? []) as Node[]) {
			const attr = this.findAttribute(a.name, ctx.file);
			if (attr === undefined || attr === null) {
				complete = false;
				continue;
			}
			const attrCtx: Ctx = { file: this.fileOf(attr), params: new Map(), self };
			interfaces.push(...(attr.node.implements as Node[]).map((i) => this.resolve(i, attrCtx)));
		}
		if (interfaces.some((i) => i.k !== 'named')) complete = false;
		let base: Type | null = null;
		if (node.typeKind === 'type' && !secret) {
			base = this.resolve(node.base, ctx);
			if (base.k !== 'named') complete = false;
		}
		return { interfaces, base, complete };
	}

	/**
	 * Every type a named type converts to: the interfaces it implements, at any depth, and a
	 * distinct type's bases. A distinct type is a number only if it says so: `Numeric` doesn't
	 * come through the base of one that doesn't implement it, so an `OrderId` has no `+`.
	 */
	supertypes(t: Type & { k: 'named' }): { types: (Type & { k: 'named' })[]; complete: boolean } {
		const types: (Type & { k: 'named' })[] = [];
		const seen = new Set<string>([typeKey(t)]);
		let complete = true;
		const queue: { type: Type & { k: 'named' }; identity: boolean }[] = [{ type: t, identity: false }];
		while (queue.length > 0) {
			const { type: next, identity } = queue.shift()!;
			const { interfaces, base, complete: c } = this.parents(next.decl, next.args, next);
			if (!c) complete = false;
			for (const s of base ? [...interfaces, base] : interfaces) {
				if (s.k !== 'named' || seen.has(typeKey(s))) continue;
				if (identity && isNamed(s, 'Numeric')) continue;
				seen.add(typeKey(s));
				types.push(s);
				queue.push({ type: s, identity: identity || (s === base && !this.isNumber(next)) });
			}
		}
		return { types, complete };
	}

	/** Whether a distinct type is a number: whether it implements `Numeric` itself. */
	isNumber(t: Type & { k: 'named' }): boolean {
		const ctx = this.ctxFor(t.decl, t.args, t);
		return (t.decl.node.implements as Node[]).some((i) => isNamed(this.resolve(i, ctx), 'Numeric'));
	}

	/** A distinct type's base, through every level (`cents + 1` is an `Int`). */
	widen(t: Type): Type {
		for (let i = 0; i < 10 && t.k === 'named' && t.decl.node.typeKind === 'type' && !isSensitive(t.decl); i++) t = this.resolve(t.decl.node.base, this.ctxFor(t.decl, t.args, t));
		return t;
	}

	/**
	 * Whether a value of type `from` fits where `to` is expected. Anything unknown fits, and
	 * so does a type parameter, until its body is checked against its constraints.
	 */
	fits(from: Type, to: Type, depth = 0): boolean {
		if (depth > 20) return true;
		const d = depth + 1;
		if (from.k === 'unknown' || to.k === 'unknown' || from.k === 'param' || to.k === 'param') return true;
		if (isNamed(from, 'Never')) return true;
		// A `Result` whose error type isn't known yet may be a plain value (`E` may be `Never`).
		if (isNamed(from, 'Result') && from.k === 'named' && hasUnknown(from.args[1] ?? UNKNOWN) && !isNamed(to, 'Result')) return this.fits(from.args[0] ?? UNKNOWN, to, d);
		if (from.k === 'static' || from.k === 'module' || to.k === 'static' || to.k === 'module') return true;
		if (to.k === 'named' && to.decl.name === 'Loggable' && to.decl.file.endsWith('log.d.nibl')) return this.loggable(from, to, d);
		if (to.k === 'nullable') return from.k === 'null' || this.fits(nonNull(from), to.inner, d);
		if (from.k === 'null') return false;
		// `T?` is codable wherever `T` is: a codec writes `null` for a missing value.
		if (from.k === 'nullable') return isNamed(to, 'Codable') && this.fits(from.inner, to, d);
		if (from.k === 'tuple' && to.k === 'tuple') return from.items.length === to.items.length && from.items.every((x, i) => this.fits(x, to.items[i], d));
		if (from.k === 'fn' && to.k === 'fn') {
			return from.params.length === to.params.length && to.params.every((p, i) => this.fits(p, from.params[i], d)) && this.fitsReturn(from.ret, to.ret, d);
		}
		if (to.k !== 'named') return false;
		// A route's handler or guard is a function checked against its route's pattern, which needs more than types.
		if (from.k === 'fn' && isRouteMarker(to)) return true;
		if (from.k === 'tuple') return ['Equatable', 'Hashable'].includes(to.decl.name) && isPrelude(to.decl) && from.items.every((x) => this.fits(x, to, d));
		if (from.k !== 'named') return false;
		if (declKey(from.decl) === declKey(to.decl)) {
			// Generic types are invariant; a `Result`, which is only ever read, is covariant.
			return from.args.every((x, i) => (isNamed(from, 'Result') ? this.fits(x, to.args[i] ?? UNKNOWN, d) : sameType(x, to.args[i] ?? UNKNOWN)));
		}
		if (isNamed(to, 'Codable')) {
			if (this.codable(from, to, d)) return true;
			// A distinct type is codable through its base, or not at all.
			if (from.decl.node.typeKind === 'type') return false;
		}
		if ((isNamed(to, 'Equatable') || isNamed(to, 'Hashable')) && isPrelude(to.decl) && this.structural(from, to.decl.name)) return this.fieldsFit(from, to, d);
		const { types, complete } = this.supertypes(from);
		if (types.some((s) => declKey(s.decl) === declKey(to.decl) && s.args.every((x, i) => sameType(x, to.args[i] ?? UNKNOWN)))) return true;
		return !complete;
	}

	/** A function's result where another's is expected: a result that isn't used, or an error that may never happen, still fits. */
	fitsReturn(from: Type, to: Type, depth: number): boolean {
		if (isNamed(to, 'Void')) return true;
		if (isNamed(to, 'Result') && to.k === 'named') {
			if (!isNamed(from, 'Result') || from.k !== 'named') return this.fits(from, to.args[0], depth);
			// A function that can fail fits where one that fails with a wider error is wanted.
			return this.fits(from.args[0], to.args[0], depth) && this.fits(from.args[1], to.args[1], depth);
		}
		if (isNamed(from, 'Result') && from.k === 'named' && hasUnknown(from.args[1])) return true;
		return this.fits(from, to, depth);
	}

	/** A record, enum or distinct type outside the prelude that doesn't write `implements name`: its equality comes from its fields. */
	structural(t: Type & { k: 'named' }, name: string): boolean {
		if (isPrelude(t.decl) || !['record', 'enum', 'type'].includes(t.decl.node.typeKind)) return false;
		return !(t.decl.node.implements as Node[]).some((i) => i.path[i.path.length - 1] === name);
	}

	/**
	 * Whether a value can be a field of a log event. The compiler writes each type's log form,
	 * but a record or class of your own may hold personal data, so it's logged only when it's
	 * marked `@loggable`. An error is logged as its chain of messages, and a secret as
	 * `[redacted]`. The standard library's types, enums and distinct types are logged as what
	 * they hold, so they're loggable when that is.
	 */
	loggable(from: Type, to: Type, d: number): boolean {
		if (from.k === 'null') return true;
		if (from.k === 'nullable') return this.loggable(from.inner, to, d);
		if (from.k === 'tuple') return from.items.every((x) => this.loggable(x, to, d));
		if (from.k !== 'named') return from.k !== 'fn';
		if (isSensitive(from.decl)) return true;
		if (this.fits(from, this.preludeType('Error'), d)) return true;
		const { types } = this.supertypes(from);
		if (types.some((s) => s.decl.name === 'Loggable' && s.decl.file.endsWith('log.d.nibl'))) return true;
		const node = from.decl.node;
		if (from.decl.file.endsWith('.d.nibl')) return from.args.every((x) => this.loggable(x, to, d));
		if (node.typeKind === 'type') return this.loggable(this.widen(from), to, d);
		if (node.typeKind === 'enum') return this.fieldsFit(from, to, d);
		return false;
	}

	/** Whether every field of a record, every payload of an enum, or a distinct type's base fits `to`. */
	fieldsFit(t: Type & { k: 'named' }, to: Type, depth: number): boolean {
		return this.unfitField(t, to, depth) === null;
	}

	/** The first field of a record or enum, or a distinct type's base, that doesn't fit `to`. */
	unfitField(t: Type & { k: 'named' }, to: Type, depth = 0): { name: string | null; type: Type } | null {
		const ctx = this.ctxFor(t.decl, t.args, t);
		const node = t.decl.node;
		if (node.typeKind === 'type') {
			const base = this.resolve(node.base, ctx);
			return this.fits(base, to, depth + 1) ? null : { name: null, type: base };
		}
		const fields: Node[] = node.typeKind === 'enum' ? (node.members as Node[]).filter((m) => m.kind === 'Variant').flatMap((v) => v.payload ?? []) : (node.members as Node[]).filter((m) => m.kind === 'Field');
		for (const f of fields) {
			const ft = this.resolve(f.type, ctx);
			if (!(ft.k === 'named' && declKey(ft.decl) === declKey(t.decl)) && !this.fits(ft, to, depth + 1)) return { name: f.name, type: ft };
		}
		return null;
	}

	/** Codable with every codec: built-in scalars, backed enums, and collections of types codable with `codable`'s codec. */
	codable(t: Type & { k: 'named' }, codable: Type, depth: number): boolean {
		if (isPrelude(t.decl) && SCALARS.has(t.decl.name)) return true;
		if (t.decl.node.typeKind === 'enum' && t.decl.node.backing) return true;
		if (t.decl.node.typeKind === 'type') {
			// A distinct type is written as its base. One with a private wrap is read back
			// through its own `parse`, so decoding can't skip its checks.
			if (t.decl.node.privateWrap && !(t.decl.node.implements as Node[]).some((i) => i.path[i.path.length - 1] === 'Parseable')) return false;
			return this.fits(this.widen(t), codable, depth + 1);
		}
		// A type that implements `Codable<Codec>` can be written by every codec: the stdlib's value types do.
		if (this.supertypes(t).types.some((s) => isNamed(s, 'Codable') && s.args[0]?.k === 'named' && s.args[0].decl.name === 'Codec')) return true;
		if (isPrelude(t.decl) && ['List', 'Set', 'Map'].includes(t.decl.name)) return t.args.every((a) => this.fits(a, codable, depth + 1));
		return false;
	}

	/** The attribute that makes a type implement `to`, as `@json` does for `Codable<JsonCodec>`, for a hint. */
	attributeFor(to: Type): string | null {
		if (to.k !== 'named') return null;
		for (const m of [...(this.std?.values() ?? []), ...this.modules.values()]) {
			for (const [name, decls] of m.decls) {
				const attr = decls.find((d) => d.kind === 'attribute');
				if (!attr) continue;
				const ctx: Ctx = { file: this.fileOf(attr), params: new Map(), self: null };
				if ((attr.node.implements as Node[]).some((i) => typeKey(this.resolve(i, ctx)) === typeKey(to))) return name;
			}
		}
		return null;
	}

	/**
	 * Works out a call's type variables from its arguments: `pattern` is a parameter's type,
	 * `actual` the argument's. A variable keeps the first type it is given.
	 */
	infer(pattern: Type, actual: Type, vars: Map<string, Type | undefined>, depth = 0) {
		if (depth > 20 || actual.k === 'unknown') return;
		const d = depth + 1;
		switch (pattern.k) {
			case 'param':
				if (vars.has(pattern.name) && vars.get(pattern.name) === undefined && actual.k !== 'null' && !isNamed(actual, 'Never')) vars.set(pattern.name, actual);
				return;
			case 'nullable':
				this.infer(pattern.inner, nonNull(actual), vars, d);
				return;
			case 'tuple':
				if (actual.k === 'tuple') pattern.items.forEach((x, i) => actual.items[i] && this.infer(x, actual.items[i], vars, d));
				return;
			case 'fn': {
				if (actual.k !== 'fn') return;
				pattern.params.forEach((x, i) => actual.params[i] && this.infer(x, actual.params[i], vars, d));
				if (isNamed(pattern.ret, 'Result') && pattern.ret.k === 'named' && !isNamed(actual.ret, 'Result')) {
					this.infer(pattern.ret.args[0], actual.ret, vars, d);
					// A function that can't fail has the error type `Never`.
					const err = pattern.ret.args[1];
					if (actual.ret.k !== 'unknown' && err?.k === 'param' && vars.has(err.name) && vars.get(err.name) === undefined) vars.set(err.name, this.preludeType('Never'));
				} else this.infer(pattern.ret, actual.ret, vars, d);
				return;
			}
			case 'named': {
				// A guard's value is what its function gives.
				if (actual.k === 'fn' && isRouteMarker(pattern) && pattern.decl.name === 'RouteGuard' && pattern.args[1]) {
					this.infer(pattern.args[1], isNamed(actual.ret, 'Result') && actual.ret.k === 'named' ? actual.ret.args[0] : actual.ret, vars, d);
					return;
				}
				if (actual.k !== 'named') return;
				let match: (Type & { k: 'named' }) | undefined = declKey(actual.decl) === declKey(pattern.decl) ? actual : undefined;
				match ??= this.supertypes(actual).types.find((s) => declKey(s.decl) === declKey(pattern.decl));
				if (match) pattern.args.forEach((x, i) => match.args[i] && this.infer(x, match.args[i], vars, d));
				return;
			}
		}
	}

	/** A type with its variables replaced by what they were inferred to be; an unknown one becomes unknown. */
	substitute(t: Type, vars: Map<string, Type | undefined>): Type {
		switch (t.k) {
			case 'param':
				return vars.has(t.name) ? (vars.get(t.name) ?? UNKNOWN) : t;
			case 'nullable':
				return nullable(this.substitute(t.inner, vars));
			case 'tuple':
				return { k: 'tuple', items: t.items.map((x) => this.substitute(x, vars)) };
			case 'fn':
				return { k: 'fn', params: t.params.map((x) => this.substitute(x, vars)), ret: this.substitute(t.ret, vars) };
			case 'named': {
				const args = t.args.map((x) => this.substitute(x, vars));
				// `-> T else E` with `E` inferred as `Never` is just `T`.
				if (isNamed(t, 'Result') && isNamed(args[1], 'Never')) return args[0];
				return { k: 'named', decl: t.decl, args };
			}
		}
		return t;
	}

	/** The type of a field, getter or constant, or a method as a function value. */
	memberType(m: Member, typeArgs: Type[] = []): Type {
		const n = m.node;
		switch (n.kind) {
			case 'Field':
			case 'Getter':
				return this.resolve(n.type, m.ctx);
			case 'Const':
				return n.type ? this.resolve(n.type, m.ctx) : literalType(this, n.value);
			case 'Variant':
				return m.ctx.self ?? UNKNOWN;
			case 'Fn': {
				const ctx = this.fnCtx(m, typeArgs);
				return { k: 'fn', params: (n.params as Node[]).map((p) => this.resolve(p.type, ctx)), ret: this.returnType(n, ctx) };
			}
		}
		return UNKNOWN;
	}

	/** A method's context: its own type parameters are what the call wrote, or unknown. */
	fnCtx(m: Member, typeArgs: Type[]): Ctx {
		const params = new Map(m.ctx.params);
		((m.node.typeParams ?? []) as Node[]).forEach((p, i) => params.set(p.name, typeArgs[i] ?? UNKNOWN));
		return { ...m.ctx, params };
	}

	returnType(fn: Node, ctx: Ctx): Type {
		const ret = fn.ret ? this.resolve(fn.ret, ctx) : this.preludeType('Void');
		return fn.err ? this.fallible(ret, this.resolve(fn.err, ctx)) : ret;
	}
}

// ---- helpers on types -------------------------------------------------------------------

const absolute = new Map<string, string>();

/** The same declaration has one key, whether its file was named relative or absolute. */
function declKey(d: Decl): string {
	let path = absolute.get(d.file);
	if (!path) absolute.set(d.file, (path = resolve(d.file)));
	return `${path}:${d.node.line}:${d.name}`;
}

function typeKey(t: Type): string {
	switch (t.k) {
		case 'named':
			return `${declKey(t.decl)}<${t.args.map(typeKey).join(',')}>`;
		case 'nullable':
			return `${typeKey(t.inner)}?`;
		case 'fn':
			return `fn(${t.params.map(typeKey).join(',')})->${typeKey(t.ret)}`;
		case 'tuple':
			return `(${t.items.map(typeKey).join(',')})`;
		case 'param':
			return `'${t.name}`;
		default:
			return t.k;
	}
}

/** Whether two types are the same, where anything unknown matches. */
function sameType(a: Type, b: Type): boolean {
	if (a.k === 'unknown' || b.k === 'unknown' || a.k === 'param' || b.k === 'param') return true;
	if (a.k !== b.k) return false;
	switch (a.k) {
		case 'named':
			return b.k === 'named' && declKey(a.decl) === declKey(b.decl) && a.args.every((x, i) => sameType(x, b.args[i] ?? UNKNOWN));
		case 'nullable':
			return b.k === 'nullable' && sameType(a.inner, b.inner);
		case 'tuple':
			return b.k === 'tuple' && a.items.length === b.items.length && a.items.every((x, i) => sameType(x, b.items[i]));
		case 'fn':
			return b.k === 'fn' && a.params.length === b.params.length && a.params.every((x, i) => sameType(x, b.params[i])) && sameType(a.ret, b.ret);
	}
	return true;
}

function isPrelude(d: Decl): boolean {
	return d.file.endsWith('prelude.d.nibl');
}

/** The call an initialiser makes, under any `try`. */
function callIn(e: Node): Node | null {
	if (e.kind === 'Try') return callIn(e.value);
	return e.kind === 'Call' ? e : null;
}

/** Whether `name.close()` is called anywhere in `n`, including under `defer`. */
function callsClose(n: unknown, name: string): boolean {
	if (!n || typeof n !== 'object') return false;
	if (Array.isArray(n)) return n.some((x) => callsClose(x, name));
	const node = n as Node;
	if (node.kind === 'Call' && node.callee?.kind === 'Member' && node.callee.name === 'close' && node.callee.object?.kind === 'Name' && node.callee.object.name === name) return true;
	for (const [k, v] of Object.entries(node)) if (k !== 'ty' && k !== 'ref' && v && typeof v === 'object' && callsClose(v, name)) return true;
	return false;
}

/** Whether a local writer is closed, and whether it's used for anything but `write`, which hands it on. */
function writerUse(root: Node, b: Binding): { closed: boolean; escapes: boolean } {
	const result = { closed: false, escapes: false };
	const walk = (n: unknown) => {
		if (!n || typeof n !== 'object') return;
		if (Array.isArray(n)) return n.forEach(walk);
		const node = n as Node;
		if (node.kind === 'Call' && node.callee?.kind === 'Member' && node.callee.object?.kind === 'Name' && node.callee.object.ref === b) {
			if (node.callee.name === 'close') result.closed = true;
			else if (node.callee.name !== 'write') result.escapes = true;
			walk(node.args);
			return;
		}
		if (node.kind === 'Name' && node.ref === b) {
			result.escapes = true;
			return;
		}
		for (const [k, v] of Object.entries(node)) if (k !== 'ty' && k !== 'ref' && v && typeof v === 'object') walk(v);
	};
	walk(root);
	return result;
}

/** Whether a local transaction is committed, has its rollback deferred, and is used for anything but its own calls. */
function transactionUse(root: Node, b: Binding): { committed: boolean; rollbackDeferred: boolean; escapes: boolean } {
	const result = { committed: false, rollbackDeferred: false, escapes: false };
	const isCall = (n: Node | undefined, method: string) =>
		n?.kind === 'Call' && n.callee?.kind === 'Member' && n.callee.name === method && n.callee.object?.kind === 'Name' && n.callee.object.ref === b;
	const walk = (n: unknown) => {
		if (!n || typeof n !== 'object') return;
		if (Array.isArray(n)) return n.forEach(walk);
		const node = n as Node;
		if (node.kind === 'Defer' && isCall(node.value, 'rollback')) {
			result.rollbackDeferred = true;
			return;
		}
		if (node.kind === 'Call' && node.callee?.kind === 'Member' && node.callee.object?.kind === 'Name' && node.callee.object.ref === b) {
			if (node.callee.name === 'commit') result.committed = true;
			walk(node.args);
			return;
		}
		if (node.kind === 'Name' && node.ref === b) {
			result.escapes = true;
			return;
		}
		for (const [k, v] of Object.entries(node)) if (k !== 'ty' && k !== 'ref' && v && typeof v === 'object') walk(v);
	};
	walk(root);
	return result;
}

/** Whether a function body yields, outside any closure inside it: then it's a generator. */
function yieldsIn(n: unknown): boolean {
	if (!n || typeof n !== 'object') return false;
	if (Array.isArray(n)) return n.some(yieldsIn);
	const node = n as Node;
	if (node.kind === 'Yield') return true;
	if (node.kind === 'Closure') return false;
	for (const [k, v] of Object.entries(node)) if (k !== 'ty' && k !== 'ref' && v && typeof v === 'object' && yieldsIn(v)) return true;
	return false;
}

/** A type marked `@sensitive`: a secret, which keeps none of its base type's ways out. */
function isSensitive(d: Decl): boolean {
	return ((d.node.attrs ?? []) as Node[]).some((a) => a.name === 'sensitive');
}

/** Whether a type is `std.time`'s `name`. */
function isTime(t: Type, name: string): boolean {
	return isNamed(t, name) && t.k === 'named' && t.decl.file.endsWith('time.d.nibl');
}

/** A guard around a route: what it gives, its name, and the path parameters it takes. */
type RouteGuardInfo = { type: Type; name: string; took: string[] };

function isNamed(t: Type, name: string): boolean {
	return t.k === 'named' && t.decl.name === name;
}

function nullable(t: Type): Type {
	return t.k === 'nullable' || t.k === 'unknown' || t.k === 'null' ? t : { k: 'nullable', inner: t };
}

function nonNull(t: Type): Type {
	return t.k === 'nullable' ? t.inner : t;
}

function hasUnknown(t: Type): boolean {
	switch (t.k) {
		case 'unknown':
			return true;
		case 'named':
			return t.args.some(hasUnknown);
		case 'nullable':
			return hasUnknown(t.inner);
		case 'fn':
			return t.params.some(hasUnknown) || hasUnknown(t.ret);
		case 'tuple':
			return t.items.some(hasUnknown);
	}
	return false;
}

/** One type for several branches: the same type, made nullable if one branch is `null`. */
function unify(types: Type[]): Type {
	const live = types.filter((t) => !isNamed(t, 'Never'));
	if (live.length === 0) return types[0] ?? UNKNOWN;
	if (live.some((t) => t.k === 'unknown')) return UNKNOWN;
	const values = live.filter((t) => t.k !== 'null');
	if (values.length === 0) return { k: 'null' };
	const first = nonNull(values[0]);
	if (values.some((t) => typeKey(nonNull(t)) !== typeKey(first))) return UNKNOWN;
	return values.length < live.length || values.some((t) => t.k === 'nullable') ? nullable(first) : first;
}

export function typeToString(t: Type): string {
	switch (t.k) {
		case 'named':
			return t.args.length > 0 && !t.args.every((a) => a.k === 'unknown') ? `${t.decl.name}<${t.args.map(typeToString).join(', ')}>` : t.decl.name;
		case 'nullable':
			return `${typeToString(t.inner)}?`;
		case 'fn': {
			const ret = isNamed(t.ret, 'Result') && t.ret.k === 'named' ? `${typeToString(t.ret.args[0])} else ${typeToString(t.ret.args[1])}` : typeToString(t.ret);
			return `fn(${t.params.map(typeToString).join(', ')}) -> ${ret}`;
		}
		case 'tuple':
			return `(${t.items.map(typeToString).join(', ')})`;
		case 'param':
			return t.name;
		case 'null':
			return 'null';
		case 'static':
			return t.decl.name;
		default:
			return '?';
	}
}

function isLiteral(e: Node): boolean {
	if (e.kind === 'Int' || e.kind === 'Decimal') return true;
	if ((e.kind === 'Unary' && e.op === '-') || e.kind === 'Paren') return isLiteral(e.value);
	return false;
}

/** A number literal with nothing to say otherwise: `42` is an `Int`, `3.95` a `Decimal`. */
function literalType(program: Program, e: Node | null, ctx?: Ctx): Type {
	if (!e) return UNKNOWN;
	switch (e.kind) {
		// A constant built by naming its type, `SessionKey<UserId>("userId")` or
		// `BlindIndex(…)`, has that type. A generic type whose arguments aren't written is left
		// unknown, since they'd have to be inferred.
		case 'Call': {
			if (!ctx || e.callee.kind !== 'Name' || !/^[A-Z]/.test(e.callee.name)) return UNKNOWN;
			const args = (e.typeArgs ?? []) as Node[];
			const t = program.resolve({ kind: 'NamedType', path: [e.callee.name], args, line: e.line, col: e.col } as Node, ctx);
			if (t.k !== 'named' || (t.decl.node.kind !== 'TypeDecl' && t.decl.node.kind !== 'Record' && t.decl.node.kind !== 'Class')) return UNKNOWN;
			return ((t.decl.node.typeParams ?? []) as Node[]).length === args.length ? t : UNKNOWN;
		}
		case 'Int':
			return program.preludeType('Int');
		case 'Decimal':
			return program.preludeType('Decimal');
		case 'Bool':
			return program.preludeType('Bool');
		case 'Str':
			return e.tag ? UNKNOWN : program.preludeType('String');
		case 'Unary':
		case 'Paren':
			return literalType(program, e.value);
	}
	return UNKNOWN;
}

/** Short source text for a name or member chain, for messages: `this.user`, `page.user`. Empty for anything else. */
/** A pattern that matches anything: `_`, a name, or a tuple of those. */
function irrefutable(p: Node): boolean {
	if (p.kind === 'WildcardPattern' || p.kind === 'BindPattern') return true;
	if (p.kind === 'TuplePattern') return p.items.every(irrefutable);
	if (p.kind === 'OrPattern') return p.alternatives.some(irrefutable);
	return false;
}

/** A name for a new variant that holds an error: `DbError` becomes `Db`. */
function errName(t: Type): string {
	const name = t.k === 'named' ? t.decl.name : 'Cause';
	return name.replace(/Error$/, '') || name;
}

function exprText(e: Node): string {
	switch (e.kind) {
		case 'Name':
			return e.name;
		case 'This':
			return 'this';
		case 'Member': {
			const object = exprText(e.object);
			return object ? `${object}${e.safe ? '?.' : '.'}${e.name}` : '';
		}
		case 'Paren':
			return exprText(e.value);
	}
	return '';
}

/** The locals that a statement or expression assigns, anywhere inside it. */
function assignedIn(node: unknown, out = new Set<Binding>(), depth = 0): Set<Binding> {
	if (depth > 200 || !node || typeof node !== 'object') return out;
	if (Array.isArray(node)) {
		for (const x of node) assignedIn(x, out, depth + 1);
		return out;
	}
	const n = node as Node;
	if ((n.kind === 'Assign' || n.kind === 'IncDec') && n.target?.kind === 'Name' && n.target.ref) out.add(n.target.ref);
	for (const [k, v] of Object.entries(n)) if (k !== 'ty' && k !== 'ref' && typeof v === 'object') assignedIn(v, out, depth + 1);
	return out;
}

/** A closure, which takes its parameters' types from where it is passed. */
function isFunctionArg(e: Node): boolean {
	return e.kind === 'Closure';
}

/** `RouteHandler` and `RouteGuard`: interfaces that a route's functions implement by their shape. */
function isRouteMarker(t: Type): t is Type & { k: 'named' } {
	return t.k === 'named' && ['RouteHandler', 'RouteGuard', 'EventStreamHandler', 'WebSocketHandler'].includes(t.decl.name) && t.decl.file.endsWith('routes.d.nibl');
}

/** The names of a pattern's `{name}` and `{name...}` segments, in order. */
function pathParams(pattern: string): string[] {
	return [...pattern.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)(?:\.\.\.)?\}/g)].map((m) => m[1]);
}

/** Whether an expression has a closure somewhere inside it. */
function containsFunction(e: unknown, depth = 0): boolean {
	if (depth > 40 || !e || typeof e !== 'object') return false;
	if (Array.isArray(e)) return e.some((x) => containsFunction(x, depth + 1));
	const n = e as Node;
	if (n.kind === 'Closure') return true;
	return Object.entries(n).some(([k, v]) => k !== 'ty' && k !== 'ref' && typeof v === 'object' && containsFunction(v, depth + 1));
}

/** Whether a type mentions the type variable `name`. */
function mentions(t: Type, name: string): boolean {
	switch (t.k) {
		case 'param':
			return t.name === name;
		case 'named':
			return t.args.some((x) => mentions(x, name));
		case 'nullable':
			return mentions(t.inner, name);
		case 'tuple':
			return t.items.some((x) => mentions(x, name));
		case 'fn':
			return t.params.some((x) => mentions(x, name)) || mentions(t.ret, name);
	}
	return false;
}

/** A number literal, possibly negated or in brackets. */
function isLiteralNode(e: Node): boolean {
	return isLiteral(e) || literalLike(e);
}

/** Arithmetic on number literals only, as in `2 * 3`. */
function literalLike(e: Node): boolean {
	if (e.kind === 'Paren') return literalLike(e.value) || isLiteral(e.value);
	return e.kind === 'Binary' && ARITHMETIC.has(e.op) && isLiteralNode(e.left) && isLiteralNode(e.right);
}

const ARITHMETIC = new Set(['+', '-', '*', '/', 'div', 'mod']);

/** A type with its article, for messages: "an `Email`", "a `List<Order>`". */
function a(t: Type): string {
	if (t.k === 'null') return '`null`';
	const text = typeToString(t);
	return `${/^[AEIO]/.test(text) ? 'an' : 'a'} \`${text}\``;
}

/** A written type as source text, for hovers. */
function typeText(t: Node | null): string {
	if (!t) return '';
	switch (t.kind) {
		case 'NullableType':
			return `${typeText(t.inner)}?`;
		case 'TupleType':
			return `(${t.items.map(typeText).join(', ')})`;
		case 'FnType':
			return `fn(${t.params.map(typeText).join(', ')})${t.ret ? ` -> ${typeText(t.ret)}` : ''}${t.err ? ` else ${typeText(t.err)}` : ''}`;
		case 'NamedType':
			return `${t.path.join('.')}${t.args.length > 0 ? `<${t.args.map(typeText).join(', ')}>` : ''}`;
	}
	return '';
}

function typeParamsText(params: Node[] | undefined): string {
	if (!params || params.length === 0) return '';
	return `<${params.map((p) => p.name + (p.constraints.length > 0 ? `: ${p.constraints.map(typeText).join(' and ')}` : '')).join(', ')}>`;
}

/** A function's signature as it is declared, without its body. */
function signature(fn: Node): string {
	const params = (fn.params as Node[]).map((p) => {
		const attrs = (p.attrs ?? []).map((a: Node) => `@${a.name} `).join('');
		return `${attrs}${p.named ? 'named ' : ''}${p.name}: ${typeText(p.type)}${p.defaultValue ? ' = …' : ''}`;
	});
	const ret = fn.ret ? ` -> ${typeText(fn.ret)}${fn.err ? ` else ${typeText(fn.err)}` : ''}` : '';
	return `${fn.isStatic ? 'static ' : ''}${fn.isMut ? 'mut ' : ''}fn ${fn.name}${typeParamsText(fn.typeParams)}(${params.join(', ')})${ret}`;
}

export const NUMBER_TYPES = new Set(['Int', 'Int8', 'Int16', 'Int32', 'UInt8', 'UInt16', 'UInt32', 'UInt', 'Float', 'Float32', 'Decimal']);
/** The method a non-number type names for each arithmetic operator. */
const METHOD_FOR: Record<string, string> = { '+': 'plus', '-': 'minus', '*': 'times', '/': 'dividedBy' };

/** The smallest and largest value of each integer type. */
const INTEGER_RANGES: Record<string, [bigint, bigint]> = {
	Int: [-(2n ** 63n), 2n ** 63n - 1n],
	Int8: [-128n, 127n],
	Int16: [-(2n ** 15n), 2n ** 15n - 1n],
	Int32: [-(2n ** 31n), 2n ** 31n - 1n],
	UInt8: [0n, 255n],
	UInt16: [0n, 2n ** 16n - 1n],
	UInt32: [0n, 2n ** 32n - 1n],
	UInt: [0n, 2n ** 64n - 1n],
};

/** The built-in types every codec can write. */
const SCALARS = new Set([...NUMBER_TYPES, 'Bool', 'String', 'Bytes']);

// ---- calls ------------------------------------------------------------------------------

/** What a call can mean, before its arguments pick an overload. */
type Callee =
	| { k: 'fns'; name: string; fns: Member[] }
	| { k: 'variant'; name: string; member: Member }
	| { k: 'value'; name: string; type: Type & { k: 'fn' } }
	| { k: 'construct'; name: string; type: Type }
	| { k: 'build'; name: string; decl: Decl }
	| { k: 'unknown' };

interface Param {
	name: string;
	/** Its position in the declaration. */
	index: number;
	named: boolean;
	optional: boolean;
	callerLocation: boolean;
	type: Node | null;
}

function paramsOf(fn: Node): Param[] {
	return (fn.params as Node[]).map((p, index) => {
		const callerLocation = (p.attrs ?? []).some((a: Node) => a.name === 'callerLocation');
		return { name: p.label ?? p.name, index, named: p.named, optional: !!p.defaultValue || callerLocation, callerLocation, type: p.type };
	});
}

/** Matches a call's arguments to parameters: positional ones first, in order, then labels. Returns why they don't fit. */
function matchArgs(params: Param[], args: Node[], what: string): { problem: string | null; bound: (Param | null)[] } {
	const given = new Set<string>();
	const bound: (Param | null)[] = [];
	const positional = args.filter((a) => a.name === null);
	// Positional arguments fill the parameters that aren't `named`, in order.
	const unnamed = params.filter((p) => !p.named && !p.callerLocation);
	const takes = unnamed.length;
	for (let i = 0; i < positional.length; i++) {
		const p = unnamed[i];
		const next = params.find((x) => x.named && !given.has(x.name));
		if (!p && next) return { problem: `\`${next.name}\` is a \`named\` parameter, so the call labels it: \`${next.name}: …\``, bound };
		if (!p) {
			const most = takes === 1 ? '1 argument' : `${takes} arguments`;
			return { problem: `${what} takes ${most}, but this call passes ${positional.length}`, bound };
		}
		given.add(p.name);
		bound.push(p);
	}
	for (const a of args.slice(positional.length)) {
		const p = params.find((x) => x.name === a.name);
		if (!p) return { problem: `${what} has no parameter \`${a.name}\`${suggest(a.name, params.map((x) => x.name).filter((n) => !given.has(n)))}`, bound };
		if (given.has(p.name)) return { problem: `\`${p.name}\` is passed twice`, bound };
		if (!p.named && !p.callerLocation) return { problem: `\`${p.name}\` isn't a \`named\` parameter, so it's passed without a label: drop \`${p.name}:\``, bound };
		given.add(p.name);
		bound.push(p);
	}
	const missing = params.filter((p) => !p.optional && !given.has(p.name)).map((p) => `\`${p.name}\``);
	if (missing.length > 0) return { problem: `${what} needs ${andList(missing)}, which this call leaves out`, bound };
	return { problem: null, bound };
}

function andList(items: string[]): string {
	return items.length === 1 ? items[0] : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function shapeOf(params: Param[]): string {
	return `(${params.filter((p) => !p.callerLocation).map((p) => (p.named ? `${p.name}:` : p.name)).join(', ')})`;
}

// ---- the walk ---------------------------------------------------------------------------

export class TypeChecker {
	program: Program;
	file: SourceFile;
	out: Diagnostic[];
	/** The name pass's local bindings, by where each is declared. */
	locals: Map<string, Binding[]>;
	names: NameInfo[] = [];
	ctx: Ctx;
	thisType: Type = UNKNOWN;
	/** The member being checked, which decides what it may change: its own type's fields, and `this` only in a `mut fn`. */
	inMember: { owner: Decl | null; getter: boolean; mut: boolean; ctor?: boolean } | null = null;
	/** Inside a `try` or `else` operand, a fallible call's success value flows to the next step. */
	underTry = false;
	/** Inside a `try` or `else` operand, where another fallible call needs its own `try`. */
	inOperand = false;
	/** The error types of fallible calls under the nearest `else`, for its binding. */
	errors: Type[] | null = null;
	/** The item type of the generator whose body is being typed, or `null` inside a closure or an ordinary function. */
	generators: (Type | null)[] = [];
	/** The loops around the statement being typed, in this function. */
	loops: Node[] = [];
	/** The body of the function being typed, to look for what a local is used for. */
	fnBody: Node | null = null;
	/** Calls to functions marked `@opens`, and the call a `let` is binding. */
	opened = new Set<Node>();
	letInit: Node | null = null;
	/** The `try` a `for` loop goes through, which covers each step as well as the call. */
	forSource: Node | null = null;
	/** What a `return` in the function being checked must give, and the function's name; unknown in a closure that doesn't say. */
	/** `error` is what the function fails with: null if it can't fail, undefined if any error will do (a closure that doesn't say, a test). */
	returns: { type: Type; name: string; seen: Type[]; error: Type | null | undefined }[] = [];
	/** Numbers the type variables of each call, so that two calls' `T`s don't meet. */
	vars = 0;
	/** The errors that `try` and `fail` raise in the function or closure being typed. */
	raised: Type[] = [];
	/** The lazy `Iterable` method whose arguments are being checked, such as `map`. */
	lazyStep: string | null = null;
	/** Locals and parameters known not to be `null` here, after a test (#233). */
	narrowed = new Map<Binding, Type>();
	/** The member the last `memberOf` found, so that a method named in a route's closure is known by its declaration. */
	lastMember: Member | null = null;
	/** Routes seen in this file, by method and pattern with parameter names left out, for duplicates (#221). */
	routeKeys = new Map<string, number>();
	/** The constraints of the type parameters in scope, by name, to tell whether an `E` is an `Error`. */
	typeConstraints = new Map<string, Node[]>();
	/** Why a local that was narrowed isn't any more, for the message. */
	unnarrowed = new Map<Binding, string>();
	/** How many expressions so far had a type the stage couldn't work out, to tell "nothing can fail" from "can't tell". */
	unknowns = 0;

	constructor(program: Program, file: SourceFile, out: Diagnostic[], locals: Map<string, Binding[]>) {
		this.program = program;
		this.file = file;
		this.out = out;
		this.locals = locals;
		this.ctx = { file, params: new Map(), self: null };
	}

	error(at: { line: number; col: number }, message: string) {
		this.out.push({ path: this.file.path, line: at.line, col: at.col, severity: 'error', message });
	}

	warning(at: { line: number; col: number }, message: string) {
		this.out.push({ path: this.file.path, line: at.line, col: at.col, severity: 'warning', message });
	}

	run() {
		this.declarations();
		this.routeTables(this.file.decls);
		this.writtenNames();
	}

	/**
	 * Links each type written in the file, each attribute and each imported name to its
	 * declaration, so the editor can go to it. The passes above note the names in
	 * expressions; these are the ones in signatures, fields and imports.
	 */
	writtenNames() {
		const p = this.program;
		const seen = new Set(this.names.map((n) => `${n.line}:${n.col}`));
		const lines = this.file.src.split('\n');
		// Only where the text is the name: the walk also reaches nodes the checker made, or
		// borrowed from other files, whose positions aren't in this one.
		const at = (line: number, col: number, name: string) => lines[line - 1]?.slice(col - 1, col - 1 + name.length) === name;
		const link = (line: number, col: number, length: number, decl: Decl | null | undefined, detail: string | null) => {
			if (!decl || seen.has(`${line}:${col}`)) return;
			seen.add(`${line}:${col}`);
			this.note({ line, col }, length, detail, this.defOf(decl));
		};
		const kindOf = (d: Decl) => (d.node.kind === 'TypeDecl' ? `${d.node.typeKind} ${d.node.name}${typeParamsText(d.node.typeParams)}` : null);
		// The checker hangs its own data on nodes, which can lead back up the tree.
		const visited = new WeakSet<object>();
		const visit = (n: unknown) => {
			if (!n || typeof n !== 'object' || visited.has(n)) return;
			visited.add(n);
			if (Array.isArray(n)) {
				for (const x of n) visit(x);
				return;
			}
			const node = n as Node;
			if (node.kind === 'NamedType' && node.line) {
				const path = node.path as string[];
				let decl: Decl | null = null;
				if (path.length === 1) decl = p.findType(path[0], this.file);
				else if (path.length === 2) {
					const imported = p.importsOf(this.file).get(path[0]);
					if (imported && 'module' in imported) decl = imported.module?.decls.get(path[1])?.find((d) => d.kind === 'type') ?? null;
				}
				// A qualified type, `log.Level`, links from its last part.
				const offset = path.length > 1 ? path.slice(0, -1).join('.').length + 1 : 0;
				const last = path[path.length - 1];
				if (decl && at(node.line, node.col + offset, last)) link(node.line, node.col + offset, last.length, decl, kindOf(decl));
			}
			if (node.kind === 'Import' && node.names) {
				const imported = p.importsOf(this.file);
				for (const item of node.names as Node[]) {
					const entry = imported.get(item.attribute ? `@${item.name}` : item.name);
					const decl = entry && 'attribute' in entry ? entry.attribute : entry && 'decl' in entry ? entry.decl : null;
					const text = item.attribute ? `@${item.name}` : item.name;
					if (at(item.line, item.col, text)) link(item.line, item.col, text.length, decl, decl ? kindOf(decl) : null);
				}
			}
			for (const mark of (node.attrs ?? []) as Node[]) {
				if (mark?.name && mark.line && at(mark.line, mark.col, `@${mark.name}`)) link(mark.line, mark.col, mark.name.length + 1, p.findAttribute(mark.name, this.file), null);
			}
			for (const [key, value] of Object.entries(node)) {
				if (key !== 'attrs' && value && typeof value === 'object') visit(value);
			}
		};
		visit(this.file.decls);
	}

	declarations() {
		for (const node of this.file.decls) {
			this.attributeArgs(node);
			switch (node.kind) {
				case 'Fn':
					this.fn(node);
					break;
				case 'Const':
					if (node.value) this.constant(node);
					break;
				case 'TypeDecl':
					this.typeDecl(node);
					break;
				case 'Test':
					if (node.iterable) this.pattern(node.pattern, this.elementType(this.expr(node.iterable), node.iterable));
					this.returning(UNKNOWN, 'this test', () => this.block(node.body));
					break;
			}
		}
	}

	/**
	 * An attribute's arguments set its fields, so each names a field and holds a value of its
	 * type: `@db(blindIndex: "email_idx")` is an error where a `BlindIndex` is wanted.
	 */
	attributeArgs(node: Node) {
		const p = this.program;
		for (const mark of (node.attrs ?? []) as Node[]) {
			const attr = p.findAttribute(mark.name, this.file);
			if (!attr) continue;
			const t = p.instantiate(attr, []);
			if (t.k !== 'named') continue;
			const args = ((mark.args ?? []) as Node[]).filter((x) => x.name);
			const types = this.fieldInits(args, t);
			const declared = (attr.node.members as Node[]).filter((m) => m.kind === 'Field');
			args.forEach((f, i) => {
				const field = declared.find((d) => d.name === f.name);
				if (!field) {
					this.error(f, `\`@${attr.name}\` has no argument \`${f.name}\`${suggest(f.name, declared.map((d) => d.name))}`);
					return;
				}
				this.expect(f.punned ? f : f.value, types[i], p.resolve(field.type, p.ctxFor(t.decl, t.args, t)), `\`@${attr.name}(${f.name}:)\` takes`);
			});
		}
		// A blind index is for a column that's encrypted, and the field says so itself rather
		// than having the index imply it.
		for (const mark of (node.attrs ?? []) as Node[]) {
			const names = ((mark.args ?? []) as Node[]).map((x) => x.name);
			if (mark.name === 'db' && names.includes('blindIndex') && !names.includes('encrypt') && p.findAttribute('db', this.file)?.file.endsWith('db.d.nibl')) {
				this.error(mark, 'a blind index is for an encrypted column, so say how the field is encrypted too: `@db(encrypt: "pii", blindIndex: …)`');
			}
		}
		for (const m of (node.members ?? []) as Node[]) {
			this.attributeArgs(m);
			for (const f of (m.payload ?? []) as Node[]) this.attributeArgs(f);
			for (const x of (m.params ?? []) as Node[]) this.attributeArgs(x);
		}
		for (const x of (node.params ?? []) as Node[]) this.attributeArgs(x);
	}

	/** Records the type of a local where the name pass declared it. */
	declare(at: { line: number; col: number }, type: Type) {
		for (const b of this.locals.get(`${at.line}:${at.col}`) ?? []) b.type = type;
	}

	note(at: { line: number; col: number }, length: number, detail: string | null, def: NameInfo['def']) {
		this.names.push({ line: at.line, col: at.col, length, detail, def });
	}

	/** `name: Type` for a value, a function's signature, or a type's kind and name. */
	detail(name: string, t: Type, node?: Node): string | null {
		if (node?.kind === 'Fn') return signature(node);
		if (node?.kind === 'TypeDecl') return `${node.typeKind} ${node.name}${typeParamsText(node.typeParams)}`;
		if (node?.kind === 'Variant') return `${typeToString(t)}.${node.name}${node.payload ? `(${node.payload.map((f: Node) => `${f.name}: ${typeText(f.type)}`).join(', ')})` : node.from ? `(from ${typeText(node.from)})` : node.held ? `(${typeText(node.held)})` : ''}`;
		// A `Result` whose error type isn't known yet may turn out to be a plain value.
		if (t.k === 'unknown' || (isNamed(t, 'Result') && hasUnknown(t))) return null;
		return `${name}: ${typeToString(t)}`;
	}

	defOf(decl: Decl | undefined | null): NameInfo['def'] {
		return decl ? { path: decl.file, line: decl.node.line, col: decl.node.col } : null;
	}

	memberDef(m: Member): NameInfo['def'] {
		return { path: m.owner.file, line: m.node.nameLine ?? m.node.line, col: m.node.nameCol ?? m.node.col };
	}

	with<T>(ctx: Ctx, thisType: Type, f: () => T): T {
		const saved = [this.ctx, this.thisType] as const;
		this.ctx = ctx;
		this.thisType = thisType;
		try {
			return f();
		} finally {
			[this.ctx, this.thisType] = saved;
		}
	}

	resolve(t: Node | null): Type {
		return this.program.resolve(t, this.ctx);
	}

	// ---- declarations -------------------------------------------------------------------

	typeDecl(node: Node) {
		const decl = this.file.module.decls.get(node.name)?.find((d) => d.node === node);
		const params = new Map(this.ctx.params);
		for (const p of node.typeParams as Node[]) params.set(p.name, { k: 'param', name: p.name });
		const outerConstraints = this.typeConstraints;
		this.typeConstraints = new Map(outerConstraints);
		for (const p of node.typeParams as Node[]) this.typeConstraints.set(p.name, p.constraints);
		const self: Type = decl ? { k: 'named', decl, args: (node.typeParams as Node[]).map((p) => ({ k: 'param', name: p.name })) } : UNKNOWN;
		this.with({ file: this.file, params, self }, self, () => {
			if (node.base) this.written(node.base);
			if (node.target) this.written(node.target);
			this.members(node.members, self);
			if (decl && self.k === 'named') this.codecFields(node, self);
			if (node.typeKind === 'enum') this.jsonEnum(node);
			if (node.typeKind === 'enum' && self.k === 'named') this.anyError(node, self);
		});
		this.typeConstraints = outerConstraints;
	}

	/**
	 * A variant that takes any error (`from Error`) belongs where failures are only reported:
	 * an error that becomes a response, or the one `main` fails with. Elsewhere, a caller
	 * that handles the error needs to know which one it is.
	 */
	anyError(node: Node, self: Type & { k: 'named' }) {
		const p = this.program;
		const handled = p.preludeType('HandledAtCall');
		for (const v of node.members as Node[]) {
			if (v.kind !== 'Variant' || !v.from) continue;
			const t = this.resolve(v.from);
			if (t.k === 'named' && handled.k === 'named' && p.fits(t, handled)) {
				this.error(v, `${a(t)} is handled where it happens, with \`catch\` straight after the call, so no variant takes it with \`from\``);
			}
		}
		const error = p.preludeType('Error');
		const any = (node.members as Node[]).find((v) => v.kind === 'Variant' && v.from && (() => {
			const t = this.resolve(v.from);
			return t.k === 'named' && error.k === 'named' && t.decl === error.decl;
		})());
		if (!any) return;
		if (p.fits(self, p.stdType('std.http', 'ToResponse'))) return;
		const mains = this.file.module.decls.get('main') ?? [];
		const mainFails = mains.some((d) => d.node.kind === 'Fn' && d.node.err?.kind === 'NamedType' && d.node.err.path[d.node.err.path.length - 1] === node.name);
		if (mainFails) return;
		this.error(any, `\`${any.name}(from Error)\` takes any error, which belongs only where failures are reported, not handled: an error that implements \`ToResponse\`, or the one \`main\` fails with. Here, give each error its own variant, so callers can tell them apart`);
	}

	/**
	 * A type marked with a codec's attribute holds only values that codec can write: each
	 * field, or each variant's payload. A field's own `@db(embed: true)` stores a record's
	 * fields as columns, so those are checked instead, and `@db(json: true)` stores it as
	 * JSON, so it needs the JSON codec.
	 */
	codecFields(node: Node, self: Type & { k: 'named' }) {
		const p = this.program;
		for (const mark of (node.attrs ?? []) as Node[]) {
			const attr = p.findAttribute(mark.name, this.file);
			if (!attr) continue;
			for (const i of attr.node.implements as Node[]) {
				const to = p.resolve(i, { file: p.fileOf(attr), params: new Map(), self });
				if (!isNamed(to, 'Codable')) continue;
				const fields: Node[] = node.typeKind === 'enum'
					? (node.members as Node[]).filter((m) => m.kind === 'Variant').flatMap((v) => v.payload ?? [])
					: (node.members as Node[]).filter((m) => m.kind === 'Field' && !m.lazy);
				for (const f of fields) {
					const own = ((f.attrs ?? []) as Node[]).find((x) => x.name === mark.name);
					const flag = (name: string) => ((own?.args ?? []) as Node[]).some((x) => x.name === name && x.value?.kind === 'Bool' && x.value.value === true);
					const ft = this.resolve(f.type);
					if (hasUnknown(ft)) continue;
					if (flag('embed') && nonNull(ft).k === 'named') {
						const unfit = p.unfitField(nonNull(ft) as Type & { k: 'named' }, to);
						if (unfit) this.error(f, `\`${f.name}\` is embedded, but its \`${unfit.name}\` is ${a(unfit.type)}, which \`@${mark.name}\` can't write or read`);
						continue;
					}
					const target = flag('json') ? this.jsonCodable() ?? to : to;
					if (p.fits(ft, target)) continue;
					const via = target === to ? `\`@${mark.name}\`` : 'the JSON codec';
					const userType = ft.k === 'named' && !p.fileOf(ft.decl)?.path.endsWith('.d.nibl');
					const fix = p.attributeFor(target);
					const hint = userType && fix ? `: mark \`${ft.decl.name}\` \`@${fix}\` too, or store something it can write` : '';
					this.error(f, `\`${f.name}\` is ${a(ft)}, which ${via} can't write or read${hint}`);
				}
			}
		}
	}

	/**
	 * A `@json` enum is written as an object whose `tag` key (`"type"` unless renamed) holds
	 * the variant's name, beside the payload's fields. So a `from` variant, whose payload has
	 * no fields, can't be written, and a field can't use the tag's key.
	 */
	jsonEnum(node: Node) {
		const mark = ((node.attrs ?? []) as Node[]).find((x) => x.name === 'json');
		const attr = mark ? this.program.findAttribute('json', this.file) : null;
		if (!mark || !attr || !attr.file.endsWith('json.d.nibl')) return;
		const arg = (name: string): Node | undefined => ((mark.args ?? []) as Node[]).find((x) => x.name === name)?.value;
		const tagNode = arg('tag');
		const tag = tagNode ? this.literalName(tagNode) : 'type';
		const keys = arg('keys');
		const policy = keys?.kind === 'Member' ? keys.name as string : null;
		for (const v of (node.members as Node[]).filter((m) => m.kind === 'Variant')) {
			if (v.held) {
				this.error(v, `\`${v.name}\` can't be in a \`@json\` enum: a payload without a name has no fields to sit beside the tag`);
				continue;
			}
			if (tag === null) continue;
			for (const f of (v.payload ?? []) as Node[]) {
				const own = ((f.attrs ?? []) as Node[]).find((x) => x.name === 'json');
				const renamed = ((own?.args ?? []) as Node[]).find((x) => x.name === 'key')?.value;
				const key = renamed ? this.literalName(renamed) : applyCase(f.name, policy);
				if (key !== tag) continue;
				const fix = tagNode ? 'rename it with `@json(key: …)`' : 'rename it, or set `@json(tag: …)`';
				this.error(f, `\`${v.name}\`'s \`${f.name}\` is written under \`"${key}"\`, the variant's tag: ${fix}`);
			}
		}
	}

	/** `Codable<JsonCodec>`, from the `@json` attribute that gives it. */
	jsonCodable(): Type | null {
		const p = this.program;
		const attr = p.std?.get('std.json')?.decls.get('json')?.find((d) => d.kind === 'attribute');
		const i = (attr?.node.implements as Node[] | undefined)?.[0];
		return attr && i ? p.resolve(i, { file: p.fileOf(attr), params: new Map(), self: null }) : null;
	}

	within(self: Type, getter: boolean, mut: boolean, f: () => void, ctor = false) {
		const saved = this.inMember;
		this.inMember = { owner: self.k === 'named' ? self.decl : null, getter, mut, ctor };
		try {
			f();
		} finally {
			this.inMember = saved;
		}
	}

	/**
	 * Only a type changes its own fields, and a value type (a record, enum or distinct type)
	 * only in a `mut fn`, because changing one means replacing it. A getter changes nothing.
	 */
	fieldWrite(target: Node) {
		const object = target.object.ty as Type | undefined;
		if (!object || object.k !== 'named' || hasUnknown(object)) return;
		const p = this.program;
		const m = p.membersOf(object).members.get(target.name)?.find((x) => !isStaticMember(x.node));
		if (!m) return;
		const name = object.decl.name;
		if (m.node.kind === 'Getter') {
			this.error(target, `\`${target.name}\` is a getter, so it can't be assigned`);
			return;
		}
		if (m.node.kind !== 'Field') return;
		const value = object.decl.node.typeKind !== 'class';
		const here = this.inMember;
		if (!here || !here.owner || declKey(here.owner) !== declKey(object.decl)) {
			this.error(target, value
				? `only \`${name}\`'s own methods change its fields: make a changed copy with \`with (${target.name}: …)\``
				: `only \`${name}\`'s own methods change its fields: call one that does`);
			return;
		}
		if (here.getter) {
			this.error(target, 'a getter can\'t change anything: make this a method');
			return;
		}
		if (here.ctor && target.object.kind === 'This') {
			// The constructor sets each field once; whether it does is checked by the flow of its body.
			if (m.node.mutable || m.node.lazy) return;
			if (m.node.promoted) this.error(target, `\`${target.name}\` is set from the constructor's parameter, and it isn't a \`var\`, so it can't be set again`);
			else if (m.node.init) this.error(target, `\`${target.name}\` starts at its default, and it isn't a \`var\`, so it can't be set again: leave out the default if the constructor sets it`);
			return;
		}
		if (value && !here.mut) {
			this.error(target, `changing a field replaces the whole \`${name}\`, which only a \`mut fn\` can do`);
			return;
		}
		// A field changes only if it says `var`, in a record's `mut fn` as in a class.
		if (!m.node.mutable && !m.node.lazy) {
			this.error(target, `\`${target.name}\` isn't a \`var\` field, so it can't change: declare it \`var ${target.name}\` if it does`);
		}
	}

	/** The receiver of a `mut fn` call is a place that can change: a `var`, `this` in a `mut fn`, or a field this method may write. */
	mutableReceiver(e: Node, method: string) {
		const target = e.kind === 'Paren' ? e.value : e;
		if (target.kind === 'Name') {
			const b: Binding | undefined = target.ref;
			if (!b || (b.kind !== 'local' && b.kind !== 'param')) return;
			if (b.declaredWith === 'var') return;
			const what = b.kind === 'param' ? 'a parameter' : 'declared with `let`';
			this.error(target, `\`${method}\` changes \`${target.name}\`, which is ${what}: copy it to a \`var\` first`);
			return;
		}
		if (target.kind === 'This') {
			const here = this.inMember;
			if (here && here.owner && here.owner.node.typeKind !== 'class' && !here.mut) {
				this.error(target, `\`${method}\` changes \`this\`, which only a \`mut fn\` can do`);
			}
			return;
		}
		if (target.kind === 'Member') {
			const object = target.object.ty as Type | undefined;
			if (!object || object.k !== 'named' || hasUnknown(object)) return;
			const m = this.program.membersOf(object).members.get(target.name)?.find((x) => !isStaticMember(x.node));
			if (m?.node.kind === 'Field') {
				const before = this.out.length;
				this.fieldWrite(target);
				if (this.out.length === before && object.decl.node.typeKind !== 'class') this.mutableReceiver(target.object, method);
			}
		}
	}

	members(members: Node[], self: Type) {
		for (const m of members) {
			switch (m.kind) {
				case 'Field':
					this.written(m.type);
					if (m.init) this.expect(m.init, this.expr(m.init, this.resolve(m.type)), this.resolve(m.type), `the field \`${m.name}\` holds`);
					break;
				case 'Getter':
					this.written(m.type);
					if (m.body) this.within(self, true, false, () => this.with(this.ctx, m.isStatic ? UNKNOWN : self, () => this.getter(m)));
					break;
				case 'Fn':
					this.within(self, false, Boolean(m.isMut), () => this.with(this.ctx, m.isStatic && !m.isConstructor ? UNKNOWN : self, () => this.fn(m)), Boolean(m.isConstructor));
					break;
				case 'Const':
					if (m.value) this.constant(m);
					break;
				case 'Variant':
					for (const f of m.payload ?? []) if (f.init) this.expr(f.init);
					if (m.value) this.expr(m.value);
					break;
			}
		}
	}

	fn(node: Node) {
		const params = new Map(this.ctx.params);
		for (const p of node.typeParams as Node[]) params.set(p.name, { k: 'param', name: p.name });
		const outerConstraints = this.typeConstraints;
		this.typeConstraints = new Map(outerConstraints);
		for (const p of node.typeParams as Node[]) this.typeConstraints.set(p.name, p.constraints);
		for (const w of (node.when ?? []) as Node[]) this.typeConstraints.set(w.name, [...(this.typeConstraints.get(w.name) ?? []), ...w.constraints]);
		this.with({ ...this.ctx, params }, this.thisType, () => {
			for (const p of node.params as Node[]) {
				this.written(p.type);
				const t = this.resolve(p.type);
				if (p.defaultValue) this.expect(p.defaultValue, this.expr(p.defaultValue, t), t, `\`${p.name}\` needs`);
				this.declare({ line: p.nameLine, col: p.nameCol }, t);
			}
			this.written(node.ret);
			this.written(node.err);
			this.errorType(node.err, `\`${node.name}\``);
			// A doc-comment example's statements may return or fail with anything.
			const ret = node.example ? UNKNOWN : node.ret && !node.isConstructor ? this.resolve(node.ret) : this.program.preludeType('Void');
			const err = node.example ? UNKNOWN : node.err ? this.resolve(node.err) : null;
			const outerBody = this.fnBody;
			this.fnBody = node.body ?? null;
			try {
				if (node.body && yieldsIn(node.body)) return this.generator(node, ret, err);
				this.generators.push(null);
				let raised = 0;
				let returned: Type[] = [];
				try {
					if (node.body) {
						this.returning(ret, `\`${node.name}\``, () => {
							returned = this.returns[this.returns.length - 1].seen;
							this.scoped(() => {
								this.block(node.body);
								raised = this.raised.length;
							});
						}, err);
					}
				} finally {
					this.generators.pop();
				}
				this.neverFails(node, raised, returned);
			} finally {
				this.fnBody = outerBody;
			}
		});
		this.typeConstraints = outerConstraints;
	}

	/**
	 * A function that says it can fail, `-> T else E`, though nothing in its body can. A reader
	 * trusts a signature to say what can go wrong. An `override` keeps its interface's shape,
	 * and an interface's default is a shape for others, so neither is asked.
	 */
	neverFails(node: Node, raised: number, returned: Type[]) {
		if (!node.err || !node.body || node.example || node.isOverride) return;
		if (this.thisType.k === 'named' && this.thisType.decl.node.typeKind === 'interface') return;
		if (raised > 0) return;
		if (returned.some((t) => isNamed(t, 'Result') || hasUnknown(t))) return;
		this.warning(node.err, `nothing in \`${node.name}\` can fail: drop \`else ${typeText(node.err)}\` from its signature`);
	}

	/** Checks a body whose `return`s must give `type`. */
	returning<T>(type: Type, name: string, f: () => T, error: Type | null | undefined = undefined): T {
		this.returns.push({ type, name, seen: [], error });
		try {
			return f();
		} finally {
			this.returns.pop();
		}
	}

	getter(m: Node) {
		const t = this.resolve(m.type);
		this.returning(t, `\`${m.name}\``, () => {
			const body = this.scoped(() => this.body(m.body, t));
			if (m.body.kind !== 'Block') this.expect(m.body, body, t, `\`${m.name}\` is`);
		}, null);
	}

	constant(c: Node) {
		const value = this.expr(c.value, c.type ? this.resolve(c.type) : null);
		if (c.type) {
			this.written(c.type);
			this.expect(c.value, value, this.resolve(c.type), `\`${c.name}\` is declared as`);
		}
		return c.type ? this.resolve(c.type) : value;
	}

	/** A function or closure body: `try` and `else` don't reach into it. */
	scoped<T>(f: () => T): T {
		const saved = [this.underTry, this.errors, this.raised, this.inOperand, this.loops] as const;
		this.underTry = false;
		this.errors = null;
		this.raised = [];
		this.inOperand = false;
		this.loops = [];
		try {
			return f();
		} finally {
			[this.underTry, this.errors, this.raised, this.inOperand, this.loops] = saved;
		}
	}

	// ---- statements ---------------------------------------------------------------------

	block(block: Node) {
		for (const s of block.body) this.statement(s);
	}

	body(body: Node, want: Type | null = null): Type {
		if (body.kind === 'Block') {
			this.block(body);
			return UNKNOWN;
		}
		return this.expr(body, want);
	}

	statement(s: Node) {
		switch (s.kind) {
			case 'Let': {
				const declared = s.type ? this.resolve(s.type) : null;
				if (!s.init) {
					this.pattern(s.pattern, declared ?? UNKNOWN);
					return;
				}
				// `let _ = f() catch err { … }` drops the value, so its block may simply end.
				if (s.pattern.kind === 'WildcardPattern' && s.init.kind === 'Else') s.init.statement = true;
				const call = callIn(s.init);
				this.letInit = call;
				const init = this.expr(s.init, declared);
				this.letInit = null;
				if (call) this.openedInLoop(s, call);
				this.unclosedWriter(s, declared ?? init);
				this.unfinishedTransaction(s, declared ?? init);
				if (declared) {
					this.written(s.type);
					const name = s.pattern.kind === 'BindPattern' ? `\`${s.pattern.name}\`` : 'this pattern';
					this.expect(s.init, init, declared, `${name} is declared as`);
				}
				this.pattern(s.pattern, declared ?? (s.init.kind === 'Null' ? UNKNOWN : init));
				// A declaration is the first assignment: `var x: String? = "a"` starts narrowed.
				const b: Binding | undefined = s.pattern.kind === 'BindPattern' ? this.locals.get(`${s.pattern.line}:${s.pattern.col}`)?.[0] : undefined;
				if (b && declared?.k === 'nullable' && !b.mutCaptured && init.k !== 'null' && init.k !== 'nullable' && init.k !== 'unknown') this.narrowed.set(b, nonNull(declared));
				return;
			}
			case 'Const':
				this.declare(s, this.constant(s));
				return;
			case 'Yield': {
				const item = this.generators[this.generators.length - 1];
				if (!item) {
					this.expr(s.value);
					this.error(s, '`yield` gives the next item of a generator, a function whose body yields and which returns an `Iterable`');
					return;
				}
				this.expect(s.value, this.expr(s.value, item), item, 'this generator yields');
				return;
			}
			case 'Return': {
				const top = this.returns[this.returns.length - 1];
				if (!s.value) {
					top?.seen.push(this.program.preludeType('Void'));
					return;
				}
				if (this.generators[this.generators.length - 1]) {
					this.expr(s.value);
					this.error(s, 'a generator gives its items with `yield`; `return` ends it, without a value');
					return;
				}
				const t = this.expr(s.value, top?.type ?? null);
				top?.seen.push(t);
				if (top) this.expect(s.value, t, top.type, `${top.name} returns`);
				return;
			}
			case 'Fail':
				this.failing(s, this.expr(s.value, this.returns[this.returns.length - 1]?.error ?? null));
				return;
			case 'ExprStmt': {
				// A statement's value is dropped, and a `catch` block on it may simply end (#170).
				s.value.statement = true;
				const t = this.expr(s.value);
				this.dropped(s.value, t);
				return;
			}
			case 'Expect':
			case 'Defer':
				if (s.value) this.expr(s.value);
				return;
			case 'If': {
				this.condition(s.cond, '`if`');
				const yes = this.facts(s.cond, true);
				const no = this.facts(s.cond, false);
				this.narrowing(yes, () => this.block(s.then), s.then);
				if (s.otherwise) this.narrowing(no, () => (s.otherwise.kind === 'If' ? this.statement(s.otherwise) : this.block(s.otherwise)), s.otherwise);
				// `if x is null { return }` narrows what follows.
				const thenExits = this.exits(s.then);
				const elseExits = s.otherwise && s.otherwise.kind !== 'If' && this.exits(s.otherwise);
				if (thenExits && !s.otherwise) for (const [b, t] of no) this.narrowed.set(b, t);
				if (elseExits && !thenExits) for (const [b, t] of yes) this.narrowed.set(b, t);
				return;
			}
			case 'For':
				this.forget(s.body);
				this.forSource = s.iterable;
				const source = this.expr(s.iterable);
				this.forSource = null;
				this.pattern(s.pattern, this.elementType(source, s.iterable));
				this.inLoop(s, () => this.narrowing(new Map(), () => this.block(s.body), s.body));
				return;
			case 'While':
				// The next time round, a local assigned in the loop may be `null` again.
				this.forget(s);
				this.condition(s.cond, '`while`');
				this.inLoop(s, () => this.narrowing(this.facts(s.cond, true), () => this.block(s.body), s.body));
				return;
			case 'DoWhile':
				this.forget(s);
				this.inLoop(s, () => this.narrowing(new Map(), () => this.block(s.body), s.body));
				this.condition(s.cond, '`while`');
				return;
			case 'Assign': {
				const target = this.expr(s.target);
				this.assignTarget(s.target);
				const value = this.expr(s.value, s.op === '=' ? target : null);
				const name = s.target.kind === 'Name' ? `\`${s.target.name}\`` : s.target.kind === 'Member' ? `\`${s.target.name}\`` : 'this';
				if (s.op === '=') this.expect(s.value, value, s.target.kind === 'Name' && s.target.ref ? (s.target.ref.type ?? target) : target, `${name} holds`);
				else this.arithmetic(s, s.op.slice(0, -1), s.target, target, s.value, value);
				// A `var` is what was last assigned to it: `x = "a"` narrows it, `x = null` doesn't.
				const b: Binding | undefined = s.target.kind === 'Name' ? s.target.ref : undefined;
				if (b && b.type?.k === 'nullable' && !b.mutCaptured) {
					if (s.op === '=' && value.k !== 'null' && value.k !== 'nullable' && value.k !== 'unknown') this.narrowed.set(b, nonNull(b.type));
					else this.narrowed.delete(b);
				}
				return;
			}
			case 'IncDec':
				this.expr(s.target);
				this.assignTarget(s.target);
				return;
		}
	}

	/** Whether the code being checked is inside `decl`'s own declaration, where its private members are visible. */
	inside(decl: Decl): boolean {
		const self = this.ctx.self;
		return self?.k === 'named' && declKey(self.decl) === declKey(decl);
	}

	/** A private member is used only inside its own type. */
	visible(m: Member, at: { line: number; col: number }) {
		if (m.node.vis !== 'private' || this.inside(m.owner)) return;
		this.error(at, `\`${m.node.name}\` is private to \`${m.owner.name}\`, so only its own code can use it`);
	}

	/** A field or an element being assigned: its owner has to be a place that can change. */
	assignTarget(target: Node) {
		if (target.kind === 'Member') this.fieldWrite(target);
		else if (target.kind === 'Index') this.mutableReceiver(target.object, 'assigning an element');
	}

	inLoop(loop: Node, f: () => void) {
		this.loops.push(loop);
		try {
			f();
		} finally {
			this.loops.pop();
		}
	}

	/**
	 * Something opened in a loop stays open until the unit of work ends, so each time round
	 * leaves one more open unless the loop closes it.
	 */
	openedInLoop(s: Node, call: Node) {
		const loop = this.loops[this.loops.length - 1];
		if (!loop || !this.opened.has(call)) return;
		if (s.pattern?.kind !== 'BindPattern') return;
		const name = s.pattern.name;
		if (!callsClose(loop.body, name)) {
			this.warning(s, `\`${name}\` is opened in a loop and not closed in it, so each time round leaves another one open until the unit of work ends: add \`defer ${name}.close()\` after it`);
		}
	}

	/** A writer only keeps what's written once it's closed, so one that's never closed loses it all. */
	unclosedWriter(s: Node, t: Type) {
		if (s.pattern?.kind !== 'BindPattern' || !this.fnBody || t.k !== 'named' || hasUnknown(t)) return;
		const writer = this.program.stdType('std.io', 'Writer');
		if (writer.k !== 'named' || !this.program.fits(t, writer)) return;
		const b: Binding | undefined = this.locals.get(`${s.pattern.line}:${s.pattern.col}`)?.[0];
		if (!b) return;
		const use = writerUse(this.fnBody, b);
		if (!use.closed && !use.escapes) {
			this.warning(s, `\`${s.pattern.name}\` is never closed, so what's written to it is discarded when the unit of work ends: finish with \`try ${s.pattern.name}.close()\``);
		}
	}

	/**
	 * A transaction keeps its work only once it's committed, and holds a connection until it
	 * ends, so one begun here is committed here, with its rollback deferred for the paths that
	 * don't reach the commit. One handed on, such as to a constructor, is the receiver's to end.
	 */
	unfinishedTransaction(s: Node, t: Type) {
		if (s.pattern?.kind !== 'BindPattern' || !this.fnBody || !isNamed(t, 'Tx') || t.k !== 'named' || !t.decl.file.endsWith('db.d.nibl')) return;
		const b: Binding | undefined = this.locals.get(`${s.pattern.line}:${s.pattern.col}`)?.[0];
		if (!b) return;
		const use = transactionUse(this.fnBody, b);
		if (use.escapes) return;
		const name = s.pattern.name;
		if (!use.committed) {
			this.warning(s, `\`${name}\` is never committed, so its work is rolled back when it ends: finish with \`try ${name}.commit()\``);
		} else if (!use.rollbackDeferred) {
			this.warning(s, `\`${name}\` has no \`defer ${name}.rollback()\`, so a failure before the commit leaves it open, holding its connection: add one after \`begin\``);
		}
	}

	/** Forgets what is known about the locals a loop assigns. */
	forget(node: Node) {
		for (const b of assignedIn(node)) {
			if (this.narrowed.delete(b)) this.unnarrowed.set(b, 'this loop assigns it, so it may be `null` again the next time round');
		}
	}

	/** What a `for` loop over a value of this type binds each time round. */
	elementType(t: Type, e: Node): Type {
		if (e.kind === 'Range') return this.program.preludeType('Int');
		const it = this.iteration(t);
		// A source that can fail partway is written `for x in try source` (#216).
		if (it && !isNamed(it.error, 'Never') && !hasUnknown(it.error) && e.kind !== 'Try') {
			this.error(e, `this can fail partway through, with ${a(it.error)}: write \`for … in try …\` to pass the error on`);
		}
		return it?.item ?? UNKNOWN;
	}

	/** What going through a value gives each time, and how it can fail, if it is iterable. */
	iteration(t: Type): { item: Type; error: Type } | null {
		if (t.k !== 'named') return null;
		const iterator = this.program.membersOf(t).members.get('iterator')?.find((m) => m.node.kind === 'Fn' && !m.node.isStatic);
		if (!iterator) return null;
		let ret = this.program.returnType(iterator.node, this.program.fnCtx(iterator, []));
		if (isNamed(ret, 'Result') && ret.k === 'named') ret = ret.args[0];
		if (ret.k !== 'named' || ret.decl.name !== 'Iterator') return null;
		return { item: ret.args[0] ?? UNKNOWN, error: ret.args[1] ?? this.program.preludeType('Never') };
	}

	// ---- fitting ------------------------------------------------------------------------

	/**
	 * Checks that an expression fits the type its position wants. `role` says whose type that
	 * is, as in "`amount` needs". A number literal takes the type it's used as, so it is
	 * checked against the type rather than by its own.
	 */
	expect(e: Node, actual: Type, to: Type, role: string) {
		if (to.k === 'unknown' || to.k === 'param') return;
		switch (e.kind) {
			case 'Paren':
				return this.expect(e.value, e.value.ty ?? actual, to, role);
			case 'Int':
			case 'Decimal':
				return this.literal(e, e.value, to, role);
			case 'Unary':
				if (e.op === '-' && (e.value.kind === 'Int' || e.value.kind === 'Decimal')) return this.literal(e, `-${e.value.value}`, to, role);
				break;
			case 'Binary':
				// `2 * 3` is as much a literal as `6`.
				if (ARITHMETIC.has(e.op) && literalLike(e)) {
					this.expect(e.left, e.left.ty ?? UNKNOWN, to, role);
					this.expect(e.right, e.right.ty ?? UNKNOWN, to, role);
					return;
				}
				break;
			case 'ListLit': {
				const target = nonNull(to);
				if (target.k === 'named' && isPrelude(target.decl) && (target.decl.name === 'List' || target.decl.name === 'Set')) {
					for (const item of e.items as Node[]) this.expect(item, item.ty ?? UNKNOWN, target.args[0] ?? UNKNOWN, `${role} ${a(target)}, so each item is`);
					return;
				}
				break;
			}
			case 'MapLit': {
				const target = nonNull(to);
				if (target.k === 'named' && isPrelude(target.decl) && target.decl.name === 'Map') {
					for (const x of e.entries as Node[]) {
						this.expect(x.key, x.key.ty ?? UNKNOWN, target.args[0] ?? UNKNOWN, `${role} ${a(target)}, so each key is`);
						this.expect(x.value, x.value.ty ?? UNKNOWN, target.args[1] ?? UNKNOWN, `${role} ${a(target)}, so each value is`);
					}
					return;
				}
				break;
			}
			case 'Ternary':
				this.expect(e.then, e.then.ty ?? UNKNOWN, to, role);
				this.expect(e.otherwise, e.otherwise.ty ?? UNKNOWN, to, role);
				return;
			case 'Match':
				for (const arm of e.arms as Node[]) if (arm.body.kind !== 'Block' && arm.body.kind !== 'Assign' && arm.body.kind !== 'IncDec') this.expect(arm.body, arm.body.ty ?? UNKNOWN, to, role);
				return;
			case 'Closure': {
				const step = this.lazyStep;
				this.lazyStep = null;
				// Its parameters' types come from where it is passed, which is checked later.
				const target = nonNull(to);
				if (target.k !== 'fn') break;
				if (e.params.length !== target.params.length) {
					const n = target.params.length;
					this.error(e, `this function takes ${e.params.length === 1 ? '1 parameter' : `${e.params.length} parameters`}, but ${role} one that takes ${n === 1 ? '1' : n}`);
					return;
				}
				const ret = isNamed(target.ret, 'Result') && target.ret.k === 'named' ? target.ret.args[0] : target.ret;
				// A function that can fail where one that can't is wanted.
				const own = actual.k === 'fn' && isNamed(actual.ret, 'Result') && actual.ret.k === 'named' ? actual.ret.args[1] : null;
				const allowed = isNamed(target.ret, 'Result') && target.ret.k === 'named' ? target.ret.args[1] : null;
				if (own && !hasUnknown(own) && !isNamed(own, 'Never') && (!allowed || isNamed(allowed, 'Never'))) {
					const why = step
						? `: \`${step}\` on an \`Iterable\` is lazy, so its function can't fail. Collect the items with \`toList()\` first, or write a generator`
						: '';
					this.error(e, `this function can fail with ${a(own)}, but ${role} one that can't${why}`);
					return;
				}
				if (!e.ret && e.body.kind !== 'Block' && !isNamed(ret, 'Void')) this.expect(e.body, e.body.ty ?? UNKNOWN, ret, 'the function passed here should return');
				return;
			}
		}
		if (this.program.fits(actual, to)) return;
		if (actual.k === 'null') {
			this.error(e, `this is \`null\`, but ${role} ${a(to)}, which can't be \`null\`: write \`${typeToString(to)}?\` if it may be missing`);
			return;
		}
		this.error(e, `this is ${a(actual)}, but ${role} ${a(to)}${this.hint(actual, to, e)}`);
	}

	/**
	 * What to do with a value that may be `null`. A local is checked with `is not null`; a
	 * field or getter can change after it is tested, so it is put in a `let` first.
	 */
	nullHint(e: Node | undefined, t: Type): string {
		const target = e?.kind === 'Paren' ? e.value : e;
		const text = target ? exprText(target) : '';
		if (target?.kind === 'Member' && text) {
			return `a field or getter can change after it is tested, so put it in a \`let\` first, as \`let ${target.name} = ${text}\`, then test \`${target.name} is not null\`, or give a fallback with \`??\``;
		}
		return `check it with \`${text || '…'} is not null\` first, or give a fallback with \`??\``;
	}

	/** How to fix a `Result` where its success value was wanted. */
	get tryFix(): string {
		return this.inOperand ? 'give it its own `try`, since one `try` covers one call' : 'put `try` in front, or handle the error with `catch`';
	}

	/** What to do about a value that doesn't fit. */
	hint(from: Type, to: Type, e?: Node): string {
		const p = this.program;
		if (from.k === 'nullable' && p.fits(from.inner, to)) return `: ${this.nullHint(e, from)}`;
		const source = nonNull(from);
		const target = nonNull(to);
		if (isNamed(source, 'Result') && source.k === 'named' && p.fits(source.args[0], to)) {
			return `: the call can fail, so ${this.tryFix}`;
		}
		if (target.k === 'named' && target.decl.node.typeKind === 'type' && p.fits(source, p.widen(target))) {
			const name = target.decl.name;
			if (!target.decl.node.privateWrap) return `: wrap it, as \`${name}(…)\``;
			const parse = p.membersOf(target).members.has('parse');
			return `: only \`${name}\`'s own functions can make one${parse ? `, so use \`${name}.parse(…)\`` : ''}`;
		}
		if (isTime(source, 'Period') && isTime(target, 'Duration')) {
			return ': a period is calendar time, so its length depends on the zone; add it to a date in a zone, as `instant.in(zone).date.plus(…)`';
		}
		if (source.k === 'named' && target.k === 'named') {
			const convert = `to${target.decl.name}`;
			if (this.converts(source, convert)) return `: ${a({ ...source, args: [] })} doesn't become ${a(target)} by itself, so convert it with \`.${convert}()\``;
			if (target.decl.node.typeKind === 'interface') {
				if ((isNamed(target, 'Equatable') || isNamed(target, 'Hashable')) && p.structural(source, target.decl.name)) {
					const field = p.unfitField(source, target);
					if (field) return field.name ? `, because its field \`${field.name}\` is ${a(field.type)}, which isn't` : `, because ${a(field.type)} isn't`;
				}
				// For a collection, the item type is the one to fix.
				if (isPrelude(source.decl) && ['List', 'Set', 'Map'].includes(source.decl.name)) {
					const item = source.args.find((x) => !p.fits(x, target));
					return item ? this.hint(item, target) : '';
				}
				const attr = p.attributeFor(target);
				if (attr === 'loggable' && ['record', 'class'].includes(source.decl.node.typeKind)) {
					return `: a record or class of your own may hold personal data, so it's logged only when it's marked \`@loggable\`; log what you need from it, such as its ID, or mark \`${source.decl.name}\` \`@loggable\``;
				}
				if (attr === 'loggable' && source.decl.node.typeKind === 'enum') {
					const field = p.unfitField(source, target);
					if (field) return `: ${a(field.type)} in one of its variants isn't loggable, so the enum isn't either`;
				}
				if (attr) return `: mark \`${source.decl.name}\` \`@${attr}\` to make it one`;
				return `: \`${source.decl.name}\` doesn't implement \`${target.decl.name}\``;
			}
		}
		return '';
	}

	/** Whether a type has a method `name` that takes no arguments, as `toDecimal()`. */
	converts(t: Type & { k: 'named' }, name: string): boolean {
		return (this.program.membersOf(t).members.get(name) ?? []).some((m) => m.node.kind === 'Fn' && !m.node.isStatic && paramsOf(m.node).every((x) => x.optional));
	}

	/** A number literal where a type is expected: the type must be a number type it fits in. */
	literal(e: Node, text: string, to: Type, role: string) {
		const target = nonNull(to);
		const isInteger = !text.includes('.');
		if (target.k !== 'named' || !isPrelude(target.decl) || !NUMBER_TYPES.has(target.decl.name)) {
			const actual = literalType(this.program, e);
			if (!this.program.fits(actual, to)) this.error(e, `this is ${a(actual)}, but ${role} ${a(to)}${this.hint(actual, to)}`);
			return;
		}
		const name = target.decl.name;
		const range = INTEGER_RANGES[name];
		if (!range) return;
		if (!isInteger) {
			this.error(e, `\`${text}\` has a point, but ${role} ${a(target)}, which is a whole number`);
			return;
		}
		const value = BigInt(text.replace(/_/g, '').replace(/^-0([xb])/, '-0$1'));
		if (value < range[0] || value > range[1]) this.error(e, `\`${text}\` doesn't fit in ${a(target)}, which holds ${range[0]} to ${range[1]}`);
	}

	/** `if`, `while`, `and`, `or` and `not` take a `Bool`. */
	condition(e: Node, what: string): Type {
		const t = this.expr(e);
		this.expect(e, t, this.program.preludeType('Bool'), `${what} needs`);
		return t;
	}

	/**
	 * Arithmetic: both sides are one number type, after a distinct type widens to its base,
	 * and `/` is only for `Float`. A distinct type has arithmetic only if it implements
	 * `Numeric`, and never with another distinct type; `+` and `-` between two of one type,
	 * or one and a literal, keep it. Gives the type of the result.
	 */
	arithmetic(at: Node, op: string, left: Node, l: Type, right: Node, r: Type): Type {
		const p = this.program;
		const distinct = (t: Type): t is Type & { k: 'named' } => t.k === 'named' && t.decl.node.typeKind === 'type' && !isSensitive(t.decl);
		const sides = [isLiteralNode(left) ? null : nonNull(l), isLiteralNode(right) ? null : nonNull(r)];
		const kinds = sides.filter((t): t is Type & { k: 'named' } => t !== null && distinct(t));
		const identity = kinds.find((t) => !p.isNumber(t));
		if (identity) {
			this.error(at, `${a(identity)} is an identity, not a number, so it has no \`${op}\`: a distinct type has arithmetic only when it's declared \`implements Numeric\``);
			return UNKNOWN;
		}
		if (kinds.length === 2 && typeKey(kinds[0]) !== typeKey(kinds[1])) {
			this.error(at, `\`${op}\` needs both sides to be one type, but this is ${a(kinds[0])} and ${a(kinds[1])}, which are different kinds of number`);
			return UNKNOWN;
		}
		const result = this.numbers(at, op, left, l, right, r);
		// `qty + qty` and `qty - 1` are still a `Qty`; `qty * qty` and `qty + n` give the base.
		const keep = kinds.length > 0 && (op === '+' || op === '-') && sides.every((t) => t === null || distinct(t));
		return keep && result.k !== 'unknown' ? kinds[0] : result;
	}

	/** Arithmetic between number types, after a distinct type widens to its base. */
	numbers(at: Node, op: string, left: Node, l: Type, right: Node, r: Type): Type {
		const p = this.program;
		// A literal takes the type of the other side; with two literals, one with a point makes both `Decimal`.
		const literals = isLiteralNode(left) && isLiteralNode(right);
		const both = literals && (isNamed(l, 'Decimal') || isNamed(r, 'Decimal')) ? p.preludeType('Decimal') : null;
		const lw = both ?? p.widen(nonNull(isLiteralNode(left) && !isLiteralNode(right) ? r : l));
		const rw = both ?? p.widen(nonNull(isLiteralNode(right) && !isLiteralNode(left) ? l : r));
		const number = (t: Type) => t.k === 'named' && isPrelude(t.decl) && NUMBER_TYPES.has(t.decl.name);
		if (number(lw) && number(rw) && typeKey(lw) !== typeKey(rw) && lw.k === 'named' && rw.k === 'named') {
			const convert = `to${rw.decl.name}`;
			const how = this.converts(lw, convert) ? `: convert one, as \`.${convert}()\`` : '';
			this.error(at, `\`${op}\` needs both sides to be one type, but this is ${a(lw)} and ${a(rw)}${how}`);
			return UNKNOWN;
		}
		if (isNamed(lw, 'String') || isNamed(rw, 'String')) {
			this.error(at, op === '+' ? 'there is no `+` on text: interpolate, as `"${a}${b}"`, or join a list with `join`' : `text has no \`${op}\``);
			return p.preludeType('String');
		}
		// Arithmetic operators are for numbers only; other types, the stdlib's included, name their
		// arithmetic as methods (`plus`, `minus`, `times`, `dividedBy`).
		const other = [lw, rw].find((t) => t.k === 'named' && !number(t) && !isNamed(t, 'Never'));
		if (other) {
			this.error(at, `${a(other)} has no \`${op}\`: arithmetic operators are for numbers only, so use a method${METHOD_FOR[op] ? `, such as \`${METHOD_FOR[op]}\`` : ''}`);
			return UNKNOWN;
		}
		if (op === '/' && number(lw) && lw.k === 'named') {
			const name = lw.decl.name;
			if (name === 'Decimal') {
				this.error(at, `a \`Decimal\` has no \`/\`, because most divisions don't end: use \`dividedBy(divisor, places: …, rounding: …)\`${literals ? ', or write `Float` where these numbers are declared if an approximate answer is what you want' : ''}`);
			} else if (INTEGER_RANGES[name]) {
				this.error(at, `${a(lw)} has no \`/\`: divide whole numbers with \`div\`, and get the remainder with \`mod\``);
			}
		}
		if (lw.k === 'unknown' || rw.k === 'unknown') return UNKNOWN;
		return typeKey(lw) === typeKey(rw) ? lw : UNKNOWN;
	}

	/** A type written in a declaration: each type's arguments meet its parameters' constraints, and are all written or none. */
	written(t: Node | null) {
		if (!t) return;
		switch (t.kind) {
			case 'NullableType':
				return this.written(t.inner);
			case 'TupleType':
				return t.items.forEach((x: Node) => this.written(x));
			case 'FnType':
				t.params.forEach((x: Node) => this.written(x));
				this.written(t.ret);
				this.written(t.err);
				this.errorType(t.err, 'a function of this type');
				return;
			case 'NamedType': {
				(t.args as Node[]).forEach((x) => this.written(x));
				if (t.args.length === 0) return;
				const resolved = this.resolve({ ...t, args: [] });
				if (resolved.k !== 'named') return;
				const decl = resolved.decl;
				const params = (decl.node.typeParams ?? []) as Node[];
				const required = params.filter((p) => !p.defaultType).length;
				if (t.args.length < required || t.args.length > params.length) {
					const count = required === params.length ? `${params.length}` : `${required} to ${params.length}`;
					this.error(t, `\`${decl.name}\` takes ${count} type ${params.length === 1 ? 'argument' : 'arguments'}, but this gives ${t.args.length}`);
					return;
				}
				const args = (t.args as Node[]).map((x) => this.resolve(x));
				this.constraints(t, decl.name, params, args, this.program.ctxFor(decl, args, null));
				return;
			}
		}
	}

	/** What a function fails with implements `Error` (#236), so every error has a message and a chain of causes. */
	errorType(t: Node | null, what: string) {
		if (!t) return;
		const p = this.program;
		const error = p.preludeType('Error');
		const resolved = this.resolve(t);
		if (resolved.k === 'param') {
			const name = t.kind === 'NamedType' ? t.path[0] : resolved.name;
			const constraints = (this.typeConstraints.get(name) ?? []).map((c) => this.resolve(c));
			if (constraints.some((c) => c.k === 'unknown' || p.fits(c, error) || (c.k === 'named' && p.supertypes(c).types.some((s) => isNamed(s, 'Error'))))) return;
			this.error(t, `${what} fails with \`${name}\`, so \`${name}\` has to be an \`Error\`: declare it as \`${name}: Error\``);
			return;
		}
		if (resolved.k !== 'named' || hasUnknown(resolved) || p.fits(resolved, error)) return;
		const local = p.moduleOf(resolved.decl) === this.file.module || (p.fileOf(resolved.decl) && !isPrelude(resolved.decl) && !resolved.decl.file.includes('/std/'));
		this.error(t, `${what} fails with ${a(resolved)}, which doesn't implement \`Error\`: every error type does, so it has a \`message\` for logs and a chain of causes${local ? `; add \`implements Error\` to \`${resolved.decl.name}\`, with a \`message\`` : ''}`);
	}

	/** Each type argument fits its parameter's constraints (`K: Hashable`). */
	constraints(at: { line: number; col: number }, owner: string, params: Node[], args: Type[], ctx: Ctx) {
		params.forEach((p, i) => {
			const arg = args[i];
			if (!arg || arg.k === 'unknown' || arg.k === 'param') return;
			for (const c of p.constraints as Node[]) {
				const want = this.program.resolve(c, ctx);
				if (hasUnknown(want) || this.program.fits(arg, want)) continue;
				this.error(at, `\`${owner}\` needs its \`${p.name}\` to be \`${typeToString(want)}\`, and \`${typeToString(arg)}\` isn't${this.hint(arg, want)}`);
			}
		});
	}

	// ---- routes -------------------------------------------------------------------------

	/** Finds the route tables in a file and checks each route against its full pattern (#220, #221). */
	routeTables(node: unknown, depth = 0) {
		if (depth > 200 || !node || typeof node !== 'object') return;
		if (Array.isArray(node)) {
			for (const x of node) this.routeTables(x, depth + 1);
			return;
		}
		const n = node as Node;
		if (n.kind === 'Call' && n.route) {
			this.route(n, { prefix: '', guards: [] });
			return;
		}
		for (const [k, v] of Object.entries(n)) if (k !== 'ty' && k !== 'ref' && k !== 'chosen' && k !== 'fnNode' && k !== 'route' && typeof v === 'object') this.routeTables(v, depth + 1);
	}

	/**
	 * One route or group. `prefix` is the groups' prefixes so far, and `guards` the guards
	 * around it, outermost first: what each gives, and the path parameters it takes.
	 */
	route(e: Node, ctx: { prefix: string; guards: RouteGuardInfo[] }) {
		const args: Map<string, Node> = e.route.args;
		const kind: string = e.route.kind;
		if (kind === 'group') {
			const prefix = args.has('prefix') ? this.patternText(args.get('prefix')!) : '';
			if (prefix === null) return;
			let next = { prefix: ctx.prefix + prefix, guards: ctx.guards };
			const requiring = args.get('requiring');
			if (requiring) {
				// A guard takes what a handler would, and its value goes to everything inside.
				const checked = this.handler(requiring, ctx.guards, next.prefix, 'guard');
				const type = checked?.value ?? UNKNOWN;
				const name = checked?.name ?? 'the guard';
				// A `@guard` parameter is matched by type, so two guards around a route can't give the same one.
				const clash = type.k === 'unknown' ? undefined : ctx.guards.find((g) => g.type.k !== 'unknown' && (this.program.fits(type, g.type) || this.program.fits(g.type, type)));
				if (clash) this.error(requiring, `\`${clash.name}\` and \`${name}\` both give ${a(type)} to the routes inside, so a \`@guard\` parameter couldn't tell them apart: give one a type of its own that says what it proved, as \`type Admin: User\``);
				next = { ...next, guards: [...ctx.guards, { type, name, took: checked?.took ?? [] }] };
			}
			const routes = args.get('routes');
			if (routes?.kind === 'ListLit') for (const item of routes.items as Node[]) if (item.kind === 'Call' && item.route) this.route(item, next);
			return;
		}
		const patternNode = args.get('pattern');
		if (!patternNode) return;
		const pattern = this.patternText(patternNode);
		if (pattern === null) return;
		const full = ctx.prefix + pattern;
		// An events or WebSocket route answers a GET, and its handler gets the stream after the request.
		const stream = kind === 'events' ? 'EventSink' : kind === 'websocket' ? 'WebSocket' : null;
		const methods = kind === 'on' ? this.methodsOf(args.get('methods')) : stream ? ['GET'] : [kind.toUpperCase()];
		for (const method of methods) {
			const key = `${method} ${full.replace(/\{[^}]*\}/g, '{}')}`;
			const seen = this.routeKeys.get(key);
			if (seen !== undefined) this.error(patternNode, `\`${method} ${full}\` is already a route, on line ${seen}: each method and full pattern, prefixes included, has one handler`);
			else this.routeKeys.set(key, patternNode.line);
		}
		const handler = args.get('handler');
		if (handler) this.handler(handler, ctx.guards, full, 'handler', stream);
	}

	/** A pattern or prefix, which must be a plain literal so the compiler can read it; null if it isn't. */
	patternText(e: Node): string | null {
		if (e.kind === 'Str' && !e.tag && e.parts.every((x: unknown) => typeof x === 'string')) return e.parts.join('');
		this.error(e, "a route's pattern is written as a plain string, with no `${…}`, so its handler can be checked against it");
		return null;
	}

	/** The methods of a `Route.on(…)`, if they are written as a list of `Method.X`. */
	methodsOf(e: Node | undefined): string[] {
		if (e?.kind !== 'ListLit') return [];
		return (e.items as Node[]).filter((x) => x.kind === 'Member').map((x) => x.name.toUpperCase());
	}

	/**
	 * A handler or guard against its route. It takes the request if it reads it, then `@guard` parameters,
	 * each matched by type to one guard around it, in the order they run, then `@path`
	 * parameters, each matched by name to a `{name}` in the pattern so far, in the pattern's
	 * order and `Parseable`. Each of a handler's path parameters is taken by it or by a guard
	 * around it. It gives a `Response` (a guard: its value), failing with a `ToResponse`.
	 * Gives what it gives, its name and the path parameters it takes.
	 */
	handler(arg: Node, guards: RouteGuardInfo[], pattern: string, role: 'handler' | 'guard', stream: 'EventSink' | 'WebSocket' | null = null): { value: Type; name: string; took: string[] } | null {
		const p = this.program;
		// The argument is a function of the container, `fn(app) => app.checkout.show`; what it gives is the handler.
		const outer = arg.ty;
		if (outer?.k !== 'fn' || outer.ret.k !== 'fn') return null;
		const fn = outer.ret;
		const body = arg.kind === 'Closure' && arg.body.kind !== 'Block' ? arg.body : arg;
		const decl: Node | undefined = body.fnNode;
		if (!decl) return null;
		const name = `\`${decl.name}\``;
		const at = arg;
		const types = fn.params;
		const params = pathParams(pattern);
		// The request comes first, and only if it's read: a handler that doesn't read it leaves it out.
		const request = p.stdType('std.http', 'Request');
		const reads = types.length > 0 && types[0].k !== 'unknown' && p.fits(request, types[0]);
		const sinkAt = reads ? 1 : 0;
		const parseable = p.preludeType('Parseable');
		const given = (g: RouteGuardInfo) => `${a(g.type)} (\`${g.name}\`)`;
		const around = guards.length === 0 ? `no guard around \`${pattern}\` gives one: put the route in a group with \`requiring:\` and a guard that does` : `the guards around \`${pattern}\` give ${andList(guards.map(given))}`;
		const took: string[] = [];
		let lastGuard = -1;
		let lastPath = -1;
		let pathSeen = false;
		const decls = decl.params as Node[];
		if (stream && decls.length <= sinkAt) {
			this.error(at, `${name} is an ${stream === 'EventSink' ? 'events' : 'WebSocket'} route's handler, so it takes the \`${stream}\`, after the request if it reads it`);
			return null;
		}
		for (let k = 0; k < decls.length; k++) {
			const param = decls[k];
			const t = types[k] ?? UNKNOWN;
			const marks = ((param.attrs ?? []) as Node[]).map((x) => x.name).filter((x) => x === 'guard' || x === 'path');
			if (k === 0 && reads) {
				if (marks.length > 0) this.error(at, `${name}'s first parameter, \`${param.name}\`, is the request, which isn't marked`);
				else if (param.name === '_') this.error(at, `${name} doesn't read the request, so it leaves it out: a ${role} takes the request only when it reads it`);
				continue;
			}
			if (k === sinkAt && stream) {
				if (!p.fits(t, p.stdType('std.http', stream))) {
					this.error(at, `${name} is an ${stream === 'EventSink' ? 'events' : 'WebSocket'} route's handler, so it takes the \`${stream}\`, after the request if it reads it: \`${param.name}: ${stream}\``);
					return null;
				}
				if (marks.length > 0) this.error(at, `${name}'s parameter \`${param.name}\` is the \`${stream}\`, which isn't marked`);
				continue;
			}
			const inPattern = params.includes(param.name);
			const from = guards.filter((g) => g.type.k === 'unknown' || t.k === 'unknown' || p.fits(g.type, t));
			if (marks.length !== 1) {
				if (inPattern) this.error(at, `${name}'s parameter \`${param.name}\` is \`{${param.name}}\` in \`${pattern}\`, so it's marked \`@path\`: \`@path ${param.name}: ${typeToString(t)}\``);
				else if (from.length === 1) this.error(at, `${name}'s parameter \`${param.name}\` is what the guard \`${from[0].name}\` gives, so it's marked \`@guard\`: \`@guard ${param.name}: ${typeToString(t)}\``);
				else this.error(at, `${name} takes \`${param.name}\`, but nothing gives it: \`${pattern}\` has no \`{${param.name}}\`, and ${guards.length === 0 ? `no guard around it gives ${a(t)}: if it is what a guard proves, such as the signed-in user, put the route in a group with \`requiring:\`` : around}`);
				return null;
			}
			if (marks[0] === 'guard') {
				if (from.length === 0) {
					if (inPattern) this.error(at, `${name}'s parameter \`${param.name}\` is \`{${param.name}}\` in \`${pattern}\`, so it's marked \`@path\`: \`@path ${param.name}: ${typeToString(t)}\``);
					else this.error(at, `${name}'s parameter \`${param.name}\` is marked \`@guard\`, so a guard around the route gives it, but ${guards.length === 0 ? `no guard around \`${pattern}\` gives ${a(t)}: put the route in a group with \`requiring:\` and a guard that does` : `none gives ${a(t)}: ${around}`}`);
					return null;
				}
				if (from.length > 1) {
					this.error(at, `${name}'s parameter \`${param.name}\` is ${a(t)}, which ${andList(from.map(given))} ${from.length === 2 ? 'both' : 'all'} give: ask for the type one of them gives`);
					return null;
				}
				if (pathSeen) {
					this.error(at, `${name}'s \`@guard\` parameters come before its \`@path\` ones, so \`${param.name}\` goes before the first \`@path\` one`);
					return null;
				}
				const index = guards.indexOf(from[0]);
				if (index < lastGuard) {
					this.error(at, `${name}'s \`@guard\` parameters are in the order their guards run, so \`${param.name}\`, from \`${from[0].name}\`, goes before the one from \`${guards[lastGuard].name}\``);
					return null;
				}
				lastGuard = index;
				continue;
			}
			if (!inPattern) {
				this.error(at, `${name}'s parameter \`${param.name}\` is marked \`@path\`, but \`${pattern}\` has no \`{${param.name}}\`: path parameters are matched by name`);
				return null;
			}
			const index = params.indexOf(param.name);
			if (index < lastPath) {
				this.error(at, `${name}'s \`@path\` parameters are in the pattern's order (\`${pattern}\`), so \`${param.name}\` goes before \`${params[lastPath]}\``);
				return null;
			}
			lastPath = index;
			pathSeen = true;
			if (t.k !== 'unknown' && !p.fits(t, parseable)) {
				this.error(at, `\`${param.name}\` is ${a(t)}, which doesn't implement \`Parseable\`, so it can't be read from the path: use a type that does, such as a distinct type that \`implements Parseable\``);
				return null;
			}
			took.push(param.name);
		}
		if (role === 'handler') {
			const missing = params.filter((x) => !took.includes(x) && !guards.some((g) => g.took.includes(x)));
			if (missing.length > 0) {
				this.error(at, `\`${pattern}\` gives ${andList(missing.map((x) => `\`${x}\``))}, which neither ${name} nor a guard around it takes: add ${missing.length === 1 ? 'a parameter' : 'parameters'} to ${name}, as \`@path ${missing[0]}: …\``);
				return null;
			}
		}
		// What it gives: a `Response` for a handler; anything for a guard, which is its value.
		const value = isNamed(fn.ret, 'Result') && fn.ret.k === 'named' ? fn.ret.args[0] : fn.ret;
		const error = isNamed(fn.ret, 'Result') && fn.ret.k === 'named' ? fn.ret.args[1] : null;
		const toResponse = p.stdType('std.http', 'ToResponse');
		if (error && !p.fits(error, toResponse)) this.error(at, `${name} fails with ${a(error)}, which doesn't implement \`ToResponse\`, so the router can't answer with it`);
		if (role === 'handler' && stream && !isNamed(value, 'Void')) this.error(at, `${name} gives ${a(value)}, but an ${stream === 'EventSink' ? 'events' : 'WebSocket'} route's handler gives nothing: it sends through its \`${stream}\``);
		else if (role === 'handler' && !stream && !p.fits(value, p.stdType('std.http', 'Response'))) this.error(at, `${name} gives ${a(value)}, but a route's handler gives a \`Response\``);
		return { value, name: decl.name, took };
	}

	// ---- errors -------------------------------------------------------------------------

	/** `${x}` takes a `Stringable`, or `Html` and `List<Html>` inside `html"…"` (#215). */
	interpolated(e: Node, t: Type, tag: string | null | undefined, secret = false) {
		const html = tag === 'html';
		const target = e.kind === 'Paren' ? e.value : e;
		// `.revealed` is for handing a secret to code that needs its text, not for writing it out.
		if ((!tag || html) && !secret) this.revealedText(target, html ? 'on a page' : 'into a plain string');
		if (!t || t.k === 'unknown' || t.k === 'param' || hasUnknown(t)) return;
		const p = this.program;
		const sensitive = p.preludeType('Sensitive');
		if (t.k === 'named' && p.fits(t, sensitive)) {
			if (tag === 'secret' || secret) return;
			const fix = tag === 'url' || tag === 'html' ? `make the literal secret too: \`secret ${tag}"…"\`` : tag ? 'pass it to a function that takes a `Sensitive`' : 'build a `Secret` with `secret"…"`, or pass it to a function that takes a `Sensitive`';
			this.error(e, `${a(t)} is a secret, so it can't go in ${tag ? `\`${tag}"…"\`` : 'a plain string'}: ${fix}`);
			return;
		}
		const markup = p.stdType('std.html', 'Html');
		if (html && (p.fits(t, markup) || (isNamed(t, 'List') && t.k === 'named' && t.args[0] && p.fits(t.args[0], markup)))) return;
		if (t.k === 'nullable') {
			this.error(e, `this may be \`null\`, which has no text: give a fallback with \`??\`, or test it first`);
			return;
		}
		if (p.fits(t, p.preludeType('Stringable'))) return;
		this.error(e, `${a(t)} isn't \`Stringable\`, so it can't go in \`\${…}\`: use one of its members that is text, or implement \`Stringable\``);
	}

	/** A secret's `revealed` text written straight out, where the secret would no longer be redacted. */
	revealedText(e: Node, where: string) {
		if (e.kind !== 'Member' || e.name !== 'revealed') return;
		const object = e.object.ty;
		if (!object || object.k === 'unknown' || hasUnknown(object)) return;
		if (!this.program.fits(nonNull(object), this.program.preludeType('Sensitive'))) return;
		this.error(e, `this writes a secret's text ${where}, where it would no longer be redacted: ${where === 'into a log' ? 'log the secret itself, which shows as `[redacted]`' : 'build a `Secret` with `secret"…"`, or pass the secret itself to a function that takes a `Sensitive`'}`);
	}

	/** Every `.revealed` in a log call's arguments, outside closures. */
	revealedInLog(e: Node) {
		const walk = (n: unknown) => {
			if (!n || typeof n !== 'object') return;
			if (Array.isArray(n)) return n.forEach(walk);
			const node = n as Node;
			if (node.kind === 'Closure') return;
			if (node.kind === 'Member' && node.name === 'revealed') this.revealedText(node, 'into a log');
			for (const [k, v] of Object.entries(node)) if (k !== 'ty' && k !== 'ref' && v && typeof v === 'object') walk(v);
		};
		walk(e.args);
	}

	/** An error's `message` is for developers and logs, never shown to people (#229). */
	forPeople(e: Node, where: string) {
		const target = e.kind === 'Paren' ? e.value : e;
		if (target.kind !== 'Member' || target.name !== 'message') return;
		const object = target.object.ty;
		if (!object || object.k === 'unknown' || hasUnknown(object)) return;
		if (!this.program.fits(nonNull(object), this.program.preludeType('Error'))) return;
		this.error(target, `an error's \`message\` is for developers and logs, so it doesn't go on ${where}: choose the words here, by what went wrong (match on the error), and log the error if it helps`);
	}

	/**
	 * The errors a `try` passes on must fit what the function fails with, directly or
	 * through exactly one variant that takes them with `from` (#52b).
	 */
	propagate(at: Node, errors: Type[]) {
		const top = this.returns[this.returns.length - 1];
		if (!top || top.error === undefined || errors.length === 0) return;
		const known = errors.filter((x) => !hasUnknown(x));
		if (top.error === null) {
			const names = [...new Set(known.map(typeToString))];
			this.error(at, `${top.name} can't fail, so this \`try\` has nowhere to pass ${names.length > 0 ? `a \`${names.join('` or `')}\`` : 'an error'}: add \`else ${names[0] ?? '…'}\` to its signature, or handle the error here with \`catch\``);
			return;
		}
		if (hasUnknown(top.error)) return;
		const target = top.error;
		for (const err of new Map(known.map((x) => [typeKey(x), x])).values()) {
			if (this.handledAtCall(at, err, target, 'try')) continue;
			if (this.program.fits(err, target)) continue;
			const variants = this.fromVariants(target, err);
			if (variants.length === 1) continue;
			if (variants.length > 1) {
				this.error(at, `more than one variant of \`${typeToString(target)}\` takes a \`${typeToString(err)}\` with \`from\` (${andList(variants.map((v) => `\`${v}\``))}), so \`try\` can't choose: convert it here with \`catch err { fail … }\``);
			} else {
				this.error(at, `this \`try\` passes on ${a(err)}, but ${top.name} fails with ${a(target)}, which can't hold one: add a variant that takes it, as \`${errName(err)}(from ${typeToString(err)})\`, or convert it here with \`catch err { fail … }\``);
			}
		}
	}

	/**
	 * An error that's `HandledAtCall`, such as a `FormError`, is caught straight after the call.
	 * It's passed on only to a function that fails with that kind of error itself. Reports it
	 * and says true when it's passed anywhere else.
	 */
	handledAtCall(at: Node, err: Type, target: Type, how: 'try' | 'fail'): boolean {
		const p = this.program;
		const handled = p.preludeType('HandledAtCall');
		if (handled.k !== 'named' || err.k !== 'named' || !p.fits(err, handled)) return false;
		if (p.fits(err, target) && p.fits(target, handled)) return false;
		const verb = how === 'try' ? 'this `try` passes on' : 'this `fail` passes on';
		this.error(at, `${verb} ${a(err)}, which is handled where it happens: \`catch\` it straight after the call${how === 'try' ? ', as `… catch err { … }`' : ''}`);
		return true;
	}

	/**
	 * The variants of an error enum that take `err` with `from`. A variant that takes any
	 * `Error` is used only when no other variant takes it.
	 */
	fromVariants(target: Type, err: Type): string[] {
		if (target.k !== 'named' || target.decl.node.typeKind !== 'enum') return [];
		const known: string[] = [];
		const unsure: string[] = [];
		const any: string[] = [];
		for (const [name, ms] of this.program.membersOf(target).members) {
			for (const m of ms) {
				if (m.node.kind !== 'Variant' || !m.node.from) continue;
				const from = this.program.resolve(m.node.from, m.ctx);
				if (!this.program.fits(err, from)) continue;
				const variant = `${target.decl.name}.${name}`;
				// A type from a dependency isn't known, so it fits anything; count it only if nothing else does.
				(isNamed(from, 'Error') && from.k === 'named' && from.decl === this.program.preludeType('Error').decl ? any : hasUnknown(from) ? unsure : known).push(variant);
			}
		}
		if (known.length > 0) return known;
		return unsure.length > 0 ? unsure.slice(0, 1) : any;
	}

	/** `fail value`: the function can fail, and the value fits what it fails with. */
	failing(at: Node, t: Type) {
		this.raised.push(t);
		const top = this.returns[this.returns.length - 1];
		if (!top || top.error === undefined) return;
		if (top.error === null) {
			this.error(at, `${top.name} can't fail: add \`else ${t.k === 'unknown' ? '…' : typeToString(t)}\` to its signature`);
			return;
		}
		if (this.handledAtCall(at, t, top.error, 'fail')) return;
		// Like `try`, `fail` passes an error on through the one variant that takes it with `from`.
		if (!this.program.fits(t, top.error) && this.fromVariants(top.error, t).length === 1) return;
		this.expect(at.value, t, top.error, `${top.name} fails with`);
	}

	/** `a ?? b` handles `null` only (#161). */
	coalescing(e: Node, left: Type) {
		if (isNamed(left, 'Result') && left.k === 'named' && !hasUnknown(left.args[1])) {
			this.error(e, '`??` handles `null`, and this is an error result: handle the error with `catch`, or pass it on with `try`');
		} else if (left.k !== 'nullable' && left.k !== 'null' && !hasUnknown(left) && left.k !== 'param' && !isNamed(left, 'Never')) {
			this.warning(e, `this is ${a(left)}, which can't be \`null\`, so \`??\` never uses its right side`);
		}
		if (e.right.kind === 'Block' && !this.exits(e.right)) {
			this.error(e.right, 'this block runs when the value is `null`, so it has to leave, with `return`, `fail` or `panic`, or `break` or `continue` in a loop. To work out a value instead, declare it first with `let name: Type` and set it with `if`');
		}
	}

	/** A `Result` dropped by a statement, an error, or any other value that isn't `Void`, a warning. */
	dropped(e: Node, t: Type) {
		if (e.kind !== 'Else' && e.kind !== 'Try' && isNamed(t, 'Result') && t.k === 'named' && !hasUnknown(t.args[1])) {
			this.error(e, 'this can fail, and nothing handles its error: put `try` in front, handle it with `catch`, or write `let _ = …` to drop it on purpose');
			return;
		}
		const value = isNamed(t, 'Result') && t.k === 'named' ? t.args[0] : t;
		if (hasUnknown(value) || isNamed(value, 'Void') || isNamed(value, 'Never')) return;
		this.warning(e, `nothing uses this \`${typeToString(value)}\`: use it, or write \`let _ = …\` to drop it on purpose`);
	}

	/**
	 * A function whose body yields is a generator: it returns an `Iterable<T, E>`, its body runs
	 * as items are read, `yield` gives each `T`, and `try` and `fail` end it with an `E`.
	 */
	generator(node: Node, ret: Type, err: Type | null) {
		const name = `\`${node.name}\``;
		if (err) this.error(node.err, `${name} yields, so it's a generator, and a generator fails partway through its items: write the error in its type, as \`-> Iterable<T, E>\`, not after \`else\``);
		const iterable = ret.k === 'named' && isNamed(ret, 'Iterable') && isPrelude(ret.decl) ? ret : null;
		if (!iterable && ret.k !== 'unknown') this.error(node.ret ?? node, `${name} yields, so it's a generator, and returns an \`Iterable<T>\` (or \`Iterable<T, E>\` when it can fail partway), not ${a(ret)}`);
		const item = iterable?.args[0] ?? UNKNOWN;
		const error = iterable?.args[1] && !isNamed(iterable.args[1], 'Never') ? iterable.args[1] : null;
		this.generators.push(item);
		try {
			this.returning(this.program.preludeType('Void'), name, () => this.scoped(() => this.block(node.body)), error);
		} finally {
			this.generators.pop();
		}
	}

	// ---- narrowing ----------------------------------------------------------------------

	/** A local or parameter that a test can narrow: not a field, and not a `var` a closure may change. */
	narrowable(e: Node): Binding | null {
		if (e.kind === 'Paren') return this.narrowable(e.value);
		if (e.kind !== 'Name') return null;
		const b: Binding | undefined = e.ref;
		if (!b || (b.kind !== 'local' && b.kind !== 'param') || b.mutCaptured || b.declaredWith === 'const') return null;
		return b.type?.k === 'nullable' ? b : null;
	}

	/** What a condition proves about locals when it is `truth`: which are not `null`. */
	facts(cond: Node, truth: boolean): Map<Binding, Type> {
		const out = new Map<Binding, Type>();
		switch (cond.kind) {
			case 'Paren':
				return this.facts(cond.value, truth);
			case 'Not':
				return this.facts(cond.value, !truth);
			case 'Binary':
				if ((cond.op === 'and' && truth) || (cond.op === 'or' && !truth)) {
					for (const side of [cond.left, cond.right]) for (const [b, t] of this.facts(side, truth)) out.set(b, t);
				}
				return out;
			case 'Is': {
				const b = this.narrowable(cond.value);
				if (!b) return out;
				const p = cond.pattern;
				// `x is null` false, or `x is not null` true.
				const nullTest = p.kind === 'LiteralPattern' && p.value.kind === 'Null';
				if (nullTest && truth === cond.negated) out.set(b, nonNull(b.type!));
				return out;
			}
		}
		return out;
	}

	/** Runs `f` with what `facts` proves, then forgets it, and anything assigned inside. */
	narrowing<T>(facts: Map<Binding, Type>, f: () => T, body?: Node): T {
		const saved = new Map(this.narrowed);
		for (const [b, t] of facts) this.narrowed.set(b, t);
		try {
			return f();
		} finally {
			const assigned = body ? assignedIn(body) : new Set<Binding>();
			this.narrowed = new Map([...saved].filter(([b]) => !assigned.has(b) && this.narrowed.has(b)));
		}
	}

	/** Whether a block always leaves: it ends in `return`, `fail`, `break`, `continue`, or something of type `Never`. */
	exits(block: Node | null): boolean {
		const last: Node | undefined = block?.body?.[block.body.length - 1];
		if (!last) return false;
		switch (last.kind) {
			case 'Return':
			case 'Fail':
			case 'Break':
			case 'Continue':
				return true;
			case 'ExprStmt':
				return isNamed(last.value.ty ?? UNKNOWN, 'Never');
			case 'If':
				return !!last.otherwise && this.exits(last.then) && (last.otherwise.kind === 'If' ? this.exits({ body: [last.otherwise] } as Node) : this.exits(last.otherwise));
		}
		return false;
	}

	// ---- patterns -----------------------------------------------------------------------

	/** Gives the names a pattern binds their types, from the type of the value it matches. */
	pattern(p: Node, subject: Type) {
		switch (p.kind) {
			case 'BindPattern':
				this.declare(p, subject);
				return;
			case 'TuplePattern':
				(p.items as Node[]).forEach((item, i) => this.pattern(item, subject.k === 'tuple' ? subject.items[i] ?? UNKNOWN : UNKNOWN));
				return;
			case 'OrPattern':
				for (const a of p.alternatives) this.pattern(a, subject);
				return;
			case 'LiteralPattern':
				this.expr(p.value);
				if (p.value.kind === 'Null' && subject.k !== 'nullable' && subject.k !== 'null' && subject.k !== 'unknown' && subject.k !== 'param' && !hasUnknown(subject)) {
					this.error(p, `this can't be \`null\`, so there's nothing to test: use it as it is`);
				}
				return;
			case 'CtorPattern': {
				const { variant, type } = this.patternTarget(p, nonNull(subject));
				// A variant is written with its enum's name, in a pattern as in an expression. A bare
				// name can't be anything else, since a pattern never tests for a type.
				const onlyNull = !variant && subject.k === 'nullable' && type.k === 'named' && !p.args && sameType(type, nonNull(subject));
				if (p.path.length === 1 && !onlyNull) {
					const full = variant && type.k === 'named' ? `${type.decl.name}.${p.path[0]}` : `Enum.${p.path[0]}`;
					this.error(p, `write the variant with its enum's name, as \`${full}\`, so the line says what it is`);
				}
				// `x is User user`, where `x` is a `User?`, only tests for `null`.
				if (!variant && subject.k === 'nullable' && type.k === 'named' && !p.args && sameType(type, nonNull(subject))) {
					this.error(p, 'this only tests for `null`: write `is not null`, which narrows a local or a parameter, and put anything else in a `let` first');
				}
				const fields: Node[] = variant?.node.payload ?? [];
				const args = (p.args ?? []) as Node[];
				const shown = `${p.path[p.path.length - 1]}`;
				const ignored = !!variant && args.length > 0 && args.every((a) => a.pattern.kind === 'WildcardPattern' && !a.name);
				if (ignored) this.error(p, `\`${shown}\` on its own matches it whatever it holds, so leave out \`(_)\`: write \`${shown}\``);
				if (!ignored) args.forEach((a: Node, i: number) => {
					let t: Type = UNKNOWN;
					if (variant?.node.held && i === 0) {
						if (a.name) this.error(a, `\`${shown}\` holds one value without a name, so the pattern doesn't name it: \`${shown}(${a.name})\``);
						t = this.program.resolve(variant.node.held, variant.ctx);
					} else {
						const field = a.name ? fields.find((f) => f.name === a.name) : fields[i];
						if (variant && fields.length > 0 && !a.name && field) {
							const bound = a.pattern.kind === 'BindPattern' ? a.pattern.name : null;
							const fix = bound === field.name ? `${field.name}:` : bound ? `${field.name}: ${bound}` : `${field.name}: …`;
							this.error(a, `a pattern names a variant's values, as building one does: \`${fix}\``);
						} else if (variant && a.name && !field) {
							this.error(a, `\`${shown}\` has no value \`${a.name}\`${suggest(a.name, fields.map((f) => f.name))}`);
						} else if (a.name && a.pattern.kind === 'WildcardPattern') {
							this.error(a, `leave out a value the pattern doesn't need, rather than writing \`${a.name}: _\``);
						}
						if (field) t = this.program.resolve(field.type, variant!.ctx);
					}
					this.pattern(a.pattern, t);
				});
				if (p.binding) this.declare({ line: p.bindingLine, col: p.bindingCol }, type);
				this.testable(p, nonNull(subject), variant, type);
				return;
			}
		}
	}

	/** A constructor pattern names a variant of the value's enum, or tests for the value's own type (#234). */
	testable(p: Node, subject: Type, variant: Member | null, type: Type) {
		if (variant || subject.k !== 'named') return;
		const name: string = p.path[p.path.length - 1];
		if (p.path.length === 1 && subject.decl.node.typeKind === 'enum' && type.k === 'unknown') {
			const variants = (subject.decl.node.members as Node[]).filter((m) => m.kind === 'Variant').map((m) => m.name);
			this.error(p, `\`${subject.decl.name}\` has no variant \`${name}\`${suggest(name, variants)}`);
			return;
		}
		if (type.k !== 'named' || sameType(type, subject)) return;
		if (subject.decl.node.typeKind === 'interface') {
			this.error(p, `this is ${a(subject)}, an interface, so \`is\` can't test which type it holds: give \`${subject.decl.name}\` a method for what differs, or use an enum, whose \`match\` is checked for every case`);
		} else {
			this.error(p, `this is ${a(subject)}, so it is never ${a(type)}: \`is\` tests for \`null\`, a variant or a literal, not for another type`);
		}
	}

	/**
	 * What a set of patterns leaves out of a type, for exhaustiveness (#11): variants not
	 * matched, `null`, or "other values" for a type whose values can't all be listed. Where
	 * it can't tell, such as nested patterns over several fields, it gives the benefit of the
	 * doubt.
	 */
	uncovered(t: Type, patterns: Node[], depth = 0): string[] {
		const pats = patterns.flatMap((p) => (p.kind === 'OrPattern' ? p.alternatives : [p]));
		if (depth > 5 || pats.some(irrefutable) || t.k === 'unknown' || t.k === 'param' || hasUnknown(t)) return [];
		if (t.k === 'nullable') {
			const isNull = (p: Node) => p.kind === 'LiteralPattern' && p.value.kind === 'Null';
			return [...(pats.some(isNull) ? [] : ['`null`']), ...this.uncovered(t.inner, pats.filter((p) => !isNull(p)), depth + 1)];
		}
		if (t.k !== 'named') return [];
		if (isNamed(t, 'Bool') && isPrelude(t.decl)) {
			return ['true', 'false'].filter((v) => !pats.some((p) => p.kind === 'LiteralPattern' && p.value.kind === 'Bool' && String(p.value.value) === v)).map((v) => `\`${v}\``);
		}
		if (t.decl.node.typeKind !== 'enum') {
			// A type test for the value's own type covers it; literals never cover every value.
			if (pats.some((p) => p.kind === 'CtorPattern' && !p.args)) return [];
			return pats.length > 0 && pats.every((p) => p.kind === 'LiteralPattern') ? ['other values'] : [];
		}
		const missing: string[] = [];
		const ctx = this.program.ctxFor(t.decl, t.args, t);
		for (const v of (t.decl.node.members as Node[]).filter((m) => m.kind === 'Variant')) {
			const these = pats.filter((p) => p.kind === 'CtorPattern' && p.path[p.path.length - 1] === v.name && (p.path.length === 1 || p.path[p.path.length - 2] === t.decl.name));
			const label = `\`${t.decl.name}.${v.name}${v.payload || v.held ? '(…)' : ''}\``;
			if (these.length === 0) {
				missing.push(label);
				continue;
			}
			if (these.some((p) => !p.args || p.args.every((x: Node) => irrefutable(x.pattern)))) continue;
			const fields: Node[] = v.held ? [{ type: v.held } as Node] : (v.payload ?? []);
			if (fields.length === 1 && these.every((p) => p.args?.length === 1)) {
				const inner = this.uncovered(this.program.resolve(fields[0].type, ctx), these.map((p) => p.args[0].pattern), depth + 1);
				if (inner.length > 0) missing.push(`\`${t.decl.name}.${v.name}\` with ${andList(inner)}`);
			}
		}
		return missing;
	}

	/** The variant a constructor pattern names, or the type it tests for, given what it matches. */
	patternTarget(p: Node, subject: Type): { variant: Member | null; type: Type } {
		const name: string = p.path[p.path.length - 1];
		let owner: Type = UNKNOWN;
		if (p.path.length === 1) {
			if (subject.k === 'named' && subject.decl.node.typeKind === 'enum') owner = subject;
			else {
				const decl = this.program.findType(name, this.file);
				return { variant: null, type: decl ? this.program.instantiate(decl, []) : UNKNOWN };
			}
		} else {
			const head = p.path.slice(0, -1);
			const t = this.resolve({ kind: 'NamedType', path: head, args: [], line: p.line, col: p.col });
			if (t.k !== 'named') {
				// `Module.Type` as a type test.
				const whole = this.resolve({ kind: 'NamedType', path: p.path, args: [], line: p.line, col: p.col });
				return { variant: null, type: whole };
			}
			owner = subject.k === 'named' && declKey(subject.decl) === declKey(t.decl) ? subject : t;
		}
		if (owner.k !== 'named') return { variant: null, type: UNKNOWN };
		const variant = this.program.membersOf(owner).members.get(name)?.find((m) => m.node.kind === 'Variant') ?? null;
		return { variant, type: variant ? owner : UNKNOWN };
	}

	// ---- expressions --------------------------------------------------------------------

	/**
	 * The type of an expression. `want` is the type its position expects, written in the same
	 * statement or given by a parameter: it types a closure's parameters and type arguments
	 * that the arguments leave open. Null where nothing is expected.
	 */
	expr(e: Node, want: Type | null = null): Type {
		const t = this.exprInner(e, want);
		if (t.k === 'unknown') this.unknowns++;
		e.ty = t;
		return t;
	}

	exprInner(e: Node, want: Type | null): Type {
		const p = this.program;
		switch (e.kind) {
			case 'Int':
				return p.preludeType('Int');
			case 'Decimal':
				return p.preludeType('Decimal');
			case 'Bool':
				return p.preludeType('Bool');
			case 'Null':
				return { k: 'null' };
			case 'Str':
				for (const part of e.parts) {
					if (typeof part === 'string') continue;
					const t = this.scoped(() => this.expr(part));
					if (e.tag === 'html') this.forPeople(part, 'a page');
					if (e.tag !== 'sql') this.interpolated(part, t, e.tag, e.secret);
				}
				if (e.secret) return this.program.preludeType('Secret', [this.stringType(e)]);
				return this.stringType(e);
			case 'This':
				return this.thisType;
			case 'Name':
				return this.name(e, e.ref, e.name.length);
			case 'Member':
				return this.member(e);
			case 'Call':
				return this.call(e, want);
			case 'TypeApply':
				this.expr(e.callee);
				return UNKNOWN;
			case 'Index': {
				const object = nonNull(this.expr(e.object));
				this.expr(e.index);
				if (isNamed(object, 'List') && object.k === 'named') return object.args[0] ?? UNKNOWN;
				if (isNamed(object, 'Map') && object.k === 'named') return object.args[1] ?? UNKNOWN;
				return UNKNOWN;
			}
			case 'With': {
				const value = this.expr(e.value);
				const types = this.fieldInits(e.fields, value);
				// A copy with changes is for values; a class has identity, and changes through its methods.
				if (value.k === 'named' && value.decl.node.typeKind !== 'record') {
					const kind = value.decl.node.typeKind === 'class' ? 'a class, which changes through its own methods' : `${a(value)}, which has no fields`;
					this.error(e, `\`with\` copies a record, but \`${value.decl.name}\` is ${kind}`);
				} else if (value.k === 'named') this.checkFields(e, e.fields, types, value, null);
				return value;
			}
			case 'ListLit': {
				const target = want ? nonNull(want) : null;
				const item = target?.k === 'named' && isPrelude(target.decl) && ['List', 'Set'].includes(target.decl.name) ? (target.args[0] ?? null) : null;
				const items = (e.items as Node[]).map((i) => this.expr(i, item));
				return p.preludeType('List', [items.length > 0 ? this.itemType(items, e.items) : UNKNOWN]);
			}
			case 'MapLit': {
				const target = want ? nonNull(want) : null;
				const map = isNamed(target ?? UNKNOWN, 'Map') && target?.k === 'named' ? target.args : [];
				const keys = (e.entries as Node[]).map((x) => this.expr(x.key, map[0] ?? null));
				const values = (e.entries as Node[]).map((x) => this.expr(x.value, map[1] ?? null));
				const n = keys.length > 0;
				return p.preludeType('Map', [n ? this.itemType(keys, e.entries.map((x: Node) => x.key)) : UNKNOWN, n ? this.itemType(values, e.entries.map((x: Node) => x.value)) : UNKNOWN]);
			}
			case 'Tuple':
				return { k: 'tuple', items: (e.items as Node[]).map((i) => this.expr(i)) };
			case 'Paren':
				return this.expr(e.value, want);
			case 'Closure':
				return this.closure(e, want);
			case 'Match':
				return this.match(e, want);
			case 'New': {
				const t = this.resolve(e.type);
				if (e.args) return this.construct(e, t, want);
				this.with(this.ctx, t, () => this.members(e.members, t));
				return t;
			}
			case 'Is':
				this.pattern(e.pattern, this.expr(e.value));
				return p.preludeType('Bool');
			case 'Binary':
				return this.binary(e);
			case 'Ternary':
				this.condition(e.cond, '`?`');
				return unify([this.narrowing(this.facts(e.cond, true), () => this.expr(e.then, want)), this.narrowing(this.facts(e.cond, false), () => this.expr(e.otherwise, want))]);
			case 'Else': {
				const saved = [this.underTry, this.errors] as const;
				const before = this.unknowns;
				// Like `try`, `catch` handles its operand's own failure, not the calls inside it.
				this.underTry = false;
				this.errors = [];
				const inOperand = this.inOperand;
				this.inOperand = true;
				const operand = this.expr(e.value, want);
				this.inOperand = inOperand;
				this.underTry = true;
				const value = this.unwrap(operand);
				const errors = this.errors;
				[this.underTry, this.errors] = saved;
				if (errors.length === 0 && this.unknowns === before) {
					this.error(e, `nothing before this \`catch\` can fail, so it has no error to handle${value.k === 'nullable' ? ': for `null`, use `??`' : ''}`);
				}
				if (e.binding && e.binding !== '_') this.declare({ line: e.bindingLine, col: e.bindingCol }, errors.length > 0 ? unify(errors) : UNKNOWN);
				this.block(e.handler);
				// Where the value is used, the block has to leave, because there is no value to carry on with.
				if (!e.statement && !this.exits(e.handler)) this.error(e.handler, 'the value is used, so this block has to leave, with `return`, `fail` or `panic`: there is no value to carry on with');
				return value;
			}
			case 'Coalesce': {
				const left = this.expr(e.left);
				if (e.op === '??') this.coalescing(e, left);
				if (e.right.kind === 'Block') {
					// The block leaves, so the value carries on only when it isn't `null`.
					this.block(e.right);
					return e.op === '??' ? nonNull(left) : left;
				}
				const right = this.expr(e.right, want ?? (e.op === '??' ? nonNull(left) : left));
				return e.op === '??' ? unify([nonNull(left), right]) : unify([left, right]);
			}
			case 'Pipe':
				this.expr(e.left);
				this.expr(e.right);
				return UNKNOWN;
			case 'Range':
				this.expr(e.left);
				this.expr(e.right);
				return UNKNOWN;
			case 'Try': {
				const saved = [this.underTry, this.errors] as const;
				const before = this.unknowns;
				// `try` unwraps its operand's value, once: any other call inside that can fail needs its own.
				this.underTry = false;
				this.errors = [];
				const inOperand = this.inOperand;
				this.inOperand = true;
				const operand = this.expr(e.value, want);
				this.inOperand = inOperand;
				this.underTry = true;
				const t = this.unwrap(operand);
				const errors = this.errors;
				[this.underTry, this.errors] = saved;
				// In `for x in try source`, the `try` also covers every step of going through it.
				const it = this.forSource === e ? this.iteration(t) : null;
				if (it && !isNamed(it.error, 'Never')) errors.push(it.error);
				this.raised.push(...errors);
				// A `try` over something the checker can't see may still pass a failure on.
				if (errors.length === 0 && this.unknowns !== before) this.raised.push(UNKNOWN);
				if (errors.length === 0 && this.unknowns === before) this.error(e, 'nothing after this `try` can fail, so it has nothing to pass on: remove it');
				this.propagate(e, errors);
				return t;
			}
			case 'Start':
				// A task has its call's type; reading it waits for the call.
				return this.expr(e.value, want);
			case 'Not':
				this.condition(e.value, '`not`');
				return p.preludeType('Bool');
			case 'Unary':
				return this.expr(e.value);
			case 'FailExpr':
				if (e.value) this.failing(e, this.expr(e.value, this.returns[this.returns.length - 1]?.error ?? null));
				return p.preludeType('Never');
			case 'ReturnExpr':
				if (e.value) this.expr(e.value);
				return p.preludeType('Never');
		}
		return UNKNOWN;
	}

	/** The item type of a list or map literal; number literals take the type of the other items. */
	itemType(types: Type[], nodes: Node[]): Type {
		const typed = types.filter((_, i) => !isLiteral(nodes[i]));
		return unify(typed.length > 0 ? typed : types);
	}

	stringType(e: Node): Type {
		switch (e.tag) {
			case null:
			case undefined:
				return this.program.preludeType('String');
			case 'html':
				return this.program.stdType('std.html', 'Html');
			case 'sql':
				return this.program.stdType('std.db', 'Sql');
			case 'path':
				return this.program.stdType('std.files', 'Path');
			case 'secret':
				return this.program.preludeType('Secret', [this.program.preludeType('String')]);
			case 'url': {
				const first = typeof e.parts[0] === 'string' ? e.parts[0] : '';
				// `//host/…` has a host but no scheme, so it's neither kind: it would take the
				// scheme of whatever page it's used on.
				if (first.startsWith('//')) {
					this.error(e, 'a `url"//…"` literal names a host without a scheme: write the scheme, as in `url"https://…"`');
					return UNKNOWN;
				}
				if (/^[a-z][a-z0-9+.-]*:/i.test(first)) return this.program.stdType('std.http', 'Url');
				return this.program.stdType('std.http', 'RelativeUrl');
			}
		}
		return UNKNOWN;
	}

	name(e: Node, ref: Binding | undefined, length: number): Type {
		if (!ref) return UNKNOWN;
		let t: Type = UNKNOWN;
		if (ref.kind === 'local' || ref.kind === 'param') {
			t = this.narrowed.get(ref) ?? ref.type ?? UNKNOWN;
			this.note(e, length, this.detail(e.name ?? '', t), { path: this.file.path, line: ref.line, col: ref.col });
			return t;
		}
		const decl = ref.decl;
		if (!decl) return ref.kind === 'import' ? { k: 'module', module: ref.module ?? null } : UNKNOWN;
		if (decl.kind === 'type') t = { k: 'static', decl, args: [] };
		else if (decl.kind === 'const') t = decl.node.type ? this.program.resolve(decl.node.type, { file: this.program.fileOf(decl), params: new Map(), self: null }) : literalType(this.program, decl.node.value, { file: this.program.fileOf(decl), params: new Map(), self: null });
		else if (decl.kind === 'fn') t = this.program.memberType({ node: decl.node, owner: decl, ctx: { file: this.program.fileOf(decl), params: new Map(), self: null } });
		this.note(e, length, this.detail(decl.name, t, decl.kind === 'const' ? undefined : decl.node), this.defOf(decl));
		return t;
	}

	member(e: Node): Type {
		const at = { line: e.nameLine, col: e.nameCol };
		const object = this.expr(e.object);
		if (object.k === 'nullable' && !e.safe) this.mayBeNull(e.object, object, at, e.name);
		// `cart.subtotal.formatted` where `subtotal` is a method (#237).
		if (object.k === 'fn' && e.object.kind === 'Member' && e.object.fnNode) {
			const text = exprText(e.object);
			this.error(at, `\`${e.object.name}\` is a method, so it's called before \`.${e.name}\`: \`${text}().${e.name}\``);
			return UNKNOWN;
		}
		this.lastMember = null;
		const result = this.memberOf(object, e.name, at);
		if (this.lastMember?.node.kind === 'Fn') e.fnNode = this.lastMember.node;
		return e.safe ? nullable(result) : result;
	}

	/** Reports `.name` on something that may be `null`. */
	mayBeNull(object: Node, t: Type, at: { line: number; col: number }, name: string) {
		const target = object.kind === 'Paren' ? object.value : object;
		const text = exprText(target);
		const subject = text ? `\`${text}\`` : 'this';
		if (target.kind === 'Member' && text) {
			this.error(at, `${subject} may be \`null\`, and a field or getter can change after it is tested, so it isn't narrowed: put it in a \`let\` first, as \`let ${target.name} = ${text}\`, then test \`${target.name} is not null\`, or write \`${text}?.${name}\``);
			return;
		}
		const why = target.kind === 'Name' && target.ref ? this.unnarrowed.get(target.ref) : undefined;
		this.error(at, `${subject} may be \`null\`${why ? `: ${why}` : ''}: check it with \`${text || '…'} is not null\` first, write \`${text || '…'}?.${name}\`, or give a fallback with \`??\``);
	}

	/** The type of `object.name`, reporting a name that the object's type doesn't have. */
	memberOf(object: Type, name: string, at: { line: number; col: number }): Type {
		const p = this.program;
		if (object.k === 'module') {
			const decl = object.module?.decls.get(name)?.find((d) => !d.testFile || this.file.testFile);
			if (!decl) return UNKNOWN;
			return this.name(at as Node, { kind: 'decl', line: 0, col: 0, decl }, name.length);
		}
		if (object.k === 'static') {
			if (object.decl.node.typeKind === 'alias') return UNKNOWN;
			const self = p.instantiate(object.decl, object.args);
			if (self.k !== 'named') return UNKNOWN;
			const m = p.membersOf(self).members.get(name)?.find((x) => isStaticMember(x.node));
			if (!m && name === 'fields') return p.formFields(object.decl) ?? UNKNOWN;
			if (!m) return UNKNOWN;
			this.visible(m, at);
			const t = p.memberType({ ...m, ctx: { ...m.ctx, self } });
			this.note(at, name.length, this.detail(name, m.node.kind === 'Variant' ? self : t, m.node), this.memberDef(m));
			return t;
		}
		const base = nonNull(object);
		if (base.k !== 'named') return UNKNOWN;
		// A `Result` whose error type isn't known yet might be a plain value.
		if (isNamed(base, 'Result') && base.args.some((a) => a.k === 'unknown')) return UNKNOWN;
		const set = p.membersOf(base);
		const list = set.members.get(name) ?? [];
		const m = list.find((x) => !isStaticMember(x.node));
		if (m) this.visible(m, at);
		if (!m) {
			if (!set.complete) return UNKNOWN;
			const typeName = typeToString(base);
			if (list.length > 0) {
				this.error(at, `\`${name}\` is a static member of \`${base.decl.name}\`: use it on the type, as \`${base.decl.name}.${name}\``);
			} else if (isNamed(base, 'Result')) {
				this.error(at, `this is a \`${typeToString(base)}\`, which has no \`${name}\`: the call before it can fail, so ${this.tryFix}`);
			} else {
				const names = [...set.members].filter(([, ms]) => ms.some((x) => !isStaticMember(x.node))).map(([n]) => n);
				this.error(at, `\`${typeName}\` has no member \`${name}\`${suggest(name, names)}`);
			}
			return UNKNOWN;
		}
		const t = p.memberType(m);
		this.note(at, name.length, this.detail(name, t, m.node), this.memberDef(m));
		this.lastMember = m;
		return t;
	}

	recordLit(e: Node, want: Type | null, built: Type & { k: 'named' }): Type {
		const p = this.program;
		let t: Type = built;
		const params = (built.decl.node.typeParams ?? []) as Node[];
		// `Routes { … }` where a `Routes<Services>` is wanted is a `Routes<Services>`.
		const wanted = want ? nonNull(want) : null;
		if (t.k === 'named' && e.typeArgs.length === 0 && wanted?.k === 'named' && declKey(wanted.decl) === declKey(t.decl)) t = wanted;
		const types = this.fieldInits(e.fields, t);
		if (t.k === 'named' && e.typeArgs.length === 0 && params.length > 0 && t.args.some(hasUnknown)) {
			// `Page { items: squares, … }` is a `Page<Square>`.
			const vars = new Map<string, Type | undefined>(params.map((x) => [`${x.name}'${++this.vars}`, undefined]));
			const names = [...vars.keys()];
			const ctx = p.ctxFor(t.decl, names.map((name) => ({ k: 'param', name })), null);
			const declared = (t.decl.node.members as Node[]).filter((m) => m.kind === 'Field');
			(e.fields as Node[]).forEach((f, i) => {
				const field = declared.find((d) => d.name === f.name);
				if (field && !isLiteralNode(f.punned ? f : f.value)) p.infer(p.resolve(field.type, ctx), types[i], vars);
			});
			t = { k: 'named', decl: t.decl, args: names.map((name) => vars.get(name) ?? UNKNOWN) };
		}
		if (t.k === 'named' && t.decl.node.typeKind === 'record') {
			this.checkFields(e, e.fields, types, t, `\`${t.decl.name}(…)\``);
			const hidden = (t.decl.node.members as Node[]).find((m) => m.kind === 'Field' && m.vis === 'private');
			if (hidden && !this.inside(t.decl)) {
				const makers = (t.decl.node.members as Node[]).filter((m) => m.kind === 'Fn' && m.isStatic && !m.isConstructor && m.vis !== 'private').map((m) => `\`${t.decl.name}.${m.name}(…)\``);
				this.error(e, `\`${t.decl.name}\` has a private field, \`${hidden.name}\`, so only its own code can build one from its fields${makers.length > 0 ? `: use ${makers.slice(0, 2).join(' or ')}` : ''}`);
			}
		}
		return t;
	}

	/** `Point(x: 1, y: 2)` builds a record from its fields; a class is built with `new`. */
	build(e: Node, decl: Decl, typeArgs: Type[], want: Type | null): Type {
		const args = e.args as Node[];
		const t = this.program.instantiate(decl, typeArgs);
		if (decl.node.typeKind === 'class') {
			this.error(e, `\`${decl.name}\` is a class, so it's built with \`new\`: \`new ${exprText(e.callee) || decl.name}(…)\``);
			args.forEach((_, i) => this.arg(e, i, [], UNKNOWN));
			return t;
		}
		const positional = args.find((a) => a.name === null);
		if (positional) {
			this.error(positional, `a record is built from named fields, \`${decl.name}(name: value)\`, so each argument says which field it sets`);
			args.forEach((_, i) => this.arg(e, i, [], UNKNOWN));
			return t;
		}
		if (t.k !== 'named') return t;
		// Browsers drop a `SameSite=None` cookie that isn't `Secure`.
		if (decl.name === 'Cookie' && decl.file.endsWith('cookies.d.nibl')) {
			const value = (name: string) => args.find((a) => a.name === name)?.value;
			const sameSite = value('sameSite');
			const secure = value('secure');
			if (sameSite?.kind === 'Member' && sameSite.name === 'None' && secure?.kind === 'Bool' && !secure.value) {
				this.error(secure, 'browsers drop a cookie with `SameSite.None` unless it\'s secure: leave `secure` on, or use `SameSite.Lax`');
			}
		}
		return this.recordLit({ ...e, fields: args }, want, t);
	}

	/**
	 * `new Type(…)` builds a class through its constructor, which may be private to the class.
	 * A record is a value, so it's built without `new`.
	 */
	construct(e: Node, t: Type, want: Type | null): Type {
		const p = this.program;
		const args = e.args as Node[];
		const rest = () => args.forEach((_, i) => this.arg(e, i, [], UNKNOWN));
		if (t.k !== 'named') {
			rest();
			return t;
		}
		const decl = t.decl;
		const kind = decl.node.typeKind;
		if (kind === 'record') {
			this.error(e, `\`${decl.name}\` is a record, a value, so it's built without \`new\`: \`${decl.name}(…)\``);
			return this.recordLit({ ...e, kind: 'RecordLit', typeArgs: e.type.args ?? [], fields: args }, want, t);
		}
		if (kind !== 'class') {
			this.error(e, kind === 'interface'
				? `\`${decl.name}\` is an interface, so it can't be built: implement it with \`new ${decl.name} { … }\``
				: `\`new\` builds a class, and \`${decl.name}\` is ${kind === 'enum' ? 'an enum' : 'a distinct type'}`);
			rest();
			return t;
		}
		// `new Access()` where an `Access<User>` is wanted is an `Access<User>`.
		const wanted = want ? nonNull(want) : null;
		const written = (e.type.args ?? []).length > 0;
		const self = !written && wanted?.k === 'named' && declKey(wanted.decl) === declKey(decl) ? wanted : written ? t : p.instantiate(decl, []);
		const ctor = (p.membersOf(t).members.get('construct') ?? []).find((m) => m.node.isConstructor);
		if (!ctor) {
			// A class written without a constructor is built with `new Type()`, its fields all
			// having defaults. A declared one, such as the stdlib's `Session`, is built by the host.
			if (decl.file.endsWith('.d.nibl')) {
				this.error(e, `\`${decl.name}\` has no constructor, so it can't be built with \`new\``);
			} else if ((e.args ?? []).length > 0) {
				this.error(e, `\`${decl.name}\` has no constructor, so \`new ${decl.name}()\` takes nothing: give it one, \`construct(…) { … }\`, to take arguments`);
			}
			rest();
			return self;
		}
		if (ctor.node.vis === 'private' && !this.inside(decl)) {
			const makers = (decl.node.members as Node[]).filter((m) => m.kind === 'Fn' && m.isStatic && !m.isConstructor && m.vis !== 'private').map((m) => `\`${decl.name}.${m.name}(…)\``);
			this.error(e, `\`${decl.name}\`'s constructor is private, so only its own code can build one${makers.length > 0 ? `: use ${makers.slice(0, 2).join(' or ')}` : ''}`);
		}
		const types: Type[] = [];
		const call = { ...e, callee: e.type };
		const built = this.apply(call, { k: 'fns', name: `\`new ${decl.name}\``, fns: [{ ...ctor, ctx: { ...ctor.ctx, self } }] }, [], types, want);
		args.forEach((_, i) => this.arg(call, i, types, UNKNOWN));
		return built.k === 'named' && declKey(built.decl) === declKey(decl) ? built : self;
	}

	/** The types of a literal's or `with`'s field values, each typed as its field of `t` wants. */
	fieldInits(fields: Node[], t: Type): Type[] {
		const declared = t.k === 'named' ? (t.decl.node.members as Node[]).filter((m) => m.kind === 'Field') : [];
		return fields.map((f) => {
			if (f.punned) return this.name(f, f.ref, f.name.length);
			const field = t.k === 'named' ? declared.find((d) => d.name === f.name) : undefined;
			const want = field && t.k === 'named' ? this.program.resolve(field.type, this.program.ctxFor(t.decl, t.args, t)) : null;
			return this.expr(f.value, want);
		});
	}

	/** The fields a record literal or `with` names must exist; a literal sets each that has no default. */
	checkFields(at: Node, fields: Node[], types: Type[], t: Type & { k: 'named' }, literal: string | null) {
		const kind = t.decl.node.typeKind;
		if (kind !== 'record' && kind !== 'class') return;
		const declared = (t.decl.node.members as Node[]).filter((m) => m.kind === 'Field');
		fields.forEach((f, i) => {
			const field = declared.find((d) => d.name === f.name);
			if (!field) {
				this.error(f, `\`${t.decl.name}\` has no field \`${f.name}\`${suggest(f.name, declared.map((d) => d.name))}`);
				return;
			}
			const type = this.program.resolve(field.type, this.program.ctxFor(t.decl, t.args, t));
			this.note(f, f.name.length, this.detail(f.name, type), { path: t.decl.file, line: field.line, col: field.col });
			this.expect(f.punned ? f : f.value, types[i], type, `the field \`${f.name}\` holds`);
		});
		if (!literal) return;
		const given = new Set(fields.map((f) => f.name));
		const missing = declared.filter((d) => !d.init && !d.lazy && !given.has(d.name)).map((d) => `\`${d.name}\``);
		if (missing.length > 0) this.error(at, `${literal} leaves out ${andList(missing)}, which ${missing.length === 1 ? 'has' : 'have'} no default`);
	}

	/**
	 * A closure's type. Parameters without a written type take the types of the function
	 * wanted here. Its result is its body's, or what its `return`s give, and it can fail with
	 * what its `try`s and `fail`s raise.
	 */
	closure(e: Node, want: Type | null): Type {
		const p = this.program;
		const target = want ? nonNull(want) : null;
		const params = (e.params as Node[]).map((x, i) => {
			const t = x.type ? this.resolve(x.type) : target?.k === 'fn' ? (target.params[i] ?? UNKNOWN) : UNKNOWN;
			this.declare({ line: x.nameLine, col: x.nameCol }, t);
			return t;
		});
		const wantRet = target?.k === 'fn' ? (isNamed(target.ret, 'Result') && target.ret.k === 'named' ? target.ret.args[0] : target.ret) : null;
		// A closure may run after a `var` it reads has changed, so only `let`s and parameters stay narrowed.
		const outside = this.narrowed;
		this.narrowed = new Map([...outside].filter(([b]) => b.declaredWith !== 'var'));
		for (const b of outside.keys()) if (!this.narrowed.has(b)) this.unnarrowed.set(b, "a closure may run after a `var` changes, so a `var` isn't narrowed inside one; copy it to a `let` first");
		const declared = e.ret ? this.resolve(e.ret) : UNKNOWN;
		let raised: Type[] = [];
		const { body, seen } = this.returning(
			declared,
			'this function',
			() =>
				this.scoped(() => {
					// A closure isn't a generator, even inside one: write a top-level function that yields.
					this.generators.push(null);
					try {
						const body = this.body(e.body, e.ret ? declared : wantRet);
						raised = this.raised;
						return { body, seen: this.returns[this.returns.length - 1].seen };
					} finally {
						this.generators.pop();
					}
				}),
			e.ret ? (e.err ? this.resolve(e.err) : null) : undefined,
		);
		this.errorType(e.err ?? null, 'this function');
		this.narrowed = outside;
		if (e.ret && e.body.kind !== 'Block') this.expect(e.body, body, declared, 'this function returns');
		if (e.ret) return { k: 'fn', params, ret: e.err ? p.fallible(declared, this.resolve(e.err)) : declared };
		const value = e.body.kind === 'Block' ? (seen.length > 0 ? unify(seen) : p.preludeType('Void')) : body;
		// A closure that can't fail but gives a `Result` gives it as a value.
		if (raised.length === 0) return { k: 'fn', params, ret: isNamed(value, 'Result') ? { k: 'named', decl: p.prelude('Result')!, args: [value, p.preludeType('Never')] } : value };
		return { k: 'fn', params, ret: p.preludeType('Result', [value, unify(raised)]) };
	}

	match(e: Node, want: Type | null): Type {
		const subject = this.expr(e.subject);
		const arms: Type[] = [];
		const missing = this.uncovered(subject, (e.arms as Node[]).filter((arm) => !arm.guard).map((arm) => arm.pattern));
		if (missing.length > 0) {
			const what = missing.length === 1 && missing[0] === 'other values' ? `a \`match\` on ${a(nonNull(subject))} can't list every value, so it needs a \`_ =>\` arm` : `this \`match\` doesn't cover ${andList(missing.filter((m) => m !== 'other values'))}: add ${missing.length === 1 ? 'an arm for it' : 'an arm for each'}, or \`_ =>\` for the rest`;
			this.error(e, what);
		}
		// After an unguarded `null =>` arm, later arms see the value without its `null`.
		let nullCovered = false;
		const isNull = (p: Node): boolean => (p.kind === 'LiteralPattern' && p.value.kind === 'Null') || (p.kind === 'OrPattern' && p.alternatives.some(isNull));
		for (const arm of e.arms) {
			this.pattern(arm.pattern, nullCovered ? nonNull(subject) : subject);
			if (!arm.guard && isNull(arm.pattern)) nullCovered = true;
			if (arm.guard) this.condition(arm.guard, 'a `match` guard');
			this.narrowing(arm.guard ? this.facts(arm.guard, true) : new Map(), () => {
				// A block arm never gives a value. In a `match` that gives one, it has to leave.
				if (arm.body.kind === 'Block') {
					this.block(arm.body);
					const leaves = this.exits(arm.body);
					arms.push(this.program.preludeType(leaves ? 'Never' : 'Void'));
					if (!e.statement && !leaves) {
						this.error(arm.body, 'this `match` gives a value, so each arm is a value, or leaves with `return` or `fail`. To run statements first, declare the variable with `let name: Type` and set it in each arm of a `match` statement');
					}
				} else if (arm.body.kind === 'Assign' || arm.body.kind === 'IncDec') {
					this.statement(arm.body);
					arms.push(this.program.preludeType('Void'));
					if (!e.statement) this.error(arm.body, 'this `match` gives a value, so an arm can\'t set a variable: each arm is a value, or leaves with `return` or `fail`');
				} else {
					arms.push(this.expr(arm.body, want));
				}
			}, arm.body);
		}
		return unify(arms);
	}

	binary(e: Node): Type {
		if (e.op === 'and' || e.op === 'or') {
			this.condition(e.left, `\`${e.op}\``);
			// `x is not null and x.isEmpty`: the right side runs only when the left allows it.
			this.narrowing(this.facts(e.left, e.op === 'and'), () => this.condition(e.right, `\`${e.op}\``));
			return this.program.preludeType('Bool');
		}
		const left = this.expr(e.left);
		const right = this.expr(e.right);
		if ((e.op === '==' || e.op === '!=') && (e.left.kind === 'Null' || e.right.kind === 'Null')) {
			const subject = e.left.kind === 'Null' ? e.right : e.left;
			this.error(e, `test for \`null\` with \`is\`: write \`${exprText(subject) || '…'} is ${e.op === '==' ? '' : 'not '}null\``);
		}
		// Two values of different types are never equal, so comparing them is a mistake, such as
		// a `UserId` against an `OrderId`.
		if ((e.op === '==' || e.op === '!=') && !hasUnknown(left) && !hasUnknown(right) && !isLiteral(e.left) && !isLiteral(e.right)) {
			const p = this.program;
			if (!p.fits(left, right) && !p.fits(right, left)) {
				const sensitive = this.program.preludeType('Sensitive');
				const secrets = [left, right].every((t) => this.program.fits(nonNull(t), sensitive));
				this.error(e, `\`${typeToString(left)}\` and \`${typeToString(right)}\` are different types, so they're never equal${secrets ? ': to compare their text, use `matches`, as `a.matches(b)`' : ''}`);
			}
		}
		if (['==', '!=', '<', '<=', '>', '>=', 'in'].includes(e.op)) return this.program.preludeType('Bool');
		if (ARITHMETIC.has(e.op)) return this.arithmetic(e, e.op, e.left, left, e.right, right);
		return typeKey(left) === typeKey(right) ? left : UNKNOWN;
	}

	// ---- calls --------------------------------------------------------------------------

	call(e: Node, want: Type | null): Type {
		const callee = this.callee(e.callee, e.typeArgs);
		(e.typeArgs as Node[]).forEach((t) => this.written(t));
		const typeArgs = (e.typeArgs as Node[]).map((t) => this.resolve(t));
		if (callee.k === 'build') return this.build(e, callee.decl, typeArgs, want);
		// Arguments are typed as the parameter they bind to wants, once that is known.
		const types: Type[] = [];
		const t = this.apply(e, callee, typeArgs, types, want);
		(e.args as Node[]).forEach((_, i) => this.arg(e, i, types, UNKNOWN));
		if (callee.k === 'fns' && e.callee.kind === 'Member' && callee.fns.length > 0 && callee.fns.every((f) => f.node.isMut && !f.node.isStatic)) this.mutableReceiver(e.callee.object, e.callee.name);
		if (callee.k === 'fns' && callee.fns.some((f) => f.owner.file.endsWith('log.d.nibl'))) this.revealedInLog(e);
		if (callee.k === 'fns' && e.callee.kind === 'Member' && callee.fns.some((f) => f.owner.name === 'Env' && f.owner.file.endsWith('app.d.nibl'))) this.hostNeed(e, e.callee.name);
		if (callee.k === 'construct' && callee.type.k === 'named' && callee.type.decl.name === 'QueueAddress' && callee.type.decl.file.endsWith('queue.d.nibl')) this.hostNeed(e, 'queue');
		if (callee.k === 'fns' && callee.fns.length > 0 && callee.fns.every((f) => ((f.node.attrs ?? []) as Node[]).some((x) => x.name === 'opens'))) {
			this.opened.add(e);
			if (this.loops.length > 0 && this.letInit !== e) {
				this.warning(e, 'this opens something in a loop without naming it, so it stays open until the unit of work ends: bind it with `let` and add `defer ….close()`');
			}
		}
		return this.result(t);
	}

	/**
	 * A name the package's manifest must declare: a configuration variable read through `Env`,
	 * or a resource `Env` hands out (a queue is named where its `QueueAddress` is made).
	 */
	hostNeed(e: Node, method: string) {
		const host = this.program.host;
		const kind: ResourceKind | 'config' | null = CONFIG_READS.has(method) ? 'config'
			: method === 'db' ? 'databases' : method === 'queue' ? 'queues' : method === 'cache' ? 'caches' : method === 'rateLimiter' ? 'rate-limiters' : method === 'dir' ? 'directories' : method === 'files' ? 'files' : null;
		const arg: Node | undefined = e.args[0];
		// An example's names come from a manifest the reader is assumed to have.
		if (!host || !kind || !arg || this.file.example) return;
		if (method === 'queue' && e.callee.kind === 'Member') return; // `env.queue(ADDRESS)`: checked where the address is made
		const at = this.argNode(arg);
		const name = this.literalName(at);
		if (name === null) {
			this.error(at, 'write the name as a string, or a constant holding one, so it can be checked against nib.toml');
			return;
		}
		const table = kind === 'config' ? host.config : host.resources.get(kind)!;
		const declared = table.get(name);
		if (!declared) {
			const what = kind === 'config' ? `\`${name}\` isn't declared in nib.toml: add it to [config]` : `there's no ${RESOURCE_NOUN[kind]} called \`${name}\` in nib.toml: declare it in [${kind}]`;
			this.error(at, what + suggest(name, table.keys()));
			return;
		}
		declared.used = true;
		if (kind !== 'config') return;
		const secret = declared.keys.get('secret') === true;
		if (secret && method !== 'secret') this.error(at, `\`${name}\` is a secret in nib.toml, so read it with \`env.secret\`, which keeps it out of logs`);
		if (!secret && method === 'secret') this.error(at, `\`${name}\` isn't a secret in nib.toml: read it with \`env.string\`, \`env.int\` or \`env.url\`, or mark it \`secret = true\``);
		const first = host.reads.get(name);
		if (!first) host.reads.set(name, { method, path: this.file.path, line: at.line });
		else if (first.method !== method) this.error(at, `\`${name}\` is read with \`env.${first.method}\` in ${basename(first.path)}:${first.line}, so it can't be read with \`env.${method}\` here: one variable has one type`);
	}

	/** The text of a plain string literal, or of a constant that holds one. */
	literalName(e: Node): string | null {
		if (e.kind === 'Str' && !e.tag && e.parts.every((x: unknown) => typeof x === 'string')) return e.parts.join('');
		const decl: Decl | undefined = e.kind === 'Name' ? e.ref?.decl : undefined;
		if (decl?.kind === 'const' && decl.node.value) return this.literalName(decl.node.value);
		return null;
	}

	/** Types argument `i` of a call the first time it is asked for. */
	arg(e: Node, i: number, types: Type[], want: Type | null): Type {
		if (types[i] !== undefined) return types[i];
		const a: Node = e.args[i];
		return (types[i] = a.punned ? this.name(a, a.ref, a.name.length) : this.expr(a.value, want));
	}

	/** An argument's expression: the value, or for `name:` the name itself. */
	argNode(a: Node): Node {
		if (a.punned) {
			a.ty ??= UNKNOWN;
			return a;
		}
		return a.value;
	}

	/** Under `try` or `else`, a `Result` that isn't a call, such as a task, gives its success value too. */
	unwrap(t: Type): Type {
		return this.result(t);
	}

	/** A value under `try` or `else`: a `Result` gives its success value, and its error is recorded. */
	result(t: Type): Type {
		if (!this.underTry || !isNamed(t, 'Result') || t.k !== 'named') return t;
		this.errors?.push(t.args[1] ?? UNKNOWN);
		return t.args[0] ?? UNKNOWN;
	}

	callee(c: Node, typeArgs: Node[]): Callee {
		const p = this.program;
		const name = c.kind === 'Name' ? c.name : c.kind === 'Member' ? (c.object.kind === 'Name' ? `${c.object.name}.${c.name}` : c.name) : 'this function';
		const what = `\`${name}\``;
		if (c.kind === 'Name') {
			const ref: Binding | undefined = c.ref;
			const t = this.expr(c);
			if (ref?.decl?.kind === 'fn') {
				const decls = (p.moduleOf(ref.decl)?.decls.get(ref.decl.name) ?? [ref.decl]).filter((d) => d.kind === 'fn' && (!d.testFile || this.file.testFile));
				return { k: 'fns', name: what, fns: decls.map((d) => ({ node: d.node, owner: d, ctx: { file: p.fileOf(d), params: new Map(), self: null } })) };
			}
			if (t.k === 'static' && (t.decl.node.typeKind === 'record' || t.decl.node.typeKind === 'class')) return { k: 'build', name: what, decl: t.decl };
			if (t.k === 'static' && t.decl.node.typeKind === 'type') {
				if (typeArgs.length > 0) this.written({ kind: 'NamedType', line: c.line, col: c.col, path: [c.name], args: typeArgs });
				return { k: 'construct', name: what, type: p.instantiate(t.decl, typeArgs.map((a) => this.resolve(a))) };
			}
			if (t.k === 'fn') return { k: 'value', name: what, type: t };
			return { k: 'unknown' };
		}
		if (c.kind === 'Member') {
			const object = this.expr(c.object);
			const at = { line: c.nameLine, col: c.nameCol };
			let members: Member[] = [];
			let self: Type | null = null;
			if (object.k === 'module') {
				const decls = (object.module?.decls.get(c.name) ?? []).filter((d) => !d.testFile || this.file.testFile);
				if (decls[0]?.kind === 'type' && (decls[0].node.typeKind === 'record' || decls[0].node.typeKind === 'class')) {
					this.note(at, c.name.length, this.detail(c.name, UNKNOWN, decls[0].node), this.defOf(decls[0]));
					return { k: 'build', name: what, decl: decls[0] };
				}
				if (decls[0]?.kind === 'type' && decls[0].node.typeKind === 'type') {
					this.note(at, c.name.length, this.detail(c.name, UNKNOWN, decls[0].node), this.defOf(decls[0]));
					if (typeArgs.length > 0 && c.object.kind === 'Name') this.written({ kind: 'NamedType', line: c.line, col: c.col, path: [c.object.name, c.name], args: typeArgs });
					return { k: 'construct', name: what, type: p.instantiate(decls[0], typeArgs.map((a) => this.resolve(a))) };
				}
				if (decls[0]?.kind !== 'fn') {
					const t = this.memberOf(object, c.name, at);
					return t.k === 'fn' ? { k: 'value', name: what, type: t } : { k: 'unknown' };
				}
				members = decls.filter((d) => d.kind === 'fn').map((d) => ({ node: d.node, owner: d, ctx: { file: p.fileOf(d), params: new Map(), self: null } }));
				this.note(at, c.name.length, this.detail(c.name, UNKNOWN, decls[0].node), this.defOf(decls[0]));
			} else if (object.k === 'static') {
				self = p.instantiate(object.decl, object.args);
				if (self.k !== 'named') return { k: 'unknown' };
				const list = p.membersOf(self).members.get(c.name) ?? [];
				const variant = list.find((m) => m.node.kind === 'Variant');
				if (variant) {
					this.note(at, c.name.length, this.detail(c.name, self, variant.node), this.memberDef(variant));
					return { k: 'variant', name: what, member: { ...variant, ctx: { ...variant.ctx, self } } };
				}
				if (list.some((m) => m.node.isConstructor)) {
					this.error(at, `a constructor is called with \`new\`: \`new ${exprText(c.object) || self.decl.name}(…)\``);
					return { k: 'unknown' };
				}
				members = list.filter((m) => m.node.kind === 'Fn' && m.node.isStatic).map((m) => ({ ...m, ctx: { ...m.ctx, self } }));
				if (members.length > 0 && members.every((m) => m.node.vis === 'private')) this.visible(members[0], at);
				if (members.length === 0) {
					const t = this.memberOf(object, c.name, at);
					return t.k === 'fn' ? { k: 'value', name: what, type: t } : { k: 'unknown' };
				}
				this.note(at, c.name.length, this.detail(c.name, UNKNOWN, members[0].node), this.memberDef(members[0]));
			} else {
				if (object.k === 'nullable' && !c.safe) this.mayBeNull(c.object, object, at, c.name);
				const base = nonNull(object);
				if (base.k !== 'named' || (isNamed(base, 'Result') && base.args.some((a) => a.k === 'unknown'))) return { k: 'unknown' };
				const set = p.membersOf(base);
				members = (set.members.get(c.name) ?? []).filter((m) => m.node.kind === 'Fn' && !m.node.isStatic);
				if (members.length > 0 && members.every((m) => m.node.vis === 'private')) this.visible(members[0], at);
				if (members.length === 0) {
					// A field or getter holding a function, or a name the type doesn't have.
					this.lastMember = null;
					const t = this.memberOf(object, c.name, at);
					const kind = this.lastMember?.node.kind;
					if (t.k !== 'fn' && t.k !== 'unknown' && (kind === 'Getter' || kind === 'Field')) {
						this.error(at, `\`${c.name}\` is ${kind === 'Getter' ? 'a getter' : 'a field'}, so it's read without brackets: \`${exprText(c) || c.name}\``);
					}
					return t.k === 'fn' ? { k: 'value', name: what, type: t } : { k: 'unknown' };
				}
				this.note(at, c.name.length, this.detail(c.name, UNKNOWN, members[0].node), this.memberDef(members[0]));
			}
			return { k: 'fns', name: what, fns: members };
		}
		const t = this.expr(c);
		return t.k === 'fn' ? { k: 'value', name: what, type: t } : { k: 'unknown' };
	}

	/** Picks the overload the arguments fit, reports it if none does, and gives the call's type. */
	apply(e: Node, callee: Callee, typeArgs: Type[], types: Type[], want: Type | null): Type {
		const args = e.args as Node[];
		switch (callee.k) {
			case 'unknown':
			case 'build':
				return UNKNOWN;
			case 'construct': {
				if (args.length !== 1 || args[0].name !== null) {
					this.error(e, `${callee.name} wraps one value, passed without a label`);
					return callee.type;
				}
				const t = callee.type;
				if (t.k === 'named' && t.decl.node.privateWrap && !this.inside(t.decl)) {
					const parse = (t.decl.node.members as Node[]).some((m) => m.kind === 'Fn' && m.isStatic && m.name === 'parse');
					this.error(e, `only \`${t.decl.name}\`'s own functions can make one${parse ? `: use \`${t.decl.name}.parse(…)\`` : ''}`);
				}
				if (t.k === 'named') {
					const base = this.program.resolve(t.decl.node.base, this.program.ctxFor(t.decl, t.args, t));
					this.expect(this.argNode(args[0]), this.arg(e, 0, types, base), base, `${callee.name} wraps`);
				}
				return callee.type;
			}
			case 'value': {
				if (args.some((a) => a.name !== null)) return callee.type.ret;
				if (args.length !== callee.type.params.length) {
					const n = callee.type.params.length;
					this.error(e, `${callee.name} takes ${n === 1 ? '1 argument' : `${n} arguments`}, but this call passes ${args.length}`);
					return callee.type.ret;
				}
				args.forEach((a, i) => this.expect(this.argNode(a), this.arg(e, i, types, callee.type.params[i]), callee.type.params[i], `${callee.name} needs`));
				return callee.type.ret;
			}
			case 'variant': {
				const v = callee.member.node;
				const params: Param[] = v.held
					? [{ name: 'value', index: 0, named: false, optional: false, callerLocation: false, type: v.held }]
					: ((v.payload ?? []) as Node[]).map((f, index) => ({ name: f.name, index, named: true, optional: !!f.init, callerLocation: false, type: f.type }));
				const unlabelled = v.payload ? args.find((a) => a.name === null) : undefined;
				if (!v.payload && !v.held) {
					this.error(e, `${callee.name} has no payload, so it isn't called: write \`${callee.name.slice(1, -1)}\``);
				} else if (unlabelled) {
					const field = params[args.indexOf(unlabelled)]?.name ?? params[0]?.name;
					this.error(unlabelled, `a variant's values are named, like a record's fields: \`${field}: …\``);
				} else {
					const { problem, bound } = matchArgs(params, args, callee.name);
					if (problem) this.error(e, problem);
					else {
						args.forEach((a, i) => {
							const param = bound[i];
							if (!param) return;
							const type = this.program.resolve(param.type, callee.member.ctx);
							this.expect(this.argNode(a), this.arg(e, i, types, type), type, `\`${param.name}\` needs`);
						});
					}
				}
				return callee.member.ctx.self ?? UNKNOWN;
			}
			case 'fns': {
				const candidates = callee.fns.map((m) => ({ m, params: paramsOf(m.node) }));
				const fits = candidates.map((c) => ({ ...c, ...matchArgs(c.params, args, callee.name) }));
				const chosen = fits.find((f) => !f.problem);
				if (!chosen) {
					if (fits.length === 1) this.error(e, fits[0].problem!);
					else this.error(e, `no overload of ${callee.name} takes ${this.shapeOfCall(args)}; there are ${fits.map((f) => `${callee.name.slice(0, -1)}${shapeOf(f.params)}\``).join(', ')}`);
					return UNKNOWN;
				}
				// The hover shows the overload the call chose.
				const at = e.callee.kind === 'Member' ? { line: e.callee.nameLine, col: e.callee.nameCol } : e.callee;
				const named = this.names.find((n) => n.line === at.line && n.col === at.col);
				if (named) Object.assign(named, { detail: signature(chosen.m.node), def: this.memberDef(chosen.m) });
				e.chosen = chosen.m.node;
				return this.typedCall(e, callee.name, chosen.m, chosen.bound, typeArgs, types, want);
			}
		}
	}

	/**
	 * A call to a declared function, once its overload is chosen: its type arguments are
	 * written in full or inferred from the arguments, meet their constraints, and each
	 * argument fits its parameter. Gives the call's type.
	 */
	typedCall(e: Node, what: string, m: Member, bound: (Param | null)[], typeArgs: Type[], types: Type[], want: Type | null): Type {
		const p = this.program;
		const node = m.node;
		const own = (node.typeParams ?? []) as Node[];
		const required = own.filter((x) => !x.defaultType).length;
		if (typeArgs.length > 0 && (typeArgs.length < required || typeArgs.length > own.length)) {
			const count = required === own.length ? `${own.length}` : `${required} to ${own.length}`;
			const them = own.length === 1 ? 'it' : 'all of them';
			this.error(e, `${what} takes ${count} type ${own.length === 1 ? 'argument' : 'arguments'}, but this call writes ${typeArgs.length}: write ${them}, or none and let the arguments decide`);
			typeArgs = [];
		}
		const vars = new Map<string, Type | undefined>();
		const params = new Map(m.ctx.params);
		/** Type variables with a default, for when nothing decides them. */
		const defaults: [Node, string][] = [];
		const names = own.map((x, i) => {
			if (typeArgs.length > 0) {
				params.set(x.name, typeArgs[i] ?? (x.defaultType ? p.resolve(x.defaultType, { ...m.ctx, params }) : UNKNOWN));
				return null;
			}
			const name = `${x.name}'${++this.vars}`;
			params.set(x.name, { k: 'param', name });
			vars.set(name, undefined);
			return name;
		});
		// `Route.get(…)` on a generic type infers the type's parameters as well as its own.
		const self = m.ctx.self;
		if (node.isStatic && self?.k === 'named' && self.args.length > 0 && self.args.every((x) => x.k === 'unknown')) {
			const typeParams = (self.decl.node.typeParams ?? []) as Node[];
			const args = typeParams.map((x) => {
				const name = `${x.name}'${++this.vars}`;
				params.set(x.name, { k: 'param', name });
				vars.set(name, undefined);
				return { k: 'param', name } as Type;
			});
			typeParams.forEach((x, i) => defaults.push([x, (args[i] as { name: string }).name]));
		}
		const ctx: Ctx = { ...m.ctx, params };
		const paramTypes = (node.params as Node[]).map((x) => p.resolve(x.type, ctx));
		const args = e.args as Node[];
		const ret = p.returnType(node, ctx);
		const typeArg = (i: number) => {
			const param = bound[i];
			const t = this.arg(e, i, types, param ? p.substitute(paramTypes[param.index], vars) : UNKNOWN);
			if (param) p.infer(paramTypes[param.index], t, vars);
		};
		// The arguments decide first, then a type written in the statement decides what they
		// leave open (#179). A literal's type is only a guess, a closure needs its
		// parameters' types, and a list of routes needs its guard's type, so those wait.
		const rank = (i: number) => {
			const a = this.argNode(args[i]);
			return isFunctionArg(a) ? 2 : containsFunction(a) ? 3 : isLiteralNode(a) ? 1 : 0;
		};
		const order = args.map((_, i) => i).sort((i, j) => rank(i) - rank(j));
		for (const i of order.filter((i) => rank(i) === 0)) typeArg(i);
		if (want && want.k !== 'unknown') p.infer(isNamed(ret, 'Result') && ret.k === 'named' && !isNamed(want, 'Result') ? ret.args[0] : ret, want, vars);
		for (const i of order.filter((i) => rank(i) > 0)) typeArg(i);
		// A type parameter that only the result mentions can't be inferred from the arguments.
		if (want === null && typeArgs.length === 0) {
			const open = own.filter((x, i) => names[i] && vars.get(names[i]!) === undefined && !x.defaultType && !paramTypes.some((t) => mentions(t, names[i]!)));
			if (open.length > 0) {
				const callee = e.callee.kind === 'Member' ? e.callee.name : what.slice(1, -1);
				this.error(e, `nothing here says what ${andList(open.map((x) => `\`${x.name}\``))} ${open.length === 1 ? 'is' : 'are'}: write ${open.length === 1 ? 'it' : 'them'} on the call, as \`${callee}<…>(…)\`, or give the result a type`);
			}
		}
		own.forEach((x, i) => names[i] && defaults.push([x, names[i]!]));
		for (const [x, name] of defaults) if (vars.get(name) === undefined && x.defaultType) vars.set(name, p.substitute(p.resolve(x.defaultType, ctx), vars));
		const chosen = own.map((x, i) => (names[i] ? (vars.get(names[i]!) ?? UNKNOWN) : (params.get(x.name) ?? UNKNOWN)));
		this.constraints(e, what.slice(1, -1), own, chosen, { ...ctx, params: new Map([...params, ...own.map((x, i): [string, Type] => [x.name, chosen[i]])]) });
		// A method that needs more of its type's parameters (`when T: Equatable`).
		for (const w of (node.when ?? []) as Node[]) {
			const t = m.ctx.params.get(w.name);
			if (!t) continue;
			this.constraints(e, what.slice(1, -1), [w], [t], m.ctx);
		}
		const lazy = m.owner.name === 'Iterable' && isPrelude(m.owner) ? node.name : null;
		this.lazyStep = lazy;
		args.forEach((a, i) => {
			const param = bound[i];
			if (param) this.expect(this.argNode(a), types[i], p.substitute(paramTypes[param.index], vars), `\`${param.name}\` needs`);
		});
		this.lazyStep = null;
		// The words a form shows are the page's, not an error's (#229).
		if (node.name === 'explaining' && m.owner.file.endsWith('forms.d.nibl')) {
			args.forEach((a, i) => bound[i]?.name === 'text' && this.forPeople(this.argNode(a), 'a form'));
		}
		// A route or group: checked against its pattern once the whole table is typed.
		if (node.isStatic && m.owner.name === 'Route' && m.owner.file.endsWith('routes.d.nibl')) {
			e.route = { kind: node.name, args: new Map(args.map((a, i) => [bound[i]?.name ?? '', this.argNode(a)])) };
		}
		return p.substitute(ret, vars);
	}

	shapeOfCall(args: Node[]): string {
		return `(${args.map((a) => (a.name ? `${a.name}:` : '…')).join(', ')})`;
	}

}

/** A field name under a codec's naming policy, `Case.Snake` and the rest. */
function applyCase(name: string, policy: string | null): string {
	const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(' ').map((w) => w.toLowerCase());
	switch (policy) {
		case 'Snake':
			return words.join('_');
		case 'Kebab':
			return words.join('-');
		case 'Pascal':
			return words.map((w) => w[0].toUpperCase() + w.slice(1)).join('');
		case 'Camel':
			return words.map((w, i) => (i === 0 ? w : w[0].toUpperCase() + w.slice(1))).join('');
		default:
			return name;
	}
}
