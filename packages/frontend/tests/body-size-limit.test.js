import assert from 'node:assert/strict';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { test } from 'node:test';
import { getRequest } from '@sveltejs/kit/node';

/**
 * @param {number} size
 * @param {import('node:http').IncomingHttpHeaders} headers
 * @param {number} [httpVersionMajor]
 */
function requestWithBody(size, headers, httpVersionMajor = 1) {
	const incoming = new IncomingMessage(new Socket());
	incoming.headers = { 'content-type': 'text/plain', ...headers };
	incoming.httpVersionMajor = httpVersionMajor;
	incoming.method = 'POST';
	incoming.url = '/bounded-body-fixture';
	incoming.push(Buffer.alloc(64, 'a'));
	incoming.push(Buffer.alloc(size - 64, 'b'));
	incoming.push(null);
	return incoming;
}

/** @type {[string, import('node:http').IncomingHttpHeaders, number][]} */
const scenarios = [
	['declared Content-Length', { 'content-length': '256' }, 1],
	['HTTP/1 chunked body', { 'transfer-encoding': 'chunked' }, 1],
	['HTTP/2 body without Content-Length', {}, 2],
];

for (const [name, headers, version] of scenarios) {
	test(`adapter-node rejects an oversized ${name}`, { timeout: 1000 }, async () => {
		const incoming = requestWithBody(256, headers, version);
		try {
			const request = await getRequest({
				request: incoming,
				base: 'http://localhost',
				bodySizeLimit: 128,
			});
			await assert.rejects(request.arrayBuffer(), { status: 413 });
		} finally {
			incoming.destroy();
		}
	});
}

test('adapter-node accepts a streamed body exactly at the configured limit', async () => {
	const request = await getRequest({
		request: requestWithBody(128, { 'transfer-encoding': 'chunked' }),
		base: 'http://localhost',
		bodySizeLimit: 128,
	});
	assert.equal((await request.arrayBuffer()).byteLength, 128);
});
