// What a package needs from its host, as its manifest declares it: configuration variables,
// named resources (databases, queues, caches, rate limiters, directories) bound to them, and the
// files that ship with the build. Code asks for each by name through `Env`, and the type
// stage checks the names against this.

import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

export type ResourceKind = 'databases' | 'queues' | 'caches' | 'rate-limiters' | 'directories' | 'files';

export interface Declared {
	name: string;
	line: number;
	keys: Map<string, string | boolean>;
	used: boolean;
}

export interface HostProblem {
	line: number;
	severity: 'error' | 'warning';
	message: string;
}

export interface HostNeeds {
	path: string;
	config: Map<string, Declared>;
	resources: Map<ResourceKind, Map<string, Declared>>;
	problems: HostProblem[];
	/** How each configuration variable was first read: the `Env` method, and where. */
	reads: Map<string, { method: string; path: string; line: number }>;
}

const KINDS: ResourceKind[] = ['databases', 'queues', 'caches', 'rate-limiters', 'directories', 'files'];

/** The keys each section allows, and which of them must be given. */
const KEYS: Record<ResourceKind | 'config', { allowed: string[]; required: string[] }> = {
	config: { allowed: ['secret'], required: [] },
	databases: { allowed: ['engine', 'migrations', 'from', 'pool-size-from'], required: ['engine', 'from'] },
	queues: { allowed: ['from', 'database'], required: [] },
	caches: { allowed: ['from'], required: ['from'] },
	'rate-limiters': { allowed: ['from'], required: ['from'] },
	directories: { allowed: ['access', 'from'], required: ['access', 'from'] },
	files: { allowed: ['path'], required: ['path'] },
};

const ENGINES = ['postgres', 'mysql', 'sqlite'];

/** What a resource is called in messages, singular. */
export const RESOURCE_NOUN: Record<ResourceKind, string> = {
	databases: 'database',
	queues: 'queue',
	caches: 'cache',
	'rate-limiters': 'rate limiter',
	directories: 'directory',
	files: 'set of files',
};

/**
 * `onDisk` checks that each `[files]` path exists beside the manifest; a manifest in the
 * guide has no package around it.
 */
export function readHostNeeds(path: string, text: string, onDisk = true): HostNeeds {
	const host: HostNeeds = { path, config: new Map(), resources: new Map(KINDS.map((k) => [k, new Map()])), problems: [], reads: new Map() };
	const error = (line: number, message: string) => host.problems.push({ line, severity: 'error', message });
	let section: ResourceKind | 'config' | null = null;
	let current: Declared | null = null;
	const table = (kind: ResourceKind | 'config') => (kind === 'config' ? host.config : host.resources.get(kind)!);
	const declare = (kind: ResourceKind | 'config', name: string, line: number): Declared => {
		const d: Declared = { name, line, keys: new Map(), used: false };
		if (table(kind).has(name)) error(line, `\`${name}\` is declared twice in [${kind}]`);
		table(kind).set(name, d);
		return d;
	};

	text.split('\n').forEach((raw, i) => {
		const line = i + 1;
		const body = raw.replace(/\s+#.*$/, '').trim();
		if (body === '' || body.startsWith('#')) return;
		const header = body.match(/^\[([A-Za-z0-9_-]+)(?:\.([A-Za-z0-9_-]+))?\]$/);
		if (header) {
			const kind = header[1];
			section = kind === 'config' || (KINDS as string[]).includes(kind) ? (kind as ResourceKind | 'config') : null;
			current = section && header[2] ? declare(section, header[2], line) : null;
			return;
		}
		if (!section) return;
		const kv = body.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
		if (!kv) return;
		if (current) {
			current.keys.set(kv[1], value(kv[2]));
			return;
		}
		// `name = { … }` declares one entry on a line.
		const entry = declare(section, kv[1], line);
		const inline = kv[2].match(/^\{(.*)\}$/);
		if (!inline) {
			error(line, `\`${kv[1]}\` is declared as \`${kv[1]} = { … }\`, with its settings in the braces`);
			return;
		}
		for (const part of inline[1].split(',').map((s) => s.trim()).filter(Boolean)) {
			const pair = part.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
			if (pair) entry.keys.set(pair[1], value(pair[2]));
		}
	});

	validate(host, onDisk);
	return host;
}

function value(text: string): string | boolean {
	if (text === 'true' || text === 'false') return text === 'true';
	return text.replace(/^"(.*)"$/, '$1');
}

function validate(host: HostNeeds, onDisk: boolean) {
	const error = (d: Declared, message: string) => host.problems.push({ line: d.line, severity: 'error', message });
	const sections: [ResourceKind | 'config', Map<string, Declared>][] = [['config', host.config], ...host.resources];
	for (const [kind, entries] of sections) {
		const { allowed, required } = KEYS[kind];
		for (const d of entries.values()) {
			for (const key of d.keys.keys()) {
				if (!allowed.includes(key)) error(d, `[${kind}] \`${d.name}\` has no setting \`${key}\`; it takes ${allowed.map((k) => `\`${k}\``).join(', ')}`);
			}
			for (const key of required) {
				if (!d.keys.has(key)) error(d, `[${kind}] \`${d.name}\` needs \`${key}\``);
			}
			for (const key of ['from', 'pool-size-from']) {
				const from = d.keys.get(key);
				if (typeof from !== 'string') continue;
				const variable = host.config.get(from);
				if (!variable) error(d, `\`${key} = "${from}"\` names a variable that isn't declared in [config]`);
				else variable.used = true;
			}
		}
	}
	for (const d of host.config.values()) {
		const secret = d.keys.get('secret');
		if (secret !== undefined && typeof secret !== 'boolean') error(d, `\`secret\` is \`true\` or \`false\``);
	}
	for (const d of host.resources.get('databases')!.values()) {
		const engine = d.keys.get('engine');
		if (typeof engine === 'string' && !ENGINES.includes(engine)) error(d, `\`engine\` is one of ${ENGINES.map((e) => `"${e}"`).join(', ')}`);
	}
	for (const d of host.resources.get('queues')!.values()) {
		const has = ['from', 'database'].filter((k) => d.keys.has(k));
		if (has.length !== 1) error(d, `[queues] \`${d.name}\` needs either \`from\`, a variable with the queue's URL, or \`database\`, to keep the queue in one of the databases`);
		const database = d.keys.get('database');
		if (typeof database === 'string') {
			const db = host.resources.get('databases')!.get(database);
			if (!db) error(d, `\`database = "${database}"\` names a database that isn't declared in [databases]`);
			else db.used = true;
		}
	}
	for (const d of host.resources.get('directories')!.values()) {
		const access = d.keys.get('access');
		if (access !== undefined && access !== 'read' && access !== 'write') error(d, '`access` is "read" or "write"');
	}
	// A set of files belongs to the package, so its path is inside the package.
	for (const d of host.resources.get('files')!.values()) {
		const path = d.keys.get('path');
		if (typeof path !== 'string') continue;
		if (path === '' || isAbsolute(path) || path.split('/').includes('..')) {
			error(d, `[files] \`${d.name}\` has \`path = "${path}"\`: give a directory inside the package, relative to nib.toml`);
		} else if (onDisk && !existsSync(join(dirname(host.path), path))) {
			error(d, `[files] \`${d.name}\` has \`path = "${path}"\`, but there's no such directory beside nib.toml`);
		}
	}
}

/** Declarations nothing uses, once every file has been checked. */
export function unusedNeeds(host: HostNeeds): HostProblem[] {
	const out: HostProblem[] = [];
	for (const d of host.config.values()) {
		if (!d.used) out.push({ line: d.line, severity: 'warning', message: `\`${d.name}\` is declared in [config] but never read` });
	}
	for (const [kind, entries] of host.resources) {
		for (const d of entries.values()) {
			if (!d.used) out.push({ line: d.line, severity: 'warning', message: `the ${RESOURCE_NOUN[kind]} \`${d.name}\` is declared but never used` });
		}
	}
	return out;
}
