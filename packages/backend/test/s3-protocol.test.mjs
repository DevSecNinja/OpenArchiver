import assert from 'node:assert/strict';
import { buffer } from 'node:stream/consumers';
import test from 'node:test';
import { mockS3, StorageObjectExistsError } from './s3-fixture.mjs';

test('S3 upload, download and existence preserve bytes and missing-object behavior', async (t) => {
	let stored;
	const provider = await mockS3(t, ({ method, url, body }) => {
		assert.ok(url.pathname.startsWith('/test-archive/'));
		if (method === 'PUT') {
			stored = body;
			return { headers: { ETag: '"fixture"' } };
		}
		if (url.pathname.endsWith('/missing')) return { status: 404 };
		if (method === 'HEAD') return {};
		assert.equal(method, 'GET');
		return { body: stored, headers: { 'Content-Type': 'message/rfc822' } };
	});
	const original = Buffer.from('Subject: synthetic\r\n\r\nArchive bytes.\r\n');
	await provider.put('messages/one.eml', original);
	assert.deepEqual(stored, original);
	assert.equal(await provider.exists('messages/one.eml'), true);
	assert.equal(await provider.exists('missing'), false);
	assert.deepEqual(await buffer(await provider.get('messages/one.eml')), original);
});

test('conditional PUT refuses an existing object without overwriting it', async (t) => {
	let requests = 0;
	const provider = await mockS3(t, ({ method, headers }) => {
		requests++;
		assert.equal(method, 'PUT');
		assert.equal(headers['if-none-match'], '*');
		return {
			status: 412,
			body: '<Error><Code>PreconditionFailed</Code><Message>Already exists</Message></Error>',
		};
	});
	await assert.rejects(
		provider.put('existing.eml', Buffer.from('new'), { overwrite: false }),
		StorageObjectExistsError
	);
	assert.equal(requests, 1);
});

test('conditional PUT retries one conflict, retaining the precondition and original bytes', async (t) => {
	let attempts = 0;
	const original = Buffer.from('original');
	const provider = await mockS3(t, ({ method, headers, body }) => {
		attempts++;
		assert.equal(method, 'PUT');
		assert.equal(headers['if-none-match'], '*');
		assert.deepEqual(body, original);
		return attempts === 1
			? { status: 409, body: '<Error><Code>ConditionalRequestConflict</Code></Error>' }
			: { headers: { ETag: '"fixture"' } };
	});
	await provider.put('racing.eml', original, { overwrite: false });
	assert.equal(attempts, 2);
});

test('S3 XML error responses remain failures', async (t) => {
	const provider = await mockS3(t, () => ({
		status: 403,
		body: '<Error><Code>AccessDenied</Code><Message>Synthetic denial</Message></Error>',
	}));
	await assert.rejects(provider.get('denied.eml'), {
		name: 'AccessDenied',
		message: 'Synthetic denial',
	});
});

test('multipart upload preserves all bytes across two parts', async (t) => {
	const parts = new Map();
	let completed = false;
	const provider = await mockS3(t, ({ method, url, body }) => {
		if (method === 'POST' && url.searchParams.has('uploads')) {
			return {
				body: '<InitiateMultipartUploadResult><Bucket>test-archive</Bucket><Key>large.eml</Key><UploadId>fixture-upload</UploadId></InitiateMultipartUploadResult>',
			};
		}
		assert.equal(url.searchParams.get('uploadId'), 'fixture-upload');
		if (method === 'PUT') {
			const number = Number(url.searchParams.get('partNumber'));
			assert.ok(number === 1 || number === 2);
			parts.set(number, body);
			return { headers: { ETag: `"part-${number}"` } };
		}
		assert.equal(method, 'POST');
		assert.match(body.toString(), /CompleteMultipartUpload/);
		completed = true;
		return {
			body: '<CompleteMultipartUploadResult><Bucket>test-archive</Bucket><Key>large.eml</Key><ETag>"fixture-complete"</ETag></CompleteMultipartUploadResult>',
		};
	});
	const partSize = 5 * 1024 * 1024;
	const original = Buffer.alloc(partSize + 123, 0x7f);
	original.fill(0x80, partSize);
	await provider.put('large.eml', original);
	assert.equal(completed, true);
	assert.equal(parts.size, 2);
	assert.equal(parts.get(1)?.length, partSize);
	assert.equal(parts.get(2)?.length, 123);
	assert.deepEqual(Buffer.concat([parts.get(1), parts.get(2)]), original);
});
