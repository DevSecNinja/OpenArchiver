import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import test from 'node:test';

const require = createRequire(new URL('../package.json', import.meta.url));
const i18next = require('i18next');
const FsBackend = require('i18next-fs-backend');
const middleware = require('i18next-http-middleware');
const express = require('express');
const languages = ['en', 'nl', 'de', 'fr', 'es', 'pt', 'it', 'ja', 'et', 'el', 'bg'];
const loadPath = fileURLToPath(new URL('../dist/locales/{{lng}}/{{ns}}.json', import.meta.url));
const expected = async (language) =>
	JSON.parse(
		await readFile(
			new URL(`../dist/locales/${language}/translation.json`, import.meta.url),
			'utf8'
		)
	).auth.login.invalidCredentials;

async function translator(language, fallbackLanguage = language) {
	const instance = i18next.createInstance();
	await instance.use(FsBackend).init({
		lng: language,
		fallbackLng: fallbackLanguage,
		ns: ['translation'],
		defaultNS: 'translation',
		backend: { loadPath },
	});
	return instance;
}

test('packaged translations load for all languages and an explicit English fallback', async () => {
	assert.deepEqual(
		(await readdir(new URL('../dist/locales/', import.meta.url))).sort(),
		[...languages].sort()
	);
	for (const language of languages) {
		const instance = await translator(language);
		const message = await expected(language);
		assert.equal(typeof message, 'string');
		assert.ok(message.length > 0);
		assert.equal(instance.t('auth.login.invalidCredentials'), message);
	}
	const fallback = await translator('zz', 'en');
	assert.equal(fallback.t('auth.login.invalidCredentials'), await expected('en'));
});

test('filesystem backend rejects path components in language and namespace', async () => {
	const instance = await translator('en');
	const backend = instance.services.backendConnector.backend;
	for (const [language, namespace] of [
		['en/../nl', 'translation'],
		['en', '../en/translation'],
		['en\\..\\nl', 'translation'],
		['en', '..\\en\\translation'],
	]) {
		await assert.rejects(
			new Promise((resolve, reject) => {
				backend.read(language, namespace, (error, data) =>
					error ? reject(error) : resolve(data)
				);
			}),
			/unsafe lng\/ns/
		);
	}
});

test('query and header input cannot override configured language or inject headers', async (t) => {
	for (const configuredLanguage of ['en', 'nl']) {
		const instance = await translator(configuredLanguage);
		const app = express();
		app.use(middleware.handle(instance));
		app.get('/', (request, response) =>
			response.json({
				language: request.language,
				message: request.t('auth.login.invalidCredentials'),
			})
		);
		const server = app.listen(0, '127.0.0.1');
		t.after(async () => {
			server.closeAllConnections();
			await new Promise((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve()))
			);
		});
		await once(server, 'listening');
		const address = server.address();
		assert.ok(address && typeof address !== 'string');
		for (const language of ['fr', 'zz', '../en', 'en\r\nX-Injected: yes', '__proto__']) {
			const response = await fetch(
				`http://127.0.0.1:${address.port}/?lng=${encodeURIComponent(language)}&ns=..%2Ftranslation`,
				{ headers: { 'Accept-Language': encodeURIComponent(language) } }
			);
			assert.equal(response.status, 200);
			assert.equal(response.headers.get('x-injected'), null);
			assert.deepEqual(await response.json(), {
				language: configuredLanguage,
				message: await expected(configuredLanguage),
			});
		}
	}
});
