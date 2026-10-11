const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { test } = require('node:test');
const postgres = require('postgres');
const { drizzle } = require('drizzle-orm/postgres-js');
const { migrate } = require('drizzle-orm/postgres-js/migrator');
const { eq, inArray } = require('drizzle-orm');
const schema = require('../dist/database/schema');

const databaseUrl = process.env.STORAGE_AUTH_TEST_DATABASE_URL;
if (process.env.CI) assert.ok(databaseUrl, 'CI must configure STORAGE_AUTH_TEST_DATABASE_URL');

test(
	'upload lifecycle retains delete audits and bounded actionable diagnostics',
	{ skip: databaseUrl ? false : 'Set STORAGE_AUTH_TEST_DATABASE_URL', timeout: 30_000 },
	async (t) => {
		const url = new URL(databaseUrl);
		assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
		assert.equal(url.pathname, '/postgres');
		const name = `oa_audit_diagnostic_${randomUUID().replaceAll('-', '')}`;
		const admin = postgres(url.toString(), { max: 1, connect_timeout: 5 });
		const fixture = await fs.mkdtemp(path.join(tmpdir(), 'oa-audit-diagnostic-'));
		const restores = [];
		let client;
		let created = false;
		t.after(async () => {
			for (const restore of restores.reverse()) restore();
			try {
				if (client) await client.end({ timeout: 5 });
				if (created) await admin`DROP DATABASE ${admin(name)}`;
			} finally {
				await admin.end({ timeout: 5 });
				await fs.rm(fixture, { recursive: true, force: true });
			}
		});
		await admin`CREATE DATABASE ${admin(name)}`;
		created = true;
		url.pathname = `/${name}`;
		client = postgres(url.toString(), { max: 2, connect_timeout: 5 });
		const db = drizzle(client, { schema });
		await migrate(db, { migrationsFolder: path.join(__dirname, '../src/database/migrations') });
		process.env.STORAGE_TYPE = 'local';
		process.env.STORAGE_LOCAL_ROOT_PATH = fixture;
		process.env.ENCRYPTION_KEY = 'ac'.repeat(32);
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
		let getJobs = async () => [];
		provide('../dist/jobs/queues', {
			ingestionQueue: { getJobs: (...args) => getJobs(...args) },
			indexingQueue: {},
		});
		provide('../dist/jobs/helpers/workerLiveness', {});
		provide('../dist/services/EmailProviderFactory', {});
		provide('../dist/services/SearchService', {
			SearchService: class {
				async deleteDocumentsByFilter() {
					return { taskUid: 1 };
				}
				async waitForTask() {}
			},
		});
		const { IngestionService } = require('../dist/services/IngestionService');
		const { SyncSessionService } = require('../dist/services/SyncSessionService');
		const { StorageService } = require('../dist/services/StorageService');
		const { CryptoService } = require('../dist/services/CryptoService');
		const { AuditService } = require('../dist/services/AuditService');
		const finish = require('../dist/jobs/processors/sync-cycle-finished.processor').default;
		const { truncateToBytes } = require('../dist/helpers/truncateToBytes');
		const storage = new StorageService();
		const actor = { id: randomUUID(), email: 'actor@example.test' };
		const sourceRows = (ids) =>
			db
				.select()
				.from(schema.ingestionSources)
				.where(inArray(schema.ingestionSources.id, ids));
		const audits = (ids) =>
			db.select().from(schema.auditLogs).where(inArray(schema.auditLogs.targetId, ids));
		async function source(mergedIntoId) {
			const [row] = await db
				.insert(schema.ingestionSources)
				.values({
					name: `Audit fixture ${randomUUID()}`,
					provider: 'eml_import',
					mergedIntoId,
					credentials: CryptoService.encryptObject({ type: 'eml_import' }),
				})
				.returning();
			return row;
		}

		for (const failure of ['getJobs', 'remove']) {
			await t.test(
				`committed root and child deletes are audited before ${failure} failure`,
				async () => {
					const root = await source();
					const child = await source(root.id);
					const rows = [root, child];
					const ids = rows.map((row) => row.id);
					const retained = `open-archiver/${root.id}/retained.eml`;
					await storage.put(retained, Buffer.from('Cleanup not reached'));
					let observedAuditCount;
					const fail = async () => {
						assert.equal((await sourceRows(ids)).length, 0);
						observedAuditCount = (await audits(ids)).length;
						throw new Error('Synthetic queued cancellation failure');
					};
					getJobs =
						failure === 'getJobs'
							? fail
							: async () => [
									{
										id: 'synthetic-job',
										data: { ingestionSourceId: child.id },
										remove: fail,
									},
								];
					try {
						await assert.rejects(
							IngestionService.delete(root.id, actor, '127.0.0.1'),
							/queued cancellation failure/
						);
					} finally {
						getJobs = async () => [];
					}
					assert.equal((await sourceRows(ids)).length, 0);
					assert.equal(
						observedAuditCount,
						2,
						'All committed source audits precede cancellation'
					);
					assert.ok(await storage.exists(retained));
					const records = await audits(ids);
					assert.equal(records.length, 2);
					for (const row of rows) {
						const record = records.find((entry) => entry.targetId === row.id);
						assert.ok(record);
						assert.equal(record.actionType, 'DELETE');
						assert.equal(record.targetType, 'IngestionSource');
						assert.equal(record.actorIdentifier, actor.id);
						assert.equal(record.actorIp, '127.0.0.1');
						assert.deepEqual(record.details, { sourceName: row.name });
					}
					assert.equal((await new AuditService().verifyAuditLog()).ok, true);
				}
			);
		}

		for (const failure of ['rollback', 'reference-refusal']) {
			await t.test(`${failure} leaves root/child rows without delete audits`, async () => {
				const root = await source();
				const child = await source(root.id);
				const ids = [root.id, child.id];
				if (failure === 'rollback') {
					await client`CREATE FUNCTION reject_audit_fixture_delete() RETURNS trigger LANGUAGE plpgsql AS $$
					BEGIN RAISE EXCEPTION 'Synthetic rollback'; END $$`;
					await client`CREATE TRIGGER reject_audit_fixture_delete BEFORE DELETE ON ingestion_sources
					FOR EACH ROW EXECUTE FUNCTION reject_audit_fixture_delete()`;
				} else {
					const outside = await source();
					const [file] = await db
						.insert(schema.attachments)
						.values({
							ingestionSourceId: child.id,
							filename: 'shared.bin',
							sizeBytes: 1,
							contentHashSha256: '1'.repeat(64),
							storagePath: `open-archiver/${child.id}/shared.bin`,
						})
						.returning();
					const [email] = await db
						.insert(schema.archivedEmails)
						.values({
							ingestionSourceId: outside.id,
							senderEmail: 'sender@example.test',
							userEmail: 'reader@example.test',
							sentAt: new Date(),
							storagePath: 'fixture/outside.eml',
							storageHashSha256: '2'.repeat(64),
							sizeBytes: 1,
						})
						.returning();
					await db
						.insert(schema.emailAttachments)
						.values({ emailId: email.id, attachmentId: file.id });
				}
				getJobs = async () =>
					assert.fail('Cancellation must not precede successful commit');
				try {
					await assert.rejects(
						IngestionService.delete(root.id, actor, '127.0.0.1'),
						failure === 'reference-refusal'
							? /deletion refused/
							: /Failed query|Synthetic rollback/
					);
				} finally {
					getJobs = async () => [];
					if (failure === 'rollback') {
						await client`DROP TRIGGER reject_audit_fixture_delete ON ingestion_sources`;
						await client`DROP FUNCTION reject_audit_fixture_delete()`;
					}
				}
				assert.equal((await sourceRows(ids)).length, 2);
				assert.equal((await audits(ids)).length, 0);
			});
		}

		async function session(mailboxes) {
			const inputPath = `open-archiver/tmp/${randomUUID()}.zip`;
			await storage.put(inputPath, Buffer.from('Synthetic retained input'));
			const [row] = await db
				.insert(schema.ingestionSources)
				.values({
					name: 'Diagnostic fixture',
					provider: 'eml_import',
					status: 'importing',
					credentials: CryptoService.encryptObject({
						type: 'eml_import',
						uploadedFilePath: inputPath,
					}),
				})
				.returning();
			const id = await SyncSessionService.create(row.id, mailboxes.length, true, {
				inputPath,
				expectedMailboxes: mailboxes,
			});
			return { id, sourceId: row.id, inputPath };
		}
		const record = (ctx, mailbox, message) =>
			SyncSessionService.recordMailboxResult(
				ctx.id,
				{ error: true, message },
				{ sourceId: ctx.sourceId, inputPath: ctx.inputPath, mailbox }
			);
		const rowFor = async (ctx) =>
			(
				await db
					.select()
					.from(schema.syncSessions)
					.where(eq(schema.syncSessions.id, ctx.id))
			)[0];
		const finalize = (ctx) =>
			finish({
				data: { ingestionSourceId: ctx.sourceId, sessionId: ctx.id, isInitialImport: true },
			});

		await t.test(
			'parser and storage diagnostics survive duplicate results and final source status',
			async () => {
				const ctx = await session(['a@example.test', 'b@example.test']);
				await record(ctx, 'a@example.test', 'EML parse failed: invalid MIME boundary');
				await record(ctx, 'a@example.test', 'Duplicate must not replace first diagnostic');
				await record(ctx, 'b@example.test', 'Storage upload failed: ENOSPC');
				const state = await rowFor(ctx);
				assert.equal(state.failedMailboxes, 2);
				assert.equal(state.completedMailboxes, 0);
				assert.deepEqual(state.errorMessages, [
					'a@example.test: EML parse failed: invalid MIME boundary',
					'b@example.test: Storage upload failed: ENOSPC',
				]);
				await finalize(ctx);
				const [current] = await sourceRows([ctx.sourceId]);
				assert.equal(current.status, 'error');
				assert.match(current.lastSyncStatusMessage, /invalid MIME boundary/);
				assert.match(current.lastSyncStatusMessage, /ENOSPC/);
				assert.doesNotMatch(current.lastSyncStatusMessage, /Duplicate/);
				assert.equal(await rowFor(ctx), undefined);
				assert.ok(await storage.exists(ctx.inputPath));
			}
		);

		await t.test(
			'diagnostics use a UTF-8 byte bound, normalize unsafe separators and cap notes at five',
			async () => {
				const mailboxes = Array.from({ length: 6 }, (_, i) => `mailbox-${i}@example.test`);
				const ctx = await session(mailboxes);
				const diagnostic = `MBOX storage write failed:\r\n\0 ${'\u{1f4e7}'.repeat(600)}`;
				for (const mailbox of mailboxes) await record(ctx, mailbox, diagnostic);
				const state = await rowFor(ctx);
				assert.equal(state.failedMailboxes, 6);
				assert.equal(state.uploadReceipt.results.length, 6);
				assert.equal(state.errorMessages.length, 5);
				const expected = mailboxes
					.slice(0, 5)
					.map((mailbox) =>
						truncateToBytes(
							`${mailbox}: ${diagnostic.replace(/[\r\n\0]+/g, ' ').trim()}`,
							1024
						)
					);
				assert.deepEqual(state.errorMessages, expected);
				for (const note of state.errorMessages) {
					assert.ok(Buffer.byteLength(note, 'utf8') <= 1024);
					assert.doesNotMatch(note, /[\r\n\0\uFFFD]/);
				}
				await finalize(ctx);
				assert.equal(
					(await sourceRows([ctx.sourceId]))[0].lastSyncStatusMessage,
					`Sync cycle completed with 6 error(s):\n${expected.join('\n')}`
				);
				assert.ok(await storage.exists(ctx.inputPath));
			}
		);

		await t.test(
			'complete notes normalize embedded mailbox separators without changing canonical identity',
			async () => {
				const mailbox = 'a\r\nb@example.test';
				const ctx = await session([mailbox]);
				await record(ctx, mailbox, 'Parser\r\nfailed\0 on input');
				const state = await rowFor(ctx);
				assert.equal(state.uploadReceipt.expectedMailboxes[0], mailbox);
				assert.equal(state.uploadReceipt.results[0].mailbox, mailbox);
				assert.deepEqual(state.errorMessages, [
					'a b@example.test: Parser failed  on input',
				]);
				await finalize(ctx);
				assert.equal(
					(await sourceRows([ctx.sourceId]))[0].lastSyncStatusMessage,
					'Sync cycle completed with 1 error(s):\na b@example.test: Parser failed  on input'
				);
			}
		);

		await t.test(
			'worker-shaped diagnostics retain only their own canonical mailbox prefix',
			async () => {
				for (const [mailbox, message, expected] of [
					[
						'a@example.test',
						'a@example.test: 2 of 3 messages failed to archive',
						'a@example.test: 2 of 3 messages failed to archive',
					],
					[
						'a@example.test',
						'A@EXAMPLE.TEST: storage write failed',
						'A@EXAMPLE.TEST: storage write failed',
					],
					[
						'a@example.test',
						'Storage write failed',
						'a@example.test: Storage write failed',
					],
					[
						'a@example.test',
						'b@example.test: parser failed',
						'a@example.test: b@example.test: parser failed',
					],
					[
						'a@example.test',
						'a@example.test.other: parser failed',
						'a@example.test: a@example.test.other: parser failed',
					],
					[
						'a\r\nb@example.test',
						'A\r\nB@EXAMPLE.TEST:\0 parser failed',
						'A B@EXAMPLE.TEST:  parser failed',
					],
					[
						'a@example.test',
						`a@example.test: ${'\u{1f4e7}'.repeat(600)}`,
						truncateToBytes(`a@example.test: ${'\u{1f4e7}'.repeat(600)}`, 1024),
					],
				]) {
					const ctx = await session([mailbox]);
					await record(ctx, mailbox, message);
					await record(
						ctx,
						mailbox,
						'Duplicate must not replace the original diagnostic'
					);
					const state = await rowFor(ctx);
					assert.deepEqual(state.errorMessages, [expected]);
					assert.ok(Buffer.byteLength(state.errorMessages[0], 'utf8') <= 1024);
					assert.equal(state.uploadReceipt.results[0].mailbox, mailbox);
					await finalize(ctx);
					assert.equal(
						(await sourceRows([ctx.sourceId]))[0].lastSyncStatusMessage,
						`Sync cycle completed with 1 error(s):\n${expected}`
					);
				}
			}
		);

		await t.test(
			'only absent or blank messages use generic fallback and redundant failure cannot spoil success',
			async () => {
				const ctx = await session(['a@example.test', 'b@example.test']);
				await record(ctx, 'a@example.test', undefined);
				await record(ctx, 'b@example.test', ' \r\n\0 ');
				assert.deepEqual((await rowFor(ctx)).errorMessages, [
					'a@example.test: upload mailbox did not complete successfully',
					'b@example.test: upload mailbox did not complete successfully',
				]);
				const complete = await session(['ok@example.test']);
				const identity = {
					sourceId: complete.sourceId,
					inputPath: complete.inputPath,
					mailbox: 'ok@example.test',
				};
				await SyncSessionService.recordMailboxResult(complete.id, {}, identity);
				await record(complete, identity.mailbox, 'Redundant late failure');
				assert.equal((await rowFor(complete)).failedMailboxes, 0);
				assert.deepEqual((await rowFor(complete)).errorMessages, []);
			}
		);
	}
);
