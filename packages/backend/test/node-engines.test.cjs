const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { join, resolve } = require('node:path');
const { test } = require('node:test');

test('project Node range satisfies the workspace documentation tooling', () => {
	const rootPath = resolve(__dirname, '../../..');
	const project = require(join(rootPath, 'package.json'));
	const frontendRequire = createRequire(join(rootPath, 'packages/frontend/package.json'));
	const { satisfies, subset, validRange } = frontendRequire('semver');
	const range = project.engines.node;
	assert.ok(validRange(range), 'The project must declare a valid Node range');
	for (const [version, allowed] of [
		['20.19.0', false],
		['22.12.0', false],
		['22.13.0', true],
		['22.23.3', true],
		['23.0.0', false],
		['23.11.0', false],
		['24.0.0', true],
	]) {
		assert.equal(satisfies(version, range), allowed, `Unexpected support for Node ${version}`);
	}

	const docs = JSON.parse(
		readFileSync(join(rootPath, 'node_modules', 'vitepress-openapi', 'package.json'), 'utf8')
	);
	assert.ok(
		subset(range, docs.engines.node),
		`Node range ${range} exceeds ${docs.name}@${docs.version}: ${docs.engines.node}`
	);
});
