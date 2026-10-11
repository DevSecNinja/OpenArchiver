const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { buffer } = require('node:stream/consumers');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const postgres = require('postgres');
const { drizzle } = require('drizzle-orm/postgres-js');
const { migrate } = require('drizzle-orm/postgres-js/migrator');
const { eq } = require('drizzle-orm');
const archiver = require('archiver');
const { simpleParser } = require('mailparser');
const schema = require('../dist/database/schema');

const databaseUrl = process.env.STORAGE_AUTH_TEST_DATABASE_URL;
if (process.env.CI) {
	assert.ok(databaseUrl, 'CI must configure STORAGE_AUTH_TEST_DATABASE_URL');
}
const names = ['first.txt', 'report:Q4.pdf', 'trailing.', 'trailing '];
const contents = names.map((name, index) => Buffer.from(`Synthetic attachment ${index}: ${name}`));
function message(id) {
	return Buffer.from(
		[
			'From: sender@example.test',
			'To: recipient@example.test',
			`Message-ID: <${id}@example.test>`,
			'Date: Sat, 10 Oct 2026 12:00:00 +0000',
			'Subject: filename compatibility',
			'MIME-Version: 1.0',
			'Content-Type: multipart/mixed; boundary=fixture',
			'',
			'--fixture',
			'Content-Type: multipart/alternative; boundary=body',
			'',
			'--body',
			'Content-Type: text/plain',
			'',
			'Synthetic message.',
			'--body',
			'Content-Type: text/html',
			'',
			'<p>Synthetic message.</p>',
			'--body--',
			...names.flatMap((name, index) => [
				'--fixture',
				'Content-Type: application/octet-stream',
				`Content-Disposition: attachment; filename="${name}"`,
				'Content-Transfer-Encoding: base64',
				'',
				contents[index].toString('base64'),
			]),
			'--fixture--',
			'',
		].join('\r\n')
	);
}

test(
	'compiled ingestion publishes complete attachment links with real PostgreSQL',
	{
		skip: databaseUrl ? false : 'Set STORAGE_AUTH_TEST_DATABASE_URL to run PostgreSQL coverage',
		timeout: 60_000,
	},
	async (t) => {
		const url = new URL(databaseUrl);
		assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
		assert.equal(url.pathname, '/postgres');
		const databaseName = `oa_ingestion_test_${randomUUID().replaceAll('-', '')}`;
		const admin = postgres(url.toString(), { max: 1, connect_timeout: 5 });
		const fixture = await fs.mkdtemp(path.join(tmpdir(), 'oa-attachments-'));
		let client;
		let created = false;
		const restoreModules = [];
		t.after(async () => {
			for (const restore of restoreModules.reverse()) restore();
			try {
				if (client) await client.end({ timeout: 5 });
				if (created) await admin`DROP DATABASE ${admin(databaseName)}`;
			} finally {
				await admin.end({ timeout: 5 });
				await fs.rm(fixture, { recursive: true, force: true });
			}
		});
		await admin`CREATE DATABASE ${admin(databaseName)}`;
		created = true;
		url.pathname = `/${databaseName}`;
		client = postgres(url.toString(), { max: 3, connect_timeout: 5 });
		const db = drizzle(client, { schema });
		await migrate(db, { migrationsFolder: path.join(__dirname, '../src/database/migrations') });
		process.env.STORAGE_TYPE = 'local';
		process.env.STORAGE_LOCAL_ROOT_PATH = path.join(fixture, 'archive');
		process.env.STORAGE_ENCRYPTION_KEY = 'ab'.repeat(32);
		process.env.ENCRYPTION_KEY = 'cd'.repeat(32);
		process.env.LOG_LEVEL = 'silent';

		function provideModule(modulePath, exports) {
			const filename = require.resolve(modulePath);
			const previous = require.cache[filename];
			const replacement = new Module(filename, module);
			replacement.filename = filename;
			replacement.loaded = true;
			replacement.exports = exports;
			require.cache[filename] = replacement;
			restoreModules.push(() => {
				if (previous) require.cache[filename] = previous;
				else delete require.cache[filename];
			});
		}
		const databaseModule = { db };
		provideModule('../dist/database/index.js', databaseModule);
		const unavailable = new Proxy(
			{},
			{ get: () => assert.fail('Unrelated queue/provider orchestration must not run') }
		);
		for (const name of [
			'../dist/jobs/queues',
			'../dist/services/EmailProviderFactory',
			'../dist/services/SearchService',
			'../dist/jobs/helpers/workerLiveness',
		]) {
			provideModule(name, unavailable);
		}
		const { IngestionService } = require('../dist/services/IngestionService');
		const { EMLConnector } = require('../dist/services/ingestion-connectors/EMLConnector');
		const { StorageService } = require('../dist/services/StorageService');
		const { CryptoService } = require('../dist/services/CryptoService');
		const { stripAttachmentsFromEml } = require('../dist/helpers/emlUtils');
		const storage = new StorageService();
		const service = new IngestionService();
		const createSource = async (preserveOriginalFile = false, mergedIntoId) => {
			const [source] = await db
				.insert(schema.ingestionSources)
				.values({
					name: 'Synthetic retry',
					provider: 'eml_import',
					preserveOriginalFile,
					mergedIntoId,
					credentials: CryptoService.encryptObject({ type: 'eml_import' }),
				})
				.returning();
			return source;
		};
		async function ingest(
			source,
			raw,
			mailbox = 'fixture@example.test',
			ingestionService = service,
			storageService = storage,
			providerId
		) {
			const zip = archiver('zip');
			const result = buffer(zip);
			const name = 'reports:Q4/trailing. /message.eml';
			const placeholder = 'x'.repeat(Buffer.byteLength(name));
			zip.append(raw, { name: placeholder });
			const [bytes] = await Promise.all([result, zip.finalize()]);
			let replacements = 0;
			for (
				let index = bytes.indexOf(placeholder);
				index >= 0;
				index = bytes.indexOf(placeholder)
			) {
				Buffer.from(name).copy(bytes, index);
				replacements++;
			}
			assert.equal(replacements, 2);
			const zipPath = path.join(fixture, `${randomUUID()}.zip`);
			await fs.writeFile(zipPath, bytes);
			const connector = new EMLConnector(
				{ localFilePath: zipPath },
				{ preserveOriginalFile: source.preserveOriginalFile }
			);
			const results = [];
			for await (const email of connector.fetchEmails(mailbox)) {
				if (providerId) email.id = providerId;
				results.push(
					await ingestionService.processEmail(email, source, storageService, mailbox)
				);
			}
			await fs.rm(zipPath);
			assert.equal(results.length, 1);
			return results[0];
		}
		const emails = (source) =>
			db
				.select()
				.from(schema.archivedEmails)
				.where(eq(schema.archivedEmails.ingestionSourceId, source.id));
		const attachments = (source) =>
			db
				.select()
				.from(schema.attachments)
				.where(eq(schema.attachments.ingestionSourceId, source.id));
		async function verifyComplete(source, raw) {
			const rows = await emails(source);
			assert.equal(rows.length, 1);
			assert.equal(rows[0].path, 'reports:Q4/trailing. ');
			const stored = await buffer(await storage.get(rows[0].storagePath));
			assert.equal(
				createHash('sha256').update(stored).digest('hex'),
				rows[0].storageHashSha256
			);
			assert.equal(stored.length, rows[0].sizeBytes);
			const parsed = await simpleParser(stored);
			const files = await attachments(source);
			if (source.preserveOriginalFile) {
				assert.deepEqual(stored, raw);
				assert.deepEqual(
					parsed.attachments.map((file) => file.filename),
					names
				);
				assert.deepEqual(
					parsed.attachments.map((file) => file.content),
					contents
				);
				assert.equal(files.length, 0);
			} else {
				assert.equal(parsed.attachments.length, 0);
				assert.equal(files.length, names.length);
				for (const file of files) {
					assert.ok(names.includes(file.filename));
					assert.deepEqual(
						await buffer(await storage.get(file.storagePath)),
						contents[names.indexOf(file.filename)]
					);
				}
				const links = await db
					.select()
					.from(schema.emailAttachments)
					.where(eq(schema.emailAttachments.emailId, rows[0].id));
				assert.equal(links.length, names.length);
			}
		}

		await t.test(
			'retains original filenames and bytes in both preservation modes on retry',
			async () => {
				for (const preserve of [false, true]) {
					const source = await createSource(preserve);
					const raw = message(`names:mode-${preserve}`);
					assert.ok((await ingest(source, raw)).archivedEmailId);
					await verifyComplete(source, raw);
					assert.equal(await ingest(source, raw), null);
					await verifyComplete(source, raw);
				}
			}
		);

		await t.test(
			'an attachment write failure does not publish an incomplete email',
			async () => {
				const source = await createSource();
				const raw = message('storage-failure');
				const originalPut = storage.put.bind(storage);
				storage.put = async (key, bytes, options) => {
					if (key.includes('/attachments/') && bytes.equals(contents[1])) {
						throw new Error('Synthetic temporary attachment failure');
					}
					return originalPut(key, bytes, options);
				};
				try {
					const failed = await ingest(source, raw);
					assert.equal(failed.error, true);
					assert.match(failed.message, /Synthetic temporary attachment failure/);
					assert.equal((await emails(source)).length, 0);
					assert.equal((await attachments(source)).length, 0);
				} finally {
					storage.put = originalPut;
				}
				const emailPrefix = `open-archiver/${source.id}/emails`;
				const emailFiles = (
					await fs.readdir(path.join(process.env.STORAGE_LOCAL_ROOT_PATH, emailPrefix), {
						recursive: true,
					})
				).filter((file) => file.endsWith('.eml'));
				assert.equal(emailFiles.length, 1);
				const publishedKey = `${emailPrefix}/${emailFiles[0]}`;
				const published = await buffer(await storage.get(publishedKey));
				const ciphertext = await fs.readFile(
					path.join(process.env.STORAGE_LOCAL_ROOT_PATH, publishedKey)
				);
				assert.notDeepEqual(await stripAttachmentsFromEml(raw), published);
				assert.ok((await ingest(source, raw)).archivedEmailId);
				await verifyComplete(source, raw);
				assert.deepEqual(await buffer(await storage.get(publishedKey)), published);
				assert.deepEqual(
					await fs.readFile(path.join(process.env.STORAGE_LOCAL_ROOT_PATH, publishedKey)),
					ciphertext
				);
				assert.equal(await ingest(source, raw), null);
				await verifyComplete(source, raw);
			}
		);

		await t.test(
			'link insertion failure rolls back the email row so retry can complete',
			async () => {
				const source = await createSource();
				const raw = message('link-failure');
				await client`CREATE FUNCTION reject_fixture_link() RETURNS trigger LANGUAGE plpgsql
				AS $$ BEGIN RAISE EXCEPTION 'synthetic attachment link failure'; END $$`;
				await client`CREATE TRIGGER reject_fixture_link BEFORE INSERT ON email_attachments
				FOR EACH ROW EXECUTE FUNCTION reject_fixture_link()`;
				try {
					assert.equal((await ingest(source, raw)).error, true);
					assert.equal((await emails(source)).length, 0);
					assert.equal((await attachments(source)).length, 0);
				} finally {
					await client`DROP TRIGGER reject_fixture_link ON email_attachments`;
					await client`DROP FUNCTION reject_fixture_link()`;
				}
				assert.ok((await ingest(source, raw)).archivedEmailId);
				await verifyComplete(source, raw);
			}
		);

		await t.test('shared-reference link failure rolls back the new mailbox row', async () => {
			const source = await createSource();
			const raw = message('shared-link-failure');
			const full = await ingest(source, raw, 'first@example.test');
			assert.ok(full.archivedEmailId);
			const initial = await emails(source);
			const files = await attachments(source);
			const referenceService = new IngestionService();
			await client`CREATE FUNCTION reject_reference_link() RETURNS trigger LANGUAGE plpgsql
				AS $$ BEGIN RAISE EXCEPTION 'synthetic reference link failure'; END $$`;
			await client`CREATE TRIGGER reject_reference_link BEFORE INSERT ON email_attachments
				FOR EACH ROW EXECUTE FUNCTION reject_reference_link()`;
			try {
				const failed = await ingest(source, raw, 'second@example.test', referenceService);
				assert.equal(failed.error, true);
				assert.deepEqual(await emails(source), initial);
				assert.deepEqual(await attachments(source), files);
			} finally {
				await client`DROP TRIGGER reject_reference_link ON email_attachments`;
				await client`DROP FUNCTION reject_reference_link()`;
			}
			const reference = await ingest(source, raw, 'second@example.test', referenceService);
			assert.ok(reference.archivedEmailId);
			const rows = await emails(source);
			assert.equal(rows.length, 2);
			assert.equal(new Set(rows.map((row) => row.storagePath)).size, 1);
			for (const row of rows) {
				const links = await db
					.select()
					.from(schema.emailAttachments)
					.where(eq(schema.emailAttachments.emailId, row.id));
				assert.deepEqual(
					links.map((link) => link.attachmentId).sort(),
					files.map((file) => file.id).sort()
				);
				const bytes = await buffer(await storage.get(row.storagePath));
				assert.equal(
					createHash('sha256').update(bytes).digest('hex'),
					row.storageHashSha256
				);
			}
			assert.equal(
				await ingest(source, raw, ' SECOND@example.test ', new IngestionService()),
				null
			);
		});

		await t.test(
			'independent mailbox jobs serialize one full email and one reference without blocking unrelated keys',
			async () => {
				for (const preserve of [false, true]) {
					const source = await createSource(preserve);
					const child = await createSource(preserve, source.id);
					const raw = message(`concurrent-${preserve}`);
					let release;
					const paused = new Promise((resolve) => {
						release = resolve;
					});
					let started;
					const writing = new Promise((resolve) => {
						started = resolve;
					});
					const firstStorage = new StorageService();
					const originalPut = firstStorage.put.bind(firstStorage);
					firstStorage.put = async (key, bytes, options) => {
						await originalPut(key, bytes, options);
						if (key.includes('/emails/')) {
							started();
							await paused;
						}
					};
					const secondStorage = new StorageService();
					let secondWrites = 0;
					secondStorage.put = async () => {
						secondWrites++;
						assert.fail('Shared reference must not store content');
					};
					const first = ingest(
						source,
						raw,
						'first@example.test',
						new IngestionService(),
						firstStorage
					);
					let second;
					try {
						await writing;
						second = ingest(
							child,
							raw,
							'second@example.test',
							new IngestionService(),
							secondStorage
						);
						const deadline = Date.now() + 5000;
						let blocked = false;
						while (Date.now() < deadline) {
							const [state] =
								await admin`SELECT count(*)::int AS waiting FROM pg_stat_activity
							WHERE datname = ${databaseName} AND wait_event = 'advisory'`;
							if (state.waiting > 0) {
								blocked = true;
								break;
							}
							await delay(10);
						}
						assert.equal(blocked, true, 'Second job must wait on the PostgreSQL lock');
						assert.equal(
							(await emails(source)).length,
							0,
							'No partial row is published'
						);
						const unrelated = Buffer.from(
							`Message-ID: <independent-${preserve}@example.test>\r\nSubject: independent\r\n\r\nOther message.`
						);
						assert.ok(
							(
								await ingest(
									source,
									unrelated,
									'third@example.test',
									new IngestionService()
								)
							).archivedEmailId
						);
						const independentSource = await createSource(preserve);
						assert.ok(
							(
								await ingest(
									independentSource,
									raw,
									'first@example.test',
									new IngestionService()
								)
							).archivedEmailId
						);
					} finally {
						release();
						await Promise.allSettled([first, ...(second ? [second] : [])]);
					}
					assert.ok((await first).archivedEmailId);
					assert.ok((await second).archivedEmailId);
					assert.equal(secondWrites, 0);
					const allRows = await emails(source);
					assert.equal(allRows.length, 3);
					const pair = allRows.filter((row) => row.userEmail !== 'third@example.test');
					assert.equal(new Set(pair.map((row) => row.storagePath)).size, 1);
					const files = await attachments(source);
					assert.equal(files.length, preserve ? 0 : names.length);
					for (const row of pair) {
						const bytes = await buffer(await storage.get(row.storagePath));
						assert.equal(
							createHash('sha256').update(bytes).digest('hex'),
							row.storageHashSha256
						);
						assert.equal(bytes.length, row.sizeBytes);
						if (preserve) assert.deepEqual(bytes, raw);
						const links = await db
							.select()
							.from(schema.emailAttachments)
							.where(eq(schema.emailAttachments.emailId, row.id));
						assert.deepEqual(
							links.map((link) => link.attachmentId).sort(),
							files.map((file) => file.id).sort()
						);
					}
					const rootFiles = await fs.readdir(
						path.join(process.env.STORAGE_LOCAL_ROOT_PATH, 'open-archiver', source.id),
						{ recursive: true }
					);
					assert.equal(rootFiles.filter((file) => file.endsWith('.eml')).length, 2);
					assert.equal(
						await ingest(source, raw, 'first@example.test', new IngestionService()),
						null
					);
				}
			}
		);

		await t.test(
			'headerless preserve-mode byte deduplication spans different provider IDs and mailboxes',
			async () => {
				const source = await createSource(true);
				const raw = message('unused')
					.toString()
					.replace(/^Message-ID:.*\r\n/m, '');
				const results = await Promise.all(
					['one', 'two', 'three'].map((id, index) =>
						ingest(
							source,
							Buffer.from(raw),
							index < 2 ? 'same@example.test' : 'other@example.test',
							new IngestionService(),
							new StorageService(),
							id
						)
					)
				);
				assert.equal(results.filter((result) => result === null).length, 1);
				assert.equal(results.filter((result) => result?.archivedEmailId).length, 2);
				const rows = await emails(source);
				assert.equal(rows.length, 2);
				assert.equal(new Set(rows.map((row) => row.storagePath)).size, 1);
				assert.equal((await attachments(source)).length, 0);
				for (const row of rows) {
					const bytes = await buffer(await storage.get(row.storagePath));
					assert.deepEqual(bytes, Buffer.from(raw));
					assert.equal(
						createHash('sha256').update(bytes).digest('hex'),
						row.storageHashSha256
					);
					assert.equal(bytes.length, row.sizeBytes);
				}
			}
		);

		await t.test(
			'one-connection pools do not re-enter the pool during full/reference publication',
			{ timeout: 10_000 },
			async () => {
				const source = await createSource();
				const raw = message('single-connection');
				const single = postgres(url.toString(), { max: 1, connect_timeout: 5 });
				databaseModule.db = drizzle(single, { schema });
				try {
					assert.ok(
						(await ingest(source, raw, 'first@example.test', new IngestionService()))
							.archivedEmailId
					);
					assert.ok(
						(await ingest(source, raw, 'second@example.test', new IngestionService()))
							.archivedEmailId
					);
					assert.equal(
						await ingest(source, raw, 'second@example.test', new IngestionService()),
						null
					);
					assert.equal((await emails(source)).length, 2);
					assert.equal((await attachments(source)).length, names.length);
				} finally {
					databaseModule.db = db;
					await single.end({ timeout: 5 });
				}
			}
		);
	}
);
