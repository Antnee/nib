// A recursive-descent parser for Nib. It follows design/grammar.md; where the two
// disagree, that is a bug in one of them.
//
// Newlines are significant. Each token records whether a newline came before it, and the
// parser keeps a stack of contexts: inside `( )` and `[ ]` newlines are just
// whitespace; inside blocks and declaration bodies they end statements and members.

import { lex, SyntaxError, type Token, type DocLine } from './lexer.ts';

export type Node = { kind: string; line: number; col: number; [key: string]: any };

export interface ParsedFile {
	decls: Node[];
	docs: DocLine[];
	errors: SyntaxError[];
}

interface Context {
	/** Newlines are whitespace here: inside parentheses, brackets and literal braces. */
	ignoreNewlines: boolean;
	/** An `if`/`while`/`for`/`match` head: no `catch` handlers or `?? { }`. */
	condition: boolean;
}

const COMPARISONS = new Set(['==', '!=', '<', '<=', '>', '>=']);
const ASSIGNMENTS = new Set(['=', '+=', '-=', '*=', '/=']);

export function parse(src: string, options: { testFile: boolean; declarationFile?: boolean }): ParsedFile {
	let tokens: Token[];
	let docs: DocLine[];
	try {
		({ tokens, docs } = lex(src));
	} catch (e) {
		if (e instanceof SyntaxError) return { decls: [], docs: [], errors: [e] };
		throw e;
	}
	const parser = new Parser(tokens, options.testFile);
	parser.declarationFile = options.declarationFile ?? false;
	const decls = parser.file();
	return { decls, docs, errors: parser.errors };
}

/** Parses a doc-comment example: declarations, or else statements as if in a function body. */
export function parseSnippet(src: string): SyntaxError[] {
	let tokens: Token[];
	try {
		({ tokens } = lex(src));
	} catch (e) {
		if (e instanceof SyntaxError) return [e];
		throw e;
	}
	const parser = new Parser(tokens, false);
	const first = tokens[0];
	const declStart = first.kind === 'keyword' && ['fn', 'record', 'class', 'interface', 'enum', 'type', 'alias', 'import', 'pub', 'private', 'const'].includes(first.value);
	if (declStart || (first.kind === 'op' && first.value === '@')) {
		parser.file();
		return parser.errors;
	}
	try {
		parser.statements();
	} catch (e) {
		if (e instanceof SyntaxError) return [e];
		throw e;
	}
	return parser.errors;
}

class Parser {
	toks: Token[];
	i = 0;
	testFile: boolean;
	/** A `.d.nibl` file: an API's signatures, with no function or getter bodies. */
	declarationFile = false;
	errors: SyntaxError[] = [];
	stack: Context[] = [{ ignoreNewlines: false, condition: false }];

	constructor(tokens: Token[], testFile: boolean) {
		this.toks = tokens;
		this.testFile = testFile;
	}

	// ---- token helpers ------------------------------------------------------------------

	peek(offset = 0): Token {
		return this.toks[Math.min(this.i + offset, this.toks.length - 1)];
	}

	next(): Token {
		const t = this.toks[this.i];
		if (this.i < this.toks.length - 1) this.i++;
		return t;
	}

	isOp(value: string, t = this.peek()): boolean {
		return t.kind === 'op' && t.value === value;
	}

	isKw(value: string, t = this.peek()): boolean {
		return t.kind === 'keyword' && t.value === value;
	}

	isIdent(t = this.peek()): boolean {
		return t.kind === 'ident';
	}

	/** A member name may be a reserved word: after `.`, `fn` or `get`, or before `:`, it can't be read as one. */
	isMemberName(t = this.peek()): boolean {
		return t.kind === 'ident' || (t.kind === 'keyword' && /^[a-z]/.test(t.value));
	}

	expectMemberName(what: string): Token {
		if (!this.isMemberName()) this.fail(`expected ${what} but found ${this.describe(this.peek())}`);
		return this.next();
	}

	isWord(value: string, t = this.peek()): boolean {
		return t.kind === 'ident' && t.value === value;
	}

	fail(message: string, t = this.peek()): never {
		throw new SyntaxError(message, t.line, t.col);
	}

	describe(t: Token): string {
		if (t.kind === 'eof') return 'the end of the file';
		if (t.kind === 'string') return 'a string';
		if (t.kind === 'int' || t.kind === 'decimal') return `\`${t.value}\``;
		return `\`${t.value}\``;
	}

	expectOp(value: string): Token {
		if (!this.isOp(value)) this.fail(`expected \`${value}\` but found ${this.describe(this.peek())}`);
		return this.next();
	}

	expectKw(value: string): Token {
		if (!this.isKw(value)) this.fail(`expected \`${value}\` but found ${this.describe(this.peek())}`);
		return this.next();
	}

	expectIdent(what = 'a name'): Token {
		if (!this.isIdent()) {
			const t = this.peek();
			if (t.kind === 'keyword') this.fail(`\`${t.value}\` is a reserved word and can't be used as ${what}`);
			this.fail(`expected ${what} but found ${this.describe(t)}`);
		}
		return this.next();
	}

	node(kind: string, t: Token, fields: Record<string, any> = {}): Node {
		return { kind, line: t.line, col: t.col, ...fields };
	}

	get ctx(): Context {
		return this.stack[this.stack.length - 1];
	}

	within<T>(ctx: Partial<Context>, f: () => T): T {
		this.stack.push({ ignoreNewlines: false, condition: false, ...ctx });
		try {
			return f();
		} finally {
			this.stack.pop();
		}
	}

	/** True if the next token continues the current line: on the same line, or newlines don't count here. */
	sameLine(t = this.peek()): boolean {
		return !t.nl || this.ctx.ignoreNewlines;
	}

	/** After a statement or member: the next one must start on a new line. */
	endOfItem(closer: string | null) {
		const t = this.peek();
		if (t.kind === 'eof' || t.nl) return;
		if (closer && this.isOp(closer)) return;
		this.fail(`expected a new line before ${this.describe(t)}`);
	}

	// ---- files and declarations ---------------------------------------------------------

	file(): Node[] {
		const decls: Node[] = [];
		while (this.peek().kind !== 'eof') {
			const start = this.i;
			try {
				decls.push(this.topLevel());
				this.endOfItem(null);
			} catch (e) {
				if (!(e instanceof SyntaxError)) throw e;
				this.errors.push(e);
				this.recover(start);
			}
		}
		return decls;
	}

	/**
	 * Skips the statement that starts at `start`: to the next line that starts no further in
	 * than it did, or to the block's closer, whichever comes first outside any brackets.
	 */
	skipStatement(start: number, closer: string | null) {
		const col = this.toks[start].col;
		this.i = start;
		let depth = 0;
		for (;;) {
			const t = this.peek();
			if (t.kind === 'eof') return;
			if (depth === 0 && this.i > start && ((t.nl && t.col <= col) || (closer !== null && this.isOp(closer)))) return;
			if (t.kind === 'op' && (t.value === '(' || t.value === '{' || t.value === '[')) depth++;
			else if (t.kind === 'op' && (t.value === ')' || t.value === '}' || t.value === ']')) {
				if (depth === 0) {
					// A stray closer: step past it, or the block would end here.
					if (this.i === start) this.next();
					return;
				}
				depth--;
			}
			this.next();
		}
	}

	/** Skips to the next line that starts in the first column, where a declaration can begin. */
	recover(start: number) {
		if (this.i === start) this.next();
		while (this.peek().kind !== 'eof' && !(this.peek().nl && this.peek().col === 1)) this.next();
	}

	attributes(): Node[] {
		const attrs: Node[] = [];
		while (this.isOp('@')) {
			const at = this.next();
			const name = this.expectIdent('an attribute name');
			let args: Node[] | null = null;
			if (this.isOp('(') && this.peek().adjacent) args = this.callArgs();
			attrs.push(this.node('Attribute', at, { name: name.value, args }));
		}
		return attrs;
	}

	visibility(): string | null {
		if (this.isKw('pub') || this.isKw('private')) return this.next().value;
		if (this.isInternalMarker()) {
			this.fail("`internal` is the default here, so leave it out: it's written only on a constructor's parameter, where leaving it out means the parameter isn't a field");
		}
		return null;
	}

	/** `internal` is a word only where it marks a visibility, so a field or variable can still be called `internal`. */
	isInternalMarker(): boolean {
		const after = this.peek(1);
		return this.isWord('internal') && (after.kind === 'keyword' || after.kind === 'ident');
	}

	topLevel(): Node {
		const t = this.peek();
		if (this.isKw('import')) return this.importDecl();
		if (this.isWord('test') && this.peek(1).kind === 'string') {
			if (!this.testFile) this.fail('`test` blocks belong in `.test.nibl` files');
			return this.testDecl();
		}
		const attrs = this.attributes();
		const vis = this.visibility();
		const d = this.peek();
		let decl: Node;
		if (this.isKw('fn')) decl = this.fnDecl({ requireBody: true });
		else if (this.isKw('record') || this.isKw('class') || this.isKw('interface')) decl = this.typeDecl();
		else if (this.isKw('enum')) decl = this.enumDecl();
		else if (this.isKw('type')) decl = this.distinctDecl();
		else if (this.isKw('alias')) decl = this.aliasDecl();
		else if (this.isKw('const')) decl = this.constDecl();
		else if (this.isWord('attribute') && this.isIdent(this.peek(1))) decl = this.attributeDecl();
		else if (this.isKw('let') || this.isKw('var')) this.fail('top level holds only declarations: no `let` or `var` outside a function');
		else if (this.isKw('static') || this.isKw('lazy')) this.fail(`\`${d.value}\` is only allowed inside a type`);
		else this.fail(`expected a declaration but found ${this.describe(d)}`);
		decl.attrs = attrs;
		decl.vis = vis;
		if (attrs.length > 0) {
			decl.line = t.line;
			decl.col = t.col;
		}
		return decl;
	}

	importDecl(): Node {
		const t = this.next();
		const path = [this.expectIdent('a package or module name')];
		let names: Node[] | null = null;
		const list = () => this.within({ ignoreNewlines: true }, () => {
			this.next();
			const items: Node[] = [];
			while (!this.isOp('}')) {
				const at = this.isOp('@') ? this.next() : null;
				const n = this.expectIdent('a name to import');
				items.push(this.node('ImportName', at ?? n, { name: n.value, attribute: at !== null }));
				if (!this.isOp(',')) break;
				this.next();
			}
			this.expectOp('}');
			return items;
		});
		while (this.isOp('.')) {
			this.next();
			if (this.isOp('{')) {
				names = list();
				break;
			}
			path.push(this.expectIdent('a module name'));
		}
		// `import shop.ui with {SignUpForm}`: the module, and names from it.
		let withModule = false;
		if (!names && this.isKw('with')) {
			this.next();
			if (!this.isOp('{')) this.fail('`with` is followed by the names to import, in braces: `import shop.ui with {SignUpForm}`');
			names = list();
			withModule = true;
		}
		let alias: string | null = null;
		if (this.isKw('as')) {
			if (names) this.fail('`as` renames a module import, not a list of names');
			this.next();
			alias = this.expectIdent('a name for the module').value;
		}
		return this.node('Import', t, { path: path.map((p) => p.value), names, alias, withModule });
	}

	testDecl(): Node {
		const t = this.next();
		const name = this.next();
		let pattern: Node | null = null;
		let iterable: Node | null = null;
		if (this.isKw('for')) {
			this.next();
			pattern = this.pattern(false);
			this.expectKw('in');
			iterable = this.condition(() => this.expr());
		}
		const body = this.block();
		return this.node('Test', t, { name: name.str, pattern, iterable, body });
	}

	typeParams(): Node[] {
		if (!this.isOp('<')) return [];
		return this.within({ ignoreNewlines: true }, () => {
			this.next();
			const params: Node[] = [];
			while (!this.isOp('>')) {
				if (this.isKw('const')) this.fail('const generic parameters are reserved for a later version');
				const name = this.expectIdent('a type parameter');
				const constraints: Node[] = [];
				if (this.isOp(':')) {
					this.next();
					constraints.push(this.type());
					while (this.isKw('and')) {
						this.next();
						constraints.push(this.type());
					}
				}
				let defaultType: Node | null = null;
				if (this.isOp('=')) {
					this.next();
					defaultType = this.type();
				} else if (params.some((p) => p.defaultType)) {
					this.fail('type parameters with defaults come last', name);
				}
				params.push(this.node('TypeParam', name, { name: name.value, constraints, defaultType }));
				if (!this.isOp(',')) break;
				this.next();
			}
			this.expectOp('>');
			return params;
		});
	}

	fnDecl(opts: { requireBody: boolean; allowBodiless?: boolean; member?: boolean; allowDefault?: boolean }): Node {
		const t = this.expectKw('fn');
		const nameTok = this.peek();
		const name = this.isIdent() || (opts.member && this.isMemberName()) ? this.next().value : this.fail(nameTok.kind === 'keyword' ? `\`${nameTok.value}\` is a reserved word and can't name a function` : 'expected a function name');
		const typeParams = this.typeParams();
		const params = this.params();
		let ret: Node | null = null;
		let err: Node | null = null;
		if (this.isOp('->')) {
			this.next();
			ret = this.type();
		}
		// `else` straight after the parameters: a function that returns nothing but can fail.
		if (this.isKw('else')) {
			this.next();
			err = this.type();
		}
		const when: Node[] = [];
		if (this.isKw('when')) {
			this.next();
			do {
				if (when.length > 0) this.next();
				const p = this.expectIdent('a type parameter');
				this.expectOp(':');
				const constraints = [this.type()];
				while (this.isKw('and')) {
					this.next();
					constraints.push(this.type());
				}
				when.push(this.node('When', p, { name: p.value, constraints }));
			} while (this.isOp(','));
		}
		let body: Node | null = null;
		if (this.isOp('{') && this.sameLine()) {
			if (this.declarationFile && !opts.allowDefault) this.fail('a declaration file has signatures only: leave out the body');
			body = this.block();
		} else if (opts.requireBody && !opts.allowBodiless && !this.declarationFile) {
			this.fail('expected `{` to start the function body');
		}
		return this.node('Fn', t, { name, typeParams, params, ret, err, when, body, isStatic: false, isMut: false });
	}

	/**
	 * A class's constructor: `construct(private name: Type, other: Type) { … }`. A parameter
	 * marked `private`, `internal`, `pub` or `var` is also a field, set before the body runs. It builds
	 * the class it's in, so it has no return type, and it can't fail.
	 */
	constructorDecl(): Node {
		const t = this.next();
		const params = this.params(true);
		if (this.isOp('->')) this.fail('a constructor builds the class it belongs to, so it has no return type: `construct(…) { … }`');
		if (this.isKw('else')) this.fail("a constructor can't fail: for building that can, write a static function that returns `Type else Error` and calls `new`");
		let body: Node | null = null;
		if (this.isOp('{') && this.sameLine()) {
			if (this.declarationFile) this.fail('a declaration file has signatures only: leave out the body');
			body = this.block();
		} else if (!this.declarationFile) {
			this.fail('expected `{` to start the constructor\'s body: `{}` when it has nothing to do');
		}
		return this.node('Fn', t, { name: 'construct', typeParams: [], params, ret: null, err: null, when: [], body, isStatic: true, isMut: false, isConstructor: true });
	}

	params(fields = false): Node[] {
		return this.within({ ignoreNewlines: true }, () => {
			this.expectOp('(');
			const params: Node[] = [];
			while (!this.isOp(')')) {
				const attrs = this.attributes();
				const start = this.peek();
				let named = false;
				let mut = false;
				if (this.isWord('named') && (this.isIdent(this.peek(1)) || this.isKw('mut', this.peek(1)) || (fields && (['private', 'pub', 'var'].some((k) => this.isKw(k, this.peek(1))) || this.isWord('internal', this.peek(1)))))) {
					this.next();
					named = true;
				}
				// A field declared by a constructor: `private var name: Type`. Here, unlike anywhere
				// else, leaving the visibility out means something else (a plain parameter), so the
				// default visibility is written: `internal name: Type`.
				let fieldVis: string | null = null;
				if (fields && this.isInternalMarker()) {
					this.next();
					fieldVis = 'internal';
					if (this.isKw('var')) this.fail('`var` already makes the parameter a field visible across the package, so leave out `internal`');
				} else if (fields) fieldVis = this.visibility();
				let fieldVar = false;
				if (fields && this.isKw('var')) {
					this.next();
					fieldVar = true;
				}
				if (!fields && (this.isKw('private') || this.isKw('pub') || this.isKw('var') || this.isInternalMarker())) {
					this.fail(`only a class's constructor declares fields with its parameters, so \`${this.peek().value}\` doesn't belong on a parameter`);
				}
				if (this.isKw('mut')) {
					this.next();
					mut = true;
				}
				const nameTok = this.expectIdent('a parameter name');
				this.expectOp(':');
				const type = this.type();
				let defaultValue: Node | null = null;
				if (this.isOp('=')) {
					if (!named) this.fail(`only a \`named\` parameter can have a default, so every call that changes it says so: \`named ${nameTok.value}: … = …\``);
					this.next();
					defaultValue = this.expr();
				}
				params.push(this.node('Param', start, { name: nameTok.value, type, named, mut, attrs, defaultValue, fieldVis, fieldVar, nameLine: nameTok.line, nameCol: nameTok.col }));
				if (!this.isOp(',')) break;
				this.next();
			}
			this.expectOp(')');
			return params;
		});
	}

	implementsList(): Node[] {
		if (!this.isKw('implements')) return [];
		this.next();
		const list = [this.type()];
		while (this.isOp(',')) {
			this.next();
			list.push(this.type());
		}
		return list;
	}

	typeDecl(): Node {
		const t = this.next();
		const name = this.expectIdent('a type name');
		const typeParams = this.typeParams();
		const impls = this.implementsList();
		const members = this.members(t.value);
		const constructors = members.filter((m) => m.isConstructor);
		if (constructors.length > 1) this.fail('a class has one constructor: for other ways to build one, write static functions that call it', constructors[1]);
		const construct = constructors[0];
		if (construct) {
			// It gives the class itself, with its own type parameters.
			construct.ret = { kind: 'NamedType', line: construct.line, col: construct.col, path: [name.value], args: typeParams.map((x: Node) => ({ kind: 'NamedType', line: x.line, col: x.col, path: [x.name], args: [] })) };
			construct.typeParams = [];
			const fields = this.promotedFields(construct);
			const clash = fields.find((f) => members.some((m) => m.name === f.name));
			if (clash) this.fail(`\`${clash.name}\` is declared by the constructor and again in the class: declare it once`, clash);
			members.unshift(...fields);
		}
		return this.node('TypeDecl', t, { typeKind: t.value, name: name.value, typeParams, implements: impls, members });
	}

	/** The constructor's parameters marked `private`, `internal`, `pub` or `var`, as the fields they declare. */
	promotedFields(construct: Node): Node[] {
		return construct.params.filter((p: Node) => p.fieldVis || p.fieldVar).map((p: Node) => ({
			kind: 'Field', line: p.nameLine, col: p.nameCol, name: p.name, type: p.type, init: null,
			lazy: false, mutable: p.fieldVar, attrs: [], vis: p.fieldVis === 'internal' ? null : p.fieldVis, isOverride: false, promoted: true,
		}));
	}

	enumDecl(): Node {
		const t = this.next();
		const name = this.expectIdent('an enum name');
		const typeParams = this.typeParams();
		let backing: Node | null = null;
		if (this.isOp(':')) {
			this.next();
			backing = this.type();
		}
		const impls = this.implementsList();
		const members = this.members('enum');
		return this.node('TypeDecl', t, { typeKind: 'enum', name: name.value, typeParams, backing, implements: impls, members });
	}

	distinctDecl(): Node {
		const t = this.next();
		const name = this.expectIdent('a type name');
		const typeParams = this.typeParams();
		// `type UserId: Int` is a new type backed by an `Int`, as `enum Status: String` is backed
		// by a `String`; `=` means the same type, which is what `alias` is for.
		if (this.isOp('=')) this.fail(`a distinct type is a new type backed by its base, written with \`:\`, as in \`type ${name.value}: …\`; \`=\` would mean the same type, which is \`alias ${name.value} = …\``);
		this.expectOp(':');
		let isPrivate = false;
		if (this.isKw('private')) {
			this.next();
			isPrivate = true;
		}
		const base = this.type();
		const impls = this.implementsList();
		let members: Node[] = [];
		if (this.isOp('{') && this.sameLine()) members = this.members('type');
		return this.node('TypeDecl', t, { typeKind: 'type', name: name.value, typeParams, base, privateWrap: isPrivate, implements: impls, members });
	}

	aliasDecl(): Node {
		const t = this.next();
		const name = this.expectIdent('a type name');
		const typeParams = this.typeParams();
		this.expectOp('=');
		const target = this.type();
		return this.node('TypeDecl', t, { typeKind: 'alias', name: name.value, typeParams, target, implements: [], members: [] });
	}

	constDecl(): Node {
		const t = this.next();
		const name = this.expectIdent('a constant name');
		let type: Node | null = null;
		if (this.isOp(':')) {
			this.next();
			type = this.type();
		}
		if (this.declarationFile && type && !this.isOp('=')) return this.node('Const', t, { name: name.value, type, value: null });
		this.expectOp('=');
		const value = this.expr();
		return this.node('Const', t, { name: name.value, type, value });
	}

	attributeDecl(): Node {
		const t = this.next();
		const name = this.expectIdent('an attribute name');
		// The interfaces a type marked with this attribute implements.
		const impls = this.implementsList();
		const members = this.members('attribute');
		return this.node('TypeDecl', t, { typeKind: 'attribute', name: name.value, typeParams: [], implements: impls, members });
	}

	/** The `{ … }` body of a record, class, interface, enum, distinct type, attribute or `new`. */
	members(owner: string): Node[] {
		return this.within({}, () => {
			this.expectOp('{');
			const members: Node[] = [];
			while (!this.isOp('}')) {
				if (this.peek().kind === 'eof') this.fail('expected `}` to close the body');
				members.push(this.member(owner));
				this.endOfItem('}');
			}
			this.next();
			return members;
		});
	}

	member(owner: string): Node {
		const start = this.peek();
		const attrs = this.attributes();
		const vis = this.visibility();
		let m: Node;
		const bodiless = owner === 'interface';
		// `override` is a word only here, before a member, so a field or variable can still be
		// called `override`.
		const isOverride = this.isWord('override') && !this.isOp(':', this.peek(1)) && !this.isOp('(', this.peek(1));
		if (isOverride) {
			if (owner === 'interface') this.fail("`override` marks a member that implements an interface's member, so it doesn't belong in an interface");
			this.next();
		}
		const fieldName = this.isMemberName() && this.isOp(':', this.peek(1));
		if (fieldName) {
			m = this.field(owner, start);
		} else if (this.isKw('static') && this.isWord('get', this.peek(1))) {
			this.next();
			m = this.getter(bodiless);
			m.isStatic = true;
		} else if (this.isWord('construct') && this.isOp('(', this.peek(1)) && this.peek(1).adjacent) {
			if (owner !== 'class') this.fail(owner === 'record' ? "a record is built from its fields, `Point(x: 1, y: 2)`, so it has no constructor: for checks, write a static function" : `only a class has a constructor`);
			m = this.constructorDecl();
		} else if (this.isKw('static')) {
			this.next();
			if (owner === 'class' && this.isKw('fn') && this.isWord('construct', this.peek(1))) this.fail('a constructor is declared as `construct(…) { … }`, without `static fn` or a return type');
			m = this.fnDecl({ requireBody: true, allowBodiless: bodiless, member: true, allowDefault: bodiless });
			m.isStatic = true;
		} else if (this.isKw('mut')) {
			this.next();
			m = this.fnDecl({ requireBody: true, allowBodiless: bodiless, member: true, allowDefault: bodiless });
			m.isMut = true;
		} else if (this.isKw('fn')) {
			m = this.fnDecl({ requireBody: true, allowBodiless: bodiless, member: true, allowDefault: bodiless });
		} else if (this.isWord('get') && this.isMemberName(this.peek(1))) {
			m = this.getter(bodiless);
		} else if (this.isKw('const')) {
			m = this.constDecl();
		} else if (this.isKw('lazy') || this.isKw('var')) {
			m = this.field(owner, start);
		} else if (owner === 'enum' && this.isIdent()) {
			m = this.variant();
		} else if (this.isKw('let')) {
			this.fail('fields are declared as `name: Type`, without `let`');
		} else {
			this.fail(`expected a member but found ${this.describe(this.peek())}`);
		}
		if (isOverride && m.kind !== 'Fn' && m.kind !== 'Getter' && m.kind !== 'Field') this.fail('`override` marks a method, getter or field that implements an interface member');
		m.attrs = attrs;
		m.vis = vis;
		m.isOverride = isOverride;
		return m;
	}

	getter(bodiless: boolean): Node {
		const t = this.next();
		const name = this.expectMemberName('a property name');
		this.expectOp(':');
		const type = this.type();
		let body: Node | null = null;
		const hasBody = this.isOp('=>') || (this.isOp('{') && this.sameLine());
		if (hasBody && this.declarationFile && !bodiless) this.fail('a declaration file has signatures only: leave out the body');
		if (this.isOp('=>')) {
			this.next();
			body = this.expr();
		} else if (this.isOp('{') && this.sameLine()) {
			this.fail("a getter's body is one expression, after `=>`: anything that needs statements is a method");
		} else if (!bodiless && !this.declarationFile) {
			this.fail('expected `=>` and an expression for the getter');
		}
		return this.node('Getter', t, { name: name.value, type, body, isStatic: false, nameLine: name.line, nameCol: name.col });
	}

	field(owner: string, start: Token): Node {
		let lazy = false;
		let mutable = false;
		if (this.isKw('lazy')) {
			this.next();
			lazy = true;
		} else if (this.isKw('var')) {
			this.next();
			mutable = true;
		}
		const name = this.expectMemberName('a field name');
		this.expectOp(':');
		const type = this.type();
		let init: Node | null = null;
		if (this.isOp('=')) {
			this.next();
			init = this.expr();
		} else if (lazy) {
			this.fail('a `lazy` field needs `= …` to say how it is built');
		}
		if (owner === 'enum' || owner === 'type') this.fail(`${owner === 'enum' ? 'an enum' : 'a distinct type'} can't have stored fields`, start);
		return this.node('Field', name, { name: name.value, type, init, lazy, mutable });
	}

	variant(): Node {
		const name = this.next();
		let payload: Node[] | null = null;
		let from: Node | null = null;
		// One value without a name, `Ok(T)`, held as `from` holds one but never converted to.
		let held: Node | null = null;
		if (this.isOp('(') && this.peek().adjacent) {
			this.within({ ignoreNewlines: true }, () => {
				this.next();
				if (this.isWord('from') && !this.isOp(':', this.peek(1))) {
					this.next();
					from = this.type();
					held = from;
				} else if (!(this.isMemberName() && this.isOp(':', this.peek(1)))) {
					held = this.type();
				} else {
					payload = [];
					while (!this.isOp(')')) {
						const field = this.expectMemberName('a payload field name');
						this.expectOp(':');
						const type = this.type();
						let init: Node | null = null;
						if (this.isOp('=')) {
							this.next();
							init = this.expr();
						}
						payload.push(this.node('Field', field, { name: field.value, type, init }));
						if (!this.isOp(',')) break;
						this.next();
					}
				}
				this.expectOp(')');
			});
		}
		let value: Node | null = null;
		if (this.isOp('=')) {
			this.next();
			value = this.expr();
		}
		return this.node('Variant', name, { name: name.value, payload, from, held, value });
	}

	// ---- types --------------------------------------------------------------------------

	type(): Node {
		let t = this.typeAtom();
		while (this.isOp('?') && this.peek().adjacent) {
			const q = this.next();
			t = this.node('NullableType', q, { inner: t });
		}
		return t;
	}

	typeAtom(): Node {
		const t = this.peek();
		if (this.isKw('fn')) {
			this.next();
			const params = this.within({ ignoreNewlines: true }, () => {
				this.expectOp('(');
				const list: Node[] = [];
				while (!this.isOp(')')) {
					list.push(this.type());
					if (!this.isOp(',')) break;
					this.next();
				}
				this.expectOp(')');
				return list;
			});
			let ret: Node | null = null;
			let err: Node | null = null;
			if (this.isOp('->')) {
				this.next();
				ret = this.type();
				if (this.isKw('else') && this.sameLine()) {
					this.next();
					err = this.type();
				}
			}
			return this.node('FnType', t, { params, ret, err });
		}
		if (this.isOp('(')) {
			const items = this.within({ ignoreNewlines: true }, () => {
				this.next();
				const list: Node[] = [];
				while (!this.isOp(')')) {
					list.push(this.type());
					if (!this.isOp(',')) break;
					this.next();
				}
				this.expectOp(')');
				return list;
			});
			// One type in parentheses groups it, as in `(fn() -> Int)?`.
			if (items.length === 1) return items[0];
			if (items.length < 2) this.fail('a tuple type needs at least two element types', t);
			return this.node('TupleType', t, { items });
		}
		let name: string;
		if (this.isKw('This')) name = this.next().value;
		else name = this.expectIdent('a type').value;
		const path = [name];
		while (this.isOp('.') && this.isIdent(this.peek(1))) {
			this.next();
			path.push(this.next().value);
		}
		let args: Node[] = [];
		if (this.isOp('<') && this.peek().adjacent) args = this.typeArgs();
		return this.node('NamedType', t, { path, args });
	}

	typeArgs(): Node[] {
		return this.within({ ignoreNewlines: true }, () => {
			this.expectOp('<');
			const args: Node[] = [];
			while (!this.isOp('>')) {
				args.push(this.type());
				if (!this.isOp(',')) break;
				this.next();
			}
			this.expectOp('>');
			return args;
		});
	}

	/** `<T>` after a name in an expression, if what follows makes it a type argument list. */
	speculativeTypeArgs(): Node[] | null {
		if (!this.isOp('<') || !this.peek().adjacent) return null;
		const save = this.i;
		const saveErrors = this.errors.length;
		try {
			const args = this.typeArgs();
			if ((this.isOp('(') || this.isOp('.')) && this.peek().adjacent) return args;
			// A record literal's brace may have a space before it, as in `Page<User> { … }`.
			if (this.isOp('{') && this.sameLine()) return args;
		} catch (e) {
			if (!(e instanceof SyntaxError)) throw e;
		}
		this.i = save;
		this.errors.length = saveErrors;
		return null;
	}

	// ---- statements ---------------------------------------------------------------------

	block(): Node {
		const t = this.peek();
		this.expectOp('{');
		const body = this.statementsUntil('}');
		this.next();
		return this.node('Block', t, { body });
	}

	statements(): Node[] {
		return this.statementsUntil(null);
	}

	statementsUntil(closer: string | null): Node[] {
		const out: Node[] = [];
		for (;;) {
			if (closer && this.isOp(closer)) return out;
			if (this.peek().kind === 'eof') {
				if (closer) this.fail(`expected \`${closer}\` to close the block`);
				return out;
			}
			const start = this.i;
			try {
				out.push(this.statement());
				this.endOfItem(closer);
			} catch (e) {
				// Keep going with the block's next statement, so one mistake doesn't lose the
				// declaration around it.
				if (!(e instanceof SyntaxError)) throw e;
				this.errors.push(e);
				this.skipStatement(start, closer);
			}
		}
	}

	condition<T>(f: () => T): T {
		return this.within({ condition: true, ignoreNewlines: false }, f);
	}

	statement(): Node {
		const t = this.peek();
		if (this.isKw('let') || this.isKw('var')) {
			this.next();
			const mutable = t.value === 'var';
			const pattern = this.isOp('(') && !mutable ? this.pattern(false) : this.bindingPattern();
			let type: Node | null = null;
			if (this.isOp(':')) {
				this.next();
				type = this.type();
			}
			// `let name: Type` with no value is set later, once on every path, such as in each
			// arm of a `match`.
			if (!this.isOp('=') && !mutable && type && pattern.kind === 'BindPattern') {
				return this.node('Let', t, { mutable, pattern, type, init: null });
			}
			if (!this.isOp('=')) {
				this.fail(mutable ? '`var` needs a value: `var name = …`' : '`let` needs a value, or a type to be set later: `let name = …` or `let name: Type`');
			}
			this.next();
			const init = this.expr();
			return this.node('Let', t, { mutable, pattern, type, init });
		}
		if (this.isKw('const')) return this.constDecl();
		if (this.isKw('return')) {
			this.next();
			const value = this.hasOperand() ? this.expr() : null;
			return this.node('Return', t, { value });
		}
		if (this.isKw('fail')) {
			this.next();
			return this.node('Fail', t, { value: this.expr() });
		}
		if (this.isKw('break') || this.isKw('continue')) {
			this.next();
			let label: string | null = null;
			if (this.isIdent() && !this.peek().nl) label = this.next().value;
			return this.node(t.value === 'break' ? 'Break' : 'Continue', t, { label });
		}
		// A generator's next item. Whether the function is a generator is the type stage's question.
		if (this.isKw('yield')) {
			this.next();
			return this.node('Yield', t, { value: this.expr() });
		}
		if (this.isKw('defer')) {
			this.next();
			let errorOnly = false;
			if (this.isKw('else')) {
				this.next();
				errorOnly = true;
			}
			if (this.isKw('start')) this.fail('`defer start` isn\'t allowed: a task started while the block exits would outlive it');
			return this.node('Defer', t, { errorOnly, value: this.expr() });
		}
		if (this.isKw('if')) return this.ifStatement();
		if (this.isKw('for')) return this.forStatement(null);
		if (this.isKw('while')) return this.whileStatement(null);
		if (this.isKw('do')) return this.doStatement(null);
		if (this.isIdent() && this.isOp(':', this.peek(1)) && ['for', 'while', 'do'].some((k) => this.isKw(k, this.peek(2)))) {
			const label = this.next().value;
			this.next();
			if (this.isKw('for')) return this.forStatement(label);
			if (this.isKw('while')) return this.whileStatement(label);
			return this.doStatement(label);
		}
		if (this.isKw('fn') && this.isIdent(this.peek(1))) {
			this.fail('a function can\'t be declared inside another: use a closure, `let name = fn(…) => …`, or move it to the top level, which a function that calls itself or yields needs');
		}
		if (this.testFile && this.isWord('expect') && !this.peek(1).nl && !this.startsPostfixOrAssign(this.peek(1))) {
			this.next();
			return this.node('Expect', t, { value: this.expr() });
		}
		if (this.isOp('{')) this.fail('a block can\'t stand on its own here');

		const e = this.expr();
		const op = this.peek();
		if (op.kind === 'op' && ASSIGNMENTS.has(op.value) && this.sameLine(op)) {
			this.assignable(e);
			this.next();
			const value = this.expr();
			return this.node('Assign', t, { target: e, op: op.value, value });
		}
		if ((this.isOp('++') || this.isOp('--')) && this.sameLine()) {
			this.assignable(e);
			this.next();
			return this.node('IncDec', t, { target: e, op: op.value });
		}
		return this.node('ExprStmt', t, { value: e });
	}

	startsPostfixOrAssign(t: Token): boolean {
		return t.kind === 'op' && ['(', '.', '?.', '[', '=', '+=', '-=', '*=', '/=', '++', '--', ':', ','].includes(t.value);
	}

	assignable(e: Node) {
		if (e.kind === 'Name' || e.kind === 'Member' || e.kind === 'Index') return;
		this.fail('only a variable, a field or an indexed element can be assigned', { line: e.line, col: e.col } as Token);
	}

	/** Whether `return` has a value: anything on the same line other than a closing bracket. */
	hasOperand(): boolean {
		const t = this.peek();
		if (t.kind === 'eof' || !this.sameLine(t)) return false;
		return !(t.kind === 'op' && [')', ']', '}', ',', ':'].includes(t.value));
	}

	bindingPattern(): Node {
		const t = this.peek();
		const name = this.expectIdent('a variable name');
		if (name.value === '_') return this.node('WildcardPattern', t);
		return this.node('BindPattern', t, { name: name.value });
	}

	ifStatement(): Node {
		const t = this.next();
		const cond = this.condition(() => this.expr());
		this.conditionEnd('if');
		const then = this.block();
		let otherwise: Node | null = null;
		if (this.isKw('else')) {
			this.next();
			if (this.isKw('if')) otherwise = this.ifStatement();
			else otherwise = this.block();
		}
		return this.node('If', t, { cond, then, otherwise });
	}

	/** Explains the usual mistakes when a condition isn't followed by its block. */
	conditionEnd(keyword: string) {
		if (this.isOp('{') && this.sameLine()) return;
		if (this.isKw('catch')) this.fail(`a \`catch\` handler isn't allowed in the condition of \`${keyword}\`; bind the result with \`let\` first`);
		if (this.isOp('{')) this.fail(`the \`{\` after \`${keyword}\` must be on the same line`);
		this.fail(`expected \`{\` after the condition but found ${this.describe(this.peek())}`);
	}

	forStatement(label: string | null): Node {
		const t = this.next();
		const pattern = this.pattern(false);
		this.expectKw('in');
		const iterable = this.condition(() => this.expr());
		this.conditionEnd('for');
		const body = this.block();
		return this.node('For', t, { label, pattern, iterable, body });
	}

	whileStatement(label: string | null): Node {
		const t = this.next();
		const cond = this.condition(() => this.expr());
		this.conditionEnd('while');
		const body = this.block();
		return this.node('While', t, { label, cond, body });
	}

	doStatement(label: string | null): Node {
		const t = this.next();
		const body = this.block();
		this.expectKw('while');
		const cond = this.condition(() => this.expr());
		return this.node('DoWhile', t, { label, body, cond });
	}

	// ---- expressions, lowest precedence first --------------------------------------------

	expr(): Node {
		const e = this.ternary();
		const t = this.peek();
		// A `catch` handler may start the next line (a continuation, like a leading `.`).
		if (this.isKw('else') && !this.ctx.condition) this.fail('a failure is handled with `catch`, as in `… catch err { … }`: `else` is for `if` and for a signature');
		if (this.isKw('catch') && !this.ctx.condition) {
			if (e.kind === 'Try') this.fail('`try` passes a failure on and `catch` handles it, so a call takes one or the other');
			this.next();
			let binding: string | null = null;
			let bindingTok: Token | null = null;
			if (this.isIdent() || this.isWord('_')) {
				bindingTok = this.next();
				binding = bindingTok.value;
			}
			if (!this.isOp('{')) this.fail(binding ? 'expected `{` after the error\'s name' : 'expected an error name or `{` after `catch`');
			const handler = this.block();
			return this.node('Else', t, { value: e, binding, handler, bindingLine: bindingTok?.line, bindingCol: bindingTok?.col });
		}
		return e;
	}

	ternary(): Node {
		const cond = this.coalesce();
		if (this.isOp('?') && this.sameLine()) {
			const q = this.next();
			const a = this.coalesce();
			if (this.isOp('?')) this.fail('nested conditional expressions need parentheses');
			this.expectOp(':');
			const b = this.coalesce();
			if (this.isOp('?') && this.sameLine()) this.fail('nested conditional expressions need parentheses');
			return this.node('Ternary', q, { cond, then: a, otherwise: b });
		}
		return cond;
	}

	coalesce(): Node {
		const left = this.pipe();
		// No statement starts with `??` or `?:`, so one at the start of a line continues the one before.
		if (this.isOp('??') || this.isOp('?:')) {
			const op = this.next();
			if (this.isOp('{')) {
				if (this.ctx.condition) this.fail(`a \`${op.value} { … }\` block isn't allowed in a condition; bind the value with \`let\` first`);
				return this.node('Coalesce', op, { op: op.value, left, right: this.block() });
			}
			return this.node('Coalesce', op, { op: op.value, left, right: this.coalesce() });
		}
		return left;
	}

	pipe(): Node {
		let left = this.or();
		while (this.isOp('|>')) {
			const op = this.next();
			left = this.node('Pipe', op, { left, right: this.or() });
		}
		return left;
	}

	binaryLevel(ops: string[], operand: () => Node, kind = 'Binary'): Node {
		let left = operand();
		for (;;) {
			const t = this.peek();
			const matches = (t.kind === 'op' || t.kind === 'keyword') && ops.includes(t.value);
			if (!matches || !this.sameLine(t)) return left;
			this.next();
			left = this.node(kind, t, { op: t.value, left, right: operand() });
		}
	}

	or(): Node {
		return this.binaryLevel(['or'], () => this.and());
	}

	and(): Node {
		return this.binaryLevel(['and'], () => this.not());
	}

	not(): Node {
		if (this.isKw('not')) {
			const t = this.next();
			return this.node('Not', t, { value: this.not() });
		}
		return this.comparison();
	}

	comparison(): Node {
		const left = this.range();
		const t = this.peek();
		if (!this.sameLine(t)) return left;
		let result: Node | null = null;
		if (t.kind === 'op' && COMPARISONS.has(t.value)) {
			this.next();
			result = this.node('Binary', t, { op: t.value, left, right: this.range() });
		} else if (this.isKw('is')) {
			this.next();
			let negated = false;
			if (this.isKw('not')) {
				this.next();
				negated = true;
			}
			// `x is not null` names nothing: a value that needs a name is put in a `let` first.
			const name = this.peek(1);
			if (negated && this.isKw('null') && this.isIdent(name) && /^[a-z]/.test(name.value) && !name.nl) {
				this.fail(`\`is not null\` doesn't name the value: put it in a \`let\` first, as \`let ${name.value} = …\`, then test \`${name.value} is not null\``);
			}
			result = this.node('Is', t, { value: left, pattern: this.pattern(false), negated });
		} else if (this.isKw('in')) {
			this.next();
			result = this.node('Binary', t, { op: 'in', left, right: this.range() });
		}
		if (!result) return left;
		const after = this.peek();
		if (this.sameLine(after) && ((after.kind === 'op' && COMPARISONS.has(after.value)) || this.isKw('is') || this.isKw('in'))) {
			this.fail('comparisons can\'t be chained: write `a < b and b < c`, or `b in a..c`');
		}
		return result;
	}

	range(): Node {
		const left = this.bitOr();
		if ((this.isOp('..') || this.isOp('..<')) && this.sameLine()) {
			const t = this.next();
			return this.node('Range', t, { left, right: this.bitOr(), exclusive: t.value === '..<' });
		}
		return left;
	}

	bitOr(): Node {
		return this.binaryLevel(['|'], () => this.bitXor());
	}

	bitXor(): Node {
		return this.binaryLevel(['^'], () => this.bitAnd());
	}

	bitAnd(): Node {
		return this.binaryLevel(['&'], () => this.shift());
	}

	shift(): Node {
		let left = this.additive();
		for (;;) {
			const t = this.peek();
			if (!this.sameLine(t)) return left;
			if (this.isOp('<<')) {
				this.next();
				left = this.node('Binary', t, { op: '<<', left, right: this.additive() });
			} else if (this.isOp('>') && this.isOp('>', this.peek(1)) && this.peek(1).adjacent) {
				// `>>` is lexed as two `>` so that `List<List<T>>` closes cleanly.
				this.next();
				this.next();
				left = this.node('Binary', t, { op: '>>', left, right: this.additive() });
			} else {
				return left;
			}
		}
	}

	additive(): Node {
		return this.binaryLevel(['+', '-'], () => this.multiplicative());
	}

	multiplicative(): Node {
		return this.binaryLevel(['*', '/', 'div', 'mod'], () => this.unary());
	}

	unary(): Node {
		const t = this.peek();
		if (this.isOp('-') || this.isOp('~')) {
			this.next();
			return this.node('Unary', t, { op: t.value, value: this.unary() });
		}
		// `try` and `start` bind like `-`: they take the call chain to their right, and no more.
		if (this.isKw('try') || this.isKw('start')) {
			this.next();
			return this.node(t.value === 'try' ? 'Try' : 'Start', t, { value: this.unary() });
		}
		return this.postfix(this.primary());
	}

	isTypeLike(e: Node): boolean {
		if (e.kind === 'Name') return /^[A-Z]/.test(e.name) && /[a-z]/.test(e.name);
		if (e.kind === 'Member') return /^[A-Z]/.test(e.name) && /[a-z]/.test(e.name) && this.isPath(e.object);
		return false;
	}

	pathText(e: Node): string {
		return e.kind === 'Name' ? e.name : e.kind === 'Member' ? `${this.pathText(e.object)}.${e.name}` : 'Type';
	}

	isPath(e: Node): boolean {
		return e.kind === 'Name' || (e.kind === 'Member' && this.isPath(e.object));
	}

	postfix(e: Node): Node {
		for (;;) {
			const t = this.peek();
			if (this.isOp('.') || this.isOp('?.')) {
				// A leading `.` or `?.` on the next line continues the chain.
				this.next();
				const name = this.peek();
				if (!this.isMemberName()) this.fail(`expected a member name after \`${t.value}\``);
				this.next();
				e = this.node('Member', t, { object: e, name: name.value, safe: t.value === '?.', nameLine: name.line, nameCol: name.col });
				continue;
			}
			if (!this.sameLine(t)) return e;
			if (this.isOp('<') && t.adjacent) {
				const typeArgs = this.speculativeTypeArgs();
				if (typeArgs) {
					if (this.isOp('(')) {
						e = this.node('Call', t, { callee: e, typeArgs, args: this.callArgs() });
					} else if (this.isOp('{') && !this.ctx.condition && this.looksLikeFields()) {
						this.fail(`a record is built with brackets and named fields: \`${this.pathText(e)}<…>(name: value)\``);
					} else {
						e = this.node('TypeApply', t, { callee: e, typeArgs });
					}
					continue;
				}
				return e;
			}
			if (this.isOp('(') && t.adjacent) {
				e = this.node('Call', t, { callee: e, typeArgs: [], args: this.callArgs() });
				continue;
			}
			if (this.isOp('[') && t.adjacent) {
				const index = this.within({ ignoreNewlines: true }, () => {
					this.next();
					const ix = this.expr();
					this.expectOp(']');
					return ix;
				});
				e = this.node('Index', t, { object: e, index });
				continue;
			}
			if (this.isOp('{') && this.isTypeLike(e) && !this.ctx.condition && this.looksLikeFields()) {
				this.fail(`a record is built with brackets and named fields: \`${this.pathText(e)}(name: value)\``);
			}
			if (this.isKw('with')) {
				this.next();
				if (this.isOp('{')) this.fail('`with` lists the changed fields in brackets: `point with (x: 5)`');
				if (!this.isOp('(')) this.fail('expected `(` after `with`');
				e = this.node('With', t, { value: e, fields: this.fieldArgs('`with`') });
				continue;
			}
			if (this.isOp('++') || this.isOp('--')) {
				const after = this.peek(1);
				if (!after.nl && after.kind !== 'eof' && !this.isOp('}', after)) this.fail(`\`${t.value}\` is a statement, not an expression`);
			}
			return e;
		}
	}

	callArgs(): Node[] {
		return this.within({ ignoreNewlines: true }, () => {
			this.expectOp('(');
			const args: Node[] = [];
			let sawNamed = false;
			while (!this.isOp(')')) {
				const t = this.peek();
				if (this.isMemberName() && this.isOp(':', this.peek(1))) {
					this.next();
					this.next();
					sawNamed = true;
					if (this.isOp(',') || this.isOp(')')) {
						if (t.kind === 'keyword') this.fail(`\`${t.value}:\` on its own passes a variable called \`${t.value}\`, which is a reserved word; write \`${t.value}: value\``, t);
						args.push(this.node('Arg', t, { name: t.value, value: null, punned: true }));
					} else {
						args.push(this.node('Arg', t, { name: t.value, value: this.expr(), punned: false }));
					}
				} else {
					if (sawNamed) this.fail('positional arguments come before named ones');
					args.push(this.node('Arg', t, { name: null, value: this.expr(), punned: false }));
				}
				if (!this.isOp(',')) break;
				this.next();
			}
			this.expectOp(')');
			return args;
		});
	}

	/** `Point { x: 1 }`, `Point {}` and `Point { x, y }`: the old record literal, after a type name. */
	looksLikeFields(): boolean {
		const a = this.peek(1);
		const b = this.peek(2);
		return this.isOp('}', a) || (this.isMemberName(a) && (this.isOp(':', b) || this.isOp(',', b) || (this.isOp('}', b) && this.sameLine(b))));
	}

	/** `(name: value, other:)` after `with`: every argument names a field. */
	fieldArgs(what: string): Node[] {
		return this.callArgs().map((a) => {
			if (a.name === null) this.fail(`${what} names each field it sets: \`name: value\`, or \`name:\` for a variable of the same name`, a);
			return { ...a, kind: 'FieldInit' };
		});
	}

	primary(): Node {
		const t = this.peek();
		switch (t.kind) {
			case 'int':
			case 'decimal':
				this.next();
				return this.node(t.kind === 'int' ? 'Int' : 'Decimal', t, { value: t.value });
			case 'string':
				this.next();
				return this.stringLiteral(t);
			case 'ident': {
				this.next();
				// `secret url"…"` keeps a tagged literal secret. `secret` is a word only here, so
				// it still names variables and functions.
				const tagged = this.peek();
				if (t.value === 'secret' && tagged.kind === 'string' && tagged.str!.tag && !tagged.nl) {
					this.next();
					if (tagged.str!.tag !== 'url' && tagged.str!.tag !== 'html') this.fail(`only \`url"…"\` and \`html"…"\` have a secret form; for text, write \`secret"…"\``, tagged);
					const literal = this.stringLiteral(tagged);
					literal.secret = true;
					literal.line = t.line;
					literal.col = t.col;
					return literal;
				}
				return this.node('Name', t, { name: t.value });
			}
			case 'eof':
				this.fail('expected an expression but the file ended');
		}
		if (t.kind === 'keyword') {
			switch (t.value) {
				case 'true':
				case 'false':
					this.next();
					return this.node('Bool', t, { value: t.value === 'true' });
				case 'null':
					this.next();
					return this.node('Null', t);
				case 'this':
					this.next();
					return this.node('This', t);
				case 'This':
					this.next();
					return this.node('Name', t, { name: 'This' });
				case 'fn':
					return this.closure();
				case 'match':
					return this.match();
				case 'new':
					return this.newExpr();
				case 'fail': {
					this.next();
					return this.node('FailExpr', t, { value: this.ternary() });
				}
				case 'return': {
					this.next();
					const value = this.hasOperand() ? this.ternary() : null;
					return this.node('ReturnExpr', t, { value });
				}
				case 'if':
					this.fail('`if` is a statement; for a value, write `condition ? a : b`');
			}
			this.fail(`expected an expression but found \`${t.value}\``);
		}
		if (this.isOp('.')) {
			// There is no member shorthand: a closure says what it takes.
			const name = this.peek(1);
			const member = name && /^[A-Za-z_]/.test(name.value) ? name.value : 'name';
			this.fail(`a value can't start with \`.\`: write a closure, as \`fn(x) => x.${member}\``);
		}
		if (this.isOp('(')) {
			return this.within({ ignoreNewlines: true }, () => {
				this.next();
				const items = [this.expr()];
				while (this.isOp(',')) {
					this.next();
					if (this.isOp(')')) break;
					items.push(this.expr());
				}
				this.expectOp(')');
				return items.length === 1 ? this.node('Paren', t, { value: items[0] }) : this.node('Tuple', t, { items });
			});
		}
		if (this.isOp('[')) return this.listOrMap();
		this.fail(`expected an expression but found ${this.describe(t)}`);
	}

	stringLiteral(t: Token): Node {
		const parts = t.str!.parts.map((p) => {
			if (p.text !== undefined) return p.text;
			const inner = new Parser(p.tokens!, this.testFile);
			const e = inner.expr();
			if (inner.peek().kind !== 'eof') inner.fail(`expected \`}\` to close the interpolation but found ${inner.describe(inner.peek())}`);
			return e;
		});
		return this.node('Str', t, { tag: t.str!.tag, raw: t.str!.raw, triple: t.str!.triple, parts });
	}

	listOrMap(): Node {
		const t = this.peek();
		return this.within({ ignoreNewlines: true }, () => {
			this.next();
			if (this.isOp(':') && this.isOp(']', this.peek(1))) {
				this.next();
				this.next();
				return this.node('MapLit', t, { entries: [] });
			}
			if (this.isOp(']')) {
				this.next();
				return this.node('ListLit', t, { items: [] });
			}
			const first = this.expr();
			if (this.isOp(':')) {
				const entries: Node[] = [];
				let key = first;
				for (;;) {
					this.expectOp(':');
					entries.push(this.node('Entry', key, { key, value: this.expr() }));
					if (!this.isOp(',')) break;
					this.next();
					if (this.isOp(']')) break;
					key = this.expr();
				}
				this.expectOp(']');
				return this.node('MapLit', t, { entries });
			}
			const items = [first];
			while (this.isOp(',')) {
				this.next();
				if (this.isOp(']')) break;
				items.push(this.expr());
			}
			this.expectOp(']');
			return this.node('ListLit', t, { items });
		});
	}

	closure(): Node {
		const t = this.next();
		const params = this.within({ ignoreNewlines: true }, () => {
			this.expectOp('(');
			const list: Node[] = [];
			while (!this.isOp(')')) {
				const name = this.expectIdent('a parameter name');
				let type: Node | null = null;
				if (this.isOp(':')) {
					this.next();
					type = this.type();
				}
				list.push(this.node('Param', name, { name: name.value, type, nameLine: name.line, nameCol: name.col }));
				if (!this.isOp(',')) break;
				this.next();
			}
			this.expectOp(')');
			return list;
		});
		let ret: Node | null = null;
		let err: Node | null = null;
		if (this.isOp('->')) {
			this.next();
			ret = this.type();
		}
		// `else` straight after the parameters: a function that returns nothing but can fail.
		if (this.isKw('else')) {
			this.next();
			err = this.type();
		}
		const uses: Node[] = [];
		if (this.isKw('use')) {
			this.next();
			this.within({ ignoreNewlines: true }, () => {
				this.expectOp('(');
				while (!this.isOp(')')) {
					if (!this.isKw('mut')) this.fail('`use` only lists `mut` captures; everything else is captured automatically');
					this.next();
					const name = this.expectIdent('a variable to capture');
					uses.push(this.node('Use', name, { name: name.value }));
					if (!this.isOp(',')) break;
					this.next();
				}
				this.expectOp(')');
			});
		}
		let body: Node;
		if (this.isOp('=>')) {
			this.next();
			body = this.within({ condition: false }, () => this.expr());
		} else if (this.isOp('{')) {
			body = this.block();
		} else {
			this.fail('expected `=>` or `{` after the closure\'s parameters');
		}
		return this.node('Closure', t, { params, ret, err, uses, body });
	}

	match(): Node {
		const t = this.next();
		const subject = this.condition(() => this.expr());
		if (this.isKw('catch')) this.fail('a `catch` handler isn\'t allowed as a `match` subject; bind the result with `let` first');
		const arms = this.within({ ignoreNewlines: false, condition: false }, () => {
			this.expectOp('{');
			const list: Node[] = [];
			while (!this.isOp('}')) {
				if (this.peek().kind === 'eof') this.fail('expected `}` to close the `match`');
				const at = this.peek();
				const pattern = this.pattern(true);
				let guard: Node | null = null;
				if (this.isKw('if')) {
					this.next();
					guard = this.condition(() => this.expr());
				}
				this.expectOp('=>');
				let body: Node;
				if (this.isOp('{')) {
					body = this.block();
				} else {
					body = this.expr();
					// In a `match` used as a statement, an arm can set a variable: `A => x = 1`, `B => n++`.
					const op = this.peek();
					if (op.kind === 'op' && ASSIGNMENTS.has(op.value) && this.sameLine(op)) {
						this.assignable(body);
						this.next();
						body = this.node('Assign', at, { target: body, op: op.value, value: this.expr() });
					} else if ((this.isOp('++') || this.isOp('--')) && this.sameLine()) {
						this.assignable(body);
						this.next();
						body = this.node('IncDec', at, { target: body, op: op.value });
					}
				}
				list.push(this.node('Arm', at, { pattern, guard, body }));
				this.endOfItem('}');
			}
			this.next();
			return list;
		});
		return this.node('Match', t, { subject, arms });
	}

	newExpr(): Node {
		const t = this.next();
		const type = this.type();
		if (this.isOp('(') && this.peek().adjacent) return this.node('New', t, { type, args: this.callArgs(), members: null });
		if (!this.isOp('{')) this.fail('expected `(` with the arguments after `new Class`, or `{` with the implementation after `new Interface`');
		const members = this.members('new');
		return this.node('New', t, { type, args: null, members });
	}

	// ---- patterns -----------------------------------------------------------------------

	pattern(allowOr: boolean): Node {
		const first = this.patternAtom();
		if (!allowOr || !this.isKw('or')) return first;
		const alternatives = [first];
		while (this.isKw('or')) {
			this.next();
			alternatives.push(this.patternAtom());
		}
		return this.node('OrPattern', first as any, { alternatives });
	}

	patternAtom(): Node {
		const t = this.peek();
		if (this.isWord('_')) {
			this.next();
			return this.node('WildcardPattern', t);
		}
		if (t.kind === 'int' || t.kind === 'decimal' || t.kind === 'string' || this.isKw('true') || this.isKw('false') || this.isKw('null') || this.isOp('-')) {
			return this.node('LiteralPattern', t, { value: this.unary() });
		}
		if (this.isOp('(')) {
			return this.within({ ignoreNewlines: true }, () => {
				this.next();
				const items: Node[] = [];
				while (!this.isOp(')')) {
					items.push(this.pattern(true));
					if (!this.isOp(',')) break;
					this.next();
				}
				this.expectOp(')');
				return this.node('TuplePattern', t, { items });
			});
		}
		if (t.kind === 'keyword' && !this.isKw('This')) this.fail(`\`${t.value}\` is a reserved word and can't be used as a name`);
		if (!this.isIdent() && !this.isKw('This')) this.fail(`expected a pattern but found ${this.describe(t)}`);
		const path = [this.next().value];
		while (this.isOp('.') && this.isIdent(this.peek(1))) {
			this.next();
			path.push(this.next().value);
		}
		if (path.length === 1 && /^[a-z]/.test(path[0])) {
			return this.node('BindPattern', t, { name: path[0] });
		}
		let args: Node[] | null = null;
		if (this.isOp('(') && this.peek().adjacent) {
			args = this.within({ ignoreNewlines: true }, () => {
				this.next();
				const list: Node[] = [];
				while (!this.isOp(')')) {
					const a = this.peek();
					if (this.isMemberName() && this.isOp(':', this.peek(1))) {
						this.next();
						this.next();
						// `retryAfter:` on its own binds a name of its own, as a call's `port:` passes one.
						const punned = this.isOp(',') || this.isOp(')');
						const pattern = punned ? this.node('BindPattern', a, { name: a.value }) : this.pattern(true);
						list.push(this.node('PatternArg', a, { name: a.value, pattern, punned }));
					} else {
						list.push(this.node('PatternArg', a, { name: null, pattern: this.pattern(true) }));
					}
					if (!this.isOp(',')) break;
					this.next();
				}
				this.expectOp(')');
				return list;
			});
		}
		let binding: string | null = null;
		let bindingTok: Token | null = null;
		if (this.isIdent() && /^[a-z]/.test(this.peek().value) && !this.peek().nl) {
			bindingTok = this.next();
			binding = bindingTok.value;
		}
		return this.node('CtorPattern', t, { path, args, binding, bindingLine: bindingTok?.line, bindingCol: bindingTok?.col });
	}
}
