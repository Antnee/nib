// Tokenizes .nibl files with the grammar, using the tokenizer VS Code uses, and reports any
// file that ends inside a string or brace (a sign that a rule doesn't close). With --show,
// prints each line's tokens and scopes.
//
//   cd tools/editors/textmate/test && npm install --no-save vscode-textmate@9.2.0 vscode-oniguruma@2.0.1
//   node tools/editors/textmate/test/check.mjs examples std
//   node tools/editors/textmate/test/check.mjs --show examples/shop/src/money/money.nibl

import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, 'package.json'));
const vsctm = require('vscode-textmate');
const oniguruma = require('vscode-oniguruma');
await oniguruma.loadWASM(fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm')).buffer);

const grammarPath = join(here, '..', 'syntaxes', 'nib.tmLanguage.json');
const registry = new vsctm.Registry({
	onigLib: Promise.resolve({ createOnigScanner: (s) => new oniguruma.OnigScanner(s), createOnigString: (s) => new oniguruma.OnigString(s) }),
	loadGrammar: async () => vsctm.parseRawGrammar(fs.readFileSync(grammarPath, 'utf8'), grammarPath),
});
const grammar = await registry.loadGrammar('source.nib');

const args = process.argv.slice(2);
const show = args.includes('--show');
const files = args.filter((a) => a !== '--show').flatMap(find);

let leaks = 0;
for (const file of files) {
	let rule = vsctm.INITIAL;
	for (const [i, line] of fs.readFileSync(file, 'utf8').split('\n').entries()) {
		const r = grammar.tokenizeLine(line, rule);
		if (show) {
			const tokens = r.tokens
				.map((t) => [line.slice(t.startIndex, t.endIndex), t.scopes[t.scopes.length - 1].replace(/\.nib$/, '')])
				.filter(([text]) => text.trim())
				.map(([text, scope]) => `${JSON.stringify(text)}:${scope}`);
			console.log(`${i + 1}: ${tokens.join(' ')}`);
		}
		rule = r.ruleStack;
	}
	if (rule.depth > 1) {
		leaks++;
		console.log(`${file}: ends inside a string or brace`);
	}
}
console.log(`${files.length} files, ${leaks} ending inside a string or brace`);
process.exit(leaks === 0 ? 0 : 1);

function find(p) {
	if (fs.statSync(p).isFile()) return p.endsWith('.nibl') ? [p] : [];
	return fs.readdirSync(p).sort().filter((n) => !n.startsWith('.') && n !== 'node_modules').flatMap((n) => find(join(p, n)));
}
