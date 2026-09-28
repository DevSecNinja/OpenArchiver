const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createServer } = require('node:http');
const path = require('node:path');
const { test } = require('node:test');
const axios = require('axios');
const express = require('express');
const { body, validationResult } = require('express-validator');
const i18next = require('i18next');
const FsBackend = require('i18next-fs-backend');
const i18nextMiddleware = require('i18next-http-middleware');
const { subject } = require('@casl/ability');
const { eq, sql } = require('drizzle-orm');
const { PgDialect } = require('drizzle-orm/pg-core');
const { createAbilityFor } = require('../dist/iam-policy/ability.js');
const { users } = require('../dist/database/schema/users.js');

test('Express, validation, Axios and filesystem translations remain compatible', async () => {
	const translations = i18next.createInstance();
	await translations.use(FsBackend).init({
		lng: 'en',
		fallbackLng: 'en',
		ns: ['translation'],
		defaultNS: 'translation',
		backend: { loadPath: path.resolve(__dirname, '../dist/locales/{{lng}}/{{ns}}.json') },
	});
	const app = express();
	app.use(express.json({ limit: '1kb' }));
	app.use(i18nextMiddleware.handle(translations));
	app.post('/fixture/:id', body('email').isEmail(), (req, res) => {
		if (!validationResult(req).isEmpty()) {
			res.status(400).json({ message: req.t('user.emailInvalid') });
			return;
		}
		res.json({ id: req.params.id, email: req.body.email, language: req.language });
	});

	const server = createServer(app);
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	try {
		const address = server.address();
		assert.ok(address && typeof address === 'object');
		const client = axios.create({
			baseURL: `http://127.0.0.1:${address.port}`,
			proxy: false,
			timeout: 2000,
		});
		const valid = await client.post('/fixture/archived', { email: 'reader@example.test' });
		assert.deepEqual(valid.data, {
			id: 'archived',
			email: 'reader@example.test',
			language: 'en',
		});
		await assert.rejects(
			client.post('/fixture/archived', { email: 'not-an-email' }),
			(error) => {
				assert.equal(error.response.status, 400);
				assert.deepEqual(error.response.data, { message: 'Enter a valid email address.' });
				return true;
			}
		);
	} finally {
		await new Promise((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve()))
		);
	}
});

test('CASL preserves source-scoped archive permissions and explicit denials', () => {
	const ability = createAbilityFor([
		{ action: 'read', subject: 'archive', conditions: { ingestionSourceId: 'allowed-source' } },
		{
			action: 'read',
			subject: 'archive',
			conditions: { ingestionSourceId: 'allowed-source', id: 'denied-email' },
			inverted: true,
		},
	]);
	assert.equal(
		ability.can('read', subject('archive', { ingestionSourceId: 'allowed-source' })),
		true
	);
	assert.equal(
		ability.can('read', subject('archive', { ingestionSourceId: 'other-source' })),
		false
	);
	assert.equal(
		ability.can(
			'read',
			subject('archive', { ingestionSourceId: 'allowed-source', id: 'denied-email' })
		),
		false
	);
	assert.equal(ability.can('delete', 'archive'), false);
	assert.equal(ability.can('read', 'ingestion'), false);
});

test('Drizzle preserves PostgreSQL parameterization and escapes quoted identifiers', () => {
	const dialect = new PgDialect();
	const query = dialect.sqlToQuery(
		sql`select ${users.id} from ${users} where ${eq(users.email, 'reader@example.test')}`
	);
	assert.equal(query.sql, 'select "users"."id" from "users" where "users"."email" = $1');
	assert.deepEqual(query.params, ['reader@example.test']);
	assert.equal(dialect.sqlToQuery(sql`${sql.identifier('quoted"field')}`).sql, '"quoted""field"');
});
