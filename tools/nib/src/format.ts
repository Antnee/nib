// The formatter: prints Nib source in its one canonical form, so code reads the same
// whoever wrote it. It works on tokens rather than the syntax tree, so it never has to
// rebuild code it doesn't understand: anything its rules don't cover is left as written.
//
// The rules:
// - A bracketed list (parameters, arguments, list and map literals, import braces) goes on
//   one line if it fits in 120 columns, otherwise one item per line with a trailing comma.
// - A method chain of two or more calls that doesn't fit breaks before each call after the
//   first. When nothing can be broken to fit, the line stays long.
// - A run of blank lines becomes one, with none directly after `{` or before `}`, and one
//   between top-level declarations that span several lines.
// - Spacing is fixed around commas, colons, brackets and binary operators; other spaces are
//   kept, collapsed to one.
// - Imports are grouped (the stdlib, then dependencies, then this package), sorted, and
//   merged when two lines import names from one module.
// - Comments stay where they're written.
// - A `??` or `?:` that ends a line moves to the start of the next.
// - A `match` arm, or a getter, that doesn't fit breaks after its `=>`, with its value on the
//   next line, indented. Its pattern isn't broken.
//
// Every result is checked before it's returned: it must have the same tokens (apart from
// trailing commas) and comments as the input, and it must parse if the input did. If it
// doesn't, the input comes back unchanged.

import { lex, type Comment, type Token } from './lexer.ts';
import { parse } from './parser.ts';

const WIDTH = 120;
const TAB = 4;

export interface FormatOptions {
	/** The name this package's own modules start with, such as `shop`, for grouping imports. */
	packageRoot?: string | null;
	testFile?: boolean;
	declarationFile?: boolean;
}

/** The source in canonical form, or the source unchanged if it can't be formatted safely. */
export function format(src: string, options: FormatOptions = {}): string {
	return formatWithReason(src, options).text;
}

/** Like `format`, saying why the source was left as it was, if it was. */
export function formatWithReason(src: string, options: FormatOptions = {}): { text: string; skipped: string | null } {
	try {
		const sorted = sortImports(src, options.packageRoot ?? null) ?? src;
		const shebang = src.startsWith('#!') ? src.slice(0, src.indexOf('\n') + 1) : '';
		const out = print(sorted.slice(shebang.length));
		// A blank line after `#!` stays if the author left one.
		const result = shebang ? shebang + (/^\s*\n/.test(sorted.slice(shebang.length)) ? '\n' : '') + out : out;
		const problem = safe(sorted, result, options);
		return problem ? { text: src, skipped: problem } : { text: result, skipped: null };
	} catch (e) {
		return { text: src, skipped: e instanceof Error ? e.message : 'it could not be read' };
	}
}

// ---- items and groups -------------------------------------------------------------------

interface Item {
	kind: 'tok' | 'comment';
	text: string;
	start: number;
	end: number;
	tok?: Token;
	/** A newline comes before it. */
	nl: boolean;
	/** A blank line comes before it. */
	blank: boolean;
	/** Whitespace comes before it. */
	ws: boolean;
	/** The whitespace before it on its line, kept before a trailing comment so comments stay aligned. */
	gap: string;
}

interface Group {
	kind: 'group';
	/** `list` breaks one item per line; `block` holds statements; `paren` is kept as written. */
	shape: 'list' | 'block' | 'paren';
	open: Item;
	close: Item;
	children: Node[];
	nl: boolean;
	blank: boolean;
	ws: boolean;
}

type Node = Item | Group;

const OPENERS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };

function items(src: string): Item[] {
	const { tokens, comments } = lex(src);
	const toks = tokens.filter((t) => t.kind !== 'eof');
	// A comment inside a string's interpolation belongs to the string.
	const inside = (c: Comment) => toks.some((t) => t.start! <= c.start && c.end <= t.end!);
	const all: Item[] = [
		...toks.map((t): Item => ({ kind: 'tok', text: src.slice(t.start, t.end), start: t.start!, end: t.end!, tok: t, nl: false, blank: false, ws: false, gap: '' })),
		...comments.filter((c) => !inside(c)).map((c): Item => ({ kind: 'comment', text: c.text, start: c.start, end: c.end, nl: false, blank: false, ws: false, gap: '' })),
	].sort((a, b) => a.start - b.start);
	let prev = 0;
	for (const item of all) {
		const gap = src.slice(prev, item.start);
		const lines = gap.split('\n').length - 1;
		item.nl = lines > 0;
		item.blank = lines > 1;
		item.ws = gap.length > 0;
		item.gap = gap.replace(/\t/g, ' ') || ' ';
		prev = item.end;
	}
	// A `??` or `?:` that ends a line moves to the start of the next, where it reads as what
	// happens otherwise.
	for (let i = 0; i + 1 < all.length; i++) {
		const [op, next] = [all[i], all[i + 1]];
		if (op.kind !== 'tok' || (op.text !== '??' && op.text !== '?:') || op.nl || next.kind !== 'tok' || !next.nl || next.blank) continue;
		op.nl = true;
		next.nl = false;
		next.ws = true;
		next.gap = ' ';
	}
	return all;
}

function isTok(n: Node | undefined, value?: string): n is Item {
	return n !== undefined && n.kind === 'tok' && (value === undefined || n.text === value);
}

/** Nests the items into bracket groups. Throws on brackets that don't match. */
function tree(list: Item[]): Node[] {
	const root: Node[] = [];
	const stack: { open: Item; children: Node[]; outer: Node[] }[] = [];
	let current = root;
	for (const item of list) {
		if (item.kind === 'tok' && item.tok!.kind === 'op' && OPENERS[item.text]) {
			stack.push({ open: item, children: [], outer: current });
			current = stack[stack.length - 1].children;
		} else if (item.kind === 'tok' && item.tok!.kind === 'op' && [')', ']', '}'].includes(item.text)) {
			const top = stack.pop();
			if (!top || OPENERS[top.open.text] !== item.text) throw new Error('unbalanced');
			const group: Group = { kind: 'group', shape: 'paren', open: top.open, close: item, children: top.children, nl: top.open.nl, blank: top.open.blank, ws: top.open.ws };
			current = top.outer;
			group.shape = shapeOf(group, current);
			current.push(group);
		} else {
			current.push(item);
		}
	}
	if (stack.length > 0) throw new Error('unbalanced');
	return root;
}

function lastTok(n: Node | undefined): Item | undefined {
	if (!n) return undefined;
	return n.kind === 'group' ? n.close : n.kind === 'tok' ? n : undefined;
}

function firstTok(n: Node): Item {
	return n.kind === 'group' ? n.open : n;
}

function shapeOf(g: Group, before: Node[]): Group['shape'] {
	const prevNode = [...before].reverse().find((n) => n.kind !== 'comment');
	const prev = lastTok(prevNode);
	if (g.open.text === '[') return 'list';
	if (g.open.text === '{') return isTok(prev, '.') || isTok(prev, 'with') ? 'list' : 'block';
	// A call, a declaration's parameters, a closure's or a function type's: the bracket
	// touches what it follows. Brackets around an expression or a tuple are kept as written.
	if (!prev || g.open.ws) return 'paren';
	const t = prev.tok!;
	if (t.kind === 'ident' || ['fn', 'this', 'This'].includes(t.value)) return 'list';
	if (t.kind === 'op' && ['>', ')', ']', '?'].includes(t.value)) return 'list';
	return 'paren';
}

// ---- docs -------------------------------------------------------------------------------

type Doc =
	| string
	| Doc[]
	| { t: 'soft' }
	| { t: 'line' }
	| { t: 'hard' }
	| { t: 'bhard' }
	| { t: 'indent'; d: Doc }
	| { t: 'stop'; d: Doc }
	| { t: 'group'; d: Doc; broken?: boolean; forced?: boolean }
	| { t: 'ifBreak'; b: Doc; f: Doc }
	| { t: 'choice'; flat: Doc; hug: Doc | null; broken: Doc };

/** A newline the layout chooses: empty when the group fits on one line. */
const SOFT: Doc = { t: 'soft' };
/** A newline that's part of the code (a continued line, a comment): its group can't be flat. */
const HARD: Doc = { t: 'hard' };
/** A newline between a block's statements, which doesn't stop the block's caller fitting. */
const BHARD: Doc = { t: 'bhard' };

/** A binary operator, written with a space on each side. */
const SPACED = new Set(['=', '+=', '-=', '*=', '/=', '=>', '->', '==', '!=', '<=', '>=', '??', '?:', '|>']);
/** A token that, ending a line, says the statement goes on to the next. */
const CONTINUES_AFTER = new Set(['=', '+=', '-=', '*=', '/=', '=>', '->', '==', '!=', '<=', '>=', '??', '?:', '|>', '+', '-', '*', '/', '..', '..<']);
const CONTINUES_AFTER_WORD = new Set(['and', 'or', 'not', 'is', 'in', 'div', 'mod']);

function space(prev: Node, next: Node): string {
	if (next.kind === 'comment') return next.gap;
	const p = lastTok(prev);
	const n = firstTok(next);
	if (!p) return ' ';
	const pv = p.text, nv = n.text;
	if (nv === ',') return '';
	if (pv === ',') return ' ';
	if (pv === '(' || pv === '[') return '';
	if (nv === ')' || nv === ']') return '';
	if (nv === '.' || nv === '?.' || pv === '.' || pv === '?.') return '';
	if (pv === '@') return '';
	if (nv === ':') return n.ws ? ' ' : '';
	if (pv === ':') return ' ';
	if (SPACED.has(pv) || SPACED.has(nv)) return ' ';
	if (next.kind === 'group' && next.shape === 'list' && nv === '(') return '';
	if (next.kind === 'group' && next.shape === 'block') return ' ';
	return n.ws ? ' ' : '';
}

/** How a line that starts with `next` relates to the one before: a new statement, or more of it. */
function continuation(prev: Node, next: Node): 'chain' | 'more' | null {
	const n = firstTok(next);
	if (n.kind === 'tok' && (n.text === '.' || n.text === '?.')) return 'chain';
	if (n.kind === 'tok' && (n.text === 'else' || n.text === 'catch' || n.text === '??' || n.text === '?:')) return 'more';
	const p = lastTok(prev);
	if (p && p.tok && ((p.tok.kind === 'op' && CONTINUES_AFTER.has(p.text)) || (p.tok.kind === 'keyword' && CONTINUES_AFTER_WORD.has(p.text)))) return 'more';
	return null;
}

/** Splits a block's nodes into statements, one per line, each with its continued lines. */
function statements(nodes: Node[]): Node[][] {
	const out: Node[][] = [];
	for (let i = 0; i < nodes.length; i++) {
		const n = nodes[i];
		const prev = nodes[i - 1];
		const starts = i === 0 || (n.nl && (prev.kind === 'comment' || n.kind === 'comment' || continuation(prev, n) === null));
		if (starts) out.push([n]);
		else out[out.length - 1].push(n);
	}
	return out;
}

/** A call in a chain: `.name(…)`, with type arguments if it has them. Returns the index of its bracket. */
function callAt(nodes: Node[], i: number): number | null {
	if (!isTok(nodes[i], '.') && !isTok(nodes[i], '?.')) return null;
	const name = nodes[i + 1];
	if (!name || name.kind !== 'tok' || name.tok!.kind === 'op') return null;
	let j = i + 2;
	if (isTok(nodes[j], '<')) {
		let depth = 0;
		for (; j < nodes.length; j++) {
			if (isTok(nodes[j], '<')) depth++;
			if (isTok(nodes[j], '>')) depth--;
			if (depth === 0) break;
		}
		j++;
	}
	const g = nodes[j];
	return g && g.kind === 'group' && g.shape === 'list' && g.open.text === '(' ? j : null;
}

/**
 * One statement, or one item of a list: its nodes in a row, with its own continued lines.
 * `breakLast` breaks the list it ends with, for a list hugging its last item.
 */
function sequence(nodes: Node[], breakLast = false, chains = true): Doc {
	// `pattern => value`, not a closure's `fn(x) => …`: the value goes on the next line if the
	// arm doesn't fit, and the pattern stays whole. A block or multi-line value keeps its place.
	const arrow = nodes.findIndex((n) => isTok(n, '=>'));
	const closure = arrow > 0 && nodes.slice(0, arrow).some((n) => isTok(n, 'fn'));
	if (arrow > 0 && !closure && arrow < nodes.length - 1 && !nodes.slice(arrow + 1).some(multiLine) &&
		!nodes.slice(1, arrow).some((n) => n.nl) && !nodes.slice(0, arrow).some((n) => n.kind === 'comment') && !nodes.slice(arrow + 1).some((n) => n.kind === 'comment')) {
		const value = nodes.slice(arrow + 1).map((n, k) => (k === 0 ? { ...n, nl: false } : n));
		return [sequence(nodes.slice(0, arrow), false, false), ' =>', { t: 'group', d: { t: 'indent', d: [{ t: 'line' }, sequence(value, breakLast)] } }];
	}
	const calls: [number, number][] = [];
	for (let i = 0; chains && i < nodes.length; i++) {
		const end = callAt(nodes, i);
		if (end !== null) calls.push([i, end]);
	}
	// A chain of calls breaks before each call after the first, if it doesn't fit. A line
	// the author continued some other way is kept as written.
	const chained = calls.length >= 2 && !nodes.some((n, i) => i > calls[0][0] && i <= calls[calls.length - 1][1] && n.nl && !(isTok(n, '.') || isTok(n, '?.')));
	const breaks = new Set(chained ? calls.slice(1).map(([i]) => i) : []);
	const chainEnd = chained ? calls[calls.length - 1][1] : -1;

	const out: Doc[] = [];
	let tail = out;
	let more: Doc[] | null = null;
	let chain: Doc[] | null = null;
	for (let i = 0; i < nodes.length; i++) {
		const n = nodes[i];
		if (breaks.has(i)) {
			if (!chain) {
				chain = [];
				tail.push({ t: 'group', d: { t: 'indent', d: chain } });
			}
			chain.push(SOFT);
		} else if (chained && i >= calls[0][0] && i <= chainEnd && (isTok(n, '.') || isTok(n, '?.'))) {
			// The chain's own line breaks are the layout's to choose.
			(chain ?? tail).push('');
		} else if (i > 0 && n.nl && !(chain && i <= chainEnd)) {
			if (!more) {
				more = [];
				tail.push({ t: 'indent', d: more });
				tail = more;
			}
			more.push(HARD);
		} else if (i > 0 && nodes[i - 1].kind === 'comment') {
			tail.push(HARD);
		} else if (i > 0) {
			(chain && i <= chainEnd ? chain : tail).push(space(nodes[i - 1], n));
		}
		(chain && i <= chainEnd ? chain : tail).push(breakLast && i === nodes.length - 1 ? node(n, true) : node(n));
		if (i === chainEnd) chain = null;
	}
	return out;
}

function node(n: Node, forceBreak = false): Doc {
	if (n.kind !== 'group') return n.text;
	if (n.shape === 'block') return block(n);
	if (n.shape === 'list') return list(n, forceBreak);
	return asWritten(n);
}

/** Whether the node prints on more than one line whatever the layout: a block, or a multi-line string. */
function multiLine(n: Node): boolean {
	if (n.kind === 'comment') return true;
	if (n.kind === 'tok') return n.text.includes('\n');
	if (n.shape === 'block' && (n.close.nl || n.children.some((c) => c.nl))) return true;
	return n.children.some(multiLine);
}

/** Statements, one per line, keeping one blank line where the author left any. */
function body(nodes: Node[], top: boolean): Doc[] {
	const out: Doc[] = [];
	const stmts = statements(nodes);
	stmts.forEach((s, i) => {
		if (i > 0) {
			out.push(BHARD);
			if (s[0].blank || (top && needsBlank(stmts, i))) out.push(BHARD);
		}
		out.push(sequence(s));
	});
	return out;
}

const DECLARES = new Set(['import', 'fn', 'record', 'class', 'interface', 'enum', 'type', 'alias', 'const', 'pub', 'private', 'attribute', 'test', '@']);

/** Whether a top-level declaration needs a blank line before it: one of the two spans lines. */
function needsBlank(stmts: Node[][], i: number): boolean {
	const attaches = (s: Node[]) => s[0].kind === 'comment' || (isTok(s[0], '@') && !spans(s));
	const declares = (s: Node[]) => s[0].kind === 'tok' && DECLARES.has(s[0].text);
	if (attaches(stmts[i - 1]) || !declares(stmts[i - 1])) return false;
	let end = i;
	while (end < stmts.length - 1 && attaches(stmts[end])) end++;
	if (!declares(stmts[end])) return false;
	return spans(stmts[i - 1]) || stmts.slice(i, end + 1).some(spans);
}

function spans(s: Node[]): boolean {
	const text = (n: Node): string => (n.kind === 'group' ? `${n.open.text}${n.children.map(text).join('')}${n.close.text}` : n.text);
	return s.some((n, i) => (i > 0 && n.nl) || (n.kind === 'group' && (n.children.some((c) => c.nl) || n.close.nl)) || text(n).includes('\n'));
}

function block(g: Group): Doc {
	if (g.children.length === 0) return '{}';
	const multiLine = g.close.nl || g.children.some((c) => c.nl);
	if (!multiLine) return ['{ ', sequence(g.children), ' }'];
	return ['{', { t: 'stop', d: { t: 'indent', d: [BHARD, body(g.children, false)] } }, BHARD, '}'];
}

function list(g: Group, forceBreak = false): Doc {
	if (g.children.length === 0) return `${g.open.text}${g.close.text}`;
	if (g.children.some((c) => c.kind === 'comment')) return asWritten(g);
	// A comma inside type arguments, `Map<String, String>`, doesn't end an item. A `<` that
	// opens type arguments touches the name before it; a comparison has spaces.
	const parts: Node[][] = [[]];
	let angles = 0;
	for (const c of g.children) {
		if (isTok(c, '<') && !c.ws) angles++;
		else if (isTok(c, '>') && angles > 0) angles--;
		if (isTok(c, ',') && angles === 0) parts.push([]);
		else parts[parts.length - 1].push(c);
	}
	if (angles !== 0) return asWritten(g);
	if (parts[parts.length - 1].length === 0) parts.pop();
	if (parts.some((p) => p.length === 0)) return asWritten(g);
	const items = parts.map((p) => p.map((n, k) => (k === 0 ? { ...n, nl: false } : n)));
	const inner: Doc[] = [SOFT];
	items.forEach((p, i) => {
		if (i > 0) {
			inner.push(',', { t: 'line' });
			// A blank line the author left between items stays, and keeps the list broken.
			if (parts[i][0].blank) inner.push({ t: 'ifBreak', b: SOFT, f: '' });
		}
		inner.push(sequence(p));
	});
	inner.push({ t: 'ifBreak', b: ',', f: '' });
	const broken: Doc = { t: 'group', d: [g.open.text, { t: 'indent', d: inner }, SOFT, g.close.text], broken: true, forced: forceBreak };
	// Something that spans lines can only come last on a line of its own: a block or a
	// multi-line string in an earlier item breaks the list.
	const grouped = parts.slice(1).some((p) => p[0].blank);
	if (forceBreak || grouped || items.slice(0, -1).some((p) => p.some(multiLine))) return broken;
	const flat: Doc = { t: 'group', d: [g.open.text, { t: 'indent', d: inner }, SOFT, g.close.text] };
	// A call's last argument can hug its brackets when it's a literal: a list, or a value
	// being built, as in `send(Message(` with the message's fields one per line.
	const last = items[items.length - 1];
	const end = last[last.length - 1];
	const builder = last[last.length - 2];
	const literal = end.kind === 'group' && end.shape === 'list' &&
		(end.open.text === '[' || (end.open.text === '(' && builder?.kind === 'tok' && /^[A-Z]/.test(builder.text)));
	const hug: Doc | null = g.open.text === '(' && literal
		? [g.open.text, ...items.flatMap((p, i) => [i > 0 ? ', ' : '', i === items.length - 1 ? sequence(p, true) : sequence(p)]), g.close.text]
		: null;
	return { t: 'choice', flat, hug, broken };
}

/** Brackets the rules don't cover, or holding comments: their line breaks are kept. */
function asWritten(g: Group): Doc {
	const inner: Doc[] = [];
	g.children.forEach((c, i) => {
		if (c.nl) {
			if (c.blank && i > 0) inner.push(HARD);
			inner.push(HARD);
		} else if (i > 0) {
			inner.push(g.children[i - 1].kind === 'comment' ? HARD : space(g.children[i - 1], c));
		}
		inner.push(node(c));
	});
	const last = g.children[g.children.length - 1];
	const closeBreak = g.close.nl || last?.kind === 'comment';
	// A group, so its kept line breaks indent even inside a call that hugs it.
	return { t: 'group', d: [g.open.text, { t: 'indent', d: inner }, closeBreak ? HARD : '', g.close.text] };
}

// ---- printing ---------------------------------------------------------------------------

type Mode = 'flat' | 'break';
type Cmd = [indent: number, mode: Mode, doc: Doc];

/** Marks each group that holds a newline it can't remove as broken. */
function propagate(d: Doc): boolean {
	if (typeof d === 'string') return false;
	if (Array.isArray(d)) return d.map(propagate).some(Boolean);
	switch (d.t) {
		case 'hard':
			return true;
		case 'stop':
			propagate(d.d);
			return false;
		case 'indent':
			return propagate(d.d);
		case 'group': {
			const broken = propagate(d.d);
			if (broken) d.broken = true;
			// A group that's broken anyway prints its own newlines: they don't reach its parent.
			return broken && !d.forced;
		}
		case 'ifBreak':
			return propagate(d.b);
		case 'choice': {
			const flat = propagate(d.flat);
			const hug = d.hug ? propagate(d.hug) : true;
			propagate(d.broken);
			return flat && hug;
		}
		default:
			return false;
	}
}

/** Whether a doc has a group already marked broken, so it can't print on one line. */
function hasBreak(d: Doc): boolean {
	if (typeof d === 'string') return false;
	if (Array.isArray(d)) return d.some(hasBreak);
	if (d.t === 'group') return d.broken === true;
	if (d.t === 'indent' || d.t === 'stop') return hasBreak(d.d);
	return false;
}

function width(text: string): number {
	return text.replace(/\t/g, ' '.repeat(TAB)).length;
}

/** Whether `next`, and the rest of its line, fits in `room` columns. */
function fits(next: Cmd[], rest: Cmd[], room: number): boolean {
	const stack = [...next];
	let r = rest.length;
	while (room >= 0) {
		if (stack.length === 0) {
			if (r === 0) return true;
			stack.push(rest[--r]);
			continue;
		}
		const [indent, mode, d] = stack.pop()!;
		if (typeof d === 'string') {
			const nl = d.indexOf('\n');
			room -= width(nl === -1 ? d : d.slice(0, nl));
			if (nl !== -1) return room >= 0;
			continue;
		}
		if (Array.isArray(d)) {
			for (let i = d.length - 1; i >= 0; i--) stack.push([indent, mode, d[i]]);
			continue;
		}
		switch (d.t) {
			case 'indent':
			case 'stop':
				stack.push([indent, mode, d.d]);
				break;
			case 'group':
				stack.push([indent, d.broken ? 'break' : mode, d.d]);
				break;
			case 'ifBreak':
				stack.push([indent, mode, mode === 'break' ? d.b : d.f]);
				break;
			case 'choice':
				stack.push([indent, mode, mode === 'flat' ? d.flat : d.broken]);
				break;
			case 'soft':
				if (mode === 'break') return true;
				break;
			case 'line':
				if (mode === 'break') return true;
				room -= 1;
				break;
			default:
				return true;
		}
	}
	return false;
}

function render(doc: Doc): string {
	propagate(doc);
	let out = '';
	let pos = 0;
	const newline = (indent: number) => {
		out = out.replace(/[ \t]+$/, '') + '\n' + '\t'.repeat(indent);
		pos = indent * TAB;
	};
	const stack: Cmd[] = [[0, 'break', doc]];
	while (stack.length > 0) {
		const [indent, mode, d] = stack.pop()!;
		if (typeof d === 'string') {
			out += d;
			const nl = d.lastIndexOf('\n');
			pos = nl === -1 ? pos + width(d) : width(d.slice(nl + 1));
			continue;
		}
		if (Array.isArray(d)) {
			for (let i = d.length - 1; i >= 0; i--) stack.push([indent, mode, d[i]]);
			continue;
		}
		switch (d.t) {
			case 'indent':
				// On one line, an indent adds nothing: a block inside it lines up with its statement.
				stack.push([mode === 'flat' ? indent : indent + 1, mode, d.d]);
				break;
			case 'stop':
				stack.push([indent, 'break', d.d]);
				break;
			case 'group': {
				const flat = !d.broken && (mode === 'flat' || fits([[indent, 'flat', d.d]], stack, WIDTH - pos));
				stack.push([indent, flat ? 'flat' : 'break', d.d]);
				break;
			}
			case 'ifBreak':
				stack.push([indent, mode, mode === 'break' ? d.b : d.f]);
				break;
			case 'choice': {
				// All on one line if it fits; else hugging its last item, if the first line fits; else broken.
				const room = WIDTH - pos;
				const flatFits = mode === 'flat' || (!hasBreak(d.flat) && fits([[indent, 'flat', d.flat]], stack, room));
				if (flatFits) stack.push([indent, 'flat', d.flat]);
				else if (d.hug && fits([[indent, 'flat', d.hug]], stack, room)) stack.push([indent, 'flat', d.hug]);
				else stack.push([indent, 'break', d.broken]);
				break;
			}
			case 'soft':
				if (mode === 'break') newline(indent);
				break;
			case 'line':
				if (mode === 'break') newline(indent);
				else out += ' ', pos++;
				break;
			default:
				newline(indent);
		}
	}
	return out;
}

function print(src: string): string {
	const doc = body(tree(items(src)), true);
	return render(doc).replace(/[ \t]+$/gm, '').replace(/^\n+/, '').replace(/\n*$/, '\n');
}

// ---- imports ----------------------------------------------------------------------------

interface Import {
	path: string[];
	names: string[] | null;
	alias: string | null;
	/** `import shop.ui with {…}`: the module as well as the names. */
	module: boolean;
}

/** The source with its imports grouped, sorted and merged, or null to leave them alone. */
function sortImports(src: string, root: string | null): string | null {
	const top = statements(tree(items(src)));
	const first = top.findIndex((s) => isTok(s[0], 'import'));
	if (first === -1) return null;
	let last = first;
	while (last + 1 < top.length && isTok(top[last + 1][0], 'import')) last++;
	const found: Import[] = [];
	for (const s of top.slice(first, last + 1)) {
		const imp = readImport(s);
		if (!imp) return null;
		found.push(imp);
	}
	// One line per module: its names merge, and the module with them is `with {…}`.
	const merged: Import[] = [];
	for (const imp of found) {
		const same = !imp.alias && merged.find((m) => !m.alias && m.path.join('.') === imp.path.join('.'));
		if (same) {
			const wantsModule = (i: Import) => i.module || !i.names;
			same.module = wantsModule(same) || wantsModule(imp);
			same.names = same.names || imp.names ? [...new Set([...(same.names ?? []), ...(imp.names ?? [])])] : null;
			if (!same.names) same.module = false;
		} else merged.push({ ...imp, names: imp.names ? [...new Set(imp.names)] : null });
	}
	const kind = (i: Import) => (i.path[0] === 'std' ? 0 : i.path[0] === root ? 2 : 1);
	const byText = (a: string, b: string) => a.toLowerCase().localeCompare(b.toLowerCase(), 'en') || (a < b ? -1 : a > b ? 1 : 0);
	merged.sort((a, b) => kind(a) - kind(b) || byText(a.path.join('.'), b.path.join('.')) || (a.names ? 1 : 0) - (b.names ? 1 : 0));
	const list = (i: Import) => `{${[...i.names!].sort(byText).join(', ')}}`;
	const lines = merged.map((i) => `import ${i.path.join('.')}${i.names ? (i.module ? ` with ${list(i)}` : `.${list(i)}`) : ''}${i.alias ? ` as ${i.alias}` : ''}`);
	const start = firstTok(top[first][0]).start;
	const lastStmt = top[last];
	const end = lastTok(lastStmt[lastStmt.length - 1])!.end;
	return src.slice(0, start) + lines.join('\n') + src.slice(end);
}

function readImport(s: Node[]): Import | null {
	const path: string[] = [];
	let i = 1;
	while (i < s.length && s[i].kind === 'tok' && (s[i] as Item).tok!.kind !== 'op') {
		path.push((s[i] as Item).text);
		if (isTok(s[i + 1], '.') && s[i + 2]?.kind === 'tok') i += 2;
		else break;
	}
	i++;
	let names: string[] | null = null;
	let alias: string | null = null;
	const module = isTok(s[i], 'with') && s[i + 1]?.kind === 'group';
	if ((isTok(s[i], '.') || module) && s[i + 1]?.kind === 'group') {
		const g = s[i + 1] as Group;
		if (g.children.some((c) => c.kind !== 'tok')) return null;
		names = [];
		let name = '';
		for (const c of g.children as Item[]) {
			if (c.text === ',') {
				if (name) names.push(name);
				name = '';
			} else name += c.text;
		}
		if (name) names.push(name);
		i += 2;
	}
	if (isTok(s[i], 'as') && s[i + 1]?.kind === 'tok') {
		alias = (s[i + 1] as Item).text;
		i += 2;
	}
	return path.length > 0 && i === s.length ? { path, names, alias, module } : null;
}

// ---- checking the result ----------------------------------------------------------------

/** Why the result can't be used, or null: it must keep the tokens (apart from trailing commas) and comments, and parse if the input did. */
function safe(before: string, after: string, options: FormatOptions): string | null {
	const shape = (src: string) => {
		const { tokens, comments } = lex(src.startsWith('#!') ? src.slice(src.indexOf('\n')) : src);
		const values = tokens.filter((t, i) => !(t.value === ',' && t.kind === 'op' && [')', ']', '}'].includes(tokens[i + 1]?.value))).map((t) => `${t.kind}:${t.value}`);
		return JSON.stringify([values, comments.map((c) => c.text)]);
	};
	if (shape(before) !== shape(after)) return 'formatting would have changed its tokens or comments';
	const flags = { testFile: options.testFile ?? false, declarationFile: options.declarationFile ?? false };
	if (parse(before, flags).errors.length === 0 && parse(after, flags).errors.length > 0) return 'the formatted code would not parse';
	return null;
}

// ---- Markdown ---------------------------------------------------------------------------

/**
 * Formats the code in a Markdown file's `nib` blocks, and in `nib standalone` ones. An
 * `nib error` block shows code that's wrong on purpose, so it's left as written.
 */
export function formatMarkdown(md: string, options: FormatOptions = {}): string {
	const lines = md.split('\n');
	for (let i = 0; i < lines.length; i++) {
		const fence = lines[i].match(/^(\s*)```\s*nib(?:\s+(error|standalone))?\s*$/);
		if (!fence) {
			if (/^\s*```/.test(lines[i])) while (++i < lines.length && !/^\s*```\s*$/.test(lines[i]));
			continue;
		}
		const indent = fence[1];
		let end = i + 1;
		while (end < lines.length && !/^\s*```\s*$/.test(lines[end])) end++;
		if (fence[2] !== 'error' && end < lines.length) {
			const code = lines.slice(i + 1, end).map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l.trimStart())).join('\n');
			const formatted = format(code, options).replace(/\n$/, '');
			const out = formatted.split('\n').map((l) => (l === '' ? '' : indent + l));
			lines.splice(i + 1, end - i - 1, ...out);
			end = i + 1 + out.length;
		}
		i = end;
	}
	return lines.join('\n');
}
