const assert = require('node:assert/strict');
const { before, after, describe, it } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { Readable } = require('node:stream');
const { buffer } = require('node:stream/consumers');
const { createHash } = require('node:crypto');
const { createRequire, wrap } = require('node:module');
const { runInThisContext, runInNewContext } = require('node:vm');
const archiver = require('archiver');
const { simpleParser } = require('mailparser');
const { assertSafeRelativePath } = require('../dist/helpers/relativePath');
const { LocalFileSystemProvider } = require('../dist/services/storage/LocalFileSystemProvider');

const binary = Buffer.from([0, 255, 128, 13, 10, 65]);
const raw = Buffer.from(
	[
		'From: sender@example.test',
		'To: recipient@example.test',
		'Message-ID: <contained@example.test>',
		'Subject: Synthetic application fixture',
		'MIME-Version: 1.0',
		'Content-Type: multipart/mixed; boundary=fixture',
		'',
		'--fixture',
		'Content-Type: text/plain',
		'',
		'Synthetic body.',
		'--fixture',
		'Content-Type: application/octet-stream',
		'Content-Disposition: attachment; filename=fixture.bin',
		'Content-Transfer-Encoding: base64',
		'',
		binary.toString('base64'),
		'--fixture--',
		'',
	].join('\r\n')
);
const unsafePaths = [
	'',
	'.',
	'..',
	'../sentinel.eml',
	'open-archiver/source/emails/../../other-source/file.eml',
	'/absolute.eml',
	'//server/share/file.eml',
	'C:/absolute.eml',
	'C:relative.eml',
	'\\\\server\\share\\file.eml',
	'safe\\..\\file.eml',
	'safe/./file.eml',
	'safe/../file.eml',
	'safe//file.eml',
	'bad\0name.eml',
];
const literalPaths = ['report:Q4.pdf', 'trailing.', 'trailing ', 'safe/.. /file.eml'];
const unsafeError = { name: 'UnsafePathError' };
let fixture;
let root;
let provider;
let storage;
let EMLConnector;
let uploadFile;

async function makeZip(name) {
	const archive = archiver('zip');
	const result = buffer(archive);
	const placeholder = 'x'.repeat(Buffer.byteLength(name));
	archive.append(raw, { name: placeholder });
	const [bytes] = await Promise.all([result, archive.finalize()]);
	// archiver sanitizes paths; patch only our tiny fixture's two filename fields.
	let replacements = 0;
	for (let index = bytes.indexOf(placeholder); index >= 0; index = bytes.indexOf(placeholder)) {
		Buffer.from(name).copy(bytes, index);
		replacements++;
	}
	assert.equal(replacements, 2);
	return bytes;
}

async function assertOperationsReject(key) {
	for (const operation of [
		() => provider.put(key, raw),
		() => provider.put(key, raw, { overwrite: false }),
		() => provider.get(key),
		() => provider.exists(key),
		() => provider.delete(key),
	]) {
		await assert.rejects(operation(), unsafeError, key);
	}
}

async function upload(zip, filename = 'fixture.zip') {
	const body = Buffer.concat([
		Buffer.from(
			`--upload\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
				'Content-Type: application/zip\r\n\r\n'
		),
		zip,
		Buffer.from('\r\n--upload--\r\n'),
	]);
	const request = Readable.from([body]);
	request.headers = {
		'content-type': 'multipart/form-data; boundary=upload',
		'content-length': String(body.length),
	};
	return new Promise((resolve, reject) => {
		const response = {
			statusCode: 200,
			status(code) {
				this.statusCode = code;
				return this;
			},
			json(value) {
				if (this.statusCode !== 200) reject(new Error(JSON.stringify(value)));
				else resolve(value.filePath);
			},
		};
		uploadFile(request, response).catch(reject);
	});
}

async function loadIngestionBoundary() {
	const filename = require.resolve('../dist/services/IngestionService');
	const localRequire = createRequire(filename);
	const errors = [];
	let reads = 0;
	const imports = {
		'../helpers/relativePath': localRequire('../helpers/relativePath'),
		'../helpers/emailAddress': localRequire('../helpers/emailAddress'),
		'../config/logger': { logger: { error: (error) => errors.push(error) } },
		'../database/schema': { archivedEmails: { userEmail: 'user_email' } },
		'drizzle-orm': localRequire('drizzle-orm'),
		'./AuditService': { AuditService: class {} },
		'fs/promises': {
			unlink: fs.unlink,
			readFile: async () => {
				reads++;
				throw new Error('Unexpected ingestion file read');
			},
		},
	};
	// Execute the unmodified compiled class, with eager infrastructure imports inert.
	// Any later DB/queue/service access fails: this tests only the early rejection boundary.
	const unavailable = new Proxy(
		{},
		{ get: () => assert.fail('Unexpected infrastructure access') }
	);
	const module = { exports: {} };
	runInThisContext(wrap(await fs.readFile(filename, 'utf8')), { filename })(
		module.exports,
		(name) => imports[name] ?? unavailable,
		module,
		filename,
		path.dirname(filename)
	);
	return { service: new module.exports.IngestionService(), errors, reads: () => reads };
}

describe('compiled application archive boundaries', { timeout: 15000 }, () => {
	before(async () => {
		fixture = await fs.mkdtemp(path.join(tmpdir(), 'oa-containment-'));
		root = path.join(fixture, 'archive');
		await fs.mkdir(root);
		process.env.STORAGE_TYPE = 'local';
		process.env.STORAGE_LOCAL_ROOT_PATH = root;
		process.env.STORAGE_ENCRYPTION_KEY = 'ab'.repeat(32);
		process.env.LOG_LEVEL = 'silent';
		({ EMLConnector } = require('../dist/services/ingestion-connectors/EMLConnector'));
		({ uploadFile } = require('../dist/api/controllers/upload.controller'));
		const { StorageService } = require('../dist/services/StorageService');
		storage = new StorageService();
		provider = new LocalFileSystemProvider({ type: 'local', rootPath: root });
	});

	after(async () => {
		if (fixture) await fs.rm(fixture, { recursive: true, force: true });
	});

	it('rejects unsafe relative paths before source namespace composition', () => {
		for (const value of unsafePaths) {
			assert.throws(() => assertSafeRelativePath(value), unsafeError, value);
		}
		for (const value of ['inbox', 'inbox/nested/', 'caf\u00e9/mail.eml', '.folder/mail.eml']) {
			assert.doesNotThrow(() => assertSafeRelativePath(value));
		}
	});

	it('guards every local operation without touching an owned outside sentinel', async () => {
		const sentinel = path.join(fixture, 'sentinel.eml');
		await fs.writeFile(sentinel, 'owned sentinel');
		for (const key of unsafePaths) await assertOperationsReject(key);
		assert.equal(await fs.readFile(sentinel, 'utf8'), 'owned sentinel');
		assert.deepEqual(await fs.readdir(root), []);
	});

	it('preserves literal POSIX names for existing keys and new uploads', async () => {
		for (const name of literalPaths) {
			const key = `legacy/${name}`;
			await fs.mkdir(path.dirname(path.join(root, key)), { recursive: true });
			await fs.writeFile(path.join(root, key), raw);
			assert.equal(await provider.exists(key), true);
			assert.deepEqual(await buffer(await provider.get(key)), raw);
			await assert.rejects(provider.put(key, raw, { overwrite: false }), {
				name: 'StorageObjectExistsError',
			});
			await provider.put(key, raw);
			await provider.delete(key);
			assert.equal(await provider.exists(key), false);
		}
		const zip = await makeZip('reports:Q4/trailing. /message.eml');
		for (const filename of ['report:Q4.zip', 'archive.zip.', 'archive.zip ']) {
			const key = await upload(zip, filename);
			assert.ok(key.endsWith(`-${filename}`));
			assert.deepEqual(await buffer(await storage.get(key)), zip);
			await storage.delete(key);
		}
	});

	it('still rejects Windows stream, device and normalized path aliases on Windows', async () => {
		const filename = require.resolve('../dist/helpers/relativePath');
		const module = { exports: {} };
		runInNewContext(wrap(await fs.readFile(filename, 'utf8')), {
			process: { platform: 'win32' },
		})(
			module.exports,
			() => assert.fail('Unexpected import'),
			module,
			filename,
			path.dirname(filename)
		);
		const validate = module.exports.assertSafeRelativePath;
		const deviceAliases = ['\u00b9', '\u00b2', '\u00b3'].flatMap((suffix) =>
			['COM', 'lpt'].flatMap((prefix) => [
				`safe/${prefix}${suffix}`,
				`safe/${prefix}${suffix}.txt`,
				`safe/${prefix}${suffix}.tar.gz`,
			])
		);
		for (const value of [
			...unsafePaths,
			...literalPaths,
			'safe/NUL.txt',
			'safe/COM1',
			...deviceAliases,
		]) {
			assert.throws(() => validate(value), unsafeError, value);
		}
		assert.doesNotThrow(() => validate('inbox/caf\u00e9/message.eml'));
		assert.doesNotThrow(() => validate('inbox/COM10.txt'));
		for (const value of deviceAliases) {
			assert.doesNotThrow(() => assertSafeRelativePath(value));
		}
	});

	it('rejects ingestion traversal before reading mail or reaching database and cleans the temp file', async () => {
		const boundary = await loadIngestionBoundary();
		for (const unsafe of unsafePaths.filter(Boolean)) {
			const tempFilePath = path.join(fixture, 'rejected-message.eml');
			await fs.writeFile(tempFilePath, raw);
			const result = await boundary.service.processEmail(
				{ id: 'synthetic', path: unsafe, tempFilePath },
				{ id: 'source' },
				storage,
				'synthetic@example.test'
			);
			assert.equal(result.error, true);
			assert.match(result.message, /safe relative path/);
			assert.equal(boundary.errors.at(-1).error.name, 'UnsafePathError');
			await assert.rejects(fs.access(tempFilePath), { code: 'ENOENT' });
		}
		assert.equal(boundary.reads(), 0);
		for (const valid of [undefined, '', 'inbox/caf\u00e9/']) {
			const tempFilePath = path.join(fixture, 'valid-path-message.eml');
			await fs.writeFile(tempFilePath, raw);
			const result = await boundary.service.processEmail(
				{ id: 'synthetic', path: valid, tempFilePath },
				{ id: 'source' },
				storage,
				'synthetic@example.test'
			);
			assert.match(result.message, /Unexpected ingestion file read/);
			await assert.rejects(fs.access(tempFilePath), { code: 'ENOENT' });
		}
		assert.equal(boundary.reads(), 3);
	});

	it('rejects directory, file, dangling and cross-source symlink components', async () => {
		const outside = path.join(fixture, 'outside');
		await fs.mkdir(outside);
		await fs.writeFile(path.join(outside, 'sentinel.eml'), 'owned sentinel');
		await fs.mkdir(path.join(root, 'other-source'));
		await fs.writeFile(path.join(root, 'other-source', 'sentinel.eml'), 'other source');
		await fs.symlink(outside, path.join(root, 'directory-link'), 'dir');
		await fs.symlink(path.join(outside, 'sentinel.eml'), path.join(root, 'file-link'));
		await fs.symlink(path.join(outside, 'missing'), path.join(root, 'dangling-link'));
		await fs.symlink(path.join(root, 'other-source'), path.join(root, 'source-link'), 'dir');
		for (const key of [
			'directory-link/sentinel.eml',
			'directory-link/new/created.eml',
			'file-link',
			'dangling-link',
			'source-link/sentinel.eml',
		]) {
			await assertOperationsReject(key);
		}
		assert.equal(
			await fs.readFile(path.join(outside, 'sentinel.eml'), 'utf8'),
			'owned sentinel'
		);
		assert.equal(
			await fs.readFile(path.join(root, 'other-source', 'sentinel.eml'), 'utf8'),
			'other source'
		);
		assert.deepEqual(await fs.readdir(outside), ['sentinel.eml']);
	});

	it('preserves exact Unicode writes and NFC/NFD get, exists and delete fallback', async () => {
		const nfc = 'unicode/caf\u00e9/message.eml';
		const nfd = nfc.normalize('NFD');
		await provider.put(nfd, Readable.from([raw]));
		assert.deepEqual(await fs.readFile(path.join(root, nfd)), raw);
		assert.equal(await provider.exists(nfc), true);
		assert.deepEqual(await buffer(await provider.get(nfc)), raw);
		await provider.delete(nfc);
		assert.equal(await provider.exists(nfd), false);
		await provider.put(nfc, raw);
		assert.deepEqual(await fs.readFile(path.join(root, nfc)), raw);
		await provider.delete(nfc);
		await provider.delete('unicode/not-present.eml');
	});

	it('applies symlink rejection to Unicode fallback candidates too', async () => {
		const outside = path.join(fixture, 'unicode-outside');
		await fs.mkdir(outside);
		await fs.writeFile(path.join(outside, 'sentinel.eml'), 'unicode sentinel');
		await fs.symlink(outside, path.join(root, 'caf\u00e9'.normalize('NFD')), 'dir');
		for (const operation of [
			() => provider.get('caf\u00e9/sentinel.eml'),
			() => provider.exists('caf\u00e9/sentinel.eml'),
			() => provider.delete('caf\u00e9/sentinel.eml'),
		]) {
			await assert.rejects(operation(), unsafeError);
		}
		assert.equal(
			await fs.readFile(path.join(outside, 'sentinel.eml'), 'utf8'),
			'unicode sentinel'
		);
	});

	it('keeps conditional writes atomic, refuses retries and cleans failed stream staging', async () => {
		const key = 'atomic/message.eml';
		const candidates = Array.from({ length: 6 }, (_, index) => Buffer.alloc(4096, index));
		const outcomes = await Promise.allSettled(
			candidates.map((content) => provider.put(key, content, { overwrite: false }))
		);
		assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
		for (const result of outcomes.filter((result) => result.status === 'rejected')) {
			assert.equal(result.reason.name, 'StorageObjectExistsError');
		}
		const winner = outcomes.findIndex((result) => result.status === 'fulfilled');
		assert.deepEqual(await buffer(await provider.get(key)), candidates[winner]);
		await assert.rejects(provider.put(key, raw, { overwrite: false }), {
			name: 'StorageObjectExistsError',
		});
		const failure = new Error('synthetic input failure');
		const stream = Readable.from(
			(async function* () {
				yield raw;
				throw failure;
			})()
		);
		await assert.rejects(
			provider.put('atomic/failed.eml', stream, { overwrite: false }),
			failure
		);
		assert.deepEqual(await fs.readdir(path.join(root, 'atomic')), ['message.eml']);
	});

	it('rejects unsafe raw ZIP names in the actual EML connector before yielding mail', async () => {
		const names = [
			'../../../../outside/message.eml',
			'../other-source/message.eml',
			'inbox/../message.eml',
			'inbox/./message.eml',
			'/absolute/message.eml',
			'C:/absolute/message.eml',
			'C:relative.eml',
			'inbox\\..\\message.eml',
			'\\\\server\\share\\message.eml',
			'__MACOSX/../../message.eml',
			'../',
		];
		const archivePath = path.join(fixture, 'unsafe.zip');
		for (const name of names) {
			await fs.writeFile(archivePath, await makeZip(name));
			const connector = new EMLConnector({ localFilePath: archivePath });
			await assert.rejects(async () => {
				for await (const email of connector.fetchEmails('synthetic@example.test')) {
					if (email) await fs.rm(email.tempFilePath, { force: true });
					assert.fail(`Unsafe entry yielded mail: ${name}`);
				}
			}, unsafeError);
		}
		assert.equal(
			await fs.readFile(path.join(fixture, 'sentinel.eml'), 'utf8'),
			'owned sentinel'
		);
	});

	it('uploads encrypted ZIPs through the controller and retrieves original MIME via EMLConnector', async () => {
		const zip = await makeZip('inbox/caf\u00e9/message.eml');
		for (const preserveOriginalFile of [false, true]) {
			const uploadedFilePath = await upload(zip);
			assert.ok(uploadedFilePath.startsWith('open-archiver/tmp/'));
			assert.notDeepEqual(await fs.readFile(path.join(root, uploadedFilePath)), zip);
			assert.deepEqual(await buffer(await storage.get(uploadedFilePath)), zip);
			const connector = new EMLConnector({ uploadedFilePath }, { preserveOriginalFile });
			let count = 0;
			for await (const email of connector.fetchEmails('synthetic@example.test')) {
				assert.ok(email);
				try {
					count++;
					assert.equal(email.path, 'inbox/caf\u00e9');
					assert.equal(email.id, '<contained@example.test>');
					assert.equal(email.subject, 'Synthetic application fixture');
					assert.equal(email.attachments.length, 1);
					assert.deepEqual(
						email.attachments[0].content,
						preserveOriginalFile ? Buffer.alloc(0) : binary
					);
					const retrieved = await fs.readFile(email.tempFilePath);
					assert.deepEqual(retrieved, raw);
					assert.equal(
						createHash('sha256').update(retrieved).digest('hex'),
						createHash('sha256').update(raw).digest('hex')
					);
					assert.deepEqual(
						(await simpleParser(retrieved)).attachments[0].content,
						binary
					);
				} finally {
					await fs.rm(email.tempFilePath, { force: true });
				}
			}
			assert.equal(count, 1);
			assert.equal(await storage.exists(uploadedFilePath), false);
		}
	});
});
