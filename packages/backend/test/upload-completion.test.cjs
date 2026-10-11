const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { tmpdir } = require('node:os');
const Module = require('node:module');
const { buffer } = require('node:stream/consumers');
const { test } = require('node:test');
const { once } = require('node:events');
const postgres = require('postgres');
const { drizzle } = require('drizzle-orm/postgres-js');
const { migrate } = require('drizzle-orm/postgres-js/migrator');
const { eq } = require('drizzle-orm');
const archiver = require('archiver');
const schema = require('../dist/database/schema');

const databaseUrl = process.env.STORAGE_AUTH_TEST_DATABASE_URL;
if (process.env.CI) assert.ok(databaseUrl, 'CI must configure STORAGE_AUTH_TEST_DATABASE_URL');
const raw = Buffer.from(
	'From: sender@example.test\r\nTo: reader@example.test\r\n' +
		'Message-ID: <receipt@example.test>\r\nSubject: Canonical completion\r\n\r\nSynthetic message.\r\n'
);

test(
	'upload completion requires durable canonical mailbox and input proof',
	{
		skip: databaseUrl ? false : 'Set STORAGE_AUTH_TEST_DATABASE_URL to run PostgreSQL coverage',
		timeout: 180_000,
	},
	async (t) => {
		const url = new URL(databaseUrl);
		assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
		assert.equal(url.pathname, '/postgres');
		const dbName = `oa_upload_test_${randomUUID().replaceAll('-', '')}`;
		const admin = postgres(url.toString(), { max: 1, connect_timeout: 5 });
		const fixture = await fs.mkdtemp(path.join(tmpdir(), 'oa-upload-receipt-'));
		let created = false;
		let client;
		const restores = [];
		t.after(async () => {
			for (const restore of restores.reverse()) restore();
			try {
				if (client) await client.end({ timeout: 5 });
				if (created) await admin`DROP DATABASE ${admin(dbName)}`;
			} finally {
				await admin.end({ timeout: 5 });
				await fs.rm(fixture, { recursive: true, force: true });
			}
		});
		await admin`CREATE DATABASE ${admin(dbName)}`;
		created = true;
		url.pathname = `/${dbName}`;
		client = postgres(url.toString(), { max: 3, connect_timeout: 5 });
		const db = drizzle(client, { schema });
		await migrate(db, { migrationsFolder: path.join(__dirname, '../src/database/migrations') });
		process.env.STORAGE_TYPE = 'local';
		process.env.STORAGE_LOCAL_ROOT_PATH = path.join(fixture, 'archive');
		process.env.STORAGE_ENCRYPTION_KEY = 'ba'.repeat(32);
		process.env.ENCRYPTION_KEY = 'dc'.repeat(32);
		process.env.LOG_LEVEL = 'silent';
		process.env.ENABLE_DELETION = 'true';
		function provide(modulePath, exports) {
			const filename = require.resolve(modulePath);
			const previous = require.cache[filename];
			const replacement = new Module(filename, module);
			replacement.filename = filename;
			replacement.loaded = true;
			replacement.exports = exports;
			require.cache[filename] = replacement;
			restores.push(() => {
				if (previous) require.cache[filename] = previous;
				else delete require.cache[filename];
			});
		}
		provide('../dist/database', { db });
		const queued = [];
		provide('../dist/jobs/queues', {
			ingestionQueue: {
				add: async (name, data, opts) => {
					queued.push({ name, data, opts });
				},
				addBulk: async (jobs) => {
					queued.push(...jobs);
				},
				getJobs: async () => [],
			},
			indexingQueue: { add: async () => {} },
		});
		let makeConnector = () => assert.fail('Unexpected provider call');
		provide('../dist/services/EmailProviderFactory', {
			EmailProviderFactory: { createConnector: (source) => makeConnector(source) },
		});
		let confirmSearch = async () => {};
		provide('../dist/services/SearchService', {
			SearchService: class {
				async deleteDocumentsByFilter() {
					return { taskUid: 1 };
				}
				async waitForTask() {
					await confirmSearch();
				}
			},
		});
		provide('../dist/jobs/helpers/workerLiveness', {});
		provide('../dist/services/ingestion-connectors/MicrosoftConnector', {
			isMailboxUnavailableError: () => false,
		});
		const { IngestionService } = require('../dist/services/IngestionService');
		const { SyncSessionService } = require('../dist/services/SyncSessionService');
		const { StorageService } = require('../dist/services/StorageService');
		const { CryptoService } = require('../dist/services/CryptoService');
		const { EMLConnector } = require('../dist/services/ingestion-connectors/EMLConnector');
		const { MboxConnector } = require('../dist/services/ingestion-connectors/MboxConnector');
		const { PSTConnector } = require('../dist/services/ingestion-connectors/PSTConnector');
		const {
			processMailboxProcessor,
		} = require('../dist/jobs/processors/process-mailbox.processor');
		const finish = require('../dist/jobs/processors/sync-cycle-finished.processor').default;
		const initialImport = require('../dist/jobs/processors/initial-import.processor').default;
		const continuousSync = require('../dist/jobs/processors/continuous-sync.processor').default;
		const { ingestionQueue } = require('../dist/jobs/queues');
		const { JobsService } = require('../dist/services/JobsService');
		const storage = new StorageService();
		const storageLocks = require('../dist/services/storage/locking');
		const sourceRow = async (id) =>
			(
				await db
					.select()
					.from(schema.ingestionSources)
					.where(eq(schema.ingestionSources.id, id))
			)[0];
		const sessionRow = async (id) =>
			(await db.select().from(schema.syncSessions).where(eq(schema.syncSessions.id, id)))[0];
		async function sourceFor(inputPath, provider = 'eml_import', extras = {}) {
			const [source] = await db
				.insert(schema.ingestionSources)
				.values({
					name: 'Synthetic upload',
					provider,
					status: 'importing',
					credentials: CryptoService.encryptObject({
						type: provider,
						uploadedFilePath: inputPath,
						uploadedFileName: 'original-name.zip',
						...extras,
					}),
				})
				.returning();
			return source;
		}
		async function setup(
			mailboxes = ['a@example.test', 'b@example.test'],
			provider = 'eml_import',
			bytes = raw
		) {
			const inputPath = `open-archiver/tmp/${randomUUID()}.zip`;
			await storage.put(inputPath, bytes);
			const source = await sourceFor(inputPath, provider);
			const sessionId = await SyncSessionService.create(source.id, mailboxes.length, true, {
				inputPath,
				expectedMailboxes: mailboxes,
			});
			return { source, sessionId, inputPath };
		}
		const identity = (ctx, mailbox) => ({
			sourceId: ctx.source.id,
			inputPath: ctx.inputPath,
			mailbox,
		});
		const success = (ctx, mailbox) =>
			SyncSessionService.recordMailboxResult(ctx.sessionId, {}, identity(ctx, mailbox));
		const finishSession = (ctx) =>
			finish({
				data: {
					ingestionSourceId: ctx.source.id,
					sessionId: ctx.sessionId,
					isInitialImport: true,
				},
			});
		const worker = (ctx, mailbox) =>
			processMailboxProcessor({
				data: {
					ingestionSourceId: ctx.source.id,
					sessionId: ctx.sessionId,
					userEmail: mailbox,
					uploadInputPath: ctx.inputPath,
				},
			});
		async function zipBytes(broken = false) {
			const zip = archiver('zip');
			const result = buffer(zip);
			zip.append(raw, { name: 'valid.eml' });
			if (broken) zip.append(raw, { name: 'broken.eml' });
			const [bytes] = await Promise.all([result, zip.finalize()]);
			if (broken) {
				const signature = Buffer.from('504b0102', 'hex');
				const first = bytes.indexOf(signature);
				const second = bytes.indexOf(signature, first + 4);
				assert.ok(second > first && first > 0);
				assert.equal(bytes.toString('utf8', second + 46, second + 56), 'broken.eml');
				bytes.writeUInt32LE(raw.length + 1, second + 24);
			}
			return bytes;
		}
		async function pauseBeforePathLocks(inputPath, operation, concurrent) {
			const original = storageLocks.withStorageLocks;
			let entered;
			let release;
			const read = new Promise((resolve) => {
				entered = resolve;
			});
			const paused = new Promise((resolve) => {
				release = resolve;
			});
			let first = true;
			storageLocks.withStorageLocks = async (keys, ...args) => {
				if (first && keys.includes(storageLocks.storagePathLockKey(inputPath))) {
					first = false;
					entered();
					await paused;
				}
				return original(keys, ...args);
			};
			const pending = operation();
			try {
				await read;
				await concurrent();
			} finally {
				release();
				await Promise.allSettled([pending]);
				storageLocks.withStorageLocks = original;
			}
			return pending;
		}

		if (process.env.UPLOAD_QUEUE_TEST_HOST) {
			const { Queue, Worker } = require('bullmq');
			const connection = {
				host: process.env.UPLOAD_QUEUE_TEST_HOST,
				port: 6379,
				password: process.env.UPLOAD_QUEUE_TEST_PASSWORD,
			};
			const queueName = `upload-proof-${randomUUID()}`;
			const queue = new Queue(queueName, {
				connection,
				defaultJobOptions: {
					attempts: 1,
					removeOnComplete: { count: 1000 },
					removeOnFail: { count: 5000 },
				},
			});
			const originalQueue = { ...ingestionQueue };
			Object.assign(ingestionQueue, {
				add: queue.add.bind(queue),
				getJobs: queue.getJobs.bind(queue),
				getJob: queue.getJob.bind(queue),
			});
			try {
				await queue.waitUntilReady();
				for (const failure of ['search', 'database', 'reference']) {
					await t.test(
						`real queued auth_success import survives ${failure} purge refusal`,
						async () => {
							const inputPath = `open-archiver/tmp/${randomUUID()}.zip`;
							await storage.put(inputPath, raw);
							const source = await sourceFor(inputPath);
							await db
								.update(schema.ingestionSources)
								.set({ status: 'auth_success' })
								.where(eq(schema.ingestionSources.id, source.id));
							const job = await queue.add('initial-import', {
								ingestionSourceId: source.id,
							});
							let outside;
							if (failure === 'reference') {
								outside = await sourceFor(inputPath);
								const [attachment] = await db
									.insert(schema.attachments)
									.values({
										ingestionSourceId: source.id,
										filename: 'referenced.bin',
										storagePath: inputPath,
										contentHashSha256: '0'.repeat(64),
										sizeBytes: raw.length,
									})
									.returning();
								const [carrier] = await db
									.insert(schema.archivedEmails)
									.values({
										ingestionSourceId: outside.id,
										senderEmail: 'sender@example.test',
										userEmail: 'reader@example.test',
										sentAt: new Date(),
										storagePath: inputPath,
										storageHashSha256: '0'.repeat(64),
										sizeBytes: raw.length,
									})
									.returning();
								await db
									.insert(schema.emailAttachments)
									.values({ emailId: carrier.id, attachmentId: attachment.id });
							}
							if (failure === 'search')
								confirmSearch = async () => {
									throw new Error('Synthetic purge search failure');
								};
							if (failure === 'database') {
								await client`CREATE FUNCTION reject_source_delete() RETURNS trigger LANGUAGE plpgsql AS $$
							BEGIN RAISE EXCEPTION 'Synthetic purge database failure'; END $$`;
								await client`CREATE TRIGGER reject_source_delete BEFORE DELETE ON ingestion_sources
							FOR EACH ROW EXECUTE FUNCTION reject_source_delete()`;
							}
							try {
								await assert.rejects(
									IngestionService.delete(
										source.id,
										{ id: randomUUID() },
										'fixture'
									)
								);
								assert.equal((await sourceRow(source.id)).status, 'auth_success');
								assert.ok(
									await queue.getJob(job.id),
									'Failed purge must preserve queued initial import'
								);
								assert.deepEqual(await buffer(await storage.get(inputPath)), raw);
							} finally {
								confirmSearch = async () => {};
								if (failure === 'database') {
									await client`DROP TRIGGER reject_source_delete ON ingestion_sources`;
									await client`DROP FUNCTION reject_source_delete()`;
								}
								if (outside)
									await db
										.delete(schema.ingestionSources)
										.where(eq(schema.ingestionSources.id, outside.id));
								await IngestionService.delete(
									source.id,
									{ id: randomUUID() },
									'fixture'
								);
							}
							assert.equal(await queue.getJob(job.id), undefined);
							assert.equal(await storage.exists(inputPath), false);
							await initialImport(job);
							assert.equal(await sourceRow(source.id), undefined);
						}
					);
				}
				for (const failure of ['cleanup', 'mark', 'terminal-failure', 'mailbox-error']) {
					await t.test(
						`real keyed finalizer can reuse its ID after ${failure}`,
						async () => {
							const ctx = await setup(
								['a@example.test'],
								'eml_import',
								await zipBytes()
							);
							makeConnector = (source) => {
								const connector = new EMLConnector(source.credentials);
								if (failure === 'mailbox-error')
									connector.fetchEmails = async function* () {
										throw new Error('Synthetic mailbox read failure');
									};
								return connector;
							};
							const originalDelete = StorageService.prototype.deleteObject;
							let queueWorker;
							let failWorker = ['terminal-failure', 'mailbox-error'].includes(
								failure
							);
							if (failure === 'cleanup')
								StorageService.prototype.deleteObject = async function (key) {
									if (key === ctx.inputPath)
										throw new Error('Synthetic queue cleanup failure');
									return originalDelete.call(this, key);
								};
							if (failure === 'mark') {
								await client`CREATE FUNCTION reject_queue_mark() RETURNS trigger LANGUAGE plpgsql AS $$
							BEGIN IF NEW.upload_receipt->>'disposition' = 'handled' THEN
								RAISE EXCEPTION 'Synthetic queue receipt mark failure'; END IF; RETURN NEW; END $$`;
								await client`CREATE TRIGGER reject_queue_mark BEFORE UPDATE ON sync_sessions
							FOR EACH ROW EXECUTE FUNCTION reject_queue_mark()`;
							}
							try {
								queueWorker = new Worker(
									queueName,
									async (job) => {
										if (failWorker)
											throw new Error('Synthetic terminal finalizer failure');
										await finish(job);
									},
									{ connection }
								);
								await queueWorker.waitUntilReady();
								const terminal = once(
									queueWorker,
									failWorker ? 'failed' : 'completed',
									{
										signal: AbortSignal.timeout(15_000),
									}
								);
								await worker(ctx, 'a@example.test');
								await terminal;
								const jobId = `upload-finished-${ctx.sessionId}`;
								assert.ok(await sessionRow(ctx.sessionId));
								assert.equal(
									Boolean(await queue.getJob(jobId)),
									false,
									'Terminal job must not suppress same-ID retry'
								);
								StorageService.prototype.deleteObject = originalDelete;
								if (failure === 'mark') {
									await client`DROP TRIGGER reject_queue_mark ON sync_sessions`;
									await client`DROP FUNCTION reject_queue_mark()`;
								}
								failWorker = false;
								await db
									.update(schema.syncSessions)
									.set({ lastActivityAt: new Date(0) })
									.where(eq(schema.syncSessions.id, ctx.sessionId));
								const retried = once(queueWorker, 'completed', {
									signal: AbortSignal.timeout(15_000),
								});
								await SyncSessionService.cleanStaleSessions(1000);
								await retried;
								assert.equal(await sessionRow(ctx.sessionId), undefined);
								assert.equal(Boolean(await queue.getJob(jobId)), false);
								assert.equal(
									await storage.exists(ctx.inputPath),
									failure === 'mailbox-error'
								);
							} finally {
								StorageService.prototype.deleteObject = originalDelete;
								if (queueWorker) await queueWorker.close();
								if (failure === 'mark') {
									await client`DROP TRIGGER IF EXISTS reject_queue_mark ON sync_sessions`;
									await client`DROP FUNCTION IF EXISTS reject_queue_mark()`;
								}
								await queue.obliterate({ force: true });
								await db
									.delete(schema.ingestionSources)
									.where(eq(schema.ingestionSources.id, ctx.source.id));
							}
						}
					);
				}
			} finally {
				Object.assign(ingestionQueue, originalQueue);
				delete ingestionQueue.getJob;
				await queue.obliterate({ force: true });
				await queue.close();
			}
		}

		await t.test(
			'A twice cannot complete [A,B], unknown mailbox/input cannot advance, and the last success releases',
			async () => {
				const ctx = await setup([' A@example.test ', 'b@example.test']);
				const duplicates = await Promise.all([
					success(ctx, 'a@example.test'),
					success(ctx, ' A@EXAMPLE.TEST '),
				]);
				assert.ok(
					duplicates.every((result) => !result.isLast && result.totalCompleted === 1)
				);
				for (const bad of [
					identity(ctx, 'unknown@example.test'),
					{ ...identity(ctx, 'b@example.test'), inputPath: 'wrong-input.zip' },
					{ ...identity(ctx, 'b@example.test'), sourceId: randomUUID() },
				]) {
					await assert.rejects(
						SyncSessionService.recordMailboxResult(ctx.sessionId, {}, bad),
						/identity/
					);
				}
				assert.equal((await sessionRow(ctx.sessionId)).completedMailboxes, 1);
				await finishSession(ctx);
				assert.ok(await sessionRow(ctx.sessionId));
				assert.equal(await IngestionService.releaseCompletedUpload(ctx.sessionId), false);
				assert.ok(await storage.exists(ctx.inputPath));
				assert.equal((await success(ctx, 'b@example.test')).isLast, true);
				// A redundant failure is harmless only now, after all canonical successes were established.
				const duplicate = await SyncSessionService.recordMailboxResult(
					ctx.sessionId,
					{
						error: true,
						message: 'redundant stalled attempt',
					},
					identity(ctx, 'a@example.test')
				);
				assert.equal(duplicate.totalFailed, 0);
				await finishSession(ctx);
				assert.equal(await sessionRow(ctx.sessionId), undefined);
				const credentials = (await IngestionService.findById(ctx.source.id)).credentials;
				assert.equal(credentials.uploadedFilePath, undefined);
				assert.equal(credentials.uploadedFileName, 'original-name.zip');
				assert.equal(await storage.exists(ctx.inputPath), false);
				await IngestionService.update(ctx.source.id, { name: 'Renamed consumed source' });
				const newPath = `open-archiver/tmp/${randomUUID()}.zip`;
				await storage.put(newPath, raw);
				await IngestionService.update(ctx.source.id, {
					providerConfig: { type: 'eml_import', uploadedFilePath: newPath },
				});
				assert.equal(
					(await IngestionService.findById(ctx.source.id)).credentials.uploadedFilePath,
					newPath
				);
			}
		);

		await t.test(
			'non-upload provider sessions keep their existing completion behavior',
			async () => {
				const [source] = await db
					.insert(schema.ingestionSources)
					.values({
						name: 'Synthetic remote source',
						provider: 'generic_imap',
						credentials: CryptoService.encryptObject({
							type: 'generic_imap',
							username: 'synthetic',
						}),
					})
					.returning();
				const sessionId = await SyncSessionService.create(source.id, 1, false);
				assert.equal(
					(await SyncSessionService.recordMailboxResult(sessionId, {})).isLast,
					true
				);
				assert.deepEqual(await SyncSessionService.completionState(sessionId), {
					upload: false,
					complete: true,
				});
				assert.equal(await IngestionService.releaseCompletedUpload(sessionId), false);
				await SyncSessionService.finalize(sessionId);
			}
		);
		await t.test(
			'failure, skip, cancellation and incomplete legacy proof retain input even with inflated counters',
			async () => {
				for (const outcome of ['failure', 'skip', 'cancel']) {
					const ctx = await setup();
					await success(ctx, 'a@example.test');
					if (outcome !== 'cancel') {
						await SyncSessionService.recordMailboxResult(
							ctx.sessionId,
							outcome === 'skip'
								? { skipped: true, message: 'skipped' }
								: { error: true, message: 'failed' },
							identity(ctx, 'a@example.test')
						);
						await success(ctx, 'a@example.test');
						await success(ctx, 'b@example.test');
					}
					assert.equal(
						await IngestionService.releaseCompletedUpload(ctx.sessionId),
						false
					);
					await finishSession(ctx);
					assert.ok(await storage.exists(ctx.inputPath));
					assert.equal(
						(await IngestionService.findById(ctx.source.id)).credentials
							.uploadedFilePath,
						ctx.inputPath
					);
				}
				for (const malformed of [null, {}, { version: 1, discoveryClosed: false }]) {
					const ctx = await setup();
					await db
						.update(schema.syncSessions)
						.set({
							uploadReceipt: malformed,
							completedMailboxes: 999,
							failedMailboxes: 0,
							lastActivityAt: new Date(0),
						})
						.where(eq(schema.syncSessions.id, ctx.sessionId));
					const queuedBeforeSweep = queued.length;
					await SyncSessionService.cleanStaleSessions(1000);
					assert.equal(
						queued.length,
						queuedBeforeSweep,
						'Inflated counters cannot finalize upload receipts'
					);
					assert.ok(await sessionRow(ctx.sessionId));
					assert.equal(
						(await SyncSessionService.completionState(ctx.sessionId)).complete,
						false
					);
					await finishSession(ctx);
					assert.ok(await sessionRow(ctx.sessionId));
					assert.equal(
						await IngestionService.releaseCompletedUpload(ctx.sessionId),
						false
					);
					assert.ok(await storage.exists(ctx.inputPath));
					await db
						.delete(schema.syncSessions)
						.where(eq(schema.syncSessions.id, ctx.sessionId));
				}
			}
		);

		await t.test(
			'a legacy file session does not become completion proof when the current upload path is absent',
			async () => {
				const ctx = await setup(['a@example.test']);
				await db
					.update(schema.syncSessions)
					.set({ uploadReceipt: null, completedMailboxes: 1 })
					.where(eq(schema.syncSessions.id, ctx.sessionId));
				await db
					.update(schema.ingestionSources)
					.set({
						credentials: CryptoService.encryptObject({
							type: 'eml_import',
							uploadedFileName: 'legacy.zip',
						}),
						lastSyncStatusMessage: 'Newer state',
					})
					.where(eq(schema.ingestionSources.id, ctx.source.id));
				assert.equal(
					(await SyncSessionService.completionState(ctx.sessionId)).complete,
					false
				);
				await finishSession(ctx);
				await assert.rejects(
					SyncSessionService.finalize(ctx.sessionId),
					/canonical completion/
				);
				assert.ok(await sessionRow(ctx.sessionId));
				assert.ok(await storage.exists(ctx.inputPath));
				assert.equal(
					(await IngestionService.findById(ctx.source.id)).lastSyncStatusMessage,
					'Newer state'
				);
			}
		);

		await t.test(
			'shared, repointed, paused and local input paths are not released prematurely',
			async () => {
				const ctx = await setup(['a@example.test']);
				const shared = await sourceFor(ctx.inputPath);
				await success(ctx, 'a@example.test');
				assert.equal(await IngestionService.releaseCompletedUpload(ctx.sessionId), true);
				assert.ok(await storage.exists(ctx.inputPath));
				const sharedSession = await SyncSessionService.create(shared.id, 1, true, {
					inputPath: ctx.inputPath,
					expectedMailboxes: ['b@example.test'],
				});
				await success(
					{ ...ctx, source: shared, sessionId: sharedSession },
					'b@example.test'
				);
				assert.equal(await IngestionService.releaseCompletedUpload(sharedSession), true);
				assert.equal(await storage.exists(ctx.inputPath), false);

				const repointed = await setup(['a@example.test']);
				await success(repointed, 'a@example.test');
				const newPath = `open-archiver/tmp/${randomUUID()}.zip`;
				await storage.put(newPath, raw);
				await IngestionService.update(repointed.source.id, {
					providerConfig: { type: 'eml_import', uploadedFilePath: newPath },
				});
				await finishSession(repointed);
				assert.equal(
					await IngestionService.releaseCompletedUpload(repointed.sessionId),
					false
				);
				assert.equal(await storage.exists(repointed.inputPath), false);
				assert.ok(await storage.exists(newPath));
				assert.equal(
					(await IngestionService.findById(repointed.source.id)).credentials
						.uploadedFilePath,
					newPath
				);

				const paused = await setup(['a@example.test']);
				await success(paused, 'a@example.test');
				await IngestionService.update(paused.source.id, { status: 'paused' });
				assert.equal(
					await IngestionService.releaseCompletedUpload(paused.sessionId),
					false
				);
				assert.ok(await storage.exists(paused.inputPath));
				const localPath = path.join(fixture, 'external.eml');
				await fs.writeFile(localPath, raw);
				await IngestionService.update(paused.source.id, {
					status: 'importing',
					providerConfig: { type: 'eml_import', localFilePath: localPath },
				});
				assert.equal(await IngestionService.releaseCompletedUpload(paused.sessionId), true);
				assert.deepEqual(await fs.readFile(localPath), raw);
				assert.ok(await storage.exists(paused.inputPath));
			}
		);

		await t.test(
			'partial and blank provider patches merge fresh credentials after replacement or consumption',
			async () => {
				for (const consumption of [false, true]) {
					for (const patch of [
						{ type: 'eml_import', uploadedFilePath: '', uploadedFileName: '' },
						{ type: 'eml_import', uploadedFileName: 'caller-name.zip' },
					]) {
						const ctx = await setup(['a@example.test']);
						const replacement = `open-archiver/tmp/${randomUUID()}.zip`;
						await storage.put(replacement, raw);
						if (consumption) {
							await sourceFor(ctx.inputPath);
							await success(ctx, 'a@example.test');
						}
						const find = IngestionService.findById;
						let entered;
						let release;
						const paused = new Promise((resolve) => {
							release = resolve;
						});
						const read = new Promise((resolve) => {
							entered = resolve;
						});
						let first = true;
						IngestionService.findById = async function (id) {
							const result = await find.call(this, id);
							if (first && id === ctx.source.id) {
								first = false;
								entered();
								await paused;
							}
							return result;
						};
						const edit = IngestionService.update(ctx.source.id, {
							providerConfig: patch,
						});
						try {
							await read;
							if (consumption) await finishSession(ctx);
							else
								await IngestionService.update(ctx.source.id, {
									providerConfig: {
										type: 'eml_import',
										uploadedFilePath: replacement,
										uploadedFileName: 'replacement-name.zip',
									},
								});
						} finally {
							release();
							await Promise.allSettled([edit]);
							IngestionService.findById = find;
						}
						await edit;
						const source = await IngestionService.findById(ctx.source.id);
						assert.equal(
							source.credentials.uploadedFilePath,
							consumption ? undefined : replacement
						);
						assert.equal(
							source.credentials.uploadedFileName,
							patch.uploadedFileName ||
								(consumption ? 'original-name.zip' : 'replacement-name.zip')
						);
						assert.ok(await storage.exists(ctx.inputPath));
					}
				}
			}
		);

		await t.test(
			'full finalizers dispose old X after Y completed without resetting newer source status',
			async () => {
				const ctx = await setup(['a@example.test']);
				await success(ctx, 'a@example.test');
				const replacement = `open-archiver/tmp/${randomUUID()}-y.zip`;
				await storage.put(replacement, raw);
				await IngestionService.update(ctx.source.id, {
					providerConfig: { type: 'eml_import', uploadedFilePath: replacement },
				});
				const sessionId = await SyncSessionService.create(ctx.source.id, 1, true, {
					inputPath: replacement,
					expectedMailboxes: ['a@example.test'],
				});
				const latest = { ...ctx, inputPath: replacement, sessionId };
				await success(latest, 'a@example.test');
				await finishSession(latest);
				const before = await IngestionService.findById(ctx.source.id);
				assert.equal(before.credentials.uploadedFilePath, undefined);
				assert.ok(await storage.exists(ctx.inputPath));
				await finishSession(ctx);
				const after = await IngestionService.findById(ctx.source.id);
				assert.equal(after.status, before.status);
				assert.equal(after.lastSyncStatusMessage, before.lastSyncStatusMessage);
				assert.deepEqual(after.lastSyncFinishedAt, before.lastSyncFinishedAt);
				assert.equal(await sessionRow(ctx.sessionId), undefined);
				assert.equal(await storage.exists(ctx.inputPath), false);
				await IngestionService.delete(ctx.source.id, { id: randomUUID() }, 'fixture');
				assert.equal(await storage.exists(ctx.inputPath), false);
			}
		);

		await t.test(
			'cleanup and receipt-marking failures retain provenance for finalizer retry',
			async () => {
				for (const failure of ['cleanup', 'mark']) {
					const ctx = await setup(['a@example.test']);
					await success(ctx, 'a@example.test');
					const original = StorageService.prototype.deleteObject;
					if (failure === 'cleanup') {
						StorageService.prototype.deleteObject = async () => {
							throw new Error('Synthetic input cleanup failure');
						};
					} else {
						await client`CREATE FUNCTION reject_receipt_mark() RETURNS trigger LANGUAGE plpgsql AS $$
						BEGIN IF NEW.upload_receipt ->> 'disposition' = 'handled' THEN
							RAISE EXCEPTION 'synthetic receipt marking failure'; END IF; RETURN NEW; END $$`;
						await client`CREATE TRIGGER reject_receipt_mark BEFORE UPDATE ON sync_sessions
						FOR EACH ROW EXECUTE FUNCTION reject_receipt_mark()`;
					}
					try {
						await finishSession(ctx);
						const pending = await sessionRow(ctx.sessionId);
						assert.ok(pending);
						assert.equal(pending.uploadReceipt.disposition, undefined);
						assert.equal(
							(await IngestionService.findById(ctx.source.id)).credentials
								.uploadedFilePath,
							undefined
						);
						assert.equal(await storage.exists(ctx.inputPath), failure === 'cleanup');
						await assert.rejects(
							SyncSessionService.finalize(ctx.sessionId),
							/canonical completion/
						);
					} finally {
						StorageService.prototype.deleteObject = original;
						if (failure === 'mark') {
							await client`DROP TRIGGER reject_receipt_mark ON sync_sessions`;
							await client`DROP FUNCTION reject_receipt_mark()`;
						}
					}
					const before = await IngestionService.findById(ctx.source.id);
					await finishSession(ctx);
					assert.equal(await sessionRow(ctx.sessionId), undefined);
					assert.equal(await storage.exists(ctx.inputPath), false);
					const after = await IngestionService.findById(ctx.source.id);
					assert.equal(after.lastSyncStatusMessage, before.lastSyncStatusMessage);
				}
			}
		);

		await t.test(
			'stale retained old receipts do not overwrite replacement-import status',
			async () => {
				const ctx = await setup(['a@example.test', 'b@example.test']);
				await success(ctx, 'a@example.test');
				const replacement = `open-archiver/tmp/${randomUUID()}-new.zip`;
				await storage.put(replacement, raw);
				await IngestionService.update(ctx.source.id, {
					providerConfig: { type: 'eml_import', uploadedFilePath: replacement },
					status: 'importing',
					lastSyncStatusMessage: 'New import in progress',
				});
				await db
					.update(schema.syncSessions)
					.set({ lastActivityAt: new Date(0) })
					.where(eq(schema.syncSessions.id, ctx.sessionId));
				const before = await IngestionService.findById(ctx.source.id);
				await SyncSessionService.cleanStaleSessions(1000);
				await finishSession(ctx);
				const after = await IngestionService.findById(ctx.source.id);
				assert.equal(after.status, before.status);
				assert.equal(after.lastSyncStatusMessage, before.lastSyncStatusMessage);
				assert.ok(await sessionRow(ctx.sessionId));
				assert.ok(await storage.exists(ctx.inputPath));
				await IngestionService.delete(ctx.source.id, { id: randomUUID() }, 'fixture');
				assert.equal(await storage.exists(ctx.inputPath), false);
				assert.equal(await storage.exists(replacement), false);
			}
		);

		await t.test(
			'final disposition rechecks stay atomic with replacement and handled receipts never reset a new import',
			async () => {
				const failed = await setup(['a@example.test']);
				await SyncSessionService.recordMailboxResult(
					failed.sessionId,
					{ error: true, message: 'failed' },
					identity(failed, 'a@example.test')
				);
				const replacement = `open-archiver/tmp/${randomUUID()}-replacement.zip`;
				await storage.put(replacement, raw);
				const state = SyncSessionService.completionState;
				let entered;
				let release;
				const read = new Promise((resolve) => {
					entered = resolve;
				});
				const paused = new Promise((resolve) => {
					release = resolve;
				});
				let first = true;
				SyncSessionService.completionState = async function (id) {
					const value = await state.call(this, id);
					if (first && id === failed.sessionId) {
						first = false;
						entered();
						await paused;
					}
					return value;
				};
				const finalizing = SyncSessionService.finalize(failed.sessionId);
				try {
					await read;
					await IngestionService.update(failed.source.id, {
						providerConfig: { type: 'eml_import', uploadedFilePath: replacement },
						status: 'importing',
						lastSyncStatusMessage: 'Replacement underway',
					});
				} finally {
					release();
					await Promise.allSettled([finalizing]);
					SyncSessionService.completionState = state;
				}
				await assert.rejects(finalizing, /disposition changed/);
				assert.ok(await sessionRow(failed.sessionId));
				assert.ok(await storage.exists(failed.inputPath));
				assert.equal(
					(await IngestionService.findById(failed.source.id)).status,
					'importing'
				);

				const handled = await setup(['a@example.test']);
				await success(handled, 'a@example.test');
				await IngestionService.releaseCompletedUpload(handled.sessionId);
				await storage.put(handled.inputPath, raw);
				await IngestionService.update(handled.source.id, {
					providerConfig: { type: 'eml_import', uploadedFilePath: handled.inputPath },
					status: 'importing',
					lastSyncStatusMessage: 'Re-registered after consumption',
				});
				await finishSession(handled);
				const current = await IngestionService.findById(handled.source.id);
				assert.equal(current.status, 'importing');
				assert.equal(current.lastSyncStatusMessage, 'Re-registered after consumption');
				assert.equal(current.credentials.uploadedFilePath, handled.inputPath);
				assert.ok(await storage.exists(handled.inputPath));
			}
		);

		await t.test(
			'genuinely stale current uploads retain proof and input but become retryable',
			async () => {
				const ctx = await setup(['a@example.test', 'b@example.test']);
				await success(ctx, 'a@example.test');
				await db
					.update(schema.ingestionSources)
					.set({ status: 'importing', lastSyncStartedAt: new Date(0) })
					.where(eq(schema.ingestionSources.id, ctx.source.id));
				await db
					.update(schema.syncSessions)
					.set({ lastActivityAt: new Date(0) })
					.where(eq(schema.syncSessions.id, ctx.sessionId));
				const before = (await sessionRow(ctx.sessionId)).uploadReceipt;
				await SyncSessionService.cleanStaleSessions(1000);
				assert.equal((await IngestionService.findById(ctx.source.id)).status, 'error');
				assert.deepEqual((await sessionRow(ctx.sessionId)).uploadReceipt, before);
				assert.ok(await storage.exists(ctx.inputPath));
				const retry = await IngestionService.claimForImport(ctx.source.id);
				assert.ok(retry);
				assert.equal(retry.status, 'importing');
				await SyncSessionService.cleanStaleSessions(1000);
				assert.equal(
					(await IngestionService.findById(ctx.source.id)).status,
					'importing',
					'Old receipt cannot reset a newer discovery claim'
				);
			}
		);

		await t.test(
			'stale recovery rechecks heartbeat, replacement, pause and newer sessions under locks',
			async () => {
				for (const change of ['heartbeat', 'replacement', 'pause', 'new-session']) {
					const ctx = await setup(['a@example.test', 'b@example.test']);
					await success(ctx, 'a@example.test');
					await db
						.update(schema.ingestionSources)
						.set({
							status: 'importing',
							lastSyncStartedAt: new Date(0),
							lastSyncStatusMessage: 'Current work',
						})
						.where(eq(schema.ingestionSources.id, ctx.source.id));
					await db
						.update(schema.syncSessions)
						.set({ lastActivityAt: new Date(0) })
						.where(eq(schema.syncSessions.id, ctx.sessionId));
					let expectedPath = ctx.inputPath;
					let expectedStatus = 'importing';
					await pauseBeforePathLocks(
						ctx.inputPath,
						() => SyncSessionService.cleanStaleSessions(1000),
						async () => {
							if (change === 'heartbeat')
								await SyncSessionService.heartbeat(ctx.sessionId);
							if (change === 'replacement') {
								expectedPath = `open-archiver/tmp/${randomUUID()}-new.zip`;
								await storage.put(expectedPath, raw);
								await IngestionService.update(ctx.source.id, {
									providerConfig: {
										type: 'eml_import',
										uploadedFilePath: expectedPath,
									},
								});
							}
							if (change === 'pause') {
								expectedStatus = 'paused';
								await IngestionService.update(ctx.source.id, { status: 'paused' });
							}
							if (change === 'new-session') {
								await SyncSessionService.create(ctx.source.id, 1, true, {
									inputPath: ctx.inputPath,
									expectedMailboxes: ['c@example.test'],
								});
							}
						}
					);
					const source = await IngestionService.findById(ctx.source.id);
					assert.equal(source.status, expectedStatus);
					assert.equal(source.credentials.uploadedFilePath, expectedPath);
					assert.equal(source.lastSyncStatusMessage, 'Current work');
					assert.ok(await sessionRow(ctx.sessionId));
					assert.ok(await storage.exists(ctx.inputPath));
				}
			}
		);

		await t.test(
			'a delayed releaser treats the fresh handled disposition as authoritative',
			async () => {
				const ctx = await setup(['a@example.test']);
				await success(ctx, 'a@example.test');
				await sourceFor(ctx.inputPath);
				let currentCredentials;
				const result = await pauseBeforePathLocks(
					ctx.inputPath,
					() => IngestionService.releaseCompletedUpload(ctx.sessionId),
					async () => {
						assert.equal(
							await IngestionService.releaseCompletedUpload(ctx.sessionId),
							true
						);
						await IngestionService.update(ctx.source.id, {
							providerConfig: { type: 'eml_import', uploadedFilePath: ctx.inputPath },
							status: 'importing',
							lastSyncStatusMessage: 'Re-selected shared input',
						});
						currentCredentials = (await sourceRow(ctx.source.id)).credentials;
					}
				);
				assert.equal(result, false);
				assert.equal((await sourceRow(ctx.source.id)).credentials, currentCredentials);
				assert.equal(
					(await IngestionService.findById(ctx.source.id)).credentials.uploadedFilePath,
					ctx.inputPath
				);
				assert.equal(
					(await sessionRow(ctx.sessionId)).uploadReceipt.disposition,
					'handled'
				);
				assert.ok(await storage.exists(ctx.inputPath));
			}
		);

		await t.test(
			'upload finalization preserves a pause made after its earlier status read',
			async () => {
				const ctx = await setup(['a@example.test']);
				await success(ctx, 'a@example.test');
				const original = IngestionService.findById;
				let entered;
				let release;
				const read = new Promise((resolve) => {
					entered = resolve;
				});
				const paused = new Promise((resolve) => {
					release = resolve;
				});
				let first = true;
				IngestionService.findById = async function (id) {
					const source = await original.call(this, id);
					if (first && id === ctx.source.id) {
						first = false;
						entered();
						await paused;
					}
					return source;
				};
				const finalizing = finishSession(ctx);
				try {
					await read;
					await IngestionService.update(ctx.source.id, {
						status: 'paused',
						lastSyncStatusMessage: 'Paused by operator',
					});
				} finally {
					release();
					await Promise.allSettled([finalizing]);
					IngestionService.findById = original;
				}
				await finalizing;
				const source = await IngestionService.findById(ctx.source.id);
				assert.equal(source.status, 'paused');
				assert.equal(source.lastSyncStatusMessage, 'Paused by operator');
				assert.equal(source.credentials.uploadedFilePath, ctx.inputPath);
				assert.equal(
					(await sessionRow(ctx.sessionId)).uploadReceipt.disposition,
					undefined
				);
				assert.ok(await storage.exists(ctx.inputPath));
			}
		);

		await t.test(
			'another unfinished source session blocks release until it independently proves success',
			async () => {
				const ctx = await setup(['a@example.test']);
				const other = await SyncSessionService.create(ctx.source.id, 2, false, {
					inputPath: ctx.inputPath,
					expectedMailboxes: ['a@example.test', 'b@example.test'],
				});
				await success(ctx, 'a@example.test');
				assert.equal(await IngestionService.releaseCompletedUpload(ctx.sessionId), false);
				await success({ ...ctx, sessionId: other }, 'a@example.test');
				assert.equal(await IngestionService.releaseCompletedUpload(ctx.sessionId), false);
				await success({ ...ctx, sessionId: other }, 'b@example.test');
				assert.equal(await IngestionService.releaseCompletedUpload(ctx.sessionId), true);
				assert.equal(await storage.exists(ctx.inputPath), false);
			}
		);

		await t.test(
			'unfinished receipts retain X after source repoints to Y and explicit source deletion collects both',
			async () => {
				const ctx = await setup(['a@example.test']);
				const other = await sourceFor(ctx.inputPath);
				const otherSession = await SyncSessionService.create(other.id, 1, true, {
					inputPath: ctx.inputPath,
					expectedMailboxes: ['b@example.test'],
				});
				const replacement = `open-archiver/tmp/${randomUUID()}.zip`;
				await storage.put(replacement, raw);
				await IngestionService.update(ctx.source.id, {
					providerConfig: { type: 'eml_import', uploadedFilePath: replacement },
				});
				await success({ ...ctx, source: other, sessionId: otherSession }, 'b@example.test');
				assert.equal(await IngestionService.releaseCompletedUpload(otherSession), true);
				assert.deepEqual(await buffer(await storage.get(ctx.inputPath)), raw);
				await IngestionService.delete(ctx.source.id, { id: randomUUID() }, 'fixture');
				assert.equal(await storage.exists(ctx.inputPath), false);
				assert.equal(await storage.exists(replacement), false);
				assert.equal(await sessionRow(ctx.sessionId), undefined);
			}
		);

		await t.test(
			'prefix cleanup counts unfinished receipt references even after their source repoints',
			async () => {
				const owner = await sourceFor(undefined);
				const inputPath = `open-archiver/${owner.id}/pending.zip`;
				await storage.put(inputPath, raw);
				const consumer = await sourceFor(inputPath);
				const receiptId = await SyncSessionService.create(consumer.id, 1, true, {
					inputPath,
					expectedMailboxes: ['a@example.test'],
				});
				const replacement = `open-archiver/tmp/${randomUUID()}.zip`;
				await storage.put(replacement, raw);
				await IngestionService.update(consumer.id, {
					providerConfig: { type: 'eml_import', uploadedFilePath: replacement },
				});
				await IngestionService.delete(owner.id, { id: randomUUID() }, 'fixture');
				assert.deepEqual(await buffer(await storage.get(inputPath)), raw);
				assert.ok(await sessionRow(receiptId));
				await IngestionService.delete(consumer.id, { id: randomUUID() }, 'fixture');
				assert.equal(await storage.exists(inputPath), false);
				assert.equal(await storage.exists(replacement), false);
			}
		);

		await t.test(
			'partial discovery cannot create release proof or dispatch a subset',
			async () => {
				const inputPath = `open-archiver/tmp/${randomUUID()}.zip`;
				await storage.put(inputPath, raw);
				const source = await sourceFor(inputPath);
				await db
					.update(schema.ingestionSources)
					.set({ status: 'pending_auth' })
					.where(eq(schema.ingestionSources.id, source.id));
				const before = queued.length;
				makeConnector = () => ({
					async *listAllUsers() {
						yield { primaryEmail: 'a@example.test' };
						throw new Error('Synthetic discovery interruption');
					},
				});
				await assert.rejects(
					initialImport({ data: { ingestionSourceId: source.id } }),
					/discovery interruption/
				);
				assert.equal(
					(
						await db
							.select()
							.from(schema.syncSessions)
							.where(eq(schema.syncSessions.ingestionSourceId, source.id))
					).length,
					0
				);
				assert.equal(queued.length, before);
				assert.ok(await storage.exists(inputPath));
			}
		);

		await t.test(
			'closed discovery snapshots normalize and deduplicate declared mailboxes before dispatch',
			async () => {
				const inputPath = `open-archiver/tmp/${randomUUID()}.zip`;
				await storage.put(inputPath, raw);
				const source = await sourceFor(inputPath);
				await db
					.update(schema.ingestionSources)
					.set({ status: 'pending_auth' })
					.where(eq(schema.ingestionSources.id, source.id));
				const before = queued.length;
				makeConnector = () => ({
					async *listAllUsers() {
						for (const primaryEmail of [
							' A@example.test ',
							'a@EXAMPLE.test',
							'b@example.test',
						])
							yield { primaryEmail };
					},
				});
				await initialImport({ data: { ingestionSourceId: source.id } });
				const jobs = queued.slice(before).filter((job) => job.name === 'process-mailbox');
				assert.equal(jobs.length, 2);
				assert.deepEqual(
					jobs.map((job) => job.data.userEmail),
					['a@example.test', 'b@example.test']
				);
				assert.ok(jobs.every((job) => job.data.uploadInputPath === inputPath));
				const session = await sessionRow(jobs[0].data.sessionId);
				assert.equal(session.totalMailboxes, 2);
				assert.deepEqual(session.uploadReceipt.expectedMailboxes, [
					'a@example.test',
					'b@example.test',
				]);
				const publicSession = await SyncSessionService.findById(session.id);
				assert.equal(Object.hasOwn(publicSession, 'uploadReceipt'), false);
				const publicJob = await new JobsService().formatJob({
					data: jobs[0].data,
					name: 'process-mailbox',
					getState: async () => 'waiting',
				});
				assert.equal(Object.hasOwn(publicJob.data, 'uploadInputPath'), false);
			}
		);

		await t.test(
			'partial upload dispatch retries replace only matching aborted receipts and reject late results',
			async (t) => {
				for (const mode of ['initial', 'continuous']) {
					await t.test(mode, async () => {
						const inputPath = `open-archiver/tmp/${randomUUID()}.zip`;
						const bytes = await zipBytes();
						await storage.put(inputPath, bytes);
						const source = await sourceFor(inputPath);
						await db
							.update(schema.ingestionSources)
							.set({
								status: mode === 'initial' ? 'auth_success' : 'active',
							})
							.where(eq(schema.ingestionSources.id, source.id));
						const master = mode === 'initial' ? initialImport : continuousSync;
						let admitted;
						let entered;
						let resume;
						let blockNext = true;
						const reading = new Promise((resolve) => {
							entered = resolve;
						});
						const paused = new Promise((resolve) => {
							resume = resolve;
						});
						makeConnector = (current) => {
							const connector = new EMLConnector(current.credentials);
							connector.listAllUsers = async function* () {
								yield { primaryEmail: 'a@example.test' };
								yield { primaryEmail: 'b@example.test' };
								yield { primaryEmail: 'c@example.test' };
							};
							const fetch = connector.fetchEmails.bind(connector);
							connector.fetchEmails = async function* (...args) {
								if (blockNext) {
									blockNext = false;
									entered();
									await paused;
								}
								yield* fetch(...args);
							};
							return connector;
						};
						const addBulk = ingestionQueue.addBulk;
						let oldJob;
						ingestionQueue.addBulk = async (jobs) => {
							assert.equal(jobs.length, 3);
							oldJob = jobs[0];
							queued.push(oldJob);
							admitted = processMailboxProcessor(oldJob);
							await reading;
							throw new Error('Synthetic partial-page dispatch failure');
						};
						try {
							await assert.rejects(
								master({ data: { ingestionSourceId: source.id } }),
								/partial-page dispatch/
							);
							const oldId = oldJob.data.sessionId;
							const abortedReceipt = (await sessionRow(oldId)).uploadReceipt;
							assert.deepEqual(await buffer(await storage.get(inputPath)), bytes);
							await processMailboxProcessor({
								data: { ...oldJob.data, userEmail: 'b@example.test' },
							});
							const lateResults = (await sessionRow(oldId)).uploadReceipt.results;
							assert.equal(
								(await SyncSessionService.completionState(oldId)).complete,
								false
							);
							ingestionQueue.addBulk = addBulk;
							const before = queued.length;
							await master({ data: { ingestionSourceId: source.id } });
							const retry = queued
								.slice(before)
								.filter((job) => job.name === 'process-mailbox');
							assert.equal(retry.length, 3);
							const newId = retry[0].data.sessionId;
							assert.notEqual(newId, oldId);
							assert.deepEqual((await sessionRow(newId)).uploadReceipt.results, []);
							resume();
							await admitted;
							assert.deepEqual((await sessionRow(newId)).uploadReceipt.results, []);
							assert.equal(
								await IngestionService.releaseCompletedUpload(newId),
								false
							);
							await processMailboxProcessor(retry[0]);
							assert.equal(
								await IngestionService.releaseCompletedUpload(newId),
								false
							);
							assert.deepEqual(await buffer(await storage.get(inputPath)), bytes);
							await processMailboxProcessor(retry[1]);
							assert.equal(
								await IngestionService.releaseCompletedUpload(newId),
								false
							);
							await processMailboxProcessor(retry[2]);
							await finishSession({ source, sessionId: newId, inputPath });
							assert.equal(await storage.exists(inputPath), false);
							assert.equal(await sessionRow(newId), undefined);
							assert.equal(await sessionRow(oldId), undefined);
							assert.equal(abortedReceipt.dispatchAborted, true);
							assert.deepEqual(lateResults, []);
							assert.equal((await sourceRow(source.id)).status, 'imported');
						} finally {
							resume();
							if (admitted) await admitted;
							ingestionQueue.addBulk = addBulk;
						}
					});
				}
			}
		);

		await t.test(
			'dispatch errors cannot abort independently proven canonical upload success',
			async () => {
				const inputPath = `open-archiver/tmp/${randomUUID()}.zip`;
				await storage.put(inputPath, await zipBytes());
				const source = await sourceFor(inputPath);
				await db
					.update(schema.ingestionSources)
					.set({ status: 'auth_success' })
					.where(eq(schema.ingestionSources.id, source.id));
				makeConnector = (current) => {
					const connector = new EMLConnector(current.credentials);
					connector.listAllUsers = async function* () {
						yield { primaryEmail: 'a@example.test' };
					};
					return connector;
				};
				const addBulk = ingestionQueue.addBulk;
				let sessionId;
				ingestionQueue.addBulk = async (jobs) => {
					sessionId = jobs[0].data.sessionId;
					for (const job of jobs) await processMailboxProcessor(job);
					throw new Error(
						'Synthetic lost enqueue acknowledgment after canonical success'
					);
				};
				try {
					await initialImport({ data: { ingestionSourceId: source.id } });
				} finally {
					ingestionQueue.addBulk = addBulk;
				}
				assert.equal(
					(await sessionRow(sessionId)).uploadReceipt.dispatchAborted,
					undefined
				);
				assert.equal((await SyncSessionService.completionState(sessionId)).complete, true);
				await finishSession({ source, sessionId });
				assert.equal(await storage.exists(inputPath), false);
			}
		);

		await t.test(
			'aborted dispatch provenance survives changed input or a mismatched retry mailbox set',
			async () => {
				for (const change of ['input', 'mailboxes']) {
					const inputPath = `open-archiver/tmp/${randomUUID()}.zip`;
					await storage.put(inputPath, await zipBytes());
					const source = await sourceFor(inputPath);
					await db
						.update(schema.ingestionSources)
						.set({ status: 'auth_success' })
						.where(eq(schema.ingestionSources.id, source.id));
					let mailboxes = ['a@example.test', 'b@example.test'];
					makeConnector = (current) => {
						const connector = new EMLConnector(current.credentials);
						connector.listAllUsers = async function* () {
							for (const primaryEmail of mailboxes) yield { primaryEmail };
						};
						return connector;
					};
					const addBulk = ingestionQueue.addBulk;
					let oldJob;
					ingestionQueue.addBulk = async (jobs) => {
						oldJob = jobs[0];
						queued.push(oldJob);
						throw new Error('Synthetic partial enqueue');
					};
					try {
						await assert.rejects(
							initialImport({ data: { ingestionSourceId: source.id } }),
							/partial enqueue/
						);
					} finally {
						ingestionQueue.addBulk = addBulk;
					}
					const oldId = oldJob.data.sessionId;
					assert.equal((await sessionRow(oldId)).uploadReceipt.dispatchAborted, true);
					if (change === 'mailboxes') {
						mailboxes = ['a@example.test'];
						await assert.rejects(
							initialImport({ data: { ingestionSourceId: source.id } }),
							/different declared mailbox set/
						);
					} else {
						const replacement = `open-archiver/tmp/${randomUUID()}.zip`;
						await storage.put(replacement, await zipBytes());
						await IngestionService.update(source.id, {
							providerConfig: { type: 'eml_import', uploadedFilePath: replacement },
						});
						const before = queued.length;
						await initialImport({ data: { ingestionSourceId: source.id } });
						const retry = queued
							.slice(before)
							.filter((job) => job.name === 'process-mailbox');
						assert.equal(retry.length, 2);
						await processMailboxProcessor(oldJob);
						assert.equal((await sourceRow(source.id)).status, 'importing');
						for (const job of retry) await processMailboxProcessor(job);
						await finishSession({ source, sessionId: retry[0].data.sessionId });
						assert.equal(await storage.exists(replacement), false);
						assert.equal((await sourceRow(source.id)).status, 'imported');
					}
					assert.ok(await sessionRow(oldId));
					assert.ok(await storage.exists(inputPath));
					await IngestionService.delete(source.id, { id: randomUUID() }, 'fixture');
					assert.equal(await storage.exists(inputPath), false);
				}
			}
		);

		await t.test(
			'real worker retains valid-plus-broken ZIP input and releases only complete successful input',
			async () => {
				for (const broken of [true, false]) {
					const ctx = await setup(
						['a@example.test'],
						'eml_import',
						await zipBytes(broken)
					);
					makeConnector = (source) =>
						new EMLConnector(source.credentials, { preserveOriginalFile: true });
					await worker(ctx, 'a@example.test');
					const session = await sessionRow(ctx.sessionId);
					assert.equal(session.completedMailboxes, broken ? 0 : 1);
					assert.equal(session.failedMailboxes, broken ? 1 : 0);
					assert.equal(
						(
							await db
								.select()
								.from(schema.archivedEmails)
								.where(eq(schema.archivedEmails.ingestionSourceId, ctx.source.id))
						).length,
						1
					);
					await finishSession(ctx);
					assert.equal(await storage.exists(ctx.inputPath), broken);
				}
			}
		);

		await t.test(
			'archive failure and interrupted worker iteration retain the upload receipt',
			async () => {
				for (const failure of ['archive', 'interrupt']) {
					const ctx = await setup(['a@example.test'], 'eml_import', await zipBytes());
					makeConnector = (source) => {
						const connector = new EMLConnector(source.credentials);
						if (failure === 'interrupt') {
							const fetch = connector.fetchEmails.bind(connector);
							connector.fetchEmails = async function* (...args) {
								yield* fetch(...args);
								throw new Error('Synthetic worker input interruption');
							};
						}
						return connector;
					};
					const put = StorageService.prototype.put;
					if (failure === 'archive') {
						StorageService.prototype.put = async function (key, ...args) {
							if (key.includes('/emails/'))
								throw new Error('Synthetic archive failure');
							return put.call(this, key, ...args);
						};
					}
					try {
						await worker(ctx, 'a@example.test');
					} finally {
						StorageService.prototype.put = put;
					}
					assert.equal((await sessionRow(ctx.sessionId)).failedMailboxes, 1);
					await finishSession(ctx);
					assert.ok(await storage.exists(ctx.inputPath));
					assert.equal(
						(await IngestionService.findById(ctx.source.id)).credentials
							.uploadedFilePath,
						ctx.inputPath
					);
				}
			}
		);

		await t.test('streaming MBOX preserves input on a per-message parser failure', async () => {
			const bytes = Buffer.concat([
				Buffer.from('From sender@example.test Sat Oct 10 12:00:00 2026\n'),
				raw,
				Buffer.from(
					'\nFrom sender@example.test Sat Oct 10 12:00:01 2026\nSubject: BROKEN\r\n\r\nFailure fixture.\r\n'
				),
			]);
			const ctx = await setup(['a@example.test'], 'mbox_import', bytes);
			makeConnector = (source) => {
				const connector = new MboxConnector(source.credentials);
				const parse = connector.parseMessage.bind(connector);
				connector.parseMessage = async (...args) => {
					if (args[0].includes(Buffer.from('BROKEN')))
						throw new Error('Synthetic MIME parser failure');
					return parse(...args);
				};
				return connector;
			};
			await worker(ctx, 'a@example.test');
			assert.equal((await sessionRow(ctx.sessionId)).failedMailboxes, 1);
			assert.equal(
				(
					await db
						.select()
						.from(schema.archivedEmails)
						.where(eq(schema.archivedEmails.ingestionSourceId, ctx.source.id))
				).length,
				1
			);
			await finishSession(ctx);
			assert.ok(await storage.exists(ctx.inputPath));
		});

		await t.test(
			'successful streaming MBOX releases only after worker and finalizer completion',
			async () => {
				const bytes = Buffer.concat([
					Buffer.from('From sender@example.test Sat Oct 10 12:00:00 2026\n'),
					raw,
				]);
				const ctx = await setup(['a@example.test'], 'mbox_import', bytes);
				makeConnector = (source) => new MboxConnector(source.credentials);
				await worker(ctx, 'a@example.test');
				assert.equal((await sessionRow(ctx.sessionId)).completedMailboxes, 1);
				assert.ok(await storage.exists(ctx.inputPath));
				await finishSession(ctx);
				assert.equal(await storage.exists(ctx.inputPath), false);
				assert.equal(
					(await IngestionService.findById(ctx.source.id)).credentials.uploadedFilePath,
					undefined
				);
			}
		);

		await t.test(
			'incomplete PST attachments never reach persistence and a healthy same-ID retry archives exact bytes',
			async () => {
				for (const preserveOriginalFile of [false, true]) {
					for (const fault of ['missing', 'read']) {
						const ctx = await setup(
							['a@example.test'],
							'pst_import',
							Buffer.from('Synthetic PST source placeholder')
						);
						await db
							.update(schema.ingestionSources)
							.set({ preserveOriginalFile })
							.where(eq(schema.ingestionSources.id, ctx.source.id));
						const payloads = [
							Buffer.from('complete attachment'),
							Buffer.from([0, 255, 128, 13, 10, 42]),
						];
						let healthy = false;
						let yielded = 0;
						makeConnector = (source) => {
							const connector = new PSTConnector(source.credentials, {
								preserveOriginalFile,
							});
							let visited = false;
							const msg = {
								internetMessageId: `<pst-${ctx.source.id}@example.test>`,
								subject: 'PST bounded attachment retry',
								clientSubmitTime: new Date('2026-10-10T12:00:00Z'),
								senderEmailAddress: 'sender@example.test',
								body: 'Complete body',
								hasAttachments: true,
								numberOfAttachments: 2,
								get numberOfRecipients() {
									throw new Error('Optional MAPI recipient table absent');
								},
								getAttachment(index) {
									return {
										filesize: payloads[index].length,
										filename: `${index}.bin`,
										fileInputStream:
											!healthy && index === 1 && fault === 'missing'
												? null
												: {
														readCompletely(destination) {
															if (
																!healthy &&
																index === 1 &&
																fault === 'read'
															)
																throw new Error(
																	'Synthetic attachment read failure'
																);
															payloads[index].copy(destination);
														},
													},
									};
								},
							};
							connector.loadPstFile = async () => ({
								pstFile: {
									getRootFolder: () => ({
										displayName: 'Inbox',
										contentCount: 1,
										hasSubfolders: false,
										getNextChild() {
											if (visited) return null;
											visited = true;
											return msg;
										},
									}),
									close() {},
								},
								tempDir: null,
							});
							const fetch = connector.fetchEmails.bind(connector);
							connector.fetchEmails = async function* (...args) {
								for await (const email of fetch(...args)) {
									yielded++;
									yield email;
								}
							};
							return connector;
						};
						await worker(ctx, 'a@example.test');
						const rowsForSource = () =>
							db
								.select()
								.from(schema.archivedEmails)
								.where(eq(schema.archivedEmails.ingestionSourceId, ctx.source.id));
						assert.equal(
							(await rowsForSource()).length,
							0,
							'Incomplete PST message must not have an archived row'
						);
						assert.equal(
							yielded,
							0,
							'Incomplete MIME must not be yielded for archiving'
						);
						assert.equal((await sessionRow(ctx.sessionId)).failedMailboxes, 1);
						await finishSession(ctx);
						assert.ok(await storage.exists(ctx.inputPath));
						healthy = true;
						await IngestionService.update(ctx.source.id, { status: 'importing' });
						const sessionId = await SyncSessionService.create(ctx.source.id, 1, true, {
							inputPath: ctx.inputPath,
							expectedMailboxes: ['a@example.test'],
						});
						const retry = { ...ctx, sessionId };
						await worker(retry, 'a@example.test');
						const rows = await rowsForSource();
						assert.equal(rows.length, 1);
						assert.equal(
							rows[0].messageIdHeader,
							`<pst-${ctx.source.id}@example.test>`
						);
						const parsed = await require('mailparser').simpleParser(
							await buffer(await storage.get(rows[0].storagePath))
						);
						if (preserveOriginalFile) {
							assert.deepEqual(
								parsed.attachments.map((attachment) => attachment.content),
								payloads
							);
						} else {
							const attachments = await db
								.select()
								.from(schema.attachments)
								.where(eq(schema.attachments.ingestionSourceId, ctx.source.id));
							assert.equal(attachments.length, 2);
							for (const attachment of attachments) {
								assert.deepEqual(
									await buffer(await storage.get(attachment.storagePath)),
									payloads[Number(attachment.filename[0])]
								);
							}
						}
						await finishSession(retry);
						assert.equal(await storage.exists(ctx.inputPath), false);
					}
				}
				// The PST object model is synthetic; construction, worker and persistence are the real compiled code.
			}
		);

		await t.test(
			'connector cancellation and PST read failures cannot own shared-upload cleanup',
			async () => {
				const ctx = await setup(['a@example.test'], 'eml_import', await zipBytes());
				const connector = new EMLConnector({ uploadedFilePath: ctx.inputPath });
				const iterator = connector.fetchEmails('a@example.test');
				const first = await iterator.next();
				assert.ok(first.value);
				await fs.rm(first.value.tempFilePath);
				await iterator.return();
				assert.ok(await storage.exists(ctx.inputPath));

				const pst = new PSTConnector({ uploadedFilePath: ctx.inputPath });
				let child = 0;
				let closed = false;
				pst.loadPstFile = async () => ({
					pstFile: {
						getRootFolder: () => ({
							displayName: 'Inbox',
							contentCount: 2,
							hasSubfolders: false,
							getNextChild() {
								if (!child++) return {};
								throw new Error('Synthetic PST folder failure');
							},
						}),
						close() {
							closed = true;
						},
					},
					tempDir: null,
				});
				pst.parseMessage = async () => ({ id: 'synthetic-pst' });
				const results = [];
				for await (const email of pst.fetchEmails('a@example.test')) results.push(email);
				assert.equal(results.length, 1);
				assert.equal(pst.getFetchFailures().count, 1);
				assert.equal(closed, true);
				assert.ok(await storage.exists(ctx.inputPath));
				// The PST tree is a failure-path stub, not a real PST import fixture.
			}
		);
	}
);
