// The language server itself, over stdio. Editors start `lsp.ts`, which runs this file as a
// child process and starts a fresh one whenever the checker changes.
//
// It reports the checker's diagnostics as you type, shows a name's type or signature on
// hover, goes to a name's definition, folds comment runs, blocks and multi-line strings, and
// lists a file's declarations for the outline. It has no dependencies, like the checker it
// wraps.

import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkPackageOf, type Diagnostic, type NameInfo } from './check.ts';
import { parse, type Node } from './parser.ts';

interface Message {
	jsonrpc: '2.0';
	id?: number | string | null;
	method?: string;
	params?: any;
	result?: any;
	error?: { code: number; message: string };
}

/** Open documents, by path: their unsaved text is checked in place of the file on disk. */
const open = new Map<string, string>();
/** Files that were last sent diagnostics, so a fixed file gets its list cleared. */
const published = new Set<string>();
/**
 * Files sent a list at least once since this server started. The first list always goes out,
 * even when empty, so an editor drops whatever a previous server left behind.
 */
const sent = new Set<string>();
const timers = new Map<string, NodeJS.Timeout>();
/** The names in each file, with their types and definitions, from the last check. */
const names = new Map<string, NameInfo[]>();

// ---- transport ----------------------------------------------------------------------------

let buffer = Buffer.alloc(0);
process.stdin.on('data', (chunk: Buffer) => {
	buffer = Buffer.concat([buffer, chunk]);
	for (;;) {
		const headerEnd = buffer.indexOf('\r\n\r\n');
		if (headerEnd < 0) return;
		const header = buffer.subarray(0, headerEnd).toString('ascii');
		const length = Number(header.match(/Content-Length: *(\d+)/i)?.[1] ?? NaN);
		if (Number.isNaN(length)) {
			buffer = buffer.subarray(headerEnd + 4);
			continue;
		}
		if (buffer.length < headerEnd + 4 + length) return;
		const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8');
		buffer = buffer.subarray(headerEnd + 4 + length);
		handle(JSON.parse(body));
	}
});

function send(message: Omit<Message, 'jsonrpc'>) {
	const body = JSON.stringify({ jsonrpc: '2.0', ...message });
	process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
}

function log(text: string) {
	send({ method: 'window/logMessage', params: { type: 4, message: text } });
}

// ---- requests and notifications -----------------------------------------------------------

function handle(msg: Message) {
	try {
		const result = dispatch(msg);
		if (msg.id !== undefined && msg.method) send({ id: msg.id, result: result ?? null });
	} catch (e) {
		const message = e instanceof Error ? e.stack ?? e.message : String(e);
		log(`nib-lsp: ${message}`);
		if (msg.id !== undefined && msg.method) send({ id: msg.id, error: { code: -32603, message } });
	}
}

function dispatch(msg: Message): unknown {
	const p = msg.params;
	switch (msg.method) {
		case 'initialize':
			return {
				capabilities: {
					textDocumentSync: { openClose: true, change: 1, save: { includeText: false } },
					foldingRangeProvider: true,
					documentSymbolProvider: true,
					hoverProvider: true,
					definitionProvider: true,
				},
				serverInfo: { name: 'nib-lsp', version: '0.1.0' },
			};
		case 'shutdown':
			return null;
		case 'exit':
			process.exit(0);
		case 'textDocument/didOpen':
			open.set(pathOf(p.textDocument.uri), p.textDocument.text);
			schedule(pathOf(p.textDocument.uri), 0);
			return;
		case 'textDocument/didChange':
			open.set(pathOf(p.textDocument.uri), p.contentChanges[p.contentChanges.length - 1].text);
			schedule(pathOf(p.textDocument.uri), 250);
			return;
		case 'textDocument/didSave':
			schedule(pathOf(p.textDocument.uri), 0);
			return;
		case 'textDocument/didClose':
			open.delete(pathOf(p.textDocument.uri));
			schedule(pathOf(p.textDocument.uri), 0);
			return;
		case 'textDocument/foldingRange':
			return foldingRanges(textOf(pathOf(p.textDocument.uri)));
		case 'textDocument/documentSymbol':
			return documentSymbols(textOf(pathOf(p.textDocument.uri)), pathOf(p.textDocument.uri));
		case 'textDocument/hover': {
			const name = nameAt(pathOf(p.textDocument.uri), p.position);
			if (!name?.detail) return null;
			return { contents: { kind: 'markdown', value: `\`\`\`nib\n${name.detail}\n\`\`\`` }, range: rangeOf(name) };
		}
		case 'textDocument/definition': {
			const def = nameAt(pathOf(p.textDocument.uri), p.position)?.def;
			if (!def) return null;
			const at = { line: def.line - 1, character: def.col - 1 };
			return { uri: pathToFileURL(def.path).href, range: { start: at, end: at } };
		}
		default:
			// Unknown requests get an empty answer; unknown notifications are ignored.
			return null;
	}
}

function pathOf(uri: string): string {
	return fileURLToPath(uri);
}

function textOf(path: string): string {
	return open.get(path) ?? '';
}

// ---- diagnostics --------------------------------------------------------------------------

/** Re-checks a file's package after a pause, so typing doesn't re-check on every key. */
function schedule(path: string, delay: number) {
	clearTimeout(timers.get(path));
	timers.set(path, setTimeout(() => publish(path), delay));
}

function publish(path: string) {
	const { diagnostics, files } = checkPackageOf(path, open, names);
	const byFile = new Map<string, Diagnostic[]>();
	for (const f of files) byFile.set(f, []);
	for (const d of diagnostics) {
		if (!byFile.has(d.path)) byFile.set(d.path, []);
		byFile.get(d.path)!.push(d);
	}
	for (const [file, list] of byFile) {
		if (list.length === 0 && !published.has(file) && sent.has(file)) continue;
		sent.add(file);
		const text = open.get(file);
		send({
			method: 'textDocument/publishDiagnostics',
			params: { uri: pathToFileURL(file).href, diagnostics: list.map((d) => toLsp(d, text)) },
		});
		if (list.length > 0) published.add(file);
		else published.delete(file);
	}
}

/** The name under the cursor; the editor counts lines and characters from 0. */
function nameAt(path: string, position: { line: number; character: number }): NameInfo | null {
	if (!names.has(path) && existsSync(path)) checkPackageOf(path, open, names);
	const line = position.line + 1;
	const col = position.character + 1;
	return names.get(path)?.find((n) => n.line === line && n.col <= col && col <= n.col + n.length) ?? null;
}

function rangeOf(name: NameInfo) {
	return { start: { line: name.line - 1, character: name.col - 1 }, end: { line: name.line - 1, character: name.col - 1 + name.length } };
}

/** The checker gives a 1-based point; the editor wants a range, so it covers the word there. */
function toLsp(d: Diagnostic, text: string | undefined) {
	const line = Math.max(0, d.line - 1);
	const start = Math.max(0, d.col - 1);
	const lineText = text?.split('\n')[line] ?? '';
	let end = start;
	while (end < lineText.length && /[A-Za-z0-9_]/.test(lineText[end])) end++;
	if (end === start) end = start + 1;
	return {
		range: { start: { line, character: start }, end: { line, character: end } },
		severity: d.severity === 'error' ? 1 : 2,
		source: 'nib',
		message: d.message,
	};
}

// ---- folding ------------------------------------------------------------------------------

interface Fold {
	startLine: number;
	endLine: number;
	kind?: 'comment' | 'region';
}

/**
 * Folds runs of comment lines, multi-line blocks and brackets, and multi-line strings. It
 * scans the text itself rather than parsing, so it still works while the file has errors.
 */
function foldingRanges(text: string): Fold[] {
	const folds: Fold[] = [];
	const lines = text.split('\n');

	let runStart = -1;
	let runDoc = false;
	const endRun = (end: number) => {
		if (runStart >= 0 && end > runStart) folds.push({ startLine: runStart, endLine: end, kind: 'comment' });
		runStart = -1;
	};
	lines.forEach((line, i) => {
		const t = line.trimStart();
		const isComment = t.startsWith('//');
		const isDoc = t.startsWith('///');
		if (isComment && runStart >= 0 && isDoc === runDoc) return;
		endRun(i - 1);
		if (isComment) {
			runStart = i;
			runDoc = isDoc;
		}
	});
	endRun(lines.length - 1);

	const stack: { ch: string; line: number }[] = [];
	const pairs: Record<string, string> = { '}': '{', ')': '(', ']': '[' };
	let line = 0;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === '\n') {
			line++;
		} else if (c === '/' && text[i + 1] === '/') {
			while (i < text.length && text[i] !== '\n') i++;
			i--;
		} else if (c === '"') {
			const startLine = line;
			const raw = text[i - 1] === 'r';
			const triple = text.startsWith('"""', i);
			const close = triple ? '"""' : '"';
			i += close.length;
			while (i < text.length && !text.startsWith(close, i)) {
				if (text[i] === '\n') {
					line++;
					if (!triple) break;
				}
				if (text[i] === '\\' && !raw) i++;
				i++;
			}
			i += close.length - 1;
			if (line > startLine) folds.push({ startLine, endLine: line - 1, kind: 'region' });
		} else if (c === '{' || c === '(' || c === '[') {
			stack.push({ ch: c, line });
		} else if (c === '}' || c === ')' || c === ']') {
			const top = stack.pop();
			// The fold ends on the line before the closer, so the closer stays visible.
			if (top && top.ch === pairs[c] && line - 1 > top.line) folds.push({ startLine: top.line, endLine: line - 1 });
		}
	}
	return folds;
}

// ---- outline ------------------------------------------------------------------------------

const SYMBOL = { file: 1, module: 2, class: 5, method: 6, property: 7, field: 8, enum: 10, interface: 11, function: 12, constant: 14, enumMember: 22, struct: 23 } as const;

function documentSymbols(text: string, path: string) {
	const parsed = parse(text, { testFile: path.endsWith('.test.nibl'), declarationFile: path.endsWith('.d.nibl') });
	const lines = text.split('\n');
	return parsed.decls.map((d) => symbol(d, lines)).filter((s) => s !== null);
}

function symbol(node: Node, lines: string[]): any {
	const kind = symbolKind(node);
	if (kind === null || !node.name) return null;
	// A declaration with attributes starts at its first attribute; its name comes later.
	const start = node.line - 1;
	const word = new RegExp(`\\b${node.name}\\b`);
	let line = start;
	while (line < start + 10 && line < lines.length - 1 && !word.test((lines[line] ?? '').replace(/@\w+(\([^)]*\))?/g, ''))) line++;
	const found = (lines[line] ?? '').search(word);
	const col = Math.max(0, found);
	const selection = { start: { line, character: col }, end: { line, character: col + node.name.length } };
	const children = ((node.members ?? []) as Node[]).map((m) => symbol(m, lines)).filter((s) => s !== null);
	return {
		name: node.name,
		detail: node.typeKind ?? '',
		kind,
		range: { start: { line: start, character: 0 }, end: { line: endOf(node, line, lines), character: 0 } },
		selectionRange: selection,
		children,
	};
}

function symbolKind(node: Node): number | null {
	switch (node.kind) {
		case 'Fn':
			return SYMBOL.function;
		case 'Getter':
			return SYMBOL.property;
		case 'Field':
			return SYMBOL.field;
		case 'Const':
			return SYMBOL.constant;
		case 'Variant':
			return SYMBOL.enumMember;
		case 'TypeDecl':
			return { record: SYMBOL.struct, class: SYMBOL.class, interface: SYMBOL.interface, enum: SYMBOL.enum, attribute: SYMBOL.class }[node.typeKind as string] ?? SYMBOL.class;
		default:
			return null;
	}
}

/** The last line of a declaration: where the brace opened on its first line closes. */
function endOf(node: Node, line: number, lines: string[]): number {
	const first = lines[line] ?? '';
	if (!first.includes('{') && !(node.kind === 'Fn' && first.trimEnd().endsWith('('))) return line;
	let depth = 0;
	for (let i = line; i < lines.length; i++) {
		for (const c of lines[i].replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\/\/.*$/, '')) {
			if (c === '{' || c === '(') depth++;
			if (c === '}' || c === ')') depth--;
		}
		if (depth <= 0) return i;
	}
	return line;
}
