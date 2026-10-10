import assert from 'node:assert/strict';
import test from 'node:test';
import { mockS3 } from './s3-fixture.mjs';

const listing = (keys, more = false, token = '') => ({
	body: `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>${more}</IsTruncated>${token ? `<NextContinuationToken>${token}</NextContinuationToken>` : ''}${keys.map((key) => `<Contents><Key>${key}</Key><Size>1</Size></Contents>`).join('')}</ListBucketResult>`,
});

test('prefix deletion follows continuation tokens beyond 1000 objects', async (t) => {
	const batches = [];
	const tokens = [];
	const requests = [];
	const firstPage = Array.from({ length: 1000 }, (_, i) => `archive/${i}.eml`);
	const provider = await mockS3(t, ({ method, url, body }) => {
		requests.push(method);
		if (method === 'GET') {
			assert.equal(url.searchParams.get('prefix'), 'archive/');
			assert.equal(url.searchParams.get('max-keys'), '1000');
			const token = url.searchParams.get('continuation-token');
			tokens.push(token);
			return token ? listing(['archive/last.eml']) : listing(firstPage, true, 'page-2');
		}
		assert.equal(method, 'POST');
		assert.ok(url.searchParams.has('delete'));
		batches.push([...body.toString().matchAll(/<Key>(.*?)<\/Key>/g)].map((match) => match[1]));
		return { body: '<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"/>' };
	});
	await provider.delete('archive/');
	assert.deepEqual(tokens, [null, 'page-2']);
	assert.deepEqual(batches, [firstPage, ['archive/last.eml']]);
	assert.deepEqual(requests, ['GET', 'POST', 'GET', 'POST']);
});

test('HTTP 200 per-object delete errors reject instead of reporting success', async (t) => {
	const requests = [];
	const provider = await mockS3(t, ({ method }) => {
		requests.push(method);
		return method === 'GET'
			? listing(['archive/deleted.eml', 'archive/denied.eml'], true, 'page-2')
			: {
					body: '<DeleteResult><Deleted><Key>archive/deleted.eml</Key></Deleted><Error><Key>archive/denied.eml</Key><Code>AccessDenied</Code><Message>Synthetic denial</Message></Error></DeleteResult>',
				};
	});
	await assert.rejects(provider.delete('archive/'), /S3 failed to delete 1 object/);
	assert.deepEqual(requests, ['GET', 'POST']);
});

test('an empty prefix result does not send DeleteObjects', async (t) => {
	let requests = 0;
	const provider = await mockS3(t, ({ method }) => {
		requests++;
		assert.equal(method, 'GET');
		return listing([]);
	});
	await provider.delete('empty/');
	assert.equal(requests, 1);
});

test('a truncated listing without a continuation token fails explicitly', async (t) => {
	const provider = await mockS3(t, () => listing([], true));
	await assert.rejects(provider.delete('archive/'), /continuation token/);
});

test('a failed later list page rejects after the first batch, without silently stopping', async (t) => {
	let deleted = 0;
	const provider = await mockS3(t, ({ method, url }) => {
		if (method === 'POST') {
			deleted++;
			return { body: '<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"/>' };
		}
		return url.searchParams.has('continuation-token')
			? { status: 403, body: '<Error><Code>AccessDenied</Code></Error>' }
			: listing(['archive/first.eml'], true, 'page-2');
	});
	await assert.rejects(provider.delete('archive/'), { name: 'AccessDenied' });
	assert.equal(deleted, 1);
});

test('a failed DeleteObjects request rejects', async (t) => {
	const provider = await mockS3(t, ({ method }) =>
		method === 'GET'
			? listing(['archive/denied.eml'])
			: { status: 403, body: '<Error><Code>AccessDenied</Code></Error>' }
	);
	await assert.rejects(provider.delete('archive/'), { name: 'AccessDenied' });
});

test('cycling continuation tokens cannot keep deletion running indefinitely', async (t) => {
	let pages = 0;
	const provider = await mockS3(t, () => {
		pages++;
		return listing([], true, pages % 2 ? 'a' : 'b');
	});
	await assert.rejects(provider.delete('archive/'), /continuation token/);
	assert.equal(pages, 3);
});

test('a repeated continuation token fails explicitly', async (t) => {
	let pages = 0;
	const provider = await mockS3(t, () => {
		pages++;
		return listing([], true, 'same-page');
	});
	await assert.rejects(provider.delete('archive/'), /continuation token/);
	assert.equal(pages, 2);
});

test('an empty truncated page continues to the next page without an empty delete', async (t) => {
	const requests = [];
	const provider = await mockS3(t, ({ method, url, body }) => {
		requests.push(method);
		if (method === 'GET') {
			const token = url.searchParams.get('continuation-token');
			if (!token) return listing([], true, 'page-2');
			assert.equal(token, 'page-2');
			return listing(['archive/last.eml']);
		}
		assert.match(body.toString(), /<Key>archive\/last.eml<\/Key>/);
		return { body: '<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"/>' };
	});
	await provider.delete('archive/');
	assert.deepEqual(requests, ['GET', 'GET', 'POST']);
});

test('prefix deletion does not add a separator or narrow to an exact key', async (t) => {
	const keys = ['archive', 'archive.eml', 'archive/child.eml', 'archive-other.eml'];
	let deleted;
	const provider = await mockS3(t, ({ method, url, body }) => {
		if (method === 'GET') {
			assert.equal(url.searchParams.get('prefix'), 'archive');
			return listing(keys);
		}
		deleted = [...body.toString().matchAll(/<Key>(.*?)<\/Key>/g)].map((match) => match[1]);
		return { body: '<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"/>' };
	});
	await provider.delete('archive');
	assert.deepEqual(deleted, keys);
});

test('an oversized listing fails before sending a delete batch', async (t) => {
	let requests = 0;
	const provider = await mockS3(t, ({ method }) => {
		requests++;
		assert.equal(method, 'GET');
		return listing(Array.from({ length: 1001 }, (_, i) => `archive/${i}.eml`));
	});
	await assert.rejects(provider.delete('archive/'), /requested deletion batch size/);
	assert.equal(requests, 1);
});

test('a listing entry without a key fails before sending a delete batch', async (t) => {
	let requests = 0;
	const provider = await mockS3(t, ({ method }) => {
		requests++;
		assert.equal(method, 'GET');
		return {
			body: '<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>archive/valid.eml</Key></Contents><Contents><Size>1</Size></Contents></ListBucketResult>',
		};
	});
	await assert.rejects(provider.delete('archive/'), /object without a key/);
	assert.equal(requests, 1);
});
