const assert = require('node:assert/strict');
const { test } = require('node:test');
const { subject } = require('@casl/ability');
const { createAbilityFor } = require('../dist/iam-policy/ability.js');
const { normalizeEmailConditions } = require('../dist/iam-policy/normalize-conditions.js');
const adminPolicies = require('../src/iam-policy/test-policies/admin.json');
const sourcePolicies = require('../src/iam-policy/test-policies/single-ingestion-access.json');
const auditorPolicies = require('../src/iam-policy/test-policies/auditor-specific-mailbox.json');
const denyOnlyPolicies = require('../src/iam-policy/test-policies/deny-only-archive.json');

test('ingestion permissions apply to the selected record and do not imply archive access', () => {
	const ability = createAbilityFor(sourcePolicies);
	const sourceId = sourcePolicies[0].conditions.id;

	for (const action of ['read', 'update', 'delete', 'sync']) {
		assert.equal(ability.can(action, subject('ingestion', { id: sourceId })), true, action);
		assert.equal(
			ability.can(action, subject('ingestion', { id: 'another-source' })),
			false,
			action
		);
	}
	assert.equal(
		ability.can('read', subject('archive', { id: 'email-1', ingestionSourceId: sourceId })),
		false
	);
});

test('mailbox-scoped archive permissions reject other mailboxes and other sources', () => {
	const ability = createAbilityFor([
		{
			action: ['read', 'search'],
			subject: 'archive',
			conditions: {
				ingestionSourceId: 'source-1',
				userEmail: { $in: ['allowed@example.test'] },
			},
		},
	]);
	const allowed = subject('archive', {
		id: 'email-1',
		ingestionSourceId: 'source-1',
		userEmail: 'allowed@example.test',
	});

	for (const action of ['read', 'search']) {
		assert.equal(ability.can(action, allowed), true, action);
		assert.equal(
			ability.can(
				action,
				subject('archive', { ...allowed, id: 'email-2', userEmail: 'other@example.test' })
			),
			false,
			action
		);
		assert.equal(
			ability.can(
				action,
				subject('archive', { ...allowed, id: 'email-3', ingestionSourceId: 'source-2' })
			),
			false,
			action
		);
		assert.equal(ability.can(action, subject('archive', { id: 'missing-scope' })), false);
	}
	assert.equal(ability.can('delete', allowed), false);
	assert.equal(ability.can('export', allowed), false);
});

test('a later mailbox deny overrides a source allow for read and search', () => {
	const ability = createAbilityFor(auditorPolicies);
	const sourceId = auditorPolicies[1].conditions.ingestionSourceId;
	const deniedMailbox = auditorPolicies[2].conditions.userEmail;

	for (const action of ['read', 'search']) {
		for (const [ingestionSourceId, userEmail, expected] of [
			[sourceId, 'allowed@example.test', true],
			[sourceId, deniedMailbox, false],
			['another-source', 'allowed@example.test', false],
			['another-source', deniedMailbox, false],
		]) {
			assert.equal(
				ability.can(action, subject('archive', { ingestionSourceId, userEmail })),
				expected,
				`${action}: ${ingestionSourceId}, ${userEmail}`
			);
		}
	}
});

test('empty policies and deny-only policies never grant resource access', () => {
	for (const policies of [[], denyOnlyPolicies]) {
		const ability = createAbilityFor(policies);
		for (const userEmail of ['allowed@example.test', 'dev@openarchiver.com']) {
			assert.equal(ability.can('read', subject('archive', { userEmail })), false);
		}
		assert.equal(ability.can('read', subject('ingestion', { id: 'source-1' })), false);
	}
});

test('compiled mailbox normalization preserves allow and deny comparisons without mutation', () => {
	const policies = [
		{
			action: 'read',
			subject: 'archive',
			conditions: { userEmail: { $in: [' Allowed@Example.Test ', ' DENIED@Example.Test '] } },
		},
		{
			action: 'read',
			subject: 'archive',
			inverted: true,
			conditions: { userEmail: { $eq: ' Denied@Example.Test ' } },
		},
	];
	const original = structuredClone(policies);
	const ability = createAbilityFor(normalizeEmailConditions(policies));

	assert.equal(
		ability.can('read', subject('archive', { userEmail: 'allowed@example.test' })),
		true
	);
	assert.equal(
		ability.can('read', subject('archive', { userEmail: 'denied@example.test' })),
		false
	);
	assert.equal(
		ability.can('read', subject('archive', { userEmail: 'other@example.test' })),
		false
	);
	assert.deepEqual(policies, original);
});

test('manage all permits ingestion and archive records regardless of mailbox scope', () => {
	const ability = createAbilityFor(adminPolicies);
	for (const action of ['create', 'read', 'update', 'delete', 'search', 'export', 'sync']) {
		for (const resource of [
			subject('ingestion', { id: 'source-1' }),
			subject('ingestion', { id: 'source-2' }),
			subject('archive', { id: 'email-1', userEmail: 'allowed@example.test' }),
			subject('archive', { id: 'email-2', userEmail: 'other@example.test' }),
		]) {
			assert.equal(ability.can(action, resource), true, action);
		}
	}
});
