const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { Readable } = require('node:stream');
const { buffer } = require('node:stream/consumers');
const { pipeline } = require('node:stream/promises');
const { describe, it } = require('node:test');
const archiver = require('archiver');
const busboy = require('busboy');
const { simpleParser } = require('mailparser');
const multer = require('multer');
const yauzl = require('yauzl');

const attachment = Buffer.from([0x00, 0xff, 0x80, 0x0d, 0x0a, 0x41, 0x42, 0x43]);
const message = Buffer.from(
	[
		'From: Synthetic Sender <sender@example.test>',
		'To: Synthetic Recipient <recipient@example.test>',
		'Subject: =?UTF-8?Q?Synthetic_caf=C3=A9?=',
		'Message-ID: <parser-regression@example.test>',
		'Date: Sat, 10 Oct 2026 12:00:00 +0000',
		'MIME-Version: 1.0',
		'Content-Type: multipart/mixed; boundary="synthetic-mail"',
		'',
		'--synthetic-mail',
		'Content-Type: text/plain; charset=utf-8',
		'Content-Transfer-Encoding: quoted-printable',
		'',
		'Synthetic caf=C3=A9 body.',
		'--synthetic-mail',
		'Content-Type: application/octet-stream',
		'Content-Disposition: attachment; filename="fixture.bin"',
		'Content-Transfer-Encoding: base64',
		'',
		attachment.toString('base64'),
		'--synthetic-mail--',
		'',
	].join('\r\n')
);
const uploadBoundary = 'synthetic-upload';
const uploadContentType = `multipart/form-data; boundary=${uploadBoundary}`;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function makeZip(entries) {
	const archive = archiver('zip', { zlib: { level: 1 } });
	const result = buffer(archive);
	for (const [name, content] of entries) {
		archive.append(content, { name, date: new Date('2026-10-10T12:00:00Z') });
	}
	const [bytes] = await Promise.all([result, archive.finalize()]);
	return bytes;
}

async function readZip(bytes, decodeStrings = false) {
	const zip = await new Promise((resolve, reject) => {
		yauzl.fromBuffer(bytes, { lazyEntries: true, decodeStrings }, (error, file) => {
			if (error) reject(error);
			else resolve(file);
		});
	});
	try {
		return await new Promise((resolve, reject) => {
			const entries = [];
			zip.once('error', reject);
			zip.once('end', () => resolve(entries));
			zip.on('entry', (entry) => {
				zip.openReadStream(entry, (error, stream) => {
					if (error) {
						reject(error);
						return;
					}
					buffer(stream).then((content) => {
						entries.push({ name: entry.fileName, content });
						zip.readEntry();
					}, reject);
				});
			});
			zip.readEntry();
		});
	} finally {
		zip.close();
	}
}

function multipart(content, filename = 'archive.zip') {
	return Buffer.concat([
		Buffer.from(
			[
				`--${uploadBoundary}`,
				`Content-Disposition: form-data; name="file"; filename="${filename}"`,
				'Content-Type: application/zip',
				'',
				'',
			].join('\r\n')
		),
		content,
		Buffer.from(`\r\n--${uploadBoundary}--\r\n`),
	]);
}

function chunked(bytes) {
	const chunks = [];
	for (let offset = 0; offset < bytes.length; offset += 17) {
		chunks.push(bytes.subarray(offset, offset + 17));
	}
	return Readable.from(chunks, { objectMode: false });
}

async function readBusboy(body, contentType = uploadContentType) {
	const parser = busboy({ headers: { 'content-type': contentType } });
	const files = [];
	parser.on('file', (field, stream, info) => {
		const chunks = [];
		stream.on('data', (chunk) => chunks.push(chunk));
		stream.on('error', (error) => parser.destroy(error));
		stream.on('end', () => files.push({ field, ...info, content: Buffer.concat(chunks) }));
	});
	await pipeline(chunked(body), parser);
	return files;
}

async function readMulter(body, fileSize) {
	const request = chunked(body);
	request.headers = {
		'content-type': uploadContentType,
		'content-length': String(body.length),
	};
	const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize } }).single('file');
	await new Promise((resolve, reject) => {
		upload(request, {}, (error) => {
			if (error) reject(error);
			else resolve();
		});
	});
	return request.file;
}

function assertMessage(parsed) {
	assert.equal(parsed.messageId, '<parser-regression@example.test>');
	assert.equal(parsed.subject, 'Synthetic caf\u00e9');
	assert.equal(parsed.from.value[0].address, 'sender@example.test');
	assert.equal(parsed.to.value[0].address, 'recipient@example.test');
	assert.equal(parsed.date.toISOString(), '2026-10-10T12:00:00.000Z');
	assert.equal(parsed.text.trim(), 'Synthetic caf\u00e9 body.');
	assert.equal(parsed.attachments.length, 1);
	assert.equal(parsed.attachments[0].filename, 'fixture.bin');
	assert.equal(parsed.attachments[0].contentType, 'application/octet-stream');
	assert.equal(parsed.attachments[0].size, attachment.length);
	assert.deepEqual(parsed.attachments[0].content, attachment);
}

describe('mail/upload parser dependency regressions', { timeout: 5000 }, () => {
	it('preserves multipart ZIP bytes, nested EML names and binary attachments on repeated reads', async () => {
		const zip = await makeZip([
			['inbox/nested/message.eml', message],
			['sent/copy.eml', message],
		]);
		const files = await readBusboy(multipart(zip));
		assert.equal(files.length, 1);
		assert.equal(files[0].field, 'file');
		assert.equal(files[0].filename, 'archive.zip');
		assert.deepEqual(files[0].content, zip);

		for (let attempt = 0; attempt < 2; attempt++) {
			const entries = await readZip(files[0].content);
			assert.deepEqual(
				entries.map((entry) => entry.name.toString()),
				['inbox/nested/message.eml', 'sent/copy.eml']
			);
			for (const entry of entries) {
				assert.ok(Buffer.isBuffer(entry.name));
				assert.deepEqual(entry.content, message);
				assert.equal(sha256(entry.content), sha256(message));
				assertMessage(await simpleParser(chunked(entry.content)));
			}
		}
	});

	it('preserves attachment bytes when a MIME closing boundary is missing (lenient parsing)', async () => {
		const truncated = message.subarray(0, message.indexOf('--synthetic-mail--'));
		assertMessage(await simpleParser(truncated));
	});

	it('rejects a failed MIME input stream rather than returning a partial message', async () => {
		const failure = new Error('Synthetic interrupted MIME input');
		const source = Readable.from(
			(async function* () {
				yield message.subarray(0, 100);
				throw failure;
			})()
		);
		await assert.rejects(simpleParser(source), (error) => error === failure);
		assert.equal(source.destroyed, true);
	});

	it('enforces the configured HTML-to-text limit', async () => {
		const html = Buffer.from(
			'Content-Type: text/html; charset=utf-8\r\n\r\n<p>' + 'x'.repeat(64) + '</p>'
		);
		await assert.rejects(simpleParser(html, { maxHtmlLengthToParse: 32 }), /too long/i);
		const parsed = await simpleParser(html, { maxHtmlLengthToParse: 128 });
		assert.equal(parsed.text.trim(), 'x'.repeat(64));
	});

	it('rejects non-ZIP data and a missing ZIP central directory', async () => {
		await assert.rejects(
			readZip(Buffer.from('not a ZIP archive')),
			/end of central directory/i
		);
		const zip = await makeZip([['message.eml', message]]);
		await assert.rejects(
			readZip(zip.subarray(0, zip.length - 22)),
			/end of central directory/i
		);
	});

	it('rejects a deflated entry whose advertised uncompressed size is incorrect', async () => {
		const zip = await makeZip([['message.eml', message]]);
		const centralDirectory = zip.indexOf(Buffer.from('504b0102', 'hex'));
		assert.ok(centralDirectory > 0);
		assert.equal(zip.readUInt16LE(centralDirectory + 10), 8);
		assert.equal(zip.readUInt32LE(centralDirectory + 24), message.length);
		// Change central-directory metadata, not the small compressed payload.
		zip.writeUInt32LE(message.length + 1, centralDirectory + 24);
		await assert.rejects(readZip(zip), /not enough bytes|uncompressed size/i);
	});

	it('distinguishes yauzl default path validation from the connector raw-name option', async () => {
		const zip = await makeZip([['ok/message.eml', message]]);
		const centralDirectory = zip.indexOf(Buffer.from('504b0102', 'hex'));
		assert.ok(centralDirectory > 0);
		assert.equal(zip.toString('utf8', centralDirectory + 46, centralDirectory + 49), 'ok/');
		zip.write('../', centralDirectory + 46);
		await assert.rejects(readZip(zip, true), /invalid relative path/i);
		// EMLConnector uses decodeStrings:false: this is not traversal protection.
		const entries = await readZip(zip);
		assert.equal(entries[0].name.toString(), '../message.eml');
		assert.deepEqual(entries[0].content, message);
	});

	it('strips client-supplied path components with the active Busboy defaults', async () => {
		const files = await readBusboy(multipart(attachment, '../../archive.zip'));
		assert.equal(files.length, 1);
		assert.equal(files[0].filename, 'archive.zip');
		assert.deepEqual(files[0].content, attachment);
	});

	it('rejects multipart requests without a boundary or with a truncated file body', async () => {
		await assert.rejects(readBusboy(Buffer.alloc(0), 'multipart/form-data'), /boundary/i);
		const body = multipart(attachment);
		const fileStart = body.indexOf(attachment);
		assert.ok(fileStart > 0);
		await assert.rejects(
			readBusboy(body.subarray(0, fileStart + 3)),
			/unexpected end of (form|file)/i
		);
	});

	it('smoke-tests declared Multer memory uploads and an explicit file-size limit', async () => {
		const body = multipart(attachment, '../../archive.zip');
		const file = await readMulter(body, attachment.length + 1);
		assert.equal(file.originalname, 'archive.zip');
		assert.equal(file.size, attachment.length);
		assert.deepEqual(file.buffer, attachment);
		await assert.rejects(readMulter(body, attachment.length - 1), {
			name: 'MulterError',
			code: 'LIMIT_FILE_SIZE',
		});
	});
});
