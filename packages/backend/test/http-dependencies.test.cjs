const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createServer } = require('node:http');
const { before, after, test } = require('node:test');
const express = require('express');
const axios = require('axios');
const { body, validationResult, matchedData } = require('express-validator');
const { rateLimit, ipKeyGenerator, MemoryStore } = require('express-rate-limit');

const app = express();
const store = new MemoryStore();
const download = Buffer.from('Synthetic archived email\r\n');
app.use(express.json());
app.post(
	'/validate',
	body('mailbox').trim().isEmail(),
	body('limit').isInt({ min: 1, max: 100 }).toInt(),
	(req, res) => {
		const errors = validationResult(req);
		if (!errors.isEmpty()) {
			return res.status(400).json({ errors: errors.array() });
		}
		res.json(matchedData(req));
	}
);
app.get('/async-error', async () => {
	throw new Error('synthetic failure');
});
app.get('/download', (req, res) => {
	res.attachment('synthetic.eml').send(download);
});
app.get('/redirect', (req, res) => res.redirect('/download'));
app.get('/optional/{a}{b}{c}:tail', (req, res) => res.json(req.params));
app.get('/wild/*first-*second-:last', (req, res) => res.json(req.params));
app.get(
	'/limited',
	rateLimit({
		windowMs: 60_000,
		max: 2,
		store,
		keyGenerator: (req) => ipKeyGenerator(req.ip || 'unknown'),
		message: { status: 429, message: 'Synthetic request limit reached' },
		standardHeaders: true,
		legacyHeaders: false,
	}),
	(req, res) => res.json({ ok: true })
);
app.use((error, req, res, next) => {
	res.status(error.status || 500).json({ message: error.message });
});

const server = createServer(app);
let client;

before(async () => {
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	client = axios.create({
		baseURL: `http://127.0.0.1:${server.address().port}`,
		proxy: false,
		timeout: 5_000,
	});
});

after(async () => {
	store.shutdown();
	await new Promise((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
		server.closeAllConnections();
	});
});

test('Express JSON and request validators sanitize valid input and omit unvalidated fields', async () => {
	const response = await client.post('/validate', {
		mailbox: ' allowed@example.test ',
		limit: '2',
		unvalidated: 'not returned',
	});
	assert.equal(response.status, 200);
	assert.deepEqual(response.data, { mailbox: 'allowed@example.test', limit: 2 });
});

test('invalid request fields return 400 and Axios preserves the validation response', async () => {
	await assert.rejects(
		client.post('/validate', { mailbox: 'not-email', limit: '0' }),
		(error) => {
			assert.equal(axios.isAxiosError(error), true);
			assert.equal(error.response.status, 400);
			assert.deepEqual(error.response.data.errors.map(({ path }) => path).sort(), [
				'limit',
				'mailbox',
			]);
			return true;
		}
	);
});

test('malformed JSON is rejected before request validation', async () => {
	await assert.rejects(
		client.post('/validate', '{"mailbox":', {
			headers: { 'Content-Type': 'application/json' },
		}),
		(error) => {
			assert.equal(axios.isAxiosError(error), true);
			assert.equal(error.response.status, 400);
			return true;
		}
	);
});

test('Express forwards rejected async handlers to error middleware', async () => {
	await assert.rejects(client.get('/async-error'), (error) => {
		assert.equal(axios.isAxiosError(error), true);
		assert.equal(error.response.status, 500);
		assert.deepEqual(error.response.data, { message: 'synthetic failure' });
		return true;
	});
});

test('Axios follows a local redirect and streams the attachment bytes unchanged', async () => {
	const response = await client.get('/redirect', { responseType: 'stream', maxRedirects: 1 });
	const chunks = [];
	for await (const chunk of response.data) chunks.push(chunk);
	assert.equal(response.status, 200);
	assert.match(response.headers['content-disposition'], /attachment; filename="synthetic.eml"/);
	assert.deepEqual(Buffer.concat(chunks), download);
});

test('rate limiting admits two requests then returns 429 with standard retry headers', async () => {
	const first = await client.get('/limited');
	assert.equal(first.status, 200);
	assert.equal(first.headers['ratelimit-limit'], '2');
	assert.equal(first.headers['ratelimit-remaining'], '1');
	assert.equal(first.headers['x-ratelimit-limit'], undefined);

	const second = await client.get('/limited');
	assert.equal(second.status, 200);
	assert.equal(second.headers['ratelimit-remaining'], '0');

	await assert.rejects(client.get('/limited'), (error) => {
		assert.equal(axios.isAxiosError(error), true);
		assert.equal(error.response.status, 429);
		assert.deepEqual(error.response.data, {
			status: 429,
			message: 'Synthetic request limit reached',
		});
		assert.equal(error.response.headers['ratelimit-remaining'], '0');
		assert.ok(Number(error.response.headers['retry-after']) > 0);
		assert.ok(Number(error.response.headers['ratelimit-reset']) > 0);
		assert.equal(error.response.headers['x-ratelimit-limit'], undefined);
		return true;
	});
});

test('Express trust compilation keeps IPv4 clients outside unrelated IPv6 CIDRs', () => {
	for (const subnet of ['::ffff:10.0.0.0/8', '::/1']) {
		const trust = express().set('trust proxy', subnet).get('trust proxy fn');
		assert.equal(trust('203.0.113.10'), false, subnet);
		assert.equal(trust('10.1.2.3'), false, subnet);
	}
	for (const subnet of ['10.0.0.0/8', '::ffff:10.0.0.0/104']) {
		const trust = express().set('trust proxy', subnet).get('trust proxy fn');
		assert.equal(trust('10.1.2.3'), true, subnet);
		assert.equal(trust('203.0.113.10'), false, subnet);
	}
	const trust = express().set('trust proxy', '2001:db8::/32').get('trust proxy fn');
	assert.equal(trust('2001:db8::1'), true);
	assert.equal(trust('2001:db9::1'), false);
	assert.equal(trust('203.0.113.10'), false);
});

test('Express bounds optional route expansion and preserves optional/wildcard parameters', async () => {
	assert.throws(
		() => express().get(`/${'{a}'.repeat(9)}:tail`, (req, res) => res.end()),
		/Too many path combinations/
	);
	for (const url of ['/optional/abcz', '/optional/z']) {
		const response = await client.get(url);
		assert.equal(response.status, 200);
		assert.deepEqual(response.data, { tail: 'z' });
	}
	const response = await client.get('/wild/a-b-c');
	assert.equal(response.status, 200);
	assert.deepEqual(response.data, { first: ['a'], second: ['b'], last: 'c' });
	await assert.rejects(client.get('/wild/a-b-'), (error) => {
		assert.equal(axios.isAxiosError(error), true);
		assert.equal(error.response.status, 404);
		return true;
	});
});
