// Runs the formatter's cases in test/format: each `name.in.nibl` must format to
// `name.out.nibl`, and formatting that again must change nothing.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { format } from '../src/format.ts';

const dir = join(import.meta.dirname, 'format');
const cases = readdirSync(dir).filter((f) => f.endsWith('.in.nibl')).sort();
let failed = 0;
for (const name of cases) {
	const input = readFileSync(join(dir, name), 'utf8');
	const expected = readFileSync(join(dir, name.replace('.in.nibl', '.out.nibl')), 'utf8');
	const actual = format(input, { packageRoot: 'shop' });
	if (actual !== expected) {
		failed++;
		console.log(`FAIL ${name}: the output differs from ${name.replace('.in.', '.out.')}`);
		console.log(actual);
	} else if (format(actual, { packageRoot: 'shop' }) !== actual) {
		failed++;
		console.log(`FAIL ${name}: formatting the output again changes it`);
	}
}
console.log(`${cases.length - failed} of ${cases.length} formatter cases passed`);
process.exit(failed > 0 ? 1 : 0);
