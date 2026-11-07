// nib-lsp: a language server over stdio, for editors that speak the Language Server
// Protocol (PhpStorm through LSP4IJ, VS Code, Neovim, Zed).
//
//   node tools/nib/src/lsp.ts
//
// The server itself is `server.ts`. This file runs it as a child process and passes messages
// through. When the checker's source, or the declarations of the stdlib or the first-party
// packages, change, it starts a fresh server and hands it the editor's open documents, so the
// editor never has to restart it.

import { spawn, type ChildProcess } from 'node:child_process';
import { watch } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

interface Message {
	jsonrpc: '2.0';
	id?: number | string | null;
	method?: string;
	params?: any;
	result?: any;
	error?: { code: number; message: string };
}

const SOURCE_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER = join(SOURCE_DIR, 'server.ts');
const STD_DIR = join(SOURCE_DIR, '..', '..', '..', 'std');
const PACKAGES_DIR = join(SOURCE_DIR, '..', '..', '..', 'packages');
/** The id of the `initialize` this file sends a fresh server; its answer isn't the editor's. */
const REPLAY_ID = 'nib-reload';

/** The editor's `initialize` request, sent again to each fresh server. */
let initialize: Message | null = null;
let initialized = false;
/** Open documents by URI, as the editor last sent them. */
const documents = new Map<string, { uri: string; languageId: string; version: number; text: string }>();
/** Requests the server hasn't answered yet, which a reload would otherwise leave hanging. */
const pending = new Set<number | string>();
let shuttingDown = false;
let server: ChildProcess;

function read(stream: Readable, onMessage: (msg: Message) => void) {
	let buffer = Buffer.alloc(0);
	stream.on('data', (chunk: Buffer) => {
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
			onMessage(JSON.parse(body));
		}
	});
}

function write(stream: Writable, message: Omit<Message, 'jsonrpc'>) {
	const body = JSON.stringify({ jsonrpc: '2.0', ...message });
	stream.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
}

function start() {
	const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'inherit'] });
	read(child.stdout!, (msg) => {
		if (msg.id === REPLAY_ID) return;
		if (msg.id !== undefined && msg.id !== null && msg.method === undefined) pending.delete(msg.id);
		write(process.stdout, msg);
	});
	child.on('exit', (code) => {
		// A server replaced by a reload exits too; only the current one's exit ends this one.
		if (child === server) process.exit(shuttingDown ? 0 : code ?? 1);
	});
	server = child;
}

function reload() {
	const old = server;
	// The editor closing the pipe ends the session, whether or not it said `exit`.
process.stdin.on('end', () => {
	shuttingDown = true;
	server.kill();
	process.exit(0);
});

start();
	old.kill();
	for (const id of pending) write(process.stdout, { id, error: { code: -32801, message: 'the Nib checker was reloaded' } });
	pending.clear();
	if (!initialize) return;
	write(server.stdin!, { id: REPLAY_ID, method: 'initialize', params: initialize.params });
	if (initialized) write(server.stdin!, { method: 'initialized', params: {} });
	for (const doc of documents.values()) write(server.stdin!, { method: 'textDocument/didOpen', params: { textDocument: doc } });
	write(process.stdout, { method: 'window/logMessage', params: { type: 3, message: 'Nib: the checker changed, so the server was restarted' } });
}

read(process.stdin, (msg) => {
	switch (msg.method) {
		case 'initialize':
			initialize = msg;
			break;
		case 'initialized':
			initialized = true;
			break;
		case 'shutdown':
		case 'exit':
			shuttingDown = true;
			break;
		case 'textDocument/didOpen':
			documents.set(msg.params.textDocument.uri, { ...msg.params.textDocument });
			break;
		case 'textDocument/didChange': {
			// The server asks for whole documents, so the last change is the full text.
			const doc = documents.get(msg.params.textDocument.uri);
			const changes = msg.params.contentChanges;
			if (doc && changes.length > 0) {
				doc.text = changes[changes.length - 1].text;
				doc.version = msg.params.textDocument.version;
			}
			break;
		}
		case 'textDocument/didClose':
			documents.delete(msg.params.textDocument.uri);
			break;
	}
	if (msg.id !== undefined && msg.id !== null && msg.method !== undefined) pending.add(msg.id);
	write(server.stdin!, msg);
});

// Saving a file can fire several events, so a reload waits for them to settle.
let timer: NodeJS.Timeout | undefined;
function changed(file: string | null) {
	if (file && !file.endsWith('.ts') && !file.endsWith('.nibl')) return;
	clearTimeout(timer);
	timer = setTimeout(reload, 300);
}
watch(SOURCE_DIR, (_, file) => changed(file));
watch(STD_DIR, { recursive: true }, (_, file) => changed(file));
watch(PACKAGES_DIR, { recursive: true }, (_, file) => changed(file));

// The editor closing the pipe ends the session, whether or not it said `exit`.
process.stdin.on('end', () => {
	shuttingDown = true;
	server.kill();
	process.exit(0);
});

start();
