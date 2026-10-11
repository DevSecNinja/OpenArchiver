const assert = require('node:assert/strict');
const { readdirSync } = require('node:fs');
const { createRequire } = require('node:module');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const rootPath = resolve(__dirname, '../../..');

test('backend installation has no SQLite driver or SQLite-only build dependencies', () => {
	assert.equal(Object.hasOwn(require('../package.json').dependencies, 'sqlite3'), false);
	assert.throws(() => require.resolve('sqlite3'), { code: 'MODULE_NOT_FOUND' });
	const drizzleRequire = createRequire(require.resolve('drizzle-orm'));
	assert.throws(() => drizzleRequire.resolve('sqlite3'), { code: 'MODULE_NOT_FOUND' });

	const entries = readdirSync(join(rootPath, 'node_modules', '.pnpm'));
	for (const name of ['sqlite3', 'node-gyp', 'prebuild-install', 'bindings', 'tar-fs']) {
		assert.equal(
			entries.some((entry) => entry.startsWith(`${name}@`)),
			false,
			`Unexpected application dependency installed: ${name}`
		);
	}
});

test('PostgreSQL and PST modules load without requesting a SQLite driver', () => {
	const result = spawnSync(
		process.execPath,
		[
			'-e',
			`
			const Module = require('node:module');
			const original = Module._load;
			Module._load = function (request, ...args) {
				if (/^(?:sqlite3|better-sqlite3|node:sqlite)(?:\\/|$)/.test(request)) {
					throw new Error('Unexpected SQLite driver request: ' + request);
				}
				return original.call(this, request, ...args);
			};
			for (const request of [
				'drizzle-orm',
				'drizzle-orm/postgres-js',
				'drizzle-orm/postgres-js/migrator',
				'pst-extractor',
			]) {
				require(request);
			}
			`,
		],
		{ cwd: resolve(__dirname, '..'), encoding: 'utf8', timeout: 30_000 }
	);
	assert.ifError(result.error);
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
