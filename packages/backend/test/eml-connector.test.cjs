const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createWriteStream } = require('node:fs');
const { cp, mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { pipeline } = require('node:stream/promises');
const { buffer } = require('node:stream/consumers');
const { test } = require('node:test');
const archiver = require('archiver');

const attachment = Buffer.from('Synthetic attachment.\n');
const message = Buffer.from(
	[
		'From: Fixture Sender <sender@example.invalid>',
		'To: Fixture Recipient <recipient@example.invalid>',
		'Date: Sat, 10 Oct 2026 12:00:00 +0000',
		'Message-ID: <fixture@example.invalid>',
		'Subject: Native dependency EML fixture',
		'MIME-Version: 1.0',
		'Content-Type: multipart/mixed; boundary="oa-fixture"',
		'',
		'--oa-fixture',
		'Content-Type: text/plain; charset=utf-8',
		'',
		'Synthetic message body.',
		'--oa-fixture',
		'Content-Type: text/plain; name="fixture.txt"',
		'Content-Disposition: attachment; filename="fixture.txt"',
		'Content-Transfer-Encoding: base64',
		'',
		attachment.toString('base64'),
		'--oa-fixture--',
		'',
	].join('\r\n')
);

function sha256(bytes) {
	return createHash('sha256').update(bytes).digest('hex');
}

test('real EML ZIP import preserves raw bytes and restores encrypted local objects', async (t) => {
	const root = await mkdtemp(join(tmpdir(), 'oa-eml-native-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const storageRoot = join(root, 'storage');
	const encryptionKey = '12'.repeat(32);

	// Configure only synthetic local storage before loading the compiled application's config.
	const environment = {
		NODE_ENV: 'test',
		DOTENV_CONFIG_PATH: join(root, 'no-dotenv-file'),
		STORAGE_TYPE: 'local',
		STORAGE_LOCAL_ROOT_PATH: storageRoot,
		STORAGE_ENCRYPTION_KEY: encryptionKey,
		LOG_LEVEL: 'error',
	};
	const previous = Object.fromEntries(
		Object.keys(environment).map((key) => [key, process.env[key]])
	);
	Object.assign(process.env, environment);
	t.after(() => {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
	const { EMLConnector } = require('../dist/services/ingestion-connectors/EMLConnector.js');
	const { StorageService } = require('../dist/services/StorageService.js');
	const storage = new StorageService();
	const zipPath = join(root, 'fixture.zip');
	const zip = archiver('zip');
	const writing = pipeline(zip, createWriteStream(zipPath));
	zip.on('warning', (error) => zip.destroy(error));
	zip.append(message, { name: 'Inbox/message.eml' });
	zip.append(message, { name: '__MACOSX/ignored.eml' });
	zip.append('Not an email', { name: 'Inbox/ignored.txt' });
	await Promise.all([writing, zip.finalize()]);

	for (const preserveOriginalFile of [false, true]) {
		await t.test(`preserveOriginalFile=${preserveOriginalFile}`, async (t) => {
			const uploadPath = `uploads/fixture-${preserveOriginalFile}.zip`;
			await storage.put(uploadPath, await readFile(zipPath));
			const connector = new EMLConnector(
				{ uploadedFilePath: uploadPath, uploadedFileName: 'Synthetic Fixture.zip' },
				{ preserveOriginalFile }
			);
			assert.equal(await connector.testConnection(), true);
			const users = [];
			for await (const user of connector.listAllUsers()) users.push(user);
			assert.equal(users.length, 1);
			const emails = [];
			for await (const email of connector.fetchEmails(users[0].primaryEmail)) {
				assert.ok(email);
				if (email.tempFilePath) {
					t.after(() => rm(email.tempFilePath, { force: true }));
				}
				emails.push(email);
			}
			assert.equal(emails.length, 1);
			assert.equal(await storage.exists(uploadPath), false);
			assert.deepEqual(connector.getUpdatedSyncState(), {});
			const [email] = emails;
			assert.equal(email.id, '<fixture@example.invalid>');
			assert.equal(email.threadId, '<fixture@example.invalid>');
			assert.equal(email.subject, 'Native dependency EML fixture');
			assert.equal(email.path, 'Inbox');
			assert.equal(email.from[0].address, 'sender@example.invalid');
			assert.equal(email.to[0].address, 'recipient@example.invalid');
			assert.equal(email.receivedAt.toISOString(), '2026-10-10T12:00:00.000Z');
			assert.match(email.body, /Synthetic message body\./);
			assert.equal(email.attachments.length, 1);
			assert.equal(email.attachments[0].filename, 'fixture.txt');
			assert.equal(email.attachments[0].size, attachment.length);
			assert.deepEqual(
				email.attachments[0].content,
				preserveOriginalFile ? Buffer.alloc(0) : attachment
			);
			assert.ok(email.tempFilePath);
			const raw = await readFile(email.tempFilePath);
			assert.deepEqual(raw, message);
			const objectPath = `archive/${preserveOriginalFile}/message.eml`;
			await storage.put(objectPath, raw, { overwrite: false });
			assert.notDeepEqual(await readFile(join(storageRoot, objectPath)), message);
			assert.equal(sha256(await buffer(await storage.get(objectPath))), sha256(message));
		});
	}

	const backupRoot = join(root, 'backup');
	const restoredRoot = join(root, 'restored');
	await cp(storageRoot, backupRoot, { recursive: true });
	await rm(storageRoot, { recursive: true });
	await cp(backupRoot, restoredRoot, { recursive: true });
	const restored = new StorageService({
		type: 'local',
		rootPath: restoredRoot,
		openArchiverFolderName: 'open-archiver',
		encryptionKey,
	});
	for (const preserveOriginalFile of [false, true]) {
		const restoredRaw = await buffer(
			await restored.get(`archive/${preserveOriginalFile}/message.eml`)
		);
		assert.deepEqual(restoredRaw, message);
		assert.equal(sha256(restoredRaw), sha256(message));
	}
});
