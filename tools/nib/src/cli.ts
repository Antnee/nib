// nib-check: parses and checks Nib source files, and formats them.
//
//   node tools/nib/src/cli.ts check [--json] [--warnings-as-errors] <path>…
//   node tools/nib/src/cli.ts fmt [--check] <path>…
//
// `check` exits with 1 if there are errors (or warnings, with --warnings-as-errors), and warns
// about a file that isn't in canonical form. `fmt`
// rewrites each file that isn't in canonical form, and the code in the guide's Markdown;
// with --check it only lists them, and exits with 1 if there are any.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { checkPaths, type Diagnostic } from './check.ts';
import { formatMarkdown, formatWithReason } from './format.ts';
import { isCheckedMarkdown } from './markdown.ts';

const args = process.argv.slice(2);
if (args[0] === 'fmt' && args.length >= 2) {
	const onlyCheck = args.includes('--check');
	const changed: string[] = [];
	for (const path of args.slice(1).filter((a) => !a.startsWith('--')).flatMap(sources)) {
		const src = readFileSync(path, 'utf8');
		const out = formatted(path, src);
		if (out === src) continue;
		changed.push(relative(process.cwd(), path));
		if (!onlyCheck) writeFileSync(path, out);
	}
	for (const path of changed) console.log(onlyCheck ? `not formatted: ${path}` : `formatted: ${path}`);
	process.exit(onlyCheck && changed.length > 0 ? 1 : 0);
}
if (args[0] !== 'check' || args.length < 2) {
	console.error('usage: cli.ts check [--json] [--warnings-as-errors] <path>…\n       cli.ts fmt [--check] <path>…');
	process.exit(2);
}
const json = args.includes('--json');
const strict = args.includes('--warnings-as-errors');
const paths = args.slice(1).filter((a) => !a.startsWith('--'));

const diagnostics = [...checkPaths(paths), ...paths.flatMap(sources).flatMap(unformatted)];
const errors = diagnostics.filter((d) => d.severity === 'error').length;
const warnings = diagnostics.length - errors;

if (json) {
	console.log(JSON.stringify({ diagnostics: diagnostics.map((d) => ({ ...d, path: relative(process.cwd(), d.path) })), errors, warnings }, null, '\t'));
} else {
	for (const d of diagnostics) console.log(`${relative(process.cwd(), d.path)}:${d.line}:${d.col}: ${d.severity}: ${d.message}`);
	console.log(`${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`);
}
process.exit(errors > 0 || (strict && warnings > 0) ? 1 : 0);

function sources(path: string): string[] {
	if (statSync(path).isFile()) return path.endsWith('.nibl') || isCheckedMarkdown(path, true) ? [path] : [];
	return readdirSync(path).sort().flatMap((name) => {
		const full = join(path, name);
		if (statSync(full).isDirectory()) return name === 'node_modules' || name.startsWith('.') ? [] : sources(full);
		return full.endsWith('.nibl') || isCheckedMarkdown(full, false) ? [full] : [];
	});
}

/** A warning for a file that `fmt` would change, at the first line it would change. */
function unformatted(path: string): Diagnostic[] {
	const src = readFileSync(path, 'utf8');
	const out = formatted(path, src);
	if (out === src) return [];
	const before = src.split('\n');
	const after = out.split('\n');
	let line = 0;
	while (line < before.length && before[line] === after[line]) line++;
	return [{ path, line: line + 1, col: 1, severity: 'warning', message: 'this file isn\'t in canonical form from here on: run `fmt` on it' }];
}

function formatted(path: string, src: string): string {
	const options = { packageRoot: packageRoot(path), testFile: path.endsWith('.test.nibl'), declarationFile: path.endsWith('.d.nibl') };
	if (path.endsWith('.md')) return formatMarkdown(src, options);
	const result = formatWithReason(src, options);
	if (result.skipped) console.error(`left as written: ${relative(process.cwd(), path)}: ${result.skipped}`);
	return result.text;
}

/** The first part of this package's module paths: `shop` for a package named `antnee/shop`. */
function packageRoot(path: string): string | null {
	for (let dir = dirname(path); ; dir = dirname(dir)) {
		const manifest = join(dir, 'nib.toml');
		if (existsSync(manifest)) {
			const name = readFileSync(manifest, 'utf8').match(/^name\s*=\s*"([^"]+)"/m)?.[1];
			return name ? name.split('/').pop()! : null;
		}
		if (dirname(dir) === dir) return null;
	}
}
