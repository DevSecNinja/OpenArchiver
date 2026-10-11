const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const { networkInterfaces, tmpdir } = require('node:os');
const { promisify } = require('node:util');
const { test } = require('node:test');

const enabled = process.env.OA_IMAP_INTEROP === '1';
if (process.env.OA_IMAP_INTEROP !== undefined) assert.ok(enabled, 'Use OA_IMAP_INTEROP=1');
const execute = promisify(execFile);
const binary = Buffer.from([0, 255, 128, 13, 10, 65]);
const inline = Buffer.from('synthetic inline image');
const folder = 'Fixture/Caf\u00e9';
const password = 'synthetic-imap-fixture-password';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function message(id) {
	const raw = Buffer.from(
		[
			'From: =?UTF-8?Q?Ren=C3=A9?= <sender@example.invalid>',
			'To: Synthetic Recipient <recipient@example.invalid>',
			`Message-ID: <${id}@example.invalid>`,
			'Subject: =?UTF-8?Q?IMAP_caf=C3=A9?=',
			'Date: Sun, 11 Oct 2026 12:00:00 +0000',
			'MIME-Version: 1.0',
			'Content-Type: multipart/mixed; boundary=imap-fixture',
			'',
			'--imap-fixture',
			'Content-Type: multipart/alternative; boundary=body-fixture',
			'',
			'--body-fixture',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'Synthetic IMAP body.',
			'--body-fixture',
			'Content-Type: text/html; charset=utf-8',
			'',
			'<p>Synthetic IMAP body.</p><img src="cid:fixture-image">',
			'--body-fixture--',
			'--imap-fixture',
			'Content-Type: image/png',
			'Content-Disposition: inline; filename=inline.png',
			'Content-ID: <fixture-image>',
			'Content-Transfer-Encoding: base64',
			'',
			inline.toString('base64'),
			'--imap-fixture',
			'Content-Type: application/octet-stream',
			'Content-Disposition: attachment; filename=fixture.bin',
			'Content-Transfer-Encoding: base64',
			'',
			binary.toString('base64'),
			'--imap-fixture--',
			'',
		].join('\r\n')
	);
	assert.ok(raw.length < 4096);
	return raw;
}

function credentials(secure, username) {
	return {
		host: '127.0.0.1',
		port: secure ? 31993 : 31143,
		secure,
		allowInsecureCert: false,
		username,
		password,
	};
}

function assertClosed(client) {
	assert.ok(client, 'The compiled connector must have created a real client');
	assert.equal(client.usable, false);
	assert.equal(client.isClosed, true);
	assert.equal(client.authenticated, false);
	assert.equal(client.socket, null);
	assert.equal(client.writeSocket, null);
}

function observe(client) {
	const commands = [];
	let closes = 0;
	// Observe protocol logs without replacing client/connector methods or responses.
	client.emitLogs = true;
	client.on('log', (entry) => {
		if (entry.src !== 'c' || typeof entry.msg !== 'string') return;
		const match = entry.msg.match(/^\S+\s+((?:UID )?[A-Z]+)\b/);
		if (match) commands.push(match[1]);
	});
	client.on('close', () => closes++);
	return { commands, closes: () => closes };
}

test(
	'compiled connector interoperates with isolated Dovecot over verified TLS and STARTTLS',
	{
		skip: enabled ? false : 'Opt in with the isolated run-imap-interop.sh runner',
		timeout: 60_000,
	},
	async (t) => {
		assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
		assert.equal(process.env.NODE_EXTRA_CA_CERTS, '/fixture-ca/ca.crt');
		assert.equal(process.env.DOTENV_CONFIG_PATH, '/dev/null');
		assert.ok(Object.values(networkInterfaces()).flat().every((address) => address.internal));
		const { ImapFlow } = require('imapflow');
		const { ImapConnector } = require('../../dist/services/ingestion-connectors/ImapConnector');
		assert.equal(ImapFlow.version, '2.3.0');
		const samples = new Map([
			['<first@example.invalid>', { raw: message('first'), path: 'INBOX' }],
			['<nested@example.invalid>', { raw: message('nested'), path: folder }],
		]);

		async function seed(auth, appendLater = false) {
			const client = new ImapFlow({
				host: auth.host,
				port: auth.port,
				secure: auth.secure,
				doSTARTTLS: auth.secure ? undefined : true,
				tls: { rejectUnauthorized: true },
				auth: { user: auth.username, pass: password },
				logger: false,
				connectionTimeout: 5000,
				socketTimeout: 5000,
			});
			const errors = [];
			client.on('error', (error) => errors.push(error));
			try {
				await client.connect();
				assert.equal(client.secureConnection, true);
				if (appendLater) {
					return await client.append('INBOX', message('later'));
				}
				await client.mailboxCreate('Fixture');
				await client.mailboxCreate(folder);
				for (const sample of samples.values()) await client.append(sample.path, sample.raw);
				await client.append('INBOX', message('flagged-draft'), ['\\Draft']);
				await client.append('Drafts', message('folder-draft'));
			} finally {
				if (client.usable) await client.logout();
				else if (!client.isClosed) client.close();
				assertClosed(client);
				assert.deepEqual(errors, [], 'Seeder must not hide client errors');
			}
		}

		async function checkEmail(email, expected, preserveOriginalFile) {
			assert.ok(email, 'The connector must yield a message');
			try {
				const raw = await fs.readFile(email.tempFilePath);
				assert.deepEqual(raw, expected.raw);
				assert.equal(sha256(raw), sha256(expected.raw));
				assert.equal(email.path, expected.path);
				assert.equal(email.from[0].name, 'Ren\u00e9');
				assert.equal(email.to[0].address, 'recipient@example.invalid');
				assert.equal(email.subject, 'IMAP caf\u00e9');
				assert.equal(email.body.trim(), 'Synthetic IMAP body.');
				// simpleParser resolves CID links by default; raw EML above stays byte-identical.
				assert.equal(
					email.html.trim(),
					`<p>Synthetic IMAP body.</p><img src="data:image/png;base64,${inline.toString('base64')}">`
				);
				const imageData = email.html.match(/src="data:image\/png;base64,([^"]+)"/);
				assert.ok(imageData);
				assert.deepEqual(Buffer.from(imageData[1], 'base64'), inline);
				assert.equal(email.attachments.length, 2);
				assert.deepEqual(
					email.attachments.map((attachment) => attachment.filename).sort(),
					['fixture.bin', 'inline.png']
				);
				for (const attachment of email.attachments) {
					const original = attachment.filename === 'fixture.bin' ? binary : inline;
					assert.equal(
						attachment.contentType,
						attachment.filename === 'fixture.bin' ? 'application/octet-stream' : 'image/png'
					);
					assert.equal(attachment.size, original.length);
					assert.deepEqual(
						attachment.content,
						preserveOriginalFile ? Buffer.alloc(0) : original
					);
				}
			} finally {
				await fs.unlink(email.tempFilePath);
			}
		}

		for (const secure of [true, false]) {
			for (const preserveOriginalFile of [false, true]) {
				await t.test(
					`${secure ? 'TLS' : 'STARTTLS'}, preserveOriginalFile=${preserveOriginalFile}`,
					{ timeout: 12000 },
					async () => {
						const auth = credentials(secure, `oa-${secure}-${preserveOriginalFile}`);
						await seed(auth);
						const connector = new ImapConnector(auth, { preserveOriginalFile });
						try {
							// TypeScript-private methods remain the original compiled methods.
							await connector.connect();
							const client = connector.client;
							assert.ok(client instanceof ImapFlow);
							assert.equal(client.secureConnection, true);
							assert.equal(client.options.tls.rejectUnauthorized, true);
							assert.equal(client.options.proxy, undefined);
							assert.ok(client.authenticated);
							assert.equal(client.socket.encrypted, true);
							assert.equal(client.socket.authorized, true);
							const trace = observe(client);
							await client.mailboxOpen('INBOX');
							// Production's UID-only fetch criteria can omit SEARCH; test it explicitly.
							const found = await client.search(
								{ header: { 'message-id': '<first@example.invalid>' } },
								{ uid: true }
							);
							assert.deepEqual(found, [1]);
							assert.ok(trace.commands.includes('UID SEARCH'));
							trace.commands.length = 0;
							const ids = [];
							for await (const email of connector.fetchEmails(auth.username)) {
								assert.ok(samples.has(email?.id), 'Do not yield drafts or unexpected mail');
								ids.push(email.id);
								await checkEmail(email, samples.get(email.id), preserveOriginalFile);
							}
							assert.deepEqual(ids.sort(), [...samples.keys()].sort());
							assertClosed(client);
							assert.equal(trace.closes(), 1);
							for (const command of ['LIST', 'SELECT', 'FETCH', 'UID FETCH', 'LOGOUT']) {
								assert.ok(trace.commands.includes(command), `Missing real ${command}`);
							}
							const state = connector.getUpdatedSyncState();
							assert.equal(state.imap.INBOX.maxUid, 2);
							assert.equal(state.imap[folder].maxUid, 1);
							assert.equal(state.statusMessage, undefined);
							const appended = await seed(auth, true);
							assert.equal(appended.uid, 3);
							const resumed = [];
							for await (const email of connector.fetchEmails(auth.username, state)) {
								resumed.push(email.id);
								await checkEmail(
									email,
									{ raw: message('later'), path: 'INBOX' },
									preserveOriginalFile
								);
							}
							assert.deepEqual(resumed, ['<later@example.invalid>']);
							assert.equal(connector.getUpdatedSyncState().imap.INBOX.maxUid, 3);
							assertClosed(connector.client);

							await connector.connect();
							const earlyClient = connector.client;
							const earlyTrace = observe(earlyClient);
							for await (const email of connector.fetchEmails(auth.username)) {
								await fs.unlink(email.tempFilePath);
								break;
							}
							assertClosed(earlyClient);
							assert.equal(earlyTrace.closes(), 1);
							assert.ok(earlyTrace.commands.includes('LOGOUT'));
						} finally {
							// Emergency teardown does not replace the assertions above.
							if (connector.client && !connector.client.isClosed) connector.client.close();
						}
					}
				);
			}

			await t.test(`${secure ? 'TLS' : 'STARTTLS'} rejects wrong password and closes`, async () => {
				const connector = new ImapConnector({
					...credentials(secure, 'oa-wrong-password'),
					password: 'wrong-synthetic-password',
				});
				try {
					await assert.rejects(connector.testConnection(), { authenticationFailed: true });
					if (!connector.client.isClosed) {
						await once(connector.client, 'close', { signal: AbortSignal.timeout(1000) });
					}
					assertClosed(connector.client);
				} finally {
					if (connector.client && !connector.client.isClosed) connector.client.close();
				}
			});

			await t.test(`${secure ? 'TLS' : 'STARTTLS'} rejects an untrusted certificate`, async () => {
				const env = { ...process.env };
				delete env.NODE_EXTRA_CA_CERTS;
				const modulePath = require.resolve('../../dist/services/ingestion-connectors/ImapConnector');
				const script = `
					const assert = require('node:assert/strict');
					const { once } = require('node:events');
					const { ImapConnector } = require(${JSON.stringify(modulePath)});
					const connector = new ImapConnector(${JSON.stringify(credentials(secure, 'oa-untrusted'))});
					(async () => {
						try {
							await assert.rejects(connector.testConnection(), error =>
								['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN',
								'DEPTH_ZERO_SELF_SIGNED_CERT'].includes(error.code));
							if (!connector.client.isClosed) {
								await once(connector.client, 'close', { signal: AbortSignal.timeout(1000) });
							}
							assert.equal(connector.client.usable, false);
							assert.equal(connector.client.isClosed, true);
							assert.equal(connector.client.socket, null);
						} finally {
							if (connector.client && !connector.client.isClosed) connector.client.close();
						}
					})().catch(error => { console.error(error); process.exitCode = 1; });
				`;
				await execute(process.execPath, ['--max-old-space-size=128', '-e', script], {
					env,
					timeout: 10000,
					killSignal: 'SIGKILL',
					maxBuffer: 65536,
				});
			});
		}
		assert.deepEqual((await fs.readdir(tmpdir())).filter((name) => name.startsWith('oa-email-')), []);
	}
);
