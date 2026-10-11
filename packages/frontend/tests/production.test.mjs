import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { access } from 'node:fs/promises';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const frontendDirectory = fileURLToPath(new URL('../', import.meta.url));
const address = 'http://127.0.0.1:3000';
const publicOrigin = 'https://archive.example.test';
const jwtSecret = 'synthetic-frontend-regression-secret-not-for-deployment';
const user = { id: 'synthetic-user', email: 'test@example.test', role: 'super_admin' };
const jwtPayload = [{ alg: 'HS256' }, { ...user, exp: Math.floor(Date.now() / 1000) + 600 }]
	.map((part) => Buffer.from(JSON.stringify(part)).toString('base64url'))
	.join('.');
const token = `${jwtPayload}.${createHmac('sha256', jwtSecret).update(jwtPayload).digest('base64url')}`;
const authorization = `Bearer ${token}`;
const bodyLimit = 4096;

async function startFrontend(t, originEnvironment, requestHeaders) {
	await access(new URL('../build/index.js', import.meta.url));
	const child = spawn(
		process.execPath,
		['--import', './tests/offline-fetch.mjs', 'build/index.js'],
		{
			cwd: frontendDirectory,
			env: {
				PATH: process.env.PATH,
				NODE_ENV: 'production',
				HOST: '127.0.0.1',
				PORT: '3000',
				JWT_SECRET: jwtSecret,
				BODY_SIZE_LIMIT: String(bodyLimit),
				SHUTDOWN_TIMEOUT: '1',
				...originEnvironment,
			},
			stdio: ['ignore', 'pipe', 'pipe'],
		}
	);
	let output = '';
	let startupError;
	child.stdout.on('data', (chunk) => (output += chunk));
	child.stderr.on('data', (chunk) => (output += chunk));
	child.on('error', (error) => (startupError = error));
	t.after(async () => {
		if (child.exitCode === null && child.signalCode === null) {
			const stopped = once(child, 'exit');
			child.kill('SIGTERM');
			const forceStop = setTimeout(() => child.kill('SIGKILL'), 5000);
			try {
				await stopped;
			} finally {
				clearTimeout(forceStop);
			}
		}
		if (t.signal.aborted) t.diagnostic(output);
	});

	for (let attempt = 0; attempt < 100; attempt++) {
		if (startupError) throw startupError;
		assert.equal(child.exitCode, null, `Frontend exited before readiness:\n${output}`);
		try {
			const response = await fetch(`${address}/api/v1/probe`, {
				headers: requestHeaders,
				signal: AbortSignal.timeout(1000),
			});
			assert.equal(response.status, 200, await response.text());
			return;
		} catch (error) {
			if (error.cause?.code !== 'ECONNREFUSED') throw error;
			await delay(100);
		}
	}
	assert.fail(`Frontend did not become ready:\n${output}`);
}

for (const [name, originEnvironment, requestHeaders] of [
	['configured ORIGIN', { ORIGIN: publicOrigin }, {}],
	[
		'trusted proxy headers',
		{ PROTOCOL_HEADER: 'x-forwarded-proto', HOST_HEADER: 'x-forwarded-host' },
		{ 'x-forwarded-proto': 'https', 'x-forwarded-host': 'archive.example.test' },
	],
]) {
	test(`rebuilt adapter: ${name}`, { timeout: 60000 }, async (t) => {
		const requests = [];
		let needsSetup = true;
		const backend = createServer(async (request, response) => {
			const chunks = [];
			for await (const chunk of request) chunks.push(chunk);
			const body = Buffer.concat(chunks);
			requests.push({
				method: request.method,
				url: request.url,
				headers: request.headers,
				body: body.toString(),
			});
			response.setHeader('Content-Type', 'application/json');
			if (request.url === '/v1/auth/status') {
				response.end(JSON.stringify({ needsSetup }));
			} else if (['/v1/auth/login', '/v1/auth/setup'].includes(request.url)) {
				response.setHeader('Set-Cookie', [
					'mfaPendingToken=synthetic; Path=/; HttpOnly; SameSite=Lax',
					'fixture=second; Path=/; HttpOnly; SameSite=Lax',
				]);
				response.end(JSON.stringify({ accessToken: token, user }));
			} else if (['/v1/settings/system', '/v1/enterprise/sso/public'].includes(request.url)) {
				response.writeHead(404).end(JSON.stringify({ message: 'Synthetic absence' }));
			} else if (request.url === '/v1/rejected') {
				response.writeHead(401).end(JSON.stringify({ message: 'Synthetic unauthorized' }));
			} else if (request.url === '/v1/disconnect') {
				request.socket.destroy();
			} else {
				response.end(JSON.stringify({ receivedBytes: body.length }));
			}
		});
		// No PORT_BACKEND override: exercise the actual localhost:4000 default.
		backend.listen(4000);
		await once(backend, 'listening');
		t.after(async () => {
			backend.closeAllConnections();
			await new Promise((resolve, reject) =>
				backend.close((error) => (error ? reject(error) : resolve()))
			);
		});
		await startFrontend(t, originEnvironment, requestHeaders);

		const request = (path, options = {}) =>
			fetch(`${address}${path}`, {
				...options,
				redirect: 'manual',
				signal: AbortSignal.timeout(5000),
				headers: { ...requestHeaders, ...options.headers },
			});
		const multipart = () => {
			const form = new FormData();
			form.set(
				'file',
				new Blob(['Subject: Synthetic\r\n\r\nNo mailbox data.\r\n']),
				'test.eml'
			);
			return form;
		};

		await t.test('renders setup and sign-in; preserves synthetic login responses', async () => {
			let response = await request('/signin');
			assert.equal(response.status, 307);
			assert.equal(response.headers.get('location'), '/setup');
			await response.text();
			response = await request('/setup');
			assert.equal(response.status, 200);
			assert.match(await response.text(), /id="first_name"/);
			for (const path of ['/api/v1/auth/setup', '/api/v1/auth/login']) {
				response = await request(path, {
					method: 'POST',
					headers: { 'content-type': 'application/json', origin: publicOrigin },
					body: JSON.stringify({ email: user.email, password: 'synthetic-password' }),
				});
				assert.equal(response.status, 200);
				assert.deepEqual(await response.json(), { accessToken: token, user });
				assert.equal(requests.at(-1).method, 'POST');
				assert.equal(JSON.parse(requests.at(-1).body).email, user.email);
				assert.equal(response.headers.getSetCookie().length, 2);
			}
			needsSetup = false;
			response = await request('/signin');
			assert.equal(response.status, 200);
			assert.match(await response.text(), /id="password"/);
			response = await request('/signin', { headers: { cookie: `accessToken=${token}` } });
			assert.equal(response.status, 307);
			assert.equal(response.headers.get('location'), '/dashboard');
			await response.text();
			const authRequest = requests.findLast((item) => item.url === '/v1/auth/status');
			assert.equal(authRequest.headers.authorization, authorization);
		});

		await t.test('forwards query strings and authorization headers', async () => {
			const response = await request('/api/v1/probe?search=a%2Bb&limit=2', {
				headers: { authorization },
			});
			assert.equal(response.status, 200);
			await response.json();
			assert.equal(requests.at(-1).url, '/v1/probe?search=a%2Bb&limit=2');
			assert.equal(requests.at(-1).method, 'GET');
			assert.equal(requests.at(-1).headers.authorization, authorization);
		});

		await t.test(
			'forwards same-origin multipart bytes without changing the boundary',
			async () => {
				const upload = new Request(`${address}/api/v1/upload`, {
					method: 'POST',
					body: multipart(),
				});
				const body = await upload.text();
				const contentType = upload.headers.get('content-type');
				const response = await request('/api/v1/upload', {
					method: 'POST',
					headers: { origin: publicOrigin, authorization, 'content-type': contentType },
					body,
				});
				assert.equal(response.status, 200);
				assert.deepEqual(await response.json(), { receivedBytes: Buffer.byteLength(body) });
				assert.equal(requests.at(-1).url, '/v1/upload');
				assert.equal(requests.at(-1).headers.authorization, authorization);
				assert.equal(requests.at(-1).headers['content-type'], contentType);
				assert.equal(
					Number(requests.at(-1).headers['content-length']),
					Buffer.byteLength(body)
				);
				assert.equal(requests.at(-1).body, body);
			}
		);

		await t.test('rejects wrong/missing origins before proxying form bodies', async () => {
			for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
				for (const origin of ['https://wrong.example.test', address, null]) {
					const before = requests.length;
					const response = await request('/api/v1/upload', {
						method,
						headers: origin ? { origin } : {},
						body: multipart(),
					});
					assert.equal(response.status, 403);
					assert.equal(
						await response.text(),
						`Cross-site ${method} form submissions are forbidden`
					);
					assert.equal(requests.length, before);
				}
			}
			for (const contentType of ['application/x-www-form-urlencoded', 'text/plain']) {
				const before = requests.length;
				const response = await request('/api/v1/upload', {
					method: 'POST',
					headers: { origin: 'https://wrong.example.test', 'content-type': contentType },
					body: 'synthetic=value',
				});
				assert.equal(response.status, 403);
				await response.text();
				assert.equal(requests.length, before);
			}
		});

		await t.test(
			'keeps the exact SAML callback exception without accepting an assertion',
			async () => {
				const response = await request('/signin/sso/callback/saml', {
					method: 'POST',
					headers: { origin: 'https://idp.example.test' },
					body: new URLSearchParams({}),
				});
				assert.equal(response.status, 303);
				assert.equal(
					response.headers.get('location'),
					'/signin?ssoError=missing_parameters'
				);
				await response.text();
			}
		);

		await t.test('enforces the body limit for known-length and chunked requests', async () => {
			let response = await request('/api/v1/probe', {
				method: 'POST',
				headers: { 'content-type': 'application/octet-stream' },
				body: Buffer.alloc(bodyLimit, 65),
			});
			assert.equal(response.status, 200);
			assert.deepEqual(await response.json(), { receivedBytes: bodyLimit });
			for (const body of [
				Buffer.alloc(bodyLimit + 1, 65),
				Readable.from([Buffer.alloc(bodyLimit, 65), Buffer.from('B')]),
			]) {
				const before = requests.length;
				response = await request('/api/v1/probe', {
					method: 'POST',
					headers: { 'content-type': 'application/octet-stream' },
					body,
					duplex: 'half',
				});
				assert.equal(response.status, 413);
				const error = await response.json();
				assert.equal(error.status, 'error');
				assert.equal(error.statusCode, 413);
				assert.equal(error.errors, null);
				assert.match(error.message, /(body|content-length).*(limit|exceed)/i);
				assert.equal(requests.length, before);
			}
		});

		await t.test('preserves API errors and reports transport failures', async () => {
			let response = await request('/api/v1/rejected');
			assert.equal(response.status, 401);
			assert.deepEqual(await response.json(), { message: 'Synthetic unauthorized' });
			response = await request('/api/v1/disconnect');
			assert.equal(response.status, 500);
			const error = await response.json();
			assert.equal(error.status, 'error');
			assert.equal(error.statusCode, 500);
			assert.equal(error.errors, null);
			assert.ok(error.message.length > 0);
		});
	});
}
