const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { join, resolve } = require('node:path');
const { test } = require('node:test');

test('project Node minimum satisfies the native builder and workspace documentation tooling', () => {
	const rootPath = resolve(__dirname, '../../..');
	const project = require(join(rootPath, 'package.json'));
	const sqliteRequire = createRequire(require.resolve('sqlite3/package.json'));
	const builder = sqliteRequire('node-gyp/package.json');
	const builderRequire = createRequire(sqliteRequire.resolve('node-gyp/package.json'));
	const { minVersion, satisfies } = builderRequire('semver');
	const minimum = minVersion(project.engines.node);
	assert.ok(minimum, 'The project must declare a minimum Node version');
	assert.equal(satisfies('22.8.0', project.engines.node), false);

	const docs = JSON.parse(
		readFileSync(join(rootPath, 'node_modules', 'vitepress-openapi', 'package.json'), 'utf8')
	);
	for (const dependency of [require('sqlite3/package.json'), builder, docs]) {
		assert.ok(
			satisfies(minimum, dependency.engines.node),
			`Node ${minimum} does not satisfy ${dependency.name}@${dependency.version}: ${dependency.engines.node}`
		);
	}
});
