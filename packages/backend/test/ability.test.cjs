const assert = require('node:assert/strict');
const test = require('node:test');
const { subject } = require('@casl/ability');
const { createAbilityFor } = require('../dist/iam-policy/ability.js');

test('an empty policy denies access', () => {
	const ability = createAbilityFor([]);

	for (const action of ['read', 'search', 'export', 'delete']) {
		assert.equal(
			ability.can(action, subject('archive', { userEmail: 'alice@example.test' })),
			false
		);
	}
	assert.equal(ability.can('manage', 'all'), false);
});

test('mailbox-scoped read and search do not grant access to other mailboxes or actions', () => {
	const ability = createAbilityFor([
		{
			action: ['read', 'search'],
			subject: 'archive',
			conditions: { userEmail: { $in: ['alice@example.test'] } },
		},
	]);
	const allowed = subject('archive', { userEmail: 'alice@example.test' });
	const other = subject('archive', { userEmail: 'bob@example.test' });
	const missingMailbox = subject('archive', {});

	for (const action of ['read', 'search']) {
		assert.equal(ability.can(action, allowed), true);
		assert.equal(ability.can(action, other), false);
		assert.equal(ability.can(action, missingMailbox), false);
	}
	assert.equal(ability.can('export', allowed), false);
	assert.equal(ability.can('delete', allowed), false);
	assert.equal(ability.can('read', subject('users', { userEmail: 'alice@example.test' })), false);
});

test('ingestion permissions do not implicitly grant archive permissions', () => {
	const ability = createAbilityFor([
		{ action: 'manage', subject: 'ingestion', conditions: { id: 'source-a' } },
	]);

	assert.equal(ability.can('read', subject('ingestion', { id: 'source-a' })), true);
	assert.equal(ability.can('read', subject('ingestion', { id: 'source-b' })), false);
	assert.equal(ability.can('read', subject('archive', { ingestionSourceId: 'source-a' })), false);
});

test('explicit archive permissions require both source and mailbox conditions', () => {
	const ability = createAbilityFor([
		{
			action: 'read',
			subject: 'archive',
			conditions: { ingestionSourceId: 'source-a', userEmail: 'alice@example.test' },
		},
	]);

	for (const ingestionSourceId of ['source-a', 'source-b']) {
		for (const userEmail of ['alice@example.test', 'bob@example.test']) {
			assert.equal(
				ability.can('read', subject('archive', { ingestionSourceId, userEmail })),
				ingestionSourceId === 'source-a' && userEmail === 'alice@example.test'
			);
		}
	}
});

test('a later explicit deny overrides a broader allow without denying other mailboxes', () => {
	const ability = createAbilityFor([
		{ action: ['read', 'export'], subject: 'archive' },
		{
			action: 'export',
			subject: 'archive',
			conditions: { userEmail: 'alice@example.test' },
			inverted: true,
		},
	]);
	const restricted = subject('archive', { userEmail: 'alice@example.test' });
	const other = subject('archive', { userEmail: 'bob@example.test' });

	assert.equal(ability.can('read', restricted), true);
	assert.equal(ability.can('export', restricted), false);
	assert.equal(ability.can('export', other), true);
});

test('an explicit administrator policy retains wildcard access', () => {
	const ability = createAbilityFor([{ action: 'manage', subject: 'all' }]);

	assert.equal(
		ability.can('delete', subject('archive', { userEmail: 'alice@example.test' })),
		true
	);
	assert.equal(ability.can('sync', subject('ingestion', { id: 'source-a' })), true);
	assert.equal(ability.can('update', 'settings'), true);
});
