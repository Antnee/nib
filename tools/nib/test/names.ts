// Checks that the names the editor can go to lead to their declarations: names in
// expressions, and types written in signatures, fields and imports. Run with:
//   node tools/nib/test/names.ts
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPackageOf } from '../src/check.ts';
import type { NameInfo } from '../src/types.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const path = join(root, 'examples', 'notes', 'src', 'main.nibl');
const lines = readFileSync(path, 'utf8').split('\n');
const names = new Map<string, NameInfo[]>();
checkPackageOf(path, new Map(), names);
const found = names.get(path) ?? [];

/** The line, counting from 1, of the first line that contains `text`. */
const lineOf = (text: string) => lines.findIndex((l) => l.includes(text)) + 1;

const cases: { what: string; line: string; name: string; to: string; toLine?: string }[] = [
	{ what: 'a type in a signature', line: 'fn index(req: Request) -> Response else WebError', name: 'WebError', to: 'main.nibl', toLine: 'enum WebError' },
	{ what: 'a stdlib type in a signature', line: 'fn index(req: Request) -> Response else WebError', name: 'Request', to: 'messages.d.nibl' },
	{ what: 'an imported attribute', line: 'import std.db.{@db', name: '@db', to: 'db.d.nibl' },
	{ what: 'an imported type', line: 'import std.db.{@db', name: 'DbError', to: 'db.d.nibl' },
	{ what: 'an attribute on a declaration', line: '@db(table: "notes")', name: '@db', to: 'db.d.nibl' },
	{ what: 'a call in an expression', line: 'return Response.html(notesPage(', name: 'notesPage', to: 'main.nibl', toLine: 'fn notesPage' },
];

let failed = 0;
for (const c of cases) {
	const line = lineOf(c.line);
	const col = lines[line - 1].indexOf(c.name) + 1;
	const name = found.find((n) => n.line === line && n.col === col);
	const def = name?.def;
	const ok = def && def.path.endsWith(c.to) && (!c.toLine || def.line === lineOf(c.toLine));
	if (!ok) {
		failed++;
		console.log(`FAIL ${c.what}: \`${c.name}\` on line ${line} leads to ${def ? `${def.path}:${def.line}` : 'nothing'}, not ${c.to}`);
	}
}
console.log(`${cases.length - failed} of ${cases.length} name cases passed`);
if (failed > 0) process.exit(1);
