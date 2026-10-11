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
		process.env.ENABLE_DELETION = 'true';

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
		for (const name of ['../dist/jobs/helpers/workerLiveness']) {
			provideModule(name, unavailable);
		}
		let createConnector = () => assert.fail('Unrelated provider must not run');
		provideModule('../dist/services/EmailProviderFactory', {
			EmailProviderFactory: { createConnector: (...args) => createConnector(...args) },
		});
		let queuedJobs = [];
		provideModule('../dist/jobs/queues', {
			ingestionQueue: { getJobs: async () => queuedJobs },
		});
		let confirmSearch = async () => {};
		provideModule('../dist/services/SearchService', {
			SearchService: class {
				async deleteDocuments() {
					return { taskUid: 1 };
				}
				async deleteDocumentsByFilter() {
					return { taskUid: 1 };
				}
				async waitForTask() {
					await confirmSearch();
				}
			},
		});
		const { IngestionService } = require('../dist/services/IngestionService');
		const { EMLConnector } = require('../dist/services/ingestion-connectors/EMLConnector');
		const { StorageService } = require('../dist/services/StorageService');
		const { CryptoService } = require('../dist/services/CryptoService');
		const { stripAttachmentsFromEml } = require('../dist/helpers/emlUtils');
		const { ArchivedEmailService } = require('../dist/services/ArchivedEmailService');
		const {
			withStorageLocks,
			cleanupUnreferencedObjects,
			storageLockStripes,
			STORAGE_LOCK_STRIPES,
			STORAGE_LOCK_NAMESPACE,
		} = require('../dist/services/storage/locking');
		const storage = new StorageService();
		const service = new IngestionService();
		const actor = { id: randomUUID(), email: 'actor@example.test' };
		const objectFiles = async (source) =>
			(
				await fs.readdir(
					path.join(process.env.STORAGE_LOCAL_ROOT_PATH, 'open-archiver', source.id),
					{ recursive: true }
				)
			).filter((name) => name.includes('sha256-'));
		async function waitForLockWaiters(expected) {
			const deadline = Date.now() + 5000;
			while (Date.now() < deadline) {
				const [state] = await admin`SELECT count(*)::int AS waiting FROM pg_stat_activity
					WHERE datname = ${databaseName} AND wait_event = 'advisory'`;
				if (state.waiting >= expected) return;
				await delay(10);
			}
			assert.fail(`Expected ${expected} lock waiters`);
		}
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
			'independent mailbox jobs serialize one full email and one reference',
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
					} finally {
						release();
						await Promise.allSettled([first, ...(second ? [second] : [])]);
					}
					assert.ok((await first).archivedEmailId);
					assert.ok((await second).archivedEmailId);
					assert.equal(secondWrites, 0);
					const allRows = await emails(source);
					assert.equal(allRows.length, 2);
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
					assert.equal(rootFiles.filter((file) => file.endsWith('.eml')).length, 1);
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

		await t.test(
			'repeated rollback reuses a bounded set of content objects and verifies winners',
			async () => {
				const source = await createSource();
				const raw = message('stable-objects');
				const originalPut = storage.put.bind(storage);
				storage.put = async (key, bytes, options) => {
					if (key.includes('/attachments/') && bytes.equals(contents[1])) {
						throw new Error('Synthetic repeated storage failure');
					}
					return originalPut(key, bytes, options);
				};
				let firstFiles;
				try {
					for (let attempt = 0; attempt < 3; attempt++) {
						assert.equal((await ingest(source, raw)).error, true);
						assert.equal((await emails(source)).length, 0);
						assert.equal((await attachments(source)).length, 0);
						const files = (await objectFiles(source)).sort();
						assert.equal(files.length, names.length - 1);
						if (!firstFiles) firstFiles = files;
						else assert.deepEqual(files, firstFiles);
					}
				} finally {
					storage.put = originalPut;
				}
				assert.ok((await ingest(source, raw)).archivedEmailId);
				await verifyComplete(source, raw);
				assert.equal((await objectFiles(source)).length, names.length);

				const corrupt = await createSource();
				const hash = createHash('sha256').update(contents[0]).digest('hex');
				const key = `open-archiver/${corrupt.id}/attachments/sha256-${hash}`;
				await storage.put(key, Buffer.from('wrong content'));
				const failed = await ingest(corrupt, message('wrong-winner'));
				assert.equal(failed.error, true);
				assert.match(failed.message, /does not match its storage key/);
				assert.equal((await emails(corrupt)).length, 0);
				assert.equal((await buffer(await storage.get(key))).toString(), 'wrong content');
			}
		);

		await t.test(
			'existing random attachment paths remain reusable without renaming metadata',
			async () => {
				const source = await createSource();
				const key = `open-archiver/${source.id}/attachments/legacy-report:Q4.pdf`;
				await storage.put(key, contents[0]);
				const [legacy] = await db
					.insert(schema.attachments)
					.values({
						filename: names[0],
						mimeType: 'application/octet-stream',
						sizeBytes: contents[0].length,
						contentHashSha256: createHash('sha256').update(contents[0]).digest('hex'),
						storagePath: key,
						ingestionSourceId: source.id,
					})
					.returning();
				const raw = message('legacy-record');
				assert.ok((await ingest(source, raw)).archivedEmailId);
				await verifyComplete(source, raw);
				const retained = (await attachments(source)).find((file) => file.id === legacy.id);
				assert.equal(retained.storagePath, key);
				assert.equal((await objectFiles(source)).length, names.length - 1);
			}
		);

		await t.test(
			'fixed stripes bound lock use and discovery never runs writes before all stripes are held',
			async () => {
				assert.equal(STORAGE_LOCK_STRIPES, 64);
				const keys = Array.from({ length: 2048 }, (_, i) => `tiny-attachment-${i}`);
				assert.equal(storageLockStripes(keys).length, 64);
				let discoveries = 0;
				let writes = 0;
				await withStorageLocks([keys[0]], async (tx) => {
					discoveries++;
					return {
						keys,
						run: async () => {
							writes++;
							const [state] = await tx.execute(require('drizzle-orm').sql`
						SELECT count(*)::int AS held FROM pg_locks
						WHERE pid = pg_backend_pid() AND locktype = 'advisory'
						AND classid = ${STORAGE_LOCK_NAMESPACE} AND granted`);
							assert.equal(state.held, 64);
						},
					};
				});
				assert.equal(discoveries, 2);
				assert.equal(writes, 1);
				const firstKey = keys[0];
				const secondKey = keys.find(
					(key) => storageLockStripes([key])[0] !== storageLockStripes([firstKey])[0]
				);
				let release;
				let entered;
				const paused = new Promise((resolve) => {
					release = resolve;
				});
				const active = new Promise((resolve) => {
					entered = resolve;
				});
				const held = withStorageLocks([firstKey], async () => ({
					keys: [],
					run: async () => {
						entered();
						await paused;
					},
				}));
				try {
					await active;
					let independent = false;
					await withStorageLocks([secondKey], async () => ({
						keys: [],
						run: async () => {
							independent = true;
						},
					}));
					assert.equal(independent, true);
				} finally {
					release();
					await held;
				}
			}
		);

		await t.test(
			'a message with many tiny distinct attachments holds no more than 64 protocol locks',
			async () => {
				const source = await createSource();
				const raw = Buffer.from(
					[
						'Message-ID: <many-small@example.test>',
						'Content-Type: multipart/mixed; boundary=many',
						'',
						...Array.from({ length: 160 }, (_, i) => [
							'--many',
							'Content-Type: application/octet-stream',
							`Content-Disposition: attachment; filename="${i}.bin"`,
							'Content-Transfer-Encoding: base64',
							'',
							Buffer.from(`tiny-${i}`).toString('base64'),
						]).flat(),
						'--many--',
						'',
					].join('\r\n')
				);
				const originalPut = storage.put.bind(storage);
				let observed = 0;
				storage.put = async (key, bytes, options) => {
					if (key.includes('/emails/')) {
						const [state] = await admin`SELECT count(*)::int AS held FROM pg_locks l
						JOIN pg_stat_activity a ON a.pid = l.pid WHERE a.datname = ${databaseName}
						AND l.locktype = 'advisory' AND l.classid = ${STORAGE_LOCK_NAMESPACE} AND l.granted`;
						observed = state.held;
						assert.ok(observed > 0 && observed <= 64, `Actual lock count: ${observed}`);
					}
					return originalPut(key, bytes, options);
				};
				try {
					assert.ok((await ingest(source, raw)).archivedEmailId);
					assert.equal((await attachments(source)).length, 160);
					assert.ok(observed > 0 && observed <= STORAGE_LOCK_STRIPES);
					t.diagnostic(
						`Observed ${observed} protocol locks for 160 distinct attachments (bound: ${STORAGE_LOCK_STRIPES})`
					);
				} finally {
					storage.put = originalPut;
				}
			}
		);

		await t.test(
			'compiled deletion waits for uncommitted attachment reuse and shared raw references',
			async () => {
				for (const variant of ['reference', 'reuse', 'preserve']) {
					const source = await createSource(variant === 'preserve');
					const raw = message(`delete-race-${variant}`);
					const original = await ingest(source, raw, 'old@example.test');
					const blocker = await client.reserve();
					await blocker`SELECT pg_advisory_lock(1234567, 1)`;
					await client`CREATE FUNCTION pause_new_email() RETURNS trigger LANGUAGE plpgsql AS $$
					BEGIN IF NEW.user_email = 'new@example.test' THEN
						PERFORM pg_advisory_xact_lock(1234567, 1); END IF; RETURN NEW; END $$`;
					await client`CREATE TRIGGER pause_new_email BEFORE INSERT ON archived_emails
					FOR EACH ROW EXECUTE FUNCTION pause_new_email()`;
					const incoming = ingest(
						source,
						variant === 'reuse' ? message('other-message') : raw,
						'new@example.test',
						new IngestionService()
					);
					let deleting;
					try {
						await waitForLockWaiters(1);
						deleting = ArchivedEmailService.deleteArchivedEmail(
							original.archivedEmailId,
							actor,
							'fixture'
						);
						await waitForLockWaiters(2);
					} finally {
						await blocker`SELECT pg_advisory_unlock(1234567, 1)`;
						blocker.release();
						await Promise.allSettled([incoming, ...(deleting ? [deleting] : [])]);
						await client`DROP TRIGGER pause_new_email ON archived_emails`;
						await client`DROP FUNCTION pause_new_email()`;
					}
					assert.ok((await incoming).archivedEmailId);
					await deleting;
					const remaining = await emails(source);
					assert.equal(remaining.length, 1);
					assert.equal(remaining[0].userEmail, 'new@example.test');
					const bytes = await buffer(await storage.get(remaining[0].storagePath));
					assert.equal(
						createHash('sha256').update(bytes).digest('hex'),
						remaining[0].storageHashSha256
					);
					for (const file of await attachments(source)) {
						assert.deepEqual(
							await buffer(await storage.get(file.storagePath)),
							contents[names.indexOf(file.filename)]
						);
					}
				}
			}
		);

		await t.test('a new publication waits for already-started physical cleanup', async () => {
			const source = await createSource();
			const raw = message('cleanup-before-publish');
			const original = await ingest(source, raw, 'old@example.test');
			let entered;
			let release;
			const active = new Promise((resolve) => {
				entered = resolve;
			});
			const paused = new Promise((resolve) => {
				release = resolve;
			});
			const deleteObject = StorageService.prototype.deleteObject;
			let waiting = false;
			StorageService.prototype.deleteObject = async function (key) {
				if (!waiting) {
					waiting = true;
					entered();
					await paused;
				}
				return deleteObject.call(this, key);
			};
			const deleting = ArchivedEmailService.deleteArchivedEmail(
				original.archivedEmailId,
				actor,
				'fixture'
			);
			let incoming;
			try {
				await active;
				incoming = ingest(source, raw, 'new@example.test', new IngestionService());
				await waitForLockWaiters(1);
			} finally {
				release();
				await Promise.allSettled([deleting, ...(incoming ? [incoming] : [])]);
				StorageService.prototype.deleteObject = deleteObject;
			}
			await deleting;
			assert.ok((await incoming).archivedEmailId);
			await verifyComplete(source, raw);
		});

		await t.test(
			'physical cleanup failure cannot roll back deleted rows or remove surviving references',
			async () => {
				const source = await createSource();
				const raw = message('cleanup-failure');
				const created = await ingest(source, raw);
				const rows = await emails(source);
				const files = await attachments(source);
				const originalDelete = StorageService.prototype.deleteObject;
				StorageService.prototype.deleteObject = async () => {
					throw new Error('Synthetic exact cleanup failure');
				};
				try {
					await assert.rejects(
						ArchivedEmailService.deleteArchivedEmail(
							created.archivedEmailId,
							actor,
							'fixture'
						),
						/Synthetic exact cleanup failure/
					);
					assert.equal((await emails(source)).length, 0);
					assert.equal((await attachments(source)).length, 0);
					assert.ok(await storage.exists(rows[0].storagePath));
					for (const file of files) assert.ok(await storage.exists(file.storagePath));
				} finally {
					StorageService.prototype.deleteObject = originalDelete;
				}
				assert.ok((await ingest(source, raw)).archivedEmailId);
				await cleanupUnreferencedObjects(storage, [
					rows[0].storagePath,
					...files.map((file) => file.storagePath),
				]);
				await verifyComplete(source, raw);
			}
		);

		await t.test(
			'cleanup respects Unicode fallback references across both record tables',
			async () => {
				const source = await createSource();
				await ingest(source, message('unicode-cleanup'));
				const [row] = await emails(source);
				const nfc = `open-archiver/${source.id}/caf\u00e9.eml`;
				const raw = Buffer.from('owned unicode reference');
				await storage.put(nfc, raw);
				await db.insert(schema.archivedEmails).values({
					...row,
					id: randomUUID(),
					storagePath: nfc.normalize('NFD'),
					storageHashSha256: createHash('sha256').update(raw).digest('hex'),
					sizeBytes: raw.length,
				});
				await cleanupUnreferencedObjects(storage, [nfc]);
				assert.deepEqual(await buffer(await storage.get(nfc)), raw);
				const attachmentKey = `open-archiver/${source.id}/pi\u00f1ata.bin`;
				await storage.put(attachmentKey, raw);
				await db.insert(schema.attachments).values({
					filename: 'pi\u00f1ata.bin',
					storagePath: attachmentKey.normalize('NFD'),
					sizeBytes: raw.length,
					contentHashSha256: createHash('sha256').update(raw).digest('hex'),
					ingestionSourceId: source.id,
				});
				await cleanupUnreferencedObjects(storage, [attachmentKey]);
				assert.deepEqual(await buffer(await storage.get(attachmentKey)), raw);
			}
		);

		await t.test(
			'source purge waits for active publication and rejects cached late writers',
			async () => {
				const source = await createSource();
				let entered;
				let release;
				const active = new Promise((resolve) => {
					entered = resolve;
				});
				const paused = new Promise((resolve) => {
					release = resolve;
				});
				const delayedStorage = new StorageService();
				const originalPut = delayedStorage.put.bind(delayedStorage);
				delayedStorage.put = async (key, bytes, options) => {
					await originalPut(key, bytes, options);
					if (key.includes('/emails/')) {
						entered();
						await paused;
					}
				};
				const writer = new IngestionService();
				const writing = ingest(
					source,
					message('purge-race'),
					'old@example.test',
					writer,
					delayedStorage
				);
				let purging;
				try {
					await active;
					purging = IngestionService.delete(source.id, actor, 'fixture');
					await waitForLockWaiters(1);
				} finally {
					release();
					await Promise.allSettled([writing, ...(purging ? [purging] : [])]);
				}
				assert.ok((await writing).archivedEmailId);
				await purging;
				assert.equal((await emails(source)).length, 0);
				assert.equal(await storage.exists(`open-archiver/${source.id}`), false);
				const late = await ingest(
					source,
					message('late-writer'),
					'old@example.test',
					writer
				);
				assert.equal(late.error, true);
				assert.match(late.message, /deleted or changed/);
				assert.equal(await storage.exists(`open-archiver/${source.id}`), false);
			}
		);

		await t.test(
			'source purge cancellation and cleanup failures do not erase live references',
			async () => {
				const source = await createSource();
				await ingest(source, message('purge-failure'));
				const [row] = await emails(source);
				queuedJobs = [
					{
						data: { ingestionSourceId: source.id },
						remove: async () => {
							throw new Error('Synthetic job cancellation failure');
						},
					},
				];
				try {
					await assert.rejects(
						IngestionService.delete(source.id, actor, 'fixture'),
						/cancellation failure/
					);
					assert.equal((await emails(source)).length, 1);
					assert.ok(await storage.exists(row.storagePath));
				} finally {
					queuedJobs = [];
				}
				const originalDelete = StorageService.prototype.delete;
				StorageService.prototype.delete = async () => {
					throw new Error('Synthetic prefix cleanup failure');
				};
				try {
					await assert.rejects(
						IngestionService.delete(source.id, actor, 'fixture'),
						/prefix cleanup failure/
					);
					assert.equal((await emails(source)).length, 0);
					assert.ok(await storage.exists(row.storagePath));
					assert.equal((await ingest(source, message('late-after-failure'))).error, true);
				} finally {
					StorageService.prototype.delete = originalDelete;
				}
			}
		);

		await t.test(
			'queued root and child imports remove only unused exact pending uploads',
			async () => {
				const records = [];
				const canceled = [];
				for (const [index, type] of ['eml_import', 'pst_import', 'mbox_import'].entries()) {
					const key = `open-archiver/tmp/pending-${randomUUID()}-${type}`;
					const bytes = Buffer.from(`Synthetic unconsumed upload ${type}`);
					await storage.put(key, bytes);
					await storage.put(`${key}-suffix`, Buffer.from('must survive exact cleanup'));
					const [row] = await db
						.insert(schema.ingestionSources)
						.values({
							name: `Pending ${type}`,
							provider: type,
							status: 'auth_success',
							mergedIntoId: index ? records[0].row.id : undefined,
							credentials: CryptoService.encryptObject({
								type,
								uploadedFilePath: key,
							}),
						})
						.returning();
					records.push({ row, key, bytes });
				}
				queuedJobs = records.map(({ row }) => ({
					id: `pending-${row.id}`,
					data: { ingestionSourceId: row.id },
					remove: async () => {
						const [locks] = await admin`SELECT count(*)::int AS held FROM pg_locks l
						JOIN pg_stat_activity a ON a.pid = l.pid WHERE a.datname = ${databaseName}
						AND l.locktype = 'advisory' AND l.classid = ${STORAGE_LOCK_NAMESPACE} AND l.granted`;
						assert.equal(
							locks.held,
							0,
							'Cancel queued imports before acquiring purge locks'
						);
						canceled.push(row.id);
					},
				}));
				try {
					await IngestionService.delete(records[0].row.id, actor, 'fixture');
				} finally {
					queuedJobs = [];
				}
				assert.deepEqual(canceled.sort(), records.map(({ row }) => row.id).sort());
				for (const { row, key } of records) {
					assert.equal(
						(
							await db
								.select()
								.from(schema.ingestionSources)
								.where(eq(schema.ingestionSources.id, row.id))
						).length,
						0
					);
					assert.equal(await storage.exists(key), false);
					assert.equal(await storage.exists(`${key}-suffix`), true);
				}
			}
		);

		await t.test(
			'pending upload cleanup preserves surviving source and archive metadata references',
			async () => {
				for (const referenceKind of ['source', 'email', 'attachment']) {
					const key = `open-archiver/tmp/shared-caf\u00e9-${randomUUID()}.zip`;
					const bytes = message(`shared-upload-${referenceKind}`);
					await storage.put(key, bytes);
					const [pending] = await db
						.insert(schema.ingestionSources)
						.values({
							name: 'Canceled pending import',
							provider: 'eml_import',
							credentials: CryptoService.encryptObject({
								type: 'eml_import',
								uploadedFilePath: key,
							}),
						})
						.returning();
					const survivor = await createSource();
					if (referenceKind === 'source') {
						await IngestionService.update(survivor.id, {
							providerConfig: {
								type: 'eml_import',
								uploadedFilePath: key.normalize('NFD'),
							},
						});
					} else if (referenceKind === 'attachment') {
						await db.insert(schema.attachments).values({
							filename: 'shared.zip',
							storagePath: key,
							sizeBytes: bytes.length,
							contentHashSha256: createHash('sha256').update(bytes).digest('hex'),
							ingestionSourceId: survivor.id,
						});
					} else {
						await db.insert(schema.archivedEmails).values({
							ingestionSourceId: survivor.id,
							userEmail: 'survivor@example.test',
							senderEmail: 'sender@example.test',
							sentAt: new Date(),
							storagePath: key,
							storageHashSha256: createHash('sha256').update(bytes).digest('hex'),
							sizeBytes: bytes.length,
						});
					}
					await IngestionService.delete(pending.id, actor, 'fixture');
					assert.deepEqual(await buffer(await storage.get(key)), bytes);
					if (referenceKind === 'source') {
						await IngestionService.delete(survivor.id, actor, 'fixture');
						assert.equal(await storage.exists(key), false);
					}
				}
			}
		);

		await t.test(
			'new upload metadata cannot publish a reference after pending cleanup removes the object',
			async () => {
				const key = `open-archiver/tmp/racing-${randomUUID()}.zip`;
				await storage.put(key, Buffer.from('owned pending upload'));
				const [pending] = await db
					.insert(schema.ingestionSources)
					.values({
						name: 'Pending deletion',
						provider: 'eml_import',
						credentials: CryptoService.encryptObject({
							type: 'eml_import',
							uploadedFilePath: key,
						}),
					})
					.returning();
				const survivor = await createSource();
				let entered;
				let release;
				const active = new Promise((resolve) => {
					entered = resolve;
				});
				const paused = new Promise((resolve) => {
					release = resolve;
				});
				const original = StorageService.prototype.deleteObject;
				StorageService.prototype.deleteObject = async function (path) {
					if (path === key) {
						entered();
						await paused;
					}
					return original.call(this, path);
				};
				const deleting = IngestionService.delete(pending.id, actor, 'fixture');
				let publishing;
				try {
					await active;
					publishing = IngestionService.update(survivor.id, {
						providerConfig: { type: 'eml_import', uploadedFilePath: key },
					});
					await waitForLockWaiters(1);
				} finally {
					release();
					await Promise.allSettled([deleting, ...(publishing ? [publishing] : [])]);
					StorageService.prototype.deleteObject = original;
				}
				await deleting;
				await assert.rejects(publishing, /Uploaded import file is missing/);
				assert.equal(
					(await IngestionService.findById(survivor.id)).credentials.uploadedFilePath,
					undefined
				);
				assert.equal(await storage.exists(key), false);
				await assert.rejects(
					IngestionService.create(
						{
							name: 'Too-late registration',
							provider: 'eml_import',
							providerConfig: { type: 'eml_import', uploadedFilePath: key },
						},
						actor.id,
						actor,
						'fixture'
					),
					/Uploaded import file is missing/
				);
			}
		);

		await t.test(
			'shared-upload create and replacement publish before a waiting deletion rechecks references',
			async () => {
				await db.insert(schema.users).values({ id: actor.id, email: actor.email });
				const originalTrigger = IngestionService.triggerInitialImport;
				let queued = 0;
				IngestionService.triggerInitialImport = async () => {
					queued++;
				};
				createConnector = () => ({ testConnection: async () => true });
				try {
					for (const operation of ['create', 'replace']) {
						const key = `open-archiver/tmp/registration-${randomUUID()}.zip`;
						const bytes = Buffer.from(`Pending registration ${operation}`);
						await storage.put(key, bytes);
						const [pending] = await db
							.insert(schema.ingestionSources)
							.values({
								name: 'Pending owner',
								provider: 'eml_import',
								credentials: CryptoService.encryptObject({
									type: 'eml_import',
									uploadedFilePath: key,
								}),
							})
							.returning();
						const replacing =
							operation === 'replace' ? await createSource() : undefined;
						const blocker = await client.reserve();
						await blocker`SELECT pg_advisory_lock(1234568, 1)`;
						await client`CREATE FUNCTION pause_upload_registration() RETURNS trigger LANGUAGE plpgsql AS $$
						BEGIN IF NEW.name = 'Registered contender' THEN
							PERFORM pg_advisory_xact_lock(1234568, 1); END IF; RETURN NEW; END $$`;
						await client`CREATE TRIGGER pause_upload_registration BEFORE INSERT OR UPDATE ON ingestion_sources
						FOR EACH ROW EXECUTE FUNCTION pause_upload_registration()`;
						const registration =
							operation === 'create'
								? IngestionService.create(
										{
											name: 'Registered contender',
											provider: 'eml_import',
											providerConfig: {
												type: 'eml_import',
												uploadedFilePath: key,
											},
										},
										actor.id,
										actor,
										'fixture'
									)
								: IngestionService.update(replacing.id, {
										name: 'Registered contender',
										providerConfig: {
											type: 'eml_import',
											uploadedFilePath: key,
										},
									});
						let deleting;
						try {
							await waitForLockWaiters(1);
							deleting = IngestionService.delete(pending.id, actor, 'fixture');
							await waitForLockWaiters(2);
						} finally {
							await blocker`SELECT pg_advisory_unlock(1234568, 1)`;
							blocker.release();
							await Promise.allSettled([
								registration,
								...(deleting ? [deleting] : []),
							]);
							await client`DROP TRIGGER pause_upload_registration ON ingestion_sources`;
							await client`DROP FUNCTION pause_upload_registration()`;
						}
						const survivor = await registration;
						await deleting;
						assert.equal(survivor.credentials.uploadedFilePath, key);
						assert.deepEqual(await buffer(await storage.get(key)), bytes);
					}
					assert.equal(queued, 1);
				} finally {
					IngestionService.triggerInitialImport = originalTrigger;
					createConnector = () => assert.fail('Unrelated provider must not run');
				}
			}
		);

		await t.test(
			'ordinary edits preserve consumed paths but stale reference reselection is checked against locked metadata',
			async () => {
				const consumed = `open-archiver/tmp/consumed-${randomUUID()}.zip`;
				const available = `open-archiver/tmp/available-${randomUUID()}.zip`;
				const [row] = await db
					.insert(schema.ingestionSources)
					.values({
						name: 'Consumed upload',
						provider: 'eml_import',
						credentials: CryptoService.encryptObject({
							type: 'eml_import',
							uploadedFilePath: consumed,
						}),
					})
					.returning();
				await IngestionService.update(row.id, { name: 'Ordinary edit' });
				assert.equal(
					(await IngestionService.findById(row.id)).credentials.uploadedFilePath,
					consumed
				);
				await storage.put(available, Buffer.from('new pending bytes'));
				const originalFind = IngestionService.findById;
				let entered;
				let release;
				const active = new Promise((resolve) => {
					entered = resolve;
				});
				const paused = new Promise((resolve) => {
					release = resolve;
				});
				let first = true;
				IngestionService.findById = async function (id) {
					const result = await originalFind.call(this, id);
					if (id === row.id && first) {
						first = false;
						entered();
						await paused;
					}
					return result;
				};
				const stale = IngestionService.update(row.id, {
					providerConfig: { type: 'eml_import', uploadedFilePath: consumed },
				});
				try {
					await active;
					await IngestionService.update(row.id, {
						providerConfig: { type: 'eml_import', uploadedFilePath: available },
					});
				} finally {
					release();
					await Promise.allSettled([stale]);
					IngestionService.findById = originalFind;
				}
				await assert.rejects(stale, /Uploaded import file is missing/);
				assert.equal(
					(await IngestionService.findById(row.id)).credentials.uploadedFilePath,
					available
				);
			}
		);

		await t.test(
			'a source prefix remains intact while another pending import references bytes within it',
			async () => {
				const source = await createSource();
				const key = `open-archiver/${source.id}/pending.zip`;
				await storage.put(key, Buffer.from('owned unconsumed upload'));
				await IngestionService.update(source.id, {
					providerConfig: { type: 'eml_import', uploadedFilePath: key },
				});
				const survivor = await createSource();
				await IngestionService.update(survivor.id, {
					providerConfig: { type: 'eml_import', uploadedFilePath: key },
				});
				await IngestionService.delete(source.id, actor, 'fixture');
				assert.equal(
					(await buffer(await storage.get(key))).toString(),
					'owned unconsumed upload'
				);
				await IngestionService.delete(survivor.id, actor, 'fixture');
				assert.equal(await storage.exists(key), false);
			}
		);

		await t.test(
			'source purge preserves externally referenced raw files and fails safely for shared attachment ownership',
			async () => {
				const source = await createSource(true);
				await ingest(source, message('raw-owner'));
				const [row] = await emails(source);
				const outside = await createSource(true);
				await db.insert(schema.archivedEmails).values({
					...row,
					id: randomUUID(),
					ingestionSourceId: outside.id,
					userEmail: 'outside@example.test',
				});
				await IngestionService.delete(source.id, actor, 'fixture');
				assert.equal((await emails(source)).length, 0);
				assert.ok(await storage.exists(row.storagePath));
				const bytes = await buffer(await storage.get(row.storagePath));
				assert.equal(
					createHash('sha256').update(bytes).digest('hex'),
					row.storageHashSha256
				);

				const owned = await createSource();
				await ingest(owned, message('attachment-owner'));
				const [carrier] = await emails(owned);
				const [file] = await attachments(owned);
				const externalId = randomUUID();
				await db.insert(schema.archivedEmails).values({
					...carrier,
					id: externalId,
					ingestionSourceId: outside.id,
					userEmail: 'external@example.test',
				});
				await db
					.insert(schema.emailAttachments)
					.values({ emailId: externalId, attachmentId: file.id });
				await assert.rejects(
					IngestionService.delete(owned.id, actor, 'fixture'),
					/still referenced/
				);
				assert.equal((await emails(owned)).length, 1);
				assert.ok(await storage.exists(file.storagePath));
				confirmSearch = async () => {
					throw new Error('Synthetic search failure');
				};
				try {
					await assert.rejects(
						IngestionService.delete(outside.id, actor, 'fixture'),
						/Synthetic search failure/
					);
					assert.ok(await storage.exists(row.storagePath));
					assert.equal((await emails(outside)).length, 2);
				} finally {
					confirmSearch = async () => {};
				}
			}
		);
	}
);
