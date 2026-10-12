const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { buffer } = require('node:stream/consumers');
const { test } = require('node:test');
const postgres = require('postgres');
const { drizzle } = require('drizzle-orm/postgres-js');
const { migrate } = require('drizzle-orm/postgres-js/migrator');
const { eq } = require('drizzle-orm');
const archiver = require('archiver');
const schema = require('../dist/database/schema');

const databaseUrl = process.env.STORAGE_AUTH_TEST_DATABASE_URL;
if (process.env.CI) assert.ok(databaseUrl, 'CI must configure STORAGE_AUTH_TEST_DATABASE_URL');

test(
	'upload dispatch acknowledgement loss respects terminal and current ownership',
	{
		skip: databaseUrl ? false : 'Set STORAGE_AUTH_TEST_DATABASE_URL',
		timeout: 90_000,
	},
	async (t) => {
		const url = new URL(databaseUrl);
		assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
		assert.equal(url.pathname, '/postgres');
		const dbName = `oa_ack_${randomUUID().replaceAll('-', '')}`;
		const admin = postgres(url.toString(), { max: 1, connect_timeout: 5 });
		const fixture = await fs.mkdtemp(path.join(tmpdir(), 'oa-ack-'));
		const restores = [];
		let client;
		let created = false;
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
		client = postgres(url.toString(), { max: 2, connect_timeout: 5 });
		const db = drizzle(client, { schema });
		await migrate(db, { migrationsFolder: path.join(__dirname, '../src/database/migrations') });
		process.env.STORAGE_TYPE = 'local';
		process.env.STORAGE_LOCAL_ROOT_PATH = fixture;
		process.env.STORAGE_ENCRYPTION_KEY = 'bc'.repeat(32);
		process.env.ENCRYPTION_KEY = 'de'.repeat(32);
		process.env.ENABLE_DELETION = 'true';
		process.env.LOG_LEVEL = 'silent';
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
		const logs = [];
		provide('../dist/config/logger', {
			logger: Object.fromEntries(
				['info', 'warn', 'error', 'debug', 'trace'].map((level) => [
					level,
					(...args) => logs.push({ level, args }),
				])
			),
		});
		let dispatch;
		const scheduled = [];
		provide('../dist/jobs/queues', {
			ingestionQueue: {
				addBulk: (jobs) => dispatch(jobs),
				add: async (name, data) => {
					scheduled.push({ name, data });
				},
				getJobs: async () => [],
				getJob: async () => null,
			},
			indexingQueue: { add: async () => {} },
		});
		provide('../dist/jobs/helpers/workerLiveness', {});
		provide('../dist/services/ingestion-connectors/MicrosoftConnector', {
			isMailboxUnavailableError: () => false,
		});
		provide('../dist/services/SearchService', {
			SearchService: class {
				async deleteDocumentsByFilter() {
					return { taskUid: 1 };
				}
				async waitForTask() {}
			},
		});
		let makeConnector;
		provide('../dist/services/EmailProviderFactory', {
			EmailProviderFactory: { createConnector: (source) => makeConnector(source) },
		});
		const { IngestionService } = require('../dist/services/IngestionService');
		const { SyncSessionService } = require('../dist/services/SyncSessionService');
		const { StorageService } = require('../dist/services/StorageService');
		const { CryptoService } = require('../dist/services/CryptoService');
		const { EMLConnector } = require('../dist/services/ingestion-connectors/EMLConnector');
		const {
			processMailboxProcessor,
		} = require('../dist/jobs/processors/process-mailbox.processor');
		const finish = require('../dist/jobs/processors/sync-cycle-finished.processor').default;
		const initial = require('../dist/jobs/processors/initial-import.processor').default;
		const continuous = require('../dist/jobs/processors/continuous-sync.processor').default;
		const storage = new StorageService();
		const mailboxes = ['a@example.test', 'b@example.test'];
		makeConnector = (source) => {
			const connector = new EMLConnector(source.credentials);
			connector.listAllUsers = async function* () {
				for (const primaryEmail of mailboxes) yield { primaryEmail };
			};
			return connector;
		};
		const sourceRow = async (id) =>
			(
				await db
					.select()
					.from(schema.ingestionSources)
					.where(eq(schema.ingestionSources.id, id))
			)[0];
		const sessionsFor = (id) =>
			db
				.select()
				.from(schema.syncSessions)
				.where(eq(schema.syncSessions.ingestionSourceId, id));
		async function seed(mode) {
			const inputPath = `open-archiver/tmp/${randomUUID()}.zip`;
			const zip = archiver('zip');
			const buffered = buffer(zip);
			zip.append(
				Buffer.from(
					`From: sender@example.test\r\nTo: reader@example.test\r\nMessage-ID: <${randomUUID()}@example.test>\r\nSubject: Dispatch proof\r\n\r\nSynthetic bytes.\r\n`
				),
				{ name: 'message.eml' }
			);
			const [bytes] = await Promise.all([buffered, zip.finalize()]);
			await storage.put(inputPath, bytes);
			const [source] = await db
				.insert(schema.ingestionSources)
				.values({
					name: 'Dispatch proof',
					provider: 'eml_import',
					status: mode === 'initial' ? 'auth_success' : 'active',
					credentials: CryptoService.encryptObject({
						type: 'eml_import',
						uploadedFilePath: inputPath,
					}),
				})
				.returning();
			return { source, inputPath, bytes };
		}
		async function complete(jobs) {
			for (const job of jobs) await processMailboxProcessor(job);
			await finish({ data: { ...jobs[0].data, isInitialImport: true } });
			assert.equal((await sessionsFor(jobs[0].data.ingestionSourceId)).length, 0);
		}

		for (const mode of ['initial', 'continuous']) {
			const master = mode === 'initial' ? initial : continuous;
			await t.test(
				`${mode}: abort persistence failure cannot make live dispatch retryable`,
				async (t) => {
					const ctx = await seed(mode);
					t.after(async () => {
						await db
							.delete(schema.ingestionSources)
							.where(eq(schema.ingestionSources.id, ctx.source.id));
					});
					let jobs;
					let before;
					dispatch = async (batch) => {
						jobs = batch;
						await processMailboxProcessor(batch[0]);
						before = await sourceRow(ctx.source.id);
						throw new Error('Synthetic partially enqueued dispatch failure');
					};
					await client`CREATE FUNCTION reject_dispatch_abort() RETURNS trigger LANGUAGE plpgsql AS $$
				BEGIN IF NEW.upload_receipt->>'dispatchAborted' = 'true' THEN
					RAISE EXCEPTION 'Synthetic abort persistence failure'; END IF; RETURN NEW; END $$`;
					await client`CREATE TRIGGER reject_dispatch_abort BEFORE UPDATE ON sync_sessions
				FOR EACH ROW EXECUTE FUNCTION reject_dispatch_abort()`;
					try {
						await master({ data: { ingestionSourceId: ctx.source.id } });
					} finally {
						await client`DROP TRIGGER reject_dispatch_abort ON sync_sessions`;
						await client`DROP FUNCTION reject_dispatch_abort()`;
					}
					assert.deepEqual(await sourceRow(ctx.source.id), before);
					const [live] = await sessionsFor(ctx.source.id);
					assert.equal(live.uploadReceipt.dispatchAborted, undefined);
					assert.equal(live.completedMailboxes, 1);
					assert.equal(
						await SyncSessionService.uploadInputForMailbox(live.id, {
							sourceId: ctx.source.id,
							inputPath: ctx.inputPath,
							mailbox: mailboxes[1],
						}),
						true
					);
					assert.equal(await IngestionService.claimForImport(ctx.source.id), null);
					assert.equal(await IngestionService.claimForSync(ctx.source.id), null);
					assert.deepEqual(await buffer(await storage.get(ctx.inputPath)), ctx.bytes);
					assert.equal(
						await SyncSessionService.abortUploadDispatch(
							live.id,
							ctx.source.id,
							ctx.inputPath,
							before.lastSyncStartedAt
						),
						'aborted'
					);
					assert.equal(
						await IngestionService.markUploadDispatchFailed(
							ctx.source.id,
							ctx.inputPath,
							before.lastSyncStartedAt,
							live.id,
							{ lastSyncStatusMessage: 'Durably aborted dispatch can retry' }
						),
						true
					);
					await processMailboxProcessor(jobs[1]);
					assert.equal((await sessionsFor(ctx.source.id))[0].completedMailboxes, 1);
					dispatch = complete;
					await master({ data: { ingestionSourceId: ctx.source.id } });
					assert.equal((await sourceRow(ctx.source.id)).status, 'imported');
					assert.equal(await storage.exists(ctx.inputPath), false);
				}
			);

			await t.test(
				`${mode}: discovery failure without a session remains retryable`,
				async (t) => {
					const ctx = await seed(mode);
					t.after(async () => {
						await db
							.delete(schema.ingestionSources)
							.where(eq(schema.ingestionSources.id, ctx.source.id));
					});
					const original = makeConnector;
					makeConnector = () => ({
						async *listAllUsers() {
							throw new Error('Synthetic discovery failure');
						},
					});
					try {
						await assert.rejects(
							master({ data: { ingestionSourceId: ctx.source.id } }),
							/discovery failure/
						);
					} finally {
						makeConnector = original;
					}
					assert.equal((await sourceRow(ctx.source.id)).status, 'error');
					assert.equal((await sessionsFor(ctx.source.id)).length, 0);
					assert.ok(await storage.exists(ctx.inputPath));
					dispatch = complete;
					await master({ data: { ingestionSourceId: ctx.source.id } });
					assert.equal((await sourceRow(ctx.source.id)).status, 'imported');
					assert.equal(await storage.exists(ctx.inputPath), false);
				}
			);

			for (const action of ['release', 'finalize']) {
				await t.test(
					`${mode}: auth_success reselection fences old owned ${action}`,
					async (t) => {
						const ctx = await seed(mode);
						t.after(async () => {
							await db
								.delete(schema.ingestionSources)
								.where(eq(schema.ingestionSources.id, ctx.source.id));
						});
						let jobs;
						dispatch = async (batch) => {
							jobs = batch;
						};
						await master({ data: { ingestionSourceId: ctx.source.id } });
						for (const job of jobs) await processMailboxProcessor(job);
						const [old] = await sessionsFor(ctx.source.id);
						assert.equal(old.uploadReceipt.inputClaim, 'owned');
						assert.equal(old.uploadReceipt.disposition, undefined);
						await IngestionService.update(ctx.source.id, {
							providerConfig: {
								type: 'eml_import',
								uploadedFilePath: ctx.inputPath,
								uploadedFileName: 'Selected again.zip',
							},
						});
						const selected = await IngestionService.findById(ctx.source.id);
						assert.equal(
							await new EMLConnector(selected.credentials).testConnection(),
							true
						);
						await IngestionService.update(ctx.source.id, { status: 'auth_success' });
						assert.ok(
							scheduled.some(
								(job) =>
									job.name === 'initial-import' &&
									job.data.ingestionSourceId === ctx.source.id
							)
						);
						const before = await sourceRow(ctx.source.id);
						assert.deepEqual(before.lastSyncStartedAt, selected.lastSyncStartedAt);
						assert.equal((await sessionsFor(ctx.source.id)).length, 1);
						if (action === 'release') {
							assert.equal(
								await IngestionService.releaseCompletedUpload(old.id),
								false
							);
						} else {
							await finish({ data: { ...jobs[0].data, isInitialImport: true } });
						}
						assert.deepEqual(await sourceRow(ctx.source.id), before);
						assert.deepEqual(await buffer(await storage.get(ctx.inputPath)), ctx.bytes);
						assert.equal(
							(await sessionsFor(ctx.source.id))[0].uploadReceipt.inputClaim,
							'owned'
						);
						dispatch = async (batch) => {
							for (const job of batch) await processMailboxProcessor(job);
							await finish({ data: { ...batch[0].data, isInitialImport: true } });
						};
						await initial({ data: { ingestionSourceId: ctx.source.id } });
						assert.equal((await sourceRow(ctx.source.id)).status, 'imported');
						assert.equal(await storage.exists(ctx.inputPath), false);
						await finish({ data: { ...jobs[0].data, isInitialImport: true } });
						assert.equal((await sessionsFor(ctx.source.id)).length, 0);
					}
				);
			}

			for (const state of [
				'finalized',
				'purged',
				'repointed',
				'same-key',
				'missing-current',
				'partial',
			]) {
				await t.test(`${mode}: ${state} before addBulk rejects`, async (t) => {
					const ctx = await seed(mode);
					t.after(async () => {
						await db
							.delete(schema.ingestionSources)
							.where(eq(schema.ingestionSources.id, ctx.source.id));
					});
					let before;
					let originalSessionId;
					const newPath = `open-archiver/tmp/${randomUUID()}-new.zip`;
					dispatch = async (jobs) => {
						originalSessionId = jobs[0].data.sessionId;
						if (state === 'finalized' || state === 'same-key') {
							await complete(jobs);
							assert.equal(await storage.exists(ctx.inputPath), false);
							assert.equal((await sourceRow(ctx.source.id)).status, 'imported');
						}
						if (state === 'same-key') {
							await storage.put(ctx.inputPath, ctx.bytes);
							await IngestionService.update(ctx.source.id, {
								providerConfig: {
									type: 'eml_import',
									uploadedFilePath: ctx.inputPath,
								},
								status: 'importing',
								lastSyncStartedAt: new Date(Date.now() + 1000),
								lastSyncStatusMessage: 'New same-key owner',
							});
						}
						if (state === 'purged')
							await IngestionService.delete(
								ctx.source.id,
								{ id: randomUUID() },
								'fixture'
							);
						if (state === 'repointed') {
							await storage.put(newPath, ctx.bytes);
							await IngestionService.update(ctx.source.id, {
								providerConfig: { type: 'eml_import', uploadedFilePath: newPath },
								status: 'importing',
								lastSyncStatusMessage: 'Replacement owner',
							});
						}
						if (state === 'missing-current')
							await db
								.delete(schema.syncSessions)
								.where(eq(schema.syncSessions.id, originalSessionId));
						if (state === 'partial') await processMailboxProcessor(jobs[0]);
						before = await sourceRow(ctx.source.id);
						throw new Error('Synthetic lost addBulk acknowledgement');
					};
					if (state === 'partial') {
						await assert.rejects(
							master({ data: { ingestionSourceId: ctx.source.id } }),
							/lost addBulk acknowledgement/
						);
						assert.equal((await sourceRow(ctx.source.id)).status, 'error');
						assert.equal(
							(await sessionsFor(ctx.source.id))[0].uploadReceipt.dispatchAborted,
							true
						);
						assert.ok(await storage.exists(ctx.inputPath));
						dispatch = complete;
						await master({ data: { ingestionSourceId: ctx.source.id } });
						assert.equal((await sourceRow(ctx.source.id)).status, 'imported');
						assert.equal(await storage.exists(ctx.inputPath), false);
						return;
					}
					await master({ data: { ingestionSourceId: ctx.source.id } });
					assert.deepEqual(await sourceRow(ctx.source.id), before);
					if (state === 'finalized' || state === 'purged') {
						assert.equal(await storage.exists(ctx.inputPath), false);
					} else {
						assert.deepEqual(await buffer(await storage.get(ctx.inputPath)), ctx.bytes);
					}
					if (state === 'missing-current') {
						assert.equal((await sessionsFor(ctx.source.id)).length, 0);
						assert.ok(
							logs.some(
								(entry) =>
									entry.level === 'error' &&
									entry.args[0]?.ingestionSourceId === ctx.source.id &&
									entry.args[0]?.reason === 'missing-current-receipt' &&
									entry.args[1].includes('unknown')
							)
						);
						await db
							.update(schema.ingestionSources)
							.set({ lastSyncStartedAt: new Date(0) })
							.where(eq(schema.ingestionSources.id, ctx.source.id));
						await SyncSessionService.cleanStaleSessions(1000);
						assert.equal((await sourceRow(ctx.source.id)).status, 'error');
						assert.ok(await storage.exists(ctx.inputPath));
						dispatch = complete;
						await master({ data: { ingestionSourceId: ctx.source.id } });
						assert.equal((await sourceRow(ctx.source.id)).status, 'imported');
						assert.equal(await storage.exists(ctx.inputPath), false);
					}
				});
			}

			for (const tie of [false, true]) {
				await t.test(
					`${mode}: newer claim between compensation and catch${tie ? ' with equal epoch' : ''}`,
					async (t) => {
						const ctx = await seed(mode);
						t.after(async () => {
							await db
								.delete(schema.ingestionSources)
								.where(eq(schema.ingestionSources.id, ctx.source.id));
						});
						const abort = SyncSessionService.abortUploadDispatch;
						let before;
						SyncSessionService.abortUploadDispatch = async function (...args) {
							const result = await abort.apply(this, args);
							const old = await sourceRow(ctx.source.id);
							const claim = tie ? old.lastSyncStartedAt : new Date(Date.now() + 1000);
							await db
								.update(schema.ingestionSources)
								.set({
									status: 'importing',
									lastSyncStartedAt: claim,
									lastSyncStatusMessage: 'New same-key retry',
								})
								.where(eq(schema.ingestionSources.id, ctx.source.id));
							await SyncSessionService.create(ctx.source.id, 2, true, {
								inputPath: ctx.inputPath,
								expectedMailboxes: mailboxes,
							});
							before = await sourceRow(ctx.source.id);
							return result;
						};
						dispatch = async () => {
							throw new Error('Synthetic failed current dispatch');
						};
						try {
							await master({ data: { ingestionSourceId: ctx.source.id } });
						} finally {
							SyncSessionService.abortUploadDispatch = abort;
						}
						assert.deepEqual(await sourceRow(ctx.source.id), before);
						assert.ok(await storage.exists(ctx.inputPath));
						const sessions = await sessionsFor(ctx.source.id);
						assert.equal(sessions.length, 1);
						assert.deepEqual(sessions[0].uploadReceipt.results, []);
					}
				);
			}
		}

		await t.test(
			'retryability refuses malformed, mismatched or non-aborted receipts',
			async (t) => {
				const ctx = await seed('initial');
				t.after(async () => {
					await db
						.delete(schema.ingestionSources)
						.where(eq(schema.ingestionSources.id, ctx.source.id));
				});
				const claimed = await IngestionService.claimForImport(ctx.source.id);
				const id = await SyncSessionService.create(ctx.source.id, 2, true, {
					inputPath: ctx.inputPath,
					expectedMailboxes: mailboxes,
				});
				const [row] = await sessionsFor(ctx.source.id);
				const aborted = { ...row.uploadReceipt, dispatchAborted: true };
				const before = await sourceRow(ctx.source.id);
				for (const receipt of [
					null,
					{},
					row.uploadReceipt,
					{ ...aborted, sourceId: randomUUID() },
					{ ...aborted, inputPath: 'other-input.zip' },
					{ ...aborted, expectedMailboxes: [mailboxes[0]] },
					{ ...aborted, discoveryClosed: false },
					{ ...aborted, inputClaim: 'released' },
					{ ...aborted, disposition: 'handled' },
				]) {
					await db
						.update(schema.syncSessions)
						.set({ uploadReceipt: receipt })
						.where(eq(schema.syncSessions.id, id));
					assert.equal(
						await IngestionService.markUploadDispatchFailed(
							ctx.source.id,
							ctx.inputPath,
							claimed.lastSyncStartedAt,
							id,
							{ lastSyncStatusMessage: 'Must not be published' }
						),
						false
					);
					assert.deepEqual(await sourceRow(ctx.source.id), before);
				}
				await db
					.update(schema.syncSessions)
					.set({ uploadReceipt: aborted })
					.where(eq(schema.syncSessions.id, id));
				assert.equal(
					await IngestionService.markUploadDispatchFailed(
						ctx.source.id,
						ctx.inputPath,
						claimed.lastSyncStartedAt,
						id,
						{ lastSyncStatusMessage: 'Verified current aborted dispatch' }
					),
					true
				);
				assert.equal((await sourceRow(ctx.source.id)).status, 'error');
				assert.ok(await storage.exists(ctx.inputPath));
			}
		);
	}
);
