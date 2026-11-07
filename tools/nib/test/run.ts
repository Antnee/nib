// Runs every case in test/cases. The first line of a case says what to expect:
//   // expect: ok                  no errors at all
//   // expect: error: <text>       at least one error whose message contains <text>
//   // expect: only error: <text>  exactly one diagnostic, an error containing <text>
//   // expect: warning: <text>     no errors, and a warning containing <text>
// A directory holding `nib.toml` is a package, checked as a whole; the header is the
// manifest's first line, with `#` in place of `//`. A `registry` directory beside its
// `src` holds the packages its dependencies resolve to.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkPaths, checkSources } from '../src/check.ts';

const dir = join(import.meta.dirname, 'cases');
let failed = 0;
const files = readdirSync(dir).filter((f) => f.endsWith('.nibl') || existsSync(join(dir, f, 'nib.toml'))).sort();
for (const name of files) {
	const path = join(dir, name);
	const isPackage = !name.endsWith('.nibl');
	const src = readFileSync(isPackage ? join(path, 'nib.toml') : path, 'utf8');
	const header = src.split('\n')[0].match(/^(?:\/\/|#) expect: (ok|only error|error|warning)(?:: (.*))?$/);
	if (!header) {
		console.log(`FAIL ${name}: missing "// expect:" header`);
		failed++;
		continue;
	}
	const [, kind, text] = header;
	if (isPackage && existsSync(join(path, 'registry'))) process.env.NIB_REGISTRY = join(path, 'registry');
	else delete process.env.NIB_REGISTRY;
	const diagnostics = isPackage ? checkPaths([join(path, 'src')]) : checkSources([{ path, src }], null);
	const errors = diagnostics.filter((d) => d.severity === 'error');
	const warnings = diagnostics.filter((d) => d.severity === 'warning');
	let ok: boolean;
	if (kind === 'ok') ok = errors.length === 0 && warnings.length === 0;
	else if (kind === 'error') ok = errors.some((d) => d.message.includes(text));
	else if (kind === 'only error') ok = diagnostics.length === 1 && errors.length === 1 && errors[0].message.includes(text);
	else ok = errors.length === 0 && warnings.some((d) => d.message.includes(text));
	if (!ok) {
		failed++;
		console.log(`FAIL ${name}: expected ${kind}${text ? `: ${text}` : ''}`);
		for (const d of diagnostics) console.log(`    ${d.line}:${d.col} ${d.severity}: ${d.message}`);
	}
}
console.log(`${files.length - failed} of ${files.length} cases passed`);
process.exit(failed === 0 ? 0 : 1);
