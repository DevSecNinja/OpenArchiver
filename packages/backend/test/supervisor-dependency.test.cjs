const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { createRequire } = require('node:module');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');

const rootRequire = createRequire(path.resolve(__dirname, '../../../package.json'));
const supervisorManifestPath = rootRequire.resolve('concurrently/package.json');
const supervisorManifest = rootRequire(supervisorManifestPath);
const supervisorRequire = createRequire(supervisorManifestPath);
const cli = path.resolve(path.dirname(supervisorManifestPath), supervisorManifest.bin.concurrently);

test('installed supervisor uses the selected ESM release and fixed shell-quote', async (t) => {
	const shellQuote = supervisorRequire('shell-quote/package.json');
	assert.equal(rootRequire('./package.json').dependencies.concurrently, '10.0.6');
	assert.equal(supervisorManifest.version, '10.0.6');
	assert.equal(supervisorManifest.type, 'module');
	assert.equal(supervisorManifest.dependencies['shell-quote'], '1.12.0');
	assert.equal(shellQuote.version, '1.12.0');
	const api = await import(pathToFileURL(rootRequire.resolve('concurrently')).href);
	assert.equal(typeof api.default, 'function');
	t.diagnostic(
		`Node ${process.version}; concurrently ${supervisorManifest.version}; ` +
			`shell-quote ${shellQuote.version}; CLI ${supervisorManifest.bin.concurrently}`
	);
});

test('fixed shell-quote rejects line terminators after a comment token', () => {
	const { quote } = supervisorRequire('shell-quote');
	for (const terminator of ['\n', '\r', '\u2028', '\u2029']) {
		assert.throws(
			() => quote(['echo', { comment: 'synthetic comment' }, `before${terminator}after`]),
			TypeError
		);
	}
});

test('CommonJS debug retains its existing color peer outside the supervisor closure', async () => {
	const backendRequire = createRequire(path.resolve(__dirname, '../package.json'));
	const expressRequire = createRequire(backendRequire.resolve('express'));
	const debugRequire = createRequire(expressRequire.resolve('debug'));
	const debug = expressRequire('debug');
	assert.equal(typeof debug, 'function');
	assert.equal(typeof debug('open-archiver:supervisor-regression'), 'function');
	assert.equal(typeof debugRequire('supports-color').supportsColor, 'function');
	for (const [consumer, version] of [
		[debugRequire, '8.1.1'],
		[supervisorRequire, '10.2.2'],
	]) {
		const manifestPath = path.join(
			path.dirname(consumer.resolve('supports-color')),
			'package.json'
		);
		assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).version, version);
	}
});

for (const scenario of ['fatal child', 'successful child', 'SIGTERM']) {
	test(
		`supervisor CLI compatibility: ${scenario} stops siblings without respawn`,
		{
			timeout: 15000,
			skip: process.platform === 'win32' && 'Requires the POSIX container shell',
		},
		async (t) => {
			const directory = await mkdtemp(path.join(tmpdir(), 'oa-supervisor-'));
			await writeFile(
				path.join(directory, 'child.cjs'),
				`const fs = require('node:fs');
const name = process.argv[2];
process.once('SIGTERM', () => {
	fs.appendFileSync('events', name + ':stopped\\n');
	process.exit(0);
});
if (name === 'indexing') {
	fs.writeFileSync('arguments', JSON.stringify({ argv: process.argv.slice(3), execArgv: process.execArgv }));
}
fs.appendFileSync('events', name + ':started\\n');
setInterval(() => {
	if (name !== 'api' || !fs.existsSync('exit-code')) return;
	process.exit(Number(fs.readFileSync('exit-code', 'utf8')));
}, 20);
`
			);
			const names = ['api', 'frontend', 'ingestion', 'indexing', 'scheduler'];
			const commands = names.map((name) =>
				name === 'indexing'
					? 'exec node --max-old-space-size=${INDEXING_WORKER_MAX_OLD_SPACE_MB:-2048} child.cjs indexing "two words" "literal;value"'
					: `exec node child.cjs ${name}`
			);
			const child = spawn(
				process.execPath,
				[cli, '--kill-others', '--success', 'all', '--names', names.join(','), ...commands],
				{
					cwd: directory,
					env: {
						PATH: process.env.PATH,
						NO_COLOR: '1',
						...(scenario === 'SIGTERM'
							? { INDEXING_WORKER_MAX_OLD_SPACE_MB: '256' }
							: {}),
					},
					detached: true,
					stdio: ['ignore', 'pipe', 'pipe'],
				}
			);
			let output = '';
			child.stdout.on('data', (chunk) => (output += chunk));
			child.stderr.on('data', (chunk) => (output += chunk));
			const closed = once(child, 'close');
			const readEvents = async () => {
				try {
					return await readFile(path.join(directory, 'events'), 'utf8');
				} catch (error) {
					if (error.code !== 'ENOENT') throw error;
					return '';
				}
			};
			try {
				for (let attempt = 0; ; attempt++) {
					assert.equal(child.exitCode, null, output);
					assert.equal(child.signalCode, null, output);
					const events = await readEvents();
					if (names.every((name) => events.includes(`${name}:started\n`))) break;
					assert.ok(
						attempt < 200,
						`Children did not become ready:\n${output}\n${events}`
					);
					await delay(25, undefined, { signal: t.signal });
				}
				const args = JSON.parse(await readFile(path.join(directory, 'arguments'), 'utf8'));
				assert.deepEqual(args.argv, ['two words', 'literal;value']);
				assert.deepEqual(args.execArgv, [
					`--max-old-space-size=${scenario === 'SIGTERM' ? '256' : '2048'}`,
				]);
				if (scenario === 'SIGTERM') {
					child.kill('SIGTERM');
				} else {
					await writeFile(
						path.join(directory, 'exit-code'),
						scenario === 'fatal child' ? '7' : '0'
					);
				}
				const [code, signal] = await once(child, 'close', { signal: t.signal });
				assert.equal(signal, null, output);
				assert.equal(code, scenario === 'fatal child' ? 1 : 0, output);
				if (scenario !== 'SIGTERM') {
					assert.match(output, /\[api\].*exited with code (7|0)/, output);
				}
				const events = await readEvents();
				for (const name of names) {
					assert.equal(events.split(`${name}:started\n`).length - 1, 1, events);
					if (name !== 'api' || scenario === 'SIGTERM') {
						assert.ok(events.includes(`${name}:stopped\n`), events);
					}
				}
				await delay(200);
				assert.equal(
					await readEvents(),
					events,
					'Children restarted after supervisor exit'
				);
			} finally {
				// Kill only this fixture's process group, including children left after a failure.
				if (child.pid) {
					try {
						process.kill(-child.pid, 'SIGKILL');
					} catch (error) {
						if (error.code !== 'ESRCH') throw error;
					}
				}
				await closed;
				await rm(directory, { recursive: true, force: true });
				if (t.signal.aborted) t.diagnostic(output);
			}
		}
	);
}
