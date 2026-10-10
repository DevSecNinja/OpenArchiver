const assert = require('node:assert/strict');
const { copyFile, mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const { promisify } = require('node:util');
const sqlite3 = require('sqlite3');

function openDatabase(filename) {
	return new Promise((resolve, reject) => {
		const database = new sqlite3.Database(filename, (error) => {
			if (error) reject(error);
			else resolve(database);
		});
	});
}

async function withDatabase(filename, callback) {
	const database = await openDatabase(filename);
	try {
		await callback({
			exec: promisify(database.exec.bind(database)),
			run: promisify(database.run.bind(database)),
			get: promisify(database.get.bind(database)),
		});
	} finally {
		await promisify(database.close.bind(database))();
	}
}

test('native SQLite creates, writes, queries, updates and closes an in-memory database', async (t) => {
	await withDatabase(':memory:', async ({ exec, run, get }) => {
		await exec('CREATE TABLE messages (id TEXT PRIMARY KEY, subject TEXT NOT NULL, raw BLOB)');
		const raw = Buffer.from('synthetic email\r\nwith binary bytes:\0\x01');
		await run('INSERT INTO messages VALUES (?, ?, ?)', [
			'<native@example.invalid>',
			"Subject with 'quotes'",
			raw,
		]);
		assert.deepEqual(await get('SELECT * FROM messages'), {
			id: '<native@example.invalid>',
			subject: "Subject with 'quotes'",
			raw,
		});
		await run('UPDATE messages SET subject = ? WHERE id = ?', [
			'Updated subject',
			'<native@example.invalid>',
		]);
		assert.deepEqual(await get('SELECT subject, raw FROM messages'), {
			subject: 'Updated subject',
			raw,
		});
		await assert.rejects(
			run('INSERT INTO messages (id, subject) VALUES (?, ?)', [
				'<native@example.invalid>',
				'Duplicate',
			]),
			{ code: 'SQLITE_CONSTRAINT' }
		);
		assert.deepEqual(await get('PRAGMA integrity_check'), { integrity_check: 'ok' });
		const { version } = await get('SELECT sqlite_version() AS version');
		assert.match(version, /^\d+\.\d+\.\d+$/);
		t.diagnostic(`sqlite3 ${require('sqlite3/package.json').version}; SQLite ${version}`);
	});
});

test('closed SQLite files reopen and restore without changing stored bytes', async (t) => {
	const root = await mkdtemp(join(tmpdir(), 'oa-sqlite-native-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const original = join(root, 'original.sqlite');
	const backup = join(root, 'backup.sqlite');
	const raw = Buffer.from('From: fixture@example.invalid\r\n\r\nSynthetic message.\r\n');

	await withDatabase(original, async ({ exec, run }) => {
		await exec('CREATE TABLE messages (id INTEGER PRIMARY KEY, raw BLOB NOT NULL)');
		await run('INSERT INTO messages (id, raw) VALUES (?, ?)', [1, raw]);
	});
	await withDatabase(original, async ({ get }) => {
		assert.deepEqual(await get('SELECT raw FROM messages WHERE id = 1'), { raw });
	});
	// Only copy a closed database: this fixture does not model a live SQLite backup.
	await copyFile(original, backup);
	await rm(original);
	await copyFile(backup, original);
	await withDatabase(original, async ({ get }) => {
		assert.deepEqual(await get('PRAGMA integrity_check'), { integrity_check: 'ok' });
		assert.deepEqual(await get('SELECT raw FROM messages WHERE id = 1'), { raw });
	});
});
