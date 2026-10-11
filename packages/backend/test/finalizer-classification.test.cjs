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
const { eq } = require('drizzle-orm');
const schema = require('../dist/database/schema');

const databaseUrl = process.env.STORAGE_AUTH_TEST_DATABASE_URL;
if (process.env.CI) assert.ok(databaseUrl, 'CI must configure STORAGE_AUTH_TEST_DATABASE_URL');

test(
	'compiled finalizer fails closed until session classification succeeds',
	{
		skip: databaseUrl ? false : 'Set STORAGE_AUTH_TEST_DATABASE_URL for PostgreSQL coverage',
		timeout: 30_000,
	},
	async (t) => {
		const url = new URL(databaseUrl);
		assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
		assert.equal(url.pathname, '/postgres');
		const databaseName = `oa_classification_${randomUUID().replaceAll('-', '')}`;
		const admin = postgres(url.toString(), { max: 1, connect_timeout: 5 });
		const fixture = await fs.mkdtemp(path.join(tmpdir(), 'oa-classification-'));
		const restores = [];
		let client;
		let created = false;
		t.after(async () => {
			for (const restore of restores.reverse()) restore();
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
		client = postgres(url.toString(), { max: 1, connect_timeout: 5 });
		const db = drizzle(client, { schema });
		await migrate(db, { migrationsFolder: path.join(__dirname, '../src/database/migrations') });
		process.env.STORAGE_TYPE = 'local';
		process.env.STORAGE_LOCAL_ROOT_PATH = fixture;
		process.env.ENCRYPTION_KEY = 'ef'.repeat(32);
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
		provide('../dist/jobs/queues', { ingestionQueue: {}, indexingQueue: {} });
		provide('../dist/jobs/helpers/workerLiveness', {});
		for (const name of ['EmailProviderFactory', 'SearchService']) {
			provide(`../dist/services/${name}`, {
				[name]: new Proxy(function () {}, {
					get: () => assert.fail(`${name} must not run during classification`),
					construct: () => assert.fail(`${name} must not run during classification`),
				}),
			});
		}
		const { IngestionService } = require('../dist/services/IngestionService');
		const { SyncSessionService } = require('../dist/services/SyncSessionService');
		const { CryptoService } = require('../dist/services/CryptoService');
		const finish = require('../dist/jobs/processors/sync-cycle-finished.processor').default;
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
		async function seed(provider, newer = false) {
			const sourceId = randomUUID();
			const inputPath = `open-archiver/tmp/${sourceId}.zip`;
			await db.insert(schema.ingestionSources).values({
				id: sourceId,
				name: 'Classification fixture',
				provider,
				status: newer ? 'syncing' : 'importing',
				lastSyncStartedAt: new Date(newer ? 3000 : 1000),
				lastSyncFinishedAt: new Date(500),
				lastSyncStatusMessage: 'Current claim must be preserved',
				credentials: CryptoService.encryptObject(
					provider === 'eml_import'
						? { type: provider, uploadedFilePath: inputPath }
						: { type: provider, username: 'synthetic' }
				),
			});
			const [session] = await db
				.insert(schema.syncSessions)
				.values({
					ingestionSourceId: sourceId,
					isInitialImport: true,
					totalMailboxes: 1,
					completedMailboxes: 0,
					failedMailboxes: 1,
					errorMessages: ['Original failure'],
					createdAt: new Date(2000),
					uploadReceipt:
						provider === 'eml_import'
							? {
									version: 1,
									sourceId,
									inputPath,
									discoveryClosed: true,
									inputClaim: 'owned',
									expectedMailboxes: ['a@example.test'],
									results: [{ mailbox: 'a@example.test', outcome: 'failure' }],
								}
							: null,
				})
				.returning();
			return { sourceId, sessionId: session.id };
		}
		const jobFor = (ctx) => ({
			data: {
				ingestionSourceId: ctx.sourceId,
				sessionId: ctx.sessionId,
				isInitialImport: true,
			},
		});

		for (const newer of [false, true]) {
			await t.test(
				`classification failure preserves ${newer ? 'newer' : 'original'} upload claim`,
				async () => {
					const ctx = await seed('eml_import', newer);
					const beforeSource = await sourceRow(ctx.sourceId);
					const beforeSessions = await sessionsFor(ctx.sourceId);
					const find = SyncSessionService.findById;
					const classify = SyncSessionService.completionState;
					let found = false;
					SyncSessionService.findById = async function (id) {
						const result = await find.call(this, id);
						found = true;
						return result;
					};
					SyncSessionService.completionState = async () => {
						assert.equal(
							found,
							true,
							'Inject only after the real session read succeeds'
						);
						throw new Error('Synthetic classification read failure');
					};
					try {
						await finish(jobFor(ctx));
					} finally {
						SyncSessionService.findById = find;
						SyncSessionService.completionState = classify;
					}
					assert.equal(found, true);
					assert.deepEqual(await sourceRow(ctx.sourceId), beforeSource);
					assert.deepEqual(await sessionsFor(ctx.sourceId), beforeSessions);
				}
			);
		}

		await t.test(
			'known remote-provider failure keeps its existing error finalization',
			async () => {
				const ctx = await seed('generic_imap');
				const find = IngestionService.findById;
				IngestionService.findById = async () => {
					IngestionService.findById = find;
					throw new Error('Synthetic failure after remote classification');
				};
				try {
					await finish(jobFor(ctx));
				} finally {
					IngestionService.findById = find;
				}
				const source = await sourceRow(ctx.sourceId);
				assert.equal(source.status, 'error');
				assert.equal(
					source.lastSyncStatusMessage,
					'An unexpected error occurred while finalizing the sync cycle.'
				);
				assert.ok(source.lastSyncFinishedAt > new Date(500));
				assert.equal((await sessionsFor(ctx.sourceId)).length, 0);
			}
		);
	}
);
