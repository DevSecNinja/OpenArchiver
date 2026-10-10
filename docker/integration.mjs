import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const engine = process.env.CONTAINER_ENGINE || 'docker';
const image = process.env.TEST_IMAGE || 'open-archiver:test';
const prefix = `oa-test-${randomBytes(5).toString('hex')}`;
const network = `${prefix}-net`;
const app = `${prefix}-app`;
const containers = [];
const volumes = [];
const compose = readFileSync(new URL('compose.test.yml', import.meta.url), 'utf8');
const sidecarImage = (service) => {
	const match = compose.match(new RegExp(`\\n    ${service}:\\s*\\n        image: ([^\\s]+)`));
	assert.ok(match, `Missing ${service} image in docker/compose.test.yml`);
	return match[1];
};
const run = (args, input) =>
	execFileSync(engine, args, { input, maxBuffer: 32 * 1024 * 1024, timeout: 120000 });
const text = (args, input) => run(args, input).toString().trim();
const inspect = (name) => JSON.parse(text(['inspect', name]))[0];
const volume = (suffix) => {
	const name = `${prefix}-${suffix}`;
	text(['volume', 'create', name]);
	volumes.push(name);
	return name;
};
const start = (name, args) => {
	text(['run', '-d', '--name', name, '--network', network, ...args]);
	containers.push(name);
};
async function waitFor(description, check, seconds = 120) {
	const deadline = Date.now() + seconds * 1000;
	let last;
	while (Date.now() < deadline) {
		try {
			const value = await check();
			if (value) return value;
		} catch (error) {
			if (error.stderr?.toString().includes('container state improper')) throw error;
			last = error;
		}
		await delay(1000);
	}
	throw new Error(`Timed out: ${description}`, { cause: last });
}
const inside = (fn, ...args) =>
	JSON.parse(
		text(
			['exec', '-i', app, 'node', '--input-type=module', '-'],
			`import {createRequire} from 'node:module';
const require = createRequire('/app/packages/backend/package.json');
const result = await (${fn.toString()})(...${JSON.stringify(args)});
console.log(JSON.stringify(result));`
		)
	);
const request = (route, method = 'GET', body, token, origin = 'http://localhost:3000') =>
	inside(
		async (route, method, body, token, origin) => {
			const response = await fetch(`http://localhost:3000/api/v1/${route}`, {
				method,
				headers: {
					Origin: origin,
					...(body ? { 'Content-Type': 'application/json' } : {}),
					...(token ? { Authorization: `Bearer ${token}` } : {}),
				},
				body: body ? JSON.stringify(body) : undefined,
			});
			const content = await response.text();
			return {
				status: response.status,
				body: response.headers.get('content-type')?.includes('application/json')
					? JSON.parse(content)
					: content,
			};
		},
		route,
		method,
		body,
		token,
		origin
	);
const checkPageAndAssets = (route) =>
	inside(async (route) => {
		const assert = await import('node:assert/strict');
		const url = new URL(route, 'http://localhost:3000');
		const response = await fetch(url, { redirect: 'manual' });
		assert.equal(response.status, 200, route);
		assert.match(response.headers.get('content-type') || '', /text\/html/);
		const html = await response.text();
		assert.match(html, /<!doctype html>/i);
		const assets = [...html.matchAll(/["']([^"'<>]+\.(?:js|css)(?:\?[^"'<>]*)?)["']/g)]
			.map((match) => new URL(match[1], url))
			.filter((asset) => asset.origin === url.origin && asset.pathname.includes('/_app/'));
		for (const [extension, contentType] of [
			['.js', /(?:text|application)\/javascript/],
			['.css', /text\/css/],
		]) {
			const asset = assets.find((candidate) => candidate.pathname.endsWith(extension));
			assert.ok(asset, `${route} has no first-party emitted ${extension} asset`);
			const result = await fetch(asset);
			assert.equal(result.status, 200, asset.href);
			assert.match(result.headers.get('content-type') || '', contentType);
			assert.ok((await result.text()).trim().length > 0, asset.href);
		}
		return true;
	}, route);
const database = `${prefix}-postgres`;
const redis = `${prefix}-valkey`;
const meili = `${prefix}-meili`;
const tika = `${prefix}-tika`;
const password = randomBytes(24).toString('hex');
const encryption = randomBytes(32).toString('hex');
const credentialEncryption = randomBytes(32).toString('hex');
assert.notEqual(encryption, credentialEncryption);
const sql = (query, db = 'archive') =>
	text([
		'exec',
		database,
		'psql',
		'-U',
		'test',
		'-d',
		db,
		'-At',
		'-v',
		'ON_ERROR_STOP=1',
		'-c',
		query,
	]);
const records = (db = 'archive') =>
	JSON.parse(
		sql(
			"SELECT coalesce(json_agg(t ORDER BY t.id), '[]') FROM (SELECT id, storage_path, storage_hash_sha256, is_indexed FROM archived_emails) t",
			db
		)
	);
const appArgs = (archive, db = 'archive', user = '12345:12345') => [
	'--read-only',
	...(user ? ['--user', user] : []),
	'--cap-drop',
	'ALL',
	'--security-opt',
	'no-new-privileges',
	'--tmpfs',
	'/tmp:rw,nosuid,nodev',
	'-v',
	`${archive}:/var/data/open-archiver:nocopy`,
	...Object.entries({
		NODE_ENV: 'production',
		APP_URL: 'http://localhost:3000',
		ORIGIN: 'http://localhost:3000',
		PORT_BACKEND: '4000',
		PORT_FRONTEND: '3000',
		DATABASE_URL: `postgresql://test:${password}@${database}:5432/${db}`,
		REDIS_HOST: redis,
		REDIS_PASSWORD: password,
		REDIS_TLS_ENABLED: 'false',
		MEILI_HOST: `http://${meili}:7700`,
		MEILI_MASTER_KEY: password,
		TIKA_URL: `http://${tika}:9998`,
		STORAGE_TYPE: 'local',
		STORAGE_LOCAL_ROOT_PATH: '/var/data/open-archiver/archive',
		STORAGE_ENCRYPTION_KEY: encryption,
		ENCRYPTION_KEY: credentialEncryption,
		JWT_SECRET: password,
		JWT_EXPIRES_IN: '7d',
		BODY_SIZE_LIMIT: '10M',
		INDEXING_WORKER_MAX_OLD_SPACE_MB: '1024',
		RATE_LIMIT_MAX_REQUESTS: '1000',
	}).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
	image,
];
const ownVolume = (name, uid = 12345) =>
	text([
		'run',
		'--rm',
		'--network',
		'none',
		'--user',
		'0:0',
		'--entrypoint',
		'sh',
		'-v',
		`${name}:/data:nocopy`,
		image,
		'-c',
		`mkdir -p /data/archive && chown ${uid}:${uid} /data/archive`,
	]);
const queueState = () =>
	inside(async () => {
		const { Queue } = require('bullmq');
		const queues = ['ingestion', 'indexing'].map(
			(name) =>
				new Queue(name, {
					connection: {
						host: process.env.REDIS_HOST,
						password: process.env.REDIS_PASSWORD,
					},
				})
		);
		try {
			const counts = await Promise.all(
				queues.map((queue) => queue.getJobCounts('active', 'wait', 'prioritized', 'failed'))
			);
			const completed = await queues[1].getJobs(['completed'], 0, -1);
			return {
				drained: counts.every((count) =>
					Object.values(count).every((value) => value === 0)
				),
				reindexes: completed.filter((job) => job.name === 'reindex').length,
			};
		} finally {
			await Promise.all(queues.map((queue) => queue.close()));
		}
	});
let networkCreated = false;
try {
	text(['network', 'create', '--internal', network]);
	networkCreated = true;
	const archive = volume('archive');
	ownVolume(archive);
	start(database, [
		'-e',
		'POSTGRES_USER=test',
		'-e',
		`POSTGRES_PASSWORD=${password}`,
		'-e',
		'POSTGRES_DB=archive',
		sidecarImage('postgres'),
	]);
	start(redis, [sidecarImage('valkey'), 'valkey-server', '--requirepass', password]);
	start(meili, ['-e', `MEILI_MASTER_KEY=${password}`, sidecarImage('meilisearch')]);
	start(tika, [sidecarImage('tika')]);
	await waitFor('PostgreSQL ready', () => sql('SELECT 1') === '1');

	const migrations = [`${prefix}-migrate-a`, `${prefix}-migrate-b`];
	for (const name of migrations) {
		start(name, [...appArgs(archive), 'node', '-e', 'console.log("migration-ready")']);
	}
	await waitFor('concurrent fresh migrations', () =>
		migrations.every((name) => !inspect(name).State.Running)
	);
	for (const name of migrations)
		assert.equal(inspect(name).State.ExitCode, 0, text(['logs', name]));
	const expectedMigrations = Number(
		text([
			'run',
			'--rm',
			'--network',
			'none',
			'--read-only',
			'--entrypoint',
			'node',
			image,
			'-p',
			'JSON.parse(require("node:fs").readFileSync("/app/packages/backend/src/database/migrations/meta/_journal.json", "utf8")).entries.length',
		])
	);
	assert.ok(expectedMigrations > 0);
	assert.equal(
		Number(sql('SELECT count(*) FROM drizzle.__drizzle_migrations')),
		expectedMigrations
	);

	for (const [flag, expectedStatus, diagnostic] of [
		['false', 0, 'external-migrations-complete'],
		['true', 1, 'DATABASE_URL is not set'],
		['invalid', 1, 'RUN_MIGRATIONS must be true or false'],
		['', 1, 'RUN_MIGRATIONS must be true or false'],
	]) {
		const result = spawnSync(
			engine,
			[
				'run',
				'--rm',
				'--network',
				'none',
				'--read-only',
				'--cap-drop',
				'ALL',
				'--security-opt',
				'no-new-privileges',
				'--tmpfs',
				'/tmp:rw,nosuid,nodev',
				'-e',
				`RUN_MIGRATIONS=${flag}`,
				image,
				'node',
				'-e',
				'console.log("external-migrations-complete")',
			],
			{ encoding: 'utf8', timeout: 30000 }
		);
		if (result.error) throw result.error;
		const output = result.stdout + result.stderr;
		assert.equal(result.status, expectedStatus, output);
		assert.ok(output.includes(diagnostic), output);
		if (expectedStatus !== 0)
			assert.ok(!output.includes('external-migrations-complete'), output);
	}

	assert.equal(inspect(image).Config.User, 'node');
	const defaultArchive = volume('default-identity');
	ownVolume(defaultArchive, 1000);
	start(app, appArgs(defaultArchive, 'archive', null));
	await waitFor(
		'default UID setup endpoint',
		() => request('auth/status').body.needsSetup === true
	);
	checkPageAndAssets('/setup');
	assert.equal(
		inside(() => process.getuid()),
		1000
	);
	assert.equal(
		inside(() => process.getgid()),
		1000
	);
	assert.equal(inspect(app).HostConfig.ReadonlyRootfs, true);
	text(['stop', '--time', '30', app]);
	assert.notEqual(inspect(app).State.ExitCode, 137, 'Default UID shutdown required SIGKILL');
	text(['rm', '-v', app]);
	containers.splice(containers.indexOf(app), 1);

	start(app, appArgs(archive));
	await waitFor('fresh setup endpoint', () => request('auth/status').body.needsSetup === true);
	checkPageAndAssets('/setup');
	assert.equal(
		inside(() => process.getuid()),
		12345
	);
	assert.equal(inspect(app).HostConfig.ReadonlyRootfs, true);
	inside(async () => {
		const assert = await import('node:assert/strict');
		const { writeFile, unlink } = await import('node:fs/promises');
		await assert.rejects(
			writeFile('/app/.runtime-write-test', 'test'),
			(error) => error.code === 'EROFS' || error.code === 'EACCES'
		);
		await writeFile('/tmp/.runtime-write-test', 'test');
		await unlink('/tmp/.runtime-write-test');
		return true;
	});
	assert.equal(
		inside(async () => {
			const { stat } = await import('node:fs/promises');
			return (await stat(process.env.STORAGE_LOCAL_ROOT_PATH)).uid;
		}),
		12345
	);
	assert.equal(request('ingestion-sources').status, 401);
	const admin = {
		email: 'admin@example.invalid',
		password,
		first_name: 'Archive',
		last_name: 'Test',
	};
	const setup = request('auth/setup', 'POST', admin);
	assert.equal(setup.status, 201, JSON.stringify(setup));
	const token = setup.body.accessToken;
	assert.ok(token);
	checkPageAndAssets('/signin');
	assert.equal(request('auth/setup', 'POST', admin).status, 403);
	const role = request('iam/roles', 'POST', { name: 'No permissions', policies: [] }, token);
	assert.equal(role.status, 201, JSON.stringify(role));
	assert.equal(
		request(
			'users',
			'POST',
			{
				email: 'reader@example.invalid',
				password,
				first_name: 'No',
				last_name: 'Permissions',
				roleId: role.body.id,
			},
			token
		).status,
		201
	);
	const reader = request('auth/login', 'POST', { email: 'reader@example.invalid', password });
	assert.equal(reader.status, 200);
	assert.equal(
		request('ingestion-sources', 'GET', undefined, reader.body.accessToken).status,
		403
	);

	const eml = [
		'From: Sender <sender@example.invalid>',
		'To: Archive <archive@example.invalid>',
		'Date: Sat, 10 Oct 2026 12:00:00 +0000',
		'Message-ID: <maintenance-fixture@example.invalid>',
		'Subject: Archive maintenance orchidfixture',
		'MIME-Version: 1.0',
		'Content-Type: multipart/mixed; boundary="oa-fixture"',
		'',
		'--oa-fixture',
		'Content-Type: text/plain; charset=utf-8',
		'',
		'Synthetic archive integrity fixture.',
		'--oa-fixture',
		'Content-Type: text/plain; name="attachment.txt"',
		'Content-Disposition: attachment; filename="attachment.txt"',
		'Content-Transfer-Encoding: base64',
		'',
		Buffer.from('Attachment text quartzfixture.').toString('base64'),
		'--oa-fixture--',
		'',
	].join('\r\n');
	const upload = inside(
		async (eml, token) => {
			const archive = require('archiver')('zip');
			const chunks = [];
			const complete = new Promise((resolve, reject) => {
				archive.on('data', (chunk) => chunks.push(chunk));
				archive.on('end', resolve);
				archive.on('error', reject);
			});
			archive.append(eml, { name: 'fixture.eml' });
			await archive.finalize();
			await complete;
			const form = new FormData();
			form.append('file', new Blob(chunks, { type: 'application/zip' }), 'fixture.zip');
			const rejected = await fetch('http://localhost:3000/api/v1/upload', {
				method: 'POST',
				headers: {
					Origin: 'https://wrong.example.invalid',
					Authorization: `Bearer ${token}`,
				},
				body: form,
			});
			const response = await fetch('http://localhost:3000/api/v1/upload', {
				method: 'POST',
				headers: { Origin: 'http://localhost:3000', Authorization: `Bearer ${token}` },
				body: form,
			});
			return {
				status: response.status,
				body: await response.json(),
				wrongOriginStatus: rejected.status,
			};
		},
		eml,
		token
	);
	assert.equal(upload.status, 200, JSON.stringify(upload));
	assert.equal(upload.wrongOriginStatus, 403);
	const source = request(
		'ingestion-sources',
		'POST',
		{
			name: 'Synthetic ZIP',
			provider: 'eml_import',
			preserveOriginalFile: true,
			providerConfig: {
				type: 'eml_import',
				uploadedFilePath: upload.body.filePath,
				uploadedFileName: 'fixture.zip',
			},
		},
		token
	);
	assert.equal(source.status, 201, JSON.stringify(source));
	await waitFor('one imported indexed email', () => {
		const rows = records();
		return rows.length === 1 && rows[0].is_indexed;
	});
	const original = records();
	const email = original[0];
	assert.equal(email.storage_hash_sha256, createHash('sha256').update(eml).digest('hex'));
	const integrity = request(`integrity/${email.id}`, 'GET', undefined, token);
	assert.equal(integrity.status, 200, JSON.stringify(integrity));
	assert.equal(integrity.body.length, 1);
	assert.equal(integrity.body[0].type, 'email');
	assert.ok(integrity.body.every((item) => item.isValid));
	assert.equal(sql('SELECT count(*) FROM attachments'), '0');
	assert.equal(sql('SELECT has_attachments FROM archived_emails'), 't');
	assert.equal(
		inside(async (key) => {
			const { readFile } = await import('node:fs/promises');
			const bytes = await readFile(`${process.env.STORAGE_LOCAL_ROOT_PATH}/${key}`);
			return bytes.subarray(0, 'oa_enc_idf_v1::'.length).toString();
		}, email.storage_path),
		'oa_enc_idf_v1::'
	);
	const download = request(
		`storage/download?path=${encodeURIComponent(email.storage_path)}`,
		'GET',
		undefined,
		token
	);
	assert.equal(download.status, 200);
	assert.equal(download.body, eml);
	const attachments = inside(async (raw) => {
		const { simpleParser } = require('mailparser');
		const parsed = await simpleParser(raw);
		return parsed.attachments.map((attachment) => ({
			filename: attachment.filename,
			content: attachment.content.toString(),
		}));
	}, download.body);
	assert.deepEqual(attachments, [
		{ filename: 'attachment.txt', content: 'Attachment text quartzfixture.' },
	]);
	const search = () => request('search?keywords=orchidfixture', 'GET', undefined, token);
	await waitFor('search contains imported email', () =>
		JSON.stringify(search().body).includes(email.id)
	);
	await waitFor('attachment text is searchable', () =>
		JSON.stringify(
			request('search?keywords=quartzfixture', 'GET', undefined, token).body
		).includes(email.id)
	);
	const reindexesBefore = queueState().reindexes;
	assert.equal(
		request('ingestion-sources/reindex-all', 'POST', { mode: 'full' }, token).status,
		202
	);
	await waitFor('reindex completes', () => {
		const queues = queueState();
		return (
			queues.drained &&
			queues.reindexes > reindexesBefore &&
			records().every((row) => row.is_indexed) &&
			JSON.stringify(search().body).includes(email.id)
		);
	});
	assert.deepEqual(records(), original);

	text(['stop', '--time', '30', app]);
	assert.notEqual(inspect(app).State.ExitCode, 137, 'Shutdown required SIGKILL');
	const log = text(['logs', app]);
	assert.equal((log.match(/Ingestion worker started/g) || []).length, 1, 'Worker respawned');
	text(['start', app]);
	await waitFor('persistent restart', () => request('auth/status').body.needsSetup === false);
	assert.deepEqual(records(), original);
	await waitFor('queues drained before backup', () => queueState().drained);
	await inside(async () => {
		const { MeiliSearch } = require('meilisearch');
		const client = new MeiliSearch({
			host: process.env.MEILI_HOST,
			apiKey: process.env.MEILI_MASTER_KEY,
		});
		const task = await client.index('emails').deleteAllDocuments();
		await client.tasks.waitForTask(task.taskUid);
		return true;
	});
	const sourceBeforeBackup = request(
		`ingestion-sources/${source.body.id}`,
		'GET',
		undefined,
		token
	);
	assert.equal(sourceBeforeBackup.status, 200, JSON.stringify(sourceBeforeBackup));
	assert.equal(sourceBeforeBackup.body.id, source.body.id);
	assert.equal(sourceBeforeBackup.body.provider, 'eml_import');
	assert.equal(sourceBeforeBackup.body.preserveOriginalFile, true);
	assert.equal('credentials' in sourceBeforeBackup.body, false);
	text(['stop', '--time', '30', app]);

	const dump = run(['exec', database, 'pg_dump', '-U', 'test', '-d', 'archive', '-Fc']);
	const files = run([
		'run',
		'--rm',
		'--network',
		'none',
		'--entrypoint',
		'tar',
		'-v',
		`${archive}:/data:ro,nocopy`,
		image,
		'cf',
		'-',
		'-C',
		'/data/archive',
		'.',
	]);
	const restored = volume('restored');
	ownVolume(restored);
	run(
		[
			'run',
			'--rm',
			'-i',
			'--network',
			'none',
			'--user',
			'12345:12345',
			'--entrypoint',
			'tar',
			'-v',
			`${restored}:/data:nocopy`,
			image,
			'xf',
			'-',
			'-C',
			'/data/archive',
		],
		files
	);
	sql('CREATE DATABASE archive_restore');
	run(
		[
			'exec',
			'-i',
			database,
			'pg_restore',
			'-U',
			'test',
			'-d',
			'archive_restore',
			'--exit-on-error',
		],
		dump
	);
	text(['rm', '-v', app]);
	containers.splice(containers.indexOf(app), 1);
	text(['exec', redis, 'valkey-cli', '-a', password, 'FLUSHALL']);
	start(app, appArgs(restored, 'archive_restore'));
	await waitFor('restored setup state', () => request('auth/status').body.needsSetup === false);
	checkPageAndAssets('/signin');
	assert.equal(request('auth/login', 'POST', { email: admin.email, password }).status, 200);
	const restoredSource = request(`ingestion-sources/${source.body.id}`, 'GET', undefined, token);
	assert.equal(restoredSource.status, 200, JSON.stringify(restoredSource));
	for (const field of ['id', 'name', 'provider', 'preserveOriginalFile', 'status']) {
		assert.equal(restoredSource.body[field], sourceBeforeBackup.body[field], field);
	}
	assert.equal('credentials' in restoredSource.body, false);
	assert.equal(
		request(
			`storage/download?path=${encodeURIComponent(email.storage_path)}`,
			'GET',
			undefined,
			token
		).body,
		eml
	);
	const restoredIntegrity = request(`integrity/${email.id}`, 'GET', undefined, token);
	assert.equal(restoredIntegrity.status, 200);
	assert.equal(restoredIntegrity.body.length, 1);
	assert.ok(restoredIntegrity.body.every((item) => item.isValid));
	assert.equal(
		request('ingestion-sources/reindex-all', 'POST', { mode: 'full' }, token).status,
		202
	);
	await waitFor(
		'restored search',
		() =>
			queueState().reindexes > 0 &&
			queueState().drained &&
			JSON.stringify(search().body).includes(email.id)
	);
	assert.equal(sql('SELECT count(*) FROM archived_emails', 'archive_restore'), '1');
	assert.deepEqual(records('archive_restore'), original);
	assert.equal(sql('SELECT count(*) FROM attachments', 'archive_restore'), '0');
	const indexingPid = inside(async () => {
		const { readdir, readFile } = await import('node:fs/promises');
		for (const pid of await readdir('/proc')) {
			if (!/^\d+$/.test(pid)) continue;
			let command;
			try {
				command = (await readFile(`/proc/${pid}/cmdline`)).toString().split('\0');
			} catch (error) {
				if (error.code === 'ENOENT') continue;
				throw error;
			}
			if (
				command[0]?.endsWith('node') &&
				command.some((arg) => arg.endsWith('/workers/indexing.worker.js'))
			) {
				return Number(pid);
			}
		}
		throw new Error('Indexing worker process was not found');
	});
	text(['exec', app, 'kill', '-KILL', String(indexingPid)]);
	await waitFor('fatal worker exit terminates container', () => !inspect(app).State.Running, 30);
	assert.notEqual(inspect(app).State.ExitCode, 0);
	console.log(
		'PASS: default/arbitrary-UID read-only startup, rendered HTML/JS/CSS, setup/authz, encrypted EML ZIP/attachment, search, reindex, persistence, shutdown and paired backup/restore'
	);
} catch (error) {
	for (const name of containers) {
		console.error(`--- ${name} ---`);
		console.error(text(['logs', '--tail', '60', name]));
	}
	throw error;
} finally {
	for (const name of [...containers].reverse()) text(['rm', '-f', '-v', name]);
	for (const name of volumes) text(['volume', 'rm', name]);
	if (networkCreated) text(['network', 'rm', network]);
}
