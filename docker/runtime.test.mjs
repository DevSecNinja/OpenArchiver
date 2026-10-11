import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const require = createRequire(new URL('../package.json', import.meta.url));

test('unused SQLite is absent from installed workspace dependencies', async () => {
	const backendRequire = createRequire(
		new URL('../packages/backend/package.json', import.meta.url)
	);
	assert.throws(() => backendRequire.resolve('sqlite3'), { code: 'MODULE_NOT_FOUND' });
	const packages = await readdir(new URL('node_modules/.pnpm/', root));
	assert.deepEqual(
		packages.filter((name) => name.startsWith('sqlite3@')),
		[]
	);
});

test('OSS container launcher has no restart loop or nested worker supervisor', async () => {
	const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
	const command = manifest.scripts['docker-start:oss'];
	assert.match(command, /--kill-others --success all/);
	assert.doesNotMatch(command, /restart-|pnpm start:/);
	assert.equal((command.match(/exec node /g) || []).length, 5);
	assert.ok(command.includes('cd packages/frontend && exec node build/index.js'));
	assert.ok(command.includes('${INDEXING_WORKER_MAX_OLD_SPACE_MB:-2048}'));
	for (const process of ['ingestion.worker', 'indexing.worker', 'sync-scheduler']) {
		assert.ok(command.includes(process));
	}
});

test('startup failure reports the missing configuration', { timeout: 15000 }, async (t) => {
	const directory = await mkdtemp(path.join(tmpdir(), 'oa-startup-'));
	const child = spawn(
		process.execPath,
		[fileURLToPath(new URL('apps/open-archiver/dist/index.js', root))],
		{
			cwd: directory,
			signal: t.signal,
			env: {
				PATH: process.env.PATH,
				NODE_ENV: 'production',
				PORT_BACKEND: '4000',
				JWT_SECRET: 'synthetic-startup-test',
				ENCRYPTION_KEY: 'a'.repeat(64),
				STORAGE_TYPE: 'local',
				STORAGE_LOCAL_ROOT_PATH: directory,
				DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/test',
				REDIS_HOST: '127.0.0.1',
				REDIS_PORT: '1',
				REDIS_TLS_ENABLED: 'false',
			},
			stdio: ['ignore', 'pipe', 'pipe'],
		}
	);
	let output = '';
	child.stdout.on('data', (chunk) => (output += chunk));
	child.stderr.on('data', (chunk) => (output += chunk));
	try {
		const [code] = await once(child, 'close');
		assert.equal(code, 1, output);
		assert.match(output, /Missing required environment variables.*JWT_EXPIRES_IN/, output);
	} finally {
		if (child.exitCode === null) child.kill('SIGKILL');
		await rm(directory, { recursive: true, force: true });
	}
});

test('mailbox-scoped archive policy does not grant access to another mailbox', () => {
	const backendRequire = createRequire(
		new URL('../packages/backend/package.json', import.meta.url)
	);
	const { subject } = backendRequire('@casl/ability');
	const { createAbilityFor } = backendRequire('./dist/iam-policy/ability.js');
	const ability = createAbilityFor([
		{
			action: 'read',
			subject: 'archive',
			conditions: { userEmail: 'allowed@example.invalid' },
		},
	]);
	assert.equal(
		ability.can('read', subject('archive', { userEmail: 'allowed@example.invalid' })),
		true
	);
	assert.equal(
		ability.can('read', subject('archive', { userEmail: 'other@example.invalid' })),
		false
	);
	assert.equal(
		ability.can('delete', subject('archive', { userEmail: 'allowed@example.invalid' })),
		false
	);
});

test(
	'a fatal child exit terminates its siblings and remains a failure',
	{ timeout: 15000 },
	async (t) => {
		const directory = await mkdtemp(path.join(tmpdir(), 'oa-runtime-'));
		const marker = path.join(directory, 'starts');
		const stopped = path.join(directory, 'stopped');
		const worker = path.join(directory, 'worker.cjs');
		const failing = path.join(directory, 'failing.cjs');
		await writeFile(
			worker,
			`const fs = require('node:fs');
process.once('SIGTERM', () => {
	fs.writeFileSync(${JSON.stringify(stopped)}, 'stopped');
	process.exit(0);
});
fs.appendFileSync(${JSON.stringify(marker)}, 'start\\n');
setInterval(() => {}, 1000);`
		);
		await writeFile(
			failing,
			`setInterval(() => {
	if (require('node:fs').existsSync(${JSON.stringify(marker)})) process.exit(7);
}, 20);`
		);
		const concurrently = path.resolve(
			path.dirname(require.resolve('concurrently/package.json')),
			require('concurrently/package.json').bin.concurrently
		);
		const child = spawn(
			process.execPath,
			[
				concurrently,
				'--kill-others',
				'--success',
				'all',
				`node "${worker}"`,
				`node "${failing}"`,
			],
			{ stdio: ['ignore', 'pipe', 'pipe'] }
		);
		let output = '';
		child.stdout.on('data', (chunk) => (output += chunk));
		child.stderr.on('data', (chunk) => (output += chunk));
		const closed = once(child, 'close');
		try {
			const [code] = await once(child, 'close', { signal: t.signal });
			assert.notEqual(code, 0, output);
			assert.match(output, /exited with code 7/, output);
			assert.equal(await readFile(marker, 'utf8'), 'start\n');
			assert.equal(await readFile(stopped, 'utf8'), 'stopped');
			assert.match(output, /SIGTERM/);
		} finally {
			if (child.exitCode === null) child.kill('SIGTERM');
			await closed;
			await rm(directory, { recursive: true, force: true });
		}
	}
);
