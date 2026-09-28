const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const { simpleParser } = require('mailparser');
const MailComposer = require('nodemailer/lib/mail-composer');
const { stripAttachmentsFromEml } = require('../dist/helpers/emlUtils.js');

for (const [name, modulePath] of [
	['mailparser', require.resolve('mailparser')],
	['nodemailer', require.resolve('nodemailer/lib/addressparser')],
]) {
	test(`${name} accumulates a bounded recipient list without quadratic copying`, () => {
		// Count copied recipients instead of timing CI hardware. Isolate instrumentation and
		// enforce a process timeout: an in-process timer cannot interrupt a blocked parser.
		const output = execFileSync(
			process.execPath,
			[
				'--max-old-space-size=128',
				'-e',
				String.raw`
					const parser = require(process.argv[1]);
					const count = 4096;
					const addresses = Array.from(
						{ length: count },
						(_, i) => 'recipient' + i + '@example.test'
					).join(', ');
					const concat = Array.prototype.concat;
					let copiedRecipients = 0;
					Array.prototype.concat = function (...args) {
						if (this[0] && Object.hasOwn(this[0], 'address')) {
							copiedRecipients += this.length;
						}
						return Reflect.apply(concat, this, args);
					};
					(async () => {
						try {
							const parsed = parser.simpleParser
								? (await parser.simpleParser(
									'From: sender@example.test\r\nTo: ' + addresses +
									'\r\nSubject: Bounded parser regression\r\n\r\nBody\r\n'
								)).to.value
								: parser(addresses);
							console.log(JSON.stringify({
								count, copiedRecipients, length: parsed.length,
								first: parsed[0].address, last: parsed.at(-1).address
							}));
						} finally {
							Array.prototype.concat = concat;
						}
					})().catch(error => { console.error(error); process.exitCode = 1; });
				`,
				modulePath,
			],
			{ encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 }
		);
		const result = JSON.parse(output);
		assert.equal(result.length, result.count);
		assert.equal(result.first, 'recipient0@example.test');
		assert.equal(result.last, `recipient${result.count - 1}@example.test`);
		assert.ok(
			result.copiedRecipients <= result.count * 16,
			`copied ${result.copiedRecipients} recipients for ${result.count} inputs`
		);
	});
}

test('MailComposer and attachment stripping preserve archived mail metadata and inline content', async () => {
	const inlineContent = Buffer.from('bounded inline fixture');
	const raw = await new MailComposer({
		from: { name: 'Archive Sender', address: 'sender@example.test' },
		to: 'Recipient <recipient@example.test>',
		cc: 'copy@example.test',
		replyTo: 'reply@example.test',
		subject: 'Archive compatibility',
		messageId: '<fixture@example.test>',
		inReplyTo: '<parent@example.test>',
		references: ['<parent@example.test>'],
		date: new Date('2026-01-01T12:00:00Z'),
		text: 'Archived plain text',
		html: '<p>Archived HTML</p><img src="cid:inline@example.test">',
		headers: { 'X-Archive-Fixture': 'preserved' },
		attachments: [
			{
				filename: 'inline.png',
				content: inlineContent,
				contentType: 'image/png',
				contentDisposition: 'inline',
				cid: 'inline@example.test',
			},
			{ filename: 'document.txt', content: 'stored separately', contentType: 'text/plain' },
		],
	})
		.compile()
		.build();

	const original = await simpleParser(raw);
	assert.equal(original.attachments.length, 2);
	const stripped = await stripAttachmentsFromEml(raw);
	assert.notDeepEqual(stripped, raw);
	const parsed = await simpleParser(stripped);
	for (const key of [
		'from',
		'to',
		'cc',
		'replyTo',
		'subject',
		'messageId',
		'inReplyTo',
		'date',
	]) {
		assert.deepEqual(parsed[key], original[key], key);
	}
	assert.deepEqual(parsed.references, original.references);
	assert.equal(parsed.headers.get('x-archive-fixture'), 'preserved');
	assert.equal(parsed.text.trim(), 'Archived plain text');
	assert.match(parsed.html, /Archived HTML/);
	assert.equal(parsed.attachments.length, 1);
	assert.equal(parsed.attachments[0].cid, 'inline@example.test');
	assert.deepEqual(parsed.attachments[0].content, inlineContent);
});

test('attachment-free messages remain byte-for-byte unchanged', async () => {
	const raw = Buffer.from(
		'From: sender@example.test\r\nTo: recipient@example.test\r\nSubject: Original\r\n\r\nBody\r\n'
	);
	assert.strictEqual(await stripAttachmentsFromEml(raw), raw);
});
