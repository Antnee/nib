// Turns source text into tokens. String literals are lexed whole, including their
// interpolations: each `${…}` becomes a nested token list, so the parser can parse it as an
// ordinary expression.

export type TokenKind = 'ident' | 'keyword' | 'int' | 'decimal' | 'string' | 'op' | 'eof';

export interface StringPart {
	text?: string;
	tokens?: Token[];
	/** Text from an escape sequence: an escaped newline doesn't start a new line. */
	escaped?: boolean;
	line: number;
	col: number;
}

export interface StringInfo {
	tag: string | null;
	raw: boolean;
	triple: boolean;
	parts: StringPart[];
}

export interface Token {
	kind: TokenKind;
	value: string;
	line: number;
	col: number;
	/** A newline (or a comment containing one) comes between this token and the previous one. */
	nl: boolean;
	/** No whitespace or comment between this token and the previous one. */
	adjacent: boolean;
	str?: StringInfo;
	/** Where the token starts and ends in the source, as offsets. */
	start?: number;
	end?: number;
}

/** A comment, which the parser never sees, kept for the formatter. */
export interface Comment {
	text: string;
	start: number;
	end: number;
	line: number;
}

export interface DocLine {
	line: number;
	col: number;
	text: string;
}

export class SyntaxError extends Error {
	line: number;
	col: number;
	constructor(message: string, line: number, col: number) {
		super(message);
		this.line = line;
		this.col = col;
	}
}

export const KEYWORDS = new Set([
	'alias', 'and', 'as', 'break', 'catch', 'class', 'const', 'continue', 'defer', 'div', 'do', 'else',
	'enum', 'fail', 'false', 'fn', 'for', 'if', 'implements', 'import', 'in', 'interface', 'is',
	'lazy', 'let', 'match', 'mod', 'mut', 'new', 'not', 'null', 'or', 'private', 'pub', 'record',
	'return', 'start', 'static', 'this', 'This', 'true', 'try', 'type', 'use', 'var', 'when',
	'while', 'with', 'yield',
]);

// Longest first, so `..<` wins over `..` and `?.` over `?`.
const OPERATORS = [
	'..<', '..', '?.', '??', '?:', '|>', '=>', '->', '==', '!=', '<=', '>=', '<<', '+=', '-=',
	'*=', '/=', '++', '--', '(', ')', '[', ']', '{', '}', ',', ':', '.', '?', '=', '<', '>', '+',
	'-', '*', '/', '&', '|', '^', '~', '@',
];

const MISTAKES: Record<string, string> = {
	';': 'Nib has no semicolons: end the statement with a newline',
	'&&': 'use `and` for logical and',
	'||': 'use `or` for logical or',
	'!': 'use `not` for negation',
	'%': 'use `mod` for the remainder',
	'#': '`#!` is only allowed on the first line',
	"'": 'strings use double quotes; single quotes are not used',
	'`': 'backticks are not used; strings use double quotes',
	'$': 'Nib has no `$` sigil; interpolation is `${…}` inside a string',
};

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '0': '\0', '\\': '\\', '"': '"', $: '$' };

export function lex(src: string): { tokens: Token[]; docs: DocLine[]; comments: Comment[] } {
	const lexer = new Lexer(src);
	const tokens = lexer.tokens(false);
	return { tokens, docs: lexer.docs, comments: lexer.comments };
}

class Lexer {
	src: string;
	i = 0;
	line = 1;
	col = 1;
	docs: DocLine[] = [];
	comments: Comment[] = [];

	constructor(src: string) {
		this.src = src;
		if (src.startsWith('#!')) {
			while (this.i < src.length && src[this.i] !== '\n') this.advance();
		}
	}

	peek(offset = 0): string {
		return this.src[this.i + offset] ?? '';
	}

	advance(): string {
		const c = this.src[this.i++];
		if (c === '\n') {
			this.line++;
			this.col = 1;
		} else {
			this.col++;
		}
		return c;
	}

	fail(message: string, line = this.line, col = this.col): never {
		throw new SyntaxError(message, line, col);
	}

	/** Lexes tokens to the end of input, or, inside an interpolation, to its closing `}`. */
	tokens(inInterpolation: boolean): Token[] {
		const out: Token[] = [];
		let depth = 0;
		let nl = false;
		for (;;) {
			const trivia = this.skipTrivia();
			nl = nl || trivia.nl;
			if (this.i >= this.src.length) {
				if (inInterpolation) this.fail('unterminated `${` interpolation');
				out.push({ kind: 'eof', value: '', line: this.line, col: this.col, nl: true, adjacent: false });
				return out;
			}
			if (inInterpolation && this.peek() === '}' && depth === 0) {
				const line = this.line, col = this.col;
				this.advance();
				out.push({ kind: 'eof', value: '', line, col, nl, adjacent: !trivia.any });
				return out;
			}
			const start = this.i;
			const token = this.token();
			token.start = start;
			token.end = this.i;
			token.nl = nl;
			token.adjacent = !trivia.any;
			nl = false;
			if (token.kind === 'op' && token.value === '{') depth++;
			if (token.kind === 'op' && token.value === '}') depth--;
			out.push(token);
		}
	}

	skipTrivia(): { nl: boolean; any: boolean } {
		let nl = false;
		let any = false;
		for (;;) {
			const c = this.peek();
			if (c === ' ' || c === '\t' || c === '\r') {
				this.advance();
				any = true;
			} else if (c === '\n') {
				this.advance();
				nl = true;
				any = true;
			} else if (c === '/' && this.peek(1) === '/') {
				const line = this.line, col = this.col, start = this.i;
				const isDoc = this.peek(2) === '/' && this.peek(3) !== '/';
				let text = '';
				while (this.i < this.src.length && this.peek() !== '\n') text += this.advance();
				if (isDoc) this.docs.push({ line, col, text: text.slice(3) });
				this.comments.push({ text: text.replace(/\s+$/, ''), start, end: this.i, line });
				any = true;
			} else if (c === '/' && this.peek(1) === '*') {
				const line = this.line, col = this.col, start = this.i;
				let depth = 0;
				do {
					if (this.i >= this.src.length) this.fail('unterminated `/*` comment', line, col);
					if (this.peek() === '/' && this.peek(1) === '*') {
						this.advance();
						this.advance();
						depth++;
					} else if (this.peek() === '*' && this.peek(1) === '/') {
						this.advance();
						this.advance();
						depth--;
					} else if (this.advance() === '\n') {
						nl = true;
					}
				} while (depth > 0);
				this.comments.push({ text: this.src.slice(start, this.i), start, end: this.i, line });
				any = true;
			} else {
				return { nl, any };
			}
		}
	}

	token(): Token {
		const line = this.line, col = this.col;
		const c = this.peek();
		const make = (kind: TokenKind, value: string): Token => ({ kind, value, line, col, nl: false, adjacent: false });

		if (/[A-Za-z_]/.test(c)) {
			let name = '';
			while (/[A-Za-z0-9_]/.test(this.peek())) name += this.advance();
			if (this.peek() === '"') {
				const raw = name === 'r';
				return this.string(raw ? null : name, raw, line, col);
			}
			return make(KEYWORDS.has(name) ? 'keyword' : 'ident', name);
		}
		if (/[0-9]/.test(c)) return this.number(line, col);
		if (c === '"') return this.string(null, false, line, col);

		for (const mistake of ['&&', '||']) {
			if (this.src.startsWith(mistake, this.i)) this.fail(MISTAKES[mistake]);
		}
		for (const op of OPERATORS) {
			if (this.src.startsWith(op, this.i)) {
				for (let k = 0; k < op.length; k++) this.advance();
				return make('op', op);
			}
		}
		if (c in MISTAKES) this.fail(MISTAKES[c]);
		this.fail(`unexpected character \`${c}\``);
	}

	number(line: number, col: number): Token {
		let text = '';
		let kind: TokenKind = 'int';
		if (this.peek() === '0' && (this.peek(1) === 'x' || this.peek(1) === 'b')) {
			text += this.advance() + this.advance();
			while (/[0-9A-Fa-f_]/.test(this.peek())) text += this.advance();
		} else {
			while (/[0-9_]/.test(this.peek())) text += this.advance();
			// `1..10` is a range, so a fraction needs a digit after the dot.
			if (this.peek() === '.' && /[0-9]/.test(this.peek(1))) {
				kind = 'decimal';
				text += this.advance();
				while (/[0-9_]/.test(this.peek())) text += this.advance();
			}
		}
		if (/[A-Za-z_]/.test(this.peek())) this.fail(`invalid number \`${text}${this.peek()}\``);
		if (text.endsWith('_')) this.fail('a number cannot end with `_`', line, col);
		return { kind, value: text, line, col, nl: false, adjacent: false };
	}

	string(tag: string | null, raw: boolean, line: number, col: number): Token {
		const triple = this.src.startsWith('"""', this.i);
		const parts: StringPart[] = [];
		let buffer = '';
		let bufferLine = this.line, bufferCol = this.col;
		const flush = () => {
			if (buffer !== '') parts.push({ text: buffer, line: bufferLine, col: bufferCol });
			buffer = '';
		};

		if (!triple) {
			this.advance();
			bufferLine = this.line;
			bufferCol = this.col;
			for (;;) {
				const c = this.peek();
				if (c === '' || c === '\n') this.fail('unterminated string; use `"""` for a string over several lines', line, col);
				if (c === '"') {
					this.advance();
					break;
				}
				if (this.interpolationOrEscape(raw, parts, flush)) {
					bufferLine = this.line;
					bufferCol = this.col;
					continue;
				}
				buffer += this.advance();
			}
			flush();
			return { kind: 'string', value: '', line, col, nl: false, adjacent: false, str: { tag, raw, triple: false, parts } };
		}

		this.advance();
		this.advance();
		this.advance();
		const block = this.peek() === '\n' || (this.peek() === '\r' && this.peek(1) === '\n');
		if (block) {
			if (this.peek() === '\r') this.advance();
			this.advance();
		}
		bufferLine = this.line;
		bufferCol = this.col;
		let lineStart = true;
		let indent = '';
		for (;;) {
			const c = this.peek();
			if (c === '') this.fail('unterminated `"""` string', line, col);
			if (this.src.startsWith('"""', this.i)) {
				if (block && !lineStart) this.fail('the closing `"""` of a multi-line string must be on its own line');
				if (block) {
					// The closing line's indentation is stripped from every line, and the newline
					// before it isn't part of the string.
					const lastNewline = buffer.lastIndexOf('\n');
					indent = buffer.slice(lastNewline + 1);
					buffer = lastNewline === -1 ? '' : buffer.slice(0, lastNewline);
				}
				this.advance();
				this.advance();
				this.advance();
				break;
			}
			if (c === '\n') {
				if (!block) this.fail('a one-line `"""` string must close on the same line; start a multi-line one with a newline after `"""`', line, col);
				buffer += this.advance();
				lineStart = true;
				continue;
			}
			if (c !== ' ' && c !== '\t') lineStart = false;
			if (this.interpolationOrEscape(raw, parts, flush)) {
				lineStart = false;
				bufferLine = this.line;
				bufferCol = this.col;
				continue;
			}
			buffer += this.advance();
		}
		flush();
		const result = block ? dedent(parts, indent, line, col) : parts;
		return { kind: 'string', value: '', line, col, nl: false, adjacent: false, str: { tag, raw, triple: true, parts: result } };
	}

	/** Handles `\x` and `${` at the current position. Returns false if neither is there. */
	interpolationOrEscape(raw: boolean, parts: StringPart[], flush: () => void): boolean {
		if (raw) return false;
		const c = this.peek();
		if (c === '\\') {
			const line = this.line, col = this.col;
			this.advance();
			const e = this.peek();
			if (e === 'u' && this.peek(1) === '{') {
				this.advance();
				this.advance();
				let hex = '';
				while (/[0-9A-Fa-f]/.test(this.peek())) hex += this.advance();
				if (this.peek() !== '}' || hex === '') this.fail('invalid `\\u{…}` escape', line, col);
				this.advance();
				flush();
				parts.push({ text: String.fromCodePoint(parseInt(hex, 16)), escaped: true, line, col });
				return true;
			}
			if (!(e in ESCAPES)) this.fail(`unknown escape \`\\${e}\``, line, col);
			this.advance();
			flush();
			parts.push({ text: ESCAPES[e], escaped: true, line, col });
			return true;
		}
		if (c === '$' && this.peek(1) === '{') {
			flush();
			const line = this.line, col = this.col;
			this.advance();
			this.advance();
			const tokens = this.tokens(true);
			if (tokens.length === 1) this.fail('empty `${}` interpolation', line, col);
			parts.push({ tokens, line, col });
			return true;
		}
		return false;
	}
}

/** Strips `indent` from the start of every line of a multi-line string. */
function dedent(parts: StringPart[], indent: string, line: number, col: number): StringPart[] {
	const out: StringPart[] = [];
	let atLineStart = true;
	const lessIndented = (at: number) => {
		throw new SyntaxError('a line in this multi-line string is less indented than its closing `"""`', at, 1);
	};
	for (const part of parts) {
		if (part.tokens || part.escaped) {
			if (atLineStart && indent !== '') lessIndented(part.line);
			atLineStart = false;
			out.push(part);
			continue;
		}
		const text = part.text!;
		let result = '';
		let k = 0;
		let lineNo = part.line;
		while (k < text.length) {
			if (atLineStart) {
				const newline = text.indexOf('\n', k);
				const lineText = text.slice(k, newline === -1 ? text.length : newline);
				if (lineText.startsWith(indent)) {
					k += indent.length;
				} else if (newline !== -1 && lineText.trim() === '') {
					k = newline;
				} else {
					lessIndented(lineNo);
				}
				atLineStart = false;
				continue;
			}
			const ch = text[k++];
			result += ch;
			if (ch === '\n') {
				atLineStart = true;
				lineNo++;
			}
		}
		out.push({ ...part, text: result });
	}
	void line;
	void col;
	return out;
}
