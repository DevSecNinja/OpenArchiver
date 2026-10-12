const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { runInThisContext } = require('node:vm');
const { buffer } = require('node:stream/consumers');

const parserPath = require.resolve('nodemailer/lib/addressparser');
const helperPath = require.resolve('../dist/helpers/emlUtils');
const digest = (filename) => createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
const originalHashes = [parserPath, helperPath].map(digest);
let measurement;

// Count logical accumulator work without replacing either upstream operation.
// Unknown implementations fail closed so dependency updates require an explicit review.
const originalLoader = Module._extensions['.js'];
Module._extensions['.js'] = function (loadedModule, filename) {
	if (filename !== parserPath) return originalLoader(loadedModule, filename);
	const source = fs.readFileSync(filename, 'utf8');
	const sites = [
		[
			'parsedAddresses = parsedAddresses.concat(address);',
			'parsedAddresses.length + address.length',
		],
		['parsedAddresses.push(handled[i]);', '1'],
	].filter(([site]) => source.includes(site));
	assert.equal(sites.length, 1, 'Expected a reviewed address accumulator');
	const [site, work] = sites[0];
	assert.equal(source.split(site).length - 1, 1);
	loadedModule._compile(
		source.replace(
			site,
			`globalThis.__oaComposerWork(parsedAddresses.length, ${work}); ${site}`
		),
		filename
	);
};
globalThis.__oaComposerWork = (before, work) => {
	if (measurement?.composerCalls) measurement.events.push({ before, work });
};
let stripAttachmentsFromEml;
let MailComposer;
try {
	({ stripAttachmentsFromEml } = require(helperPath));
	MailComposer = require('nodemailer/lib/mail-composer');
} finally {
	Module._extensions['.js'] = originalLoader;
}
const originalCompile = MailComposer.prototype.compile;
MailComposer.prototype.compile = function (...args) {
	if (measurement) measurement.composerCalls++;
	return originalCompile.apply(this, args);
};
const { simpleParser } = require('mailparser');
const binary = Buffer.from([0, 255, 128, 13, 10, 65]);
const inline = Buffer.from('small synthetic inline resource');

function fixture(count = 4, { attachment = true, image = false, encoded = false } = {}) {
	assert.ok([4, 8, 16, 32].includes(count));
	const addresses = Array.from({ length: count }, (_, i) => `recipient${i}@example.invalid`);
	const raw = Buffer.from(
		[
			`From: ${encoded ? '=?UTF-8?Q?Ren=C3=A9?=' : 'Synthetic Sender'} <sender@example.invalid>`,
			`To: ${addresses.map((address, i) => `${encoded ? '=?UTF-8?Q?Zo=C3=AB?=' : 'Recipient'} ${i} <${address}>`).join(', ')}`,
			'Cc: "Quoted, Name" <cc@example.invalid>',
			'Reply-To: =?UTF-8?Q?Andr=C3=A9?= <reply@example.invalid>',
			'Subject: =?UTF-8?Q?Bounded_caf=C3=A9?=',
			'Message-ID: <composer-fixture@example.invalid>',
			'Date: Sun, 11 Oct 2026 06:00:00 +0000',
			'In-Reply-To: <parent@example.invalid>',
			'References: <root@example.invalid> <parent@example.invalid>',
			'X-Archive-Fixture: retained',
			'MIME-Version: 1.0',
			'Content-Type: multipart/mixed; boundary=fixture',
			'',
			'--fixture',
			'Content-Type: multipart/alternative; boundary=alternative',
			'',
			'--alternative',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'Bounded synthetic body.',
			'--alternative',
			'Content-Type: text/html; charset=utf-8',
			'',
			'<p>Bounded synthetic body.</p><img src="cid:synthetic-image">',
			'--alternative--',
			...(image
				? [
						'--fixture',
						'Content-Type: image/png',
						'Content-Disposition: inline; filename=inline.png',
						'Content-ID: <synthetic-image>',
						'Content-Transfer-Encoding: base64',
						'',
						inline.toString('base64'),
					]
				: []),
			...(attachment
				? [
						'--fixture',
						'Content-Type: application/octet-stream',
						'Content-Disposition: attachment; filename=fixture.bin',
						'Content-Transfer-Encoding: base64',
						'',
						binary.toString('base64'),
					]
				: []),
			'--fixture--',
			'',
		].join('\r\n')
	);
	assert.ok(raw.length < 4096, 'Every synthetic message must stay below 4 KiB');
	return { raw, addresses };
}

function assertMetadata(actual, expected) {
	for (const header of ['from', 'to', 'cc', 'replyTo']) {
		assert.deepEqual(actual[header].value, expected[header].value, header);
	}
	for (const header of ['subject', 'messageId', 'inReplyTo', 'references']) {
		assert.deepEqual(actual[header], expected[header], header);
	}
	assert.equal(actual.date.toISOString(), expected.date.toISOString());
	assert.equal(actual.headers.get('x-archive-fixture'), 'retained');
	assert.equal(actual.html.trim(), expected.html.trim());
	assert.equal(actual.text.trim(), expected.text.trim());
}

async function measure(raw) {
	const result = { composerCalls: 0, events: [] };
	measurement = result;
	try {
		result.output = await stripAttachmentsFromEml(raw);
	} finally {
		measurement = undefined;
	}
	return result;
}

describe('compiled mail composer regressions', { timeout: 15000 }, () => {
	let directory;
	let storage;

	before(async () => {
		directory = await fs.promises.mkdtemp(path.join(tmpdir(), 'oa-composer-'));
		process.env.STORAGE_TYPE = 'local';
		process.env.STORAGE_LOCAL_ROOT_PATH = directory;
		process.env.STORAGE_ENCRYPTION_KEY = 'ab'.repeat(32);
		process.env.LOG_LEVEL = 'silent';
		const { StorageService } = require('../dist/services/StorageService');
		storage = new StorageService();
	});

	after(async () => {
		MailComposer.prototype.compile = originalCompile;
		delete globalThis.__oaComposerWork;
		assert.deepEqual([parserPath, helperPath].map(digest), originalHashes);
		if (directory) await fs.promises.rm(directory, { recursive: true, force: true });
	});

	it('accumulates ordinary recipient lists with linear logical work through the real helper', async (t) => {
		const samples = [];
		for (const count of [4, 8, 16, 32]) {
			const { raw, addresses } = fixture(count);
			const input = await simpleParser(raw);
			const first = await measure(raw);
			const second = await measure(raw);
			assert.equal(first.composerCalls, 1);
			assert.deepEqual(first.events, second.events, 'Counts must be deterministic');
			const output = await simpleParser(first.output);
			assertMetadata(output, input);
			assert.deepEqual(
				output.to.value.map((entry) => entry.address),
				addresses
			);
			assert.equal(output.attachments.length, 0, 'Must strip, not take the error fallback');
			assert.notDeepEqual(first.output, raw);
			const groups = [];
			for (const event of first.events) {
				if (event.before === 0) groups.push({ count: 0, work: 0 });
				const group = groups.at(-1);
				assert.ok(group);
				assert.equal(event.before, group.count);
				group.count++;
				group.work += event.work;
			}
			const recipients = groups.filter((group) => group.count === count);
			assert.ok(recipients.length > 0, 'Composer must reach the installed address parser');
			samples.push({ recipients: count, work: recipients.map((group) => group.work) });
		}
		t.diagnostic(
			JSON.stringify({ nodemailer: require('nodemailer/package.json').version, samples })
		);
		for (const sample of samples) {
			for (const work of sample.work) {
				assert.equal(work, sample.recipients, 'Recipient accumulation must be linear');
			}
		}
	});

	it('preserves encoded addresses, threading headers, HTML and inline bytes when stripping', async () => {
		const { raw } = fixture(4, { encoded: true, image: true });
		const input = await simpleParser(raw);
		const output = await simpleParser((await measure(raw)).output);
		assertMetadata(output, input);
		assert.equal(output.from.value[0].name, 'Ren\u00e9');
		assert.equal(output.to.value[0].name, 'Zo\u00eb 0');
		assert.equal(output.attachments.length, 1);
		assert.equal(output.attachments[0].cid, 'synthetic-image');
		assert.equal(output.attachments[0].contentDisposition, 'inline');
		assert.deepEqual(output.attachments[0].content, inline);
	});

	it('returns identical bytes and bypasses composition for no-attachment and inline-only mail', async () => {
		for (const image of [false, true]) {
			const { raw } = fixture(32, { attachment: false, image });
			const result = await measure(raw);
			assert.strictEqual(result.output, raw);
			assert.equal(result.composerCalls, 0);
			assert.deepEqual(result.events, []);
		}
	});

	it('stores and retrieves mail and extracted bytes in both actual ingestion preservation branches', async () => {
		for (const preserveOriginalFile of [false, true]) {
			const { raw } = fixture(4, { encoded: true, image: true });
			const parsed = await simpleParser(raw);
			const tempFilePath = path.join(directory, `input-${preserveOriginalFile}.eml`);
			await fs.promises.writeFile(tempFilePath, raw);
			const { service, rows, schema } = loadIngestionBoundary();
			const branchMeasurement = { composerCalls: 0, events: [] };
			measurement = branchMeasurement;
			let result;
			try {
				result = await service.processEmail(
					{
						id: parsed.messageId,
						tempFilePath,
						headers: parsed.headers,
						from: parsed.from.value,
						to: parsed.to.value,
						cc: parsed.cc.value,
						receivedAt: parsed.date,
						subject: parsed.subject,
						attachments: parsed.attachments.map((entry) => ({
							...entry,
							content: preserveOriginalFile ? Buffer.alloc(0) : entry.content,
						})),
					},
					{ id: `source-${preserveOriginalFile}`, preserveOriginalFile },
					storage,
					'recipient0@example.invalid'
				);
			} finally {
				measurement = undefined;
			}
			assert.equal(result.archivedEmailId, 'row-0', JSON.stringify(result));
			assert.equal(branchMeasurement.composerCalls, preserveOriginalFile ? 0 : 1);
			const emailRow = rows.find((entry) => entry.table === schema.archivedEmails).value;
			const retrieved = await buffer(await storage.get(emailRow.storagePath));
			assert.notDeepEqual(
				await fs.promises.readFile(path.join(directory, emailRow.storagePath)),
				retrieved,
				'Stored bytes must be encrypted'
			);
			assert.equal(
				emailRow.storageHashSha256,
				createHash('sha256').update(retrieved).digest('hex')
			);
			assert.equal(emailRow.sizeBytes, retrieved.length);
			assertMetadata(await simpleParser(retrieved), parsed);
			const extracted = rows.filter((entry) => entry.table === schema.attachments);
			if (preserveOriginalFile) {
				assert.deepEqual(retrieved, raw);
				assert.equal(extracted.length, 0);
				assert.equal(
					rows.filter((entry) => entry.table === schema.emailAttachments).length,
					0
				);
			} else {
				assert.equal((await simpleParser(retrieved)).attachments.length, 1);
				assert.equal(extracted.length, 2);
				for (const entry of extracted) {
					const bytes = await buffer(await storage.get(entry.value.storagePath));
					assert.deepEqual(
						bytes,
						entry.value.filename === 'fixture.bin' ? binary : inline
					);
				}
				assert.equal(
					rows.filter((entry) => entry.table === schema.emailAttachments).length,
					2
				);
			}
			await assert.rejects(fs.promises.access(tempFilePath), { code: 'ENOENT' });
		}
	});

	it('loads the IMAP client and parses synthetic source in both modes without connecting', async () => {
		const { ImapConnector } = require('../dist/services/ingestion-connectors/ImapConnector');
		const { ImapFlow } = require('imapflow');
		const connector = new ImapConnector({
			host: 'mail.example.invalid',
			port: 993,
			secure: true,
			username: 'synthetic@example.invalid',
			password: 'synthetic-unused-password',
		});
		const client = await connector.createClient();
		assert.ok(client instanceof ImapFlow);
		assert.equal(client.options.secure, true);
		assert.equal(client.options.tls.rejectUnauthorized, true);
		assert.equal(client.options.proxy, undefined);
		for (const method of ['connect', 'logout', 'list', 'mailboxOpen', 'fetchOne', 'fetch']) {
			assert.equal(typeof client[method], 'function', method);
		}
		const { raw } = fixture(4, { encoded: true, image: true });
		for (const preserveOriginalFile of [false, true]) {
			const parser = new ImapConnector({}, { preserveOriginalFile });
			const email = await parser.parseMessage({ source: raw, uid: 1 }, 'INBOX');
			try {
				assert.deepEqual(await fs.promises.readFile(email.tempFilePath), raw);
				assert.equal(email.from[0].name, 'Ren\u00e9');
				assert.equal(email.attachments.length, 2);
				for (const attachment of email.attachments) {
					assert.deepEqual(
						attachment.content,
						preserveOriginalFile
							? Buffer.alloc(0)
							: attachment.filename === 'fixture.bin'
								? binary
								: inline
					);
				}
			} finally {
				await fs.promises.unlink(email.tempFilePath);
			}
		}
	});
});

function loadIngestionBoundary() {
	const filename = require.resolve('../dist/services/IngestionService');
	const localRequire = Module.createRequire(filename);
	const schema = localRequire('../database/schema');
	const rows = [];
	// Real compiled ingestion/storage/helper code; only DB results and eager infrastructure
	// are inert. This deliberately covers fresh ingestion, not deduplication or retries.
	const db = {
		query: {
			archivedEmails: { findFirst: async () => undefined },
			attachments: { findFirst: async () => undefined },
		},
		insert(table) {
			assert.ok(
				[schema.archivedEmails, schema.attachments, schema.emailAttachments].includes(table)
			);
			return {
				values(value) {
					const id = `row-${rows.length}`;
					rows.push({ table, value });
					return {
						returning: async () => [{ id, ...value }],
						onConflictDoNothing: async () => undefined,
					};
				},
			};
		},
	};
	const imports = {
		'../database': { db },
		'../database/schema': schema,
		'./AuditService': { AuditService: class {} },
	};
	for (const name of [
		'drizzle-orm',
		'crypto',
		'fs/promises',
		'../config/logger',
		'../config/index',
		'../helpers/emlUtils',
		'../helpers/emailAddress',
		'../helpers/relativePath',
		'../helpers/truncateToBytes',
		'../helpers/mapWithConcurrency',
		'../helpers/streamToBuffer',
		'./storage/errors',
	]) {
		imports[name] = localRequire(name);
	}
	const unavailable = new Proxy(
		{},
		{ get: () => assert.fail('Unexpected infrastructure access') }
	);
	const module = { exports: {} };
	runInThisContext(Module.wrap(fs.readFileSync(filename, 'utf8')), { filename })(
		module.exports,
		(name) => imports[name] ?? unavailable,
		module,
		filename,
		path.dirname(filename)
	);
	const service = new module.exports.IngestionService();
	service.resolveGroupSourceIds = async (source) => [source.id];
	return { service, rows, schema };
}
