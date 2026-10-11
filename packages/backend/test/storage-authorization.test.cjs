const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const Module = require('node:module');
const path = require('node:path');
const { test } = require('node:test');
const postgres = require('postgres');
const { drizzle } = require('drizzle-orm/postgres-js');
const { migrate } = require('drizzle-orm/postgres-js/migrator');
const schema = require('../dist/database/schema.js');

const databaseUrl = process.env.STORAGE_AUTH_TEST_DATABASE_URL;
if (process.env.CI) {
	assert.ok(databaseUrl, 'CI must configure STORAGE_AUTH_TEST_DATABASE_URL');
}

test(
	'storage-path authorization queries isolated PostgreSQL records',
	{
		skip: databaseUrl ? false : 'Set STORAGE_AUTH_TEST_DATABASE_URL to run PostgreSQL coverage',
		timeout: 60_000,
	},
	async (t) => {
		const url = new URL(databaseUrl);
		assert.ok(
			['localhost', '127.0.0.1', '[::1]'].includes(url.hostname),
			'Storage authorization tests require a loopback PostgreSQL server'
		);
		assert.equal(url.pathname, '/postgres', 'Use the postgres maintenance database');
		const databaseName = `oa_storage_test_${randomUUID().replaceAll('-', '')}`;
		const admin = postgres(url.toString(), { max: 1, connect_timeout: 5 });
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
			}
		});

		await admin`CREATE DATABASE ${admin(databaseName)}`;
		created = true;
		url.pathname = `/${databaseName}`;
		client = postgres(url.toString(), { max: 1, connect_timeout: 5 });
		const db = drizzle(client, { schema });
		await migrate(db, {
			migrationsFolder: path.join(__dirname, '../src/database/migrations'),
		});

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

		// Keep the real driver, schema, IAM, CASL and SQL filters; replace only the connection.
		provideModule('../dist/database/index.js', { db });
		// These unrelated import graphs start queues/providers.
		for (const name of ['StorageService', 'SearchService', 'IngestionService']) {
			const unexpected = () => assert.fail(`${name} must not run in a storage-path check`);
			const unavailable = new Proxy(function () {}, {
				apply: unexpected,
				construct: unexpected,
				get: unexpected,
			});
			provideModule(`../dist/services/${name}.js`, { [name]: unavailable });
		}
		provideModule('../dist/helpers/deletionGuard.js', {
			checkDeletionEnabled: () => assert.fail('Storage-path checks must not delete records'),
		});
		const { ArchivedEmailService } = require('../dist/services/ArchivedEmailService.js');
		const canAccess = (userId, storagePath) =>
			ArchivedEmailService.canAccessStoragePath(storagePath, userId);

		const sourceA = randomUUID();
		const sourceB = randomUUID();
		await db.insert(schema.ingestionSources).values(
			[sourceA, sourceB].map((id) => ({
				id,
				name: `Synthetic ${id}`,
				provider: 'eml_import',
			}))
		);
		async function userWithPolicies(policies) {
			const userId = randomUUID();
			const roleId = randomUUID();
			await db.insert(schema.users).values({ id: userId, email: `${userId}@example.test` });
			await db.insert(schema.roles).values({ id: roleId, name: roleId, policies });
			await db.insert(schema.userRoles).values({ userId, roleId });
			return userId;
		}
		const scopedReader = await userWithPolicies([
			{
				action: 'read',
				subject: 'archive',
				conditions: {
					ingestionSourceId: sourceA,
					userEmail: ' Alice@Example.Test ',
				},
			},
		]);
		const otherReader = await userWithPolicies([
			{
				action: 'read',
				subject: 'archive',
				conditions: { ingestionSourceId: sourceB, userEmail: 'bob@example.test' },
			},
		]);
		const deniedReader = await userWithPolicies([
			{ action: 'read', subject: 'archive', conditions: { ingestionSourceId: sourceA } },
			{
				action: 'read',
				subject: 'archive',
				inverted: true,
				conditions: { userEmail: ' Bob@Example.Test ' },
			},
		]);
		const noAccess = await userWithPolicies([]);
		const searchOnly = await userWithPolicies([{ action: 'search', subject: 'archive' }]);
		const administrator = await userWithPolicies([{ action: 'manage', subject: 'all' }]);

		const records = [];
		for (const ingestionSourceId of [sourceA, sourceB]) {
			for (const mailbox of ['alice', 'bob']) {
				const emailId = randomUUID();
				const attachmentId = randomUUID();
				const emailPath = `fixture/emails/${emailId}.eml`;
				const attachmentPath = `fixture/attachments/${attachmentId}.txt`;
				await db.insert(schema.archivedEmails).values({
					id: emailId,
					ingestionSourceId,
					userEmail: ` ${mailbox.toUpperCase()}@Example.Test `,
					sentAt: new Date('2026-01-01T00:00:00Z'),
					senderEmail: 'sender@example.test',
					storagePath: emailPath,
					storageHashSha256: '0'.repeat(64),
					sizeBytes: 1,
				});
				await db.insert(schema.attachments).values({
					id: attachmentId,
					filename: 'synthetic.txt',
					sizeBytes: 1,
					contentHashSha256: emailId.replaceAll('-', '').repeat(2),
					storagePath: attachmentPath,
					// Authorization belongs to the carrier, not this attachment's source metadata.
					ingestionSourceId: ingestionSourceId === sourceA ? sourceB : sourceA,
				});
				await db.insert(schema.emailAttachments).values({ emailId, attachmentId });
				records.push({ ingestionSourceId, mailbox, emailId, emailPath, attachmentPath });
			}
		}

		await t.test('email paths enforce both source and normalized mailbox scope', async () => {
			for (const record of records) {
				assert.equal(
					await canAccess(scopedReader, record.emailPath),
					record.ingestionSourceId === sourceA && record.mailbox === 'alice',
					record.emailPath
				);
				assert.equal(
					await canAccess(otherReader, record.emailPath),
					record.ingestionSourceId === sourceB && record.mailbox === 'bob',
					record.emailPath
				);
			}
		});
		await t.test('attachment paths authorize the linked carrier email', async () => {
			for (const record of records) {
				assert.equal(
					await canAccess(scopedReader, record.attachmentPath),
					record.ingestionSourceId === sourceA && record.mailbox === 'alice',
					record.attachmentPath
				);
				assert.equal(
					await canAccess(otherReader, record.attachmentPath),
					record.ingestionSourceId === sourceB && record.mailbox === 'bob',
					record.attachmentPath
				);
			}
		});
		await t.test(
			'explicit mailbox denial filters both email and attachment queries',
			async () => {
				for (const record of records) {
					const expected =
						record.ingestionSourceId === sourceA && record.mailbox === 'alice';
					assert.equal(await canAccess(deniedReader, record.emailPath), expected);
					assert.equal(await canAccess(deniedReader, record.attachmentPath), expected);
				}
			}
		);
		await t.test('shared attachments need at least one visible carrier', async () => {
			const attachmentId = randomUUID();
			const storagePath = `fixture/attachments/shared-${attachmentId}.txt`;
			await db.insert(schema.attachments).values({
				id: attachmentId,
				filename: 'shared.txt',
				sizeBytes: 1,
				contentHashSha256: 'f'.repeat(64),
				storagePath,
				ingestionSourceId: sourceB,
			});
			const denied = records.find(
				(record) => record.ingestionSourceId === sourceB && record.mailbox === 'bob'
			);
			await db
				.insert(schema.emailAttachments)
				.values({ emailId: denied.emailId, attachmentId });
			assert.equal(await canAccess(scopedReader, storagePath), false);
			assert.equal(await canAccess(otherReader, storagePath), true);

			const allowed = records.find(
				(record) => record.ingestionSourceId === sourceA && record.mailbox === 'alice'
			);
			await db
				.insert(schema.emailAttachments)
				.values({ emailId: allowed.emailId, attachmentId });
			assert.equal(await canAccess(scopedReader, storagePath), true);
			assert.equal(await canAccess(otherReader, storagePath), true);
		});
		await t.test('read permission is required while administrators retain access', async () => {
			for (const record of records) {
				for (const storagePath of [record.emailPath, record.attachmentPath]) {
					assert.equal(await canAccess(noAccess, storagePath), false);
					assert.equal(await canAccess(searchOnly, storagePath), false);
					assert.equal(await canAccess(administrator, storagePath), true);
				}
			}
		});
		await t.test('missing paths and unreferenced attachments grant no access', async () => {
			const orphanPath = 'fixture/attachments/orphan.txt';
			await db.insert(schema.attachments).values({
				filename: 'orphan.txt',
				sizeBytes: 1,
				contentHashSha256: 'e'.repeat(64),
				storagePath: orphanPath,
				ingestionSourceId: sourceA,
			});
			for (const userId of [scopedReader, administrator]) {
				assert.equal(await canAccess(userId, 'fixture/missing.eml'), false);
				assert.equal(await canAccess(userId, orphanPath), false);
			}
		});
	}
);
