const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { wrap } = require('node:module');
const path = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

const filename = require.resolve('../dist/helpers/relativePath');
const compiled = readFileSync(filename, 'utf8');
function validator(platform) {
	const module = { exports: {} };
	runInNewContext(wrap(compiled), { process: { platform } })(
		module.exports,
		() => assert.fail('The relative-path helper must not load external modules'),
		module,
		filename,
		path.dirname(filename)
	);
	return module.exports.assertSafeRelativePath;
}
const windows = validator('win32');
const posix = validator('linux');
const aliases = ['CONIN$', 'conin$', 'CoNiN$', 'CONOUT$', 'conout$', 'CoNoUt$'];
const pathsFor = (name) => [name, `source/${name}`, `source/${name}/message.eml`];

test('Windows rejects console aliases in every path segment regardless of case', () => {
	for (const alias of aliases) {
		for (const value of pathsFor(alias)) {
			assert.throws(() => windows(value), { name: 'UnsafePathError' }, value);
		}
	}
});

test('POSIX preserves console-looking literal names and Windows preserves ordinary lookalikes', () => {
	for (const alias of aliases) {
		for (const value of pathsFor(alias)) assert.doesNotThrow(() => posix(value), value);
		for (const name of [`X${alias}`, `${alias}-backup`, `${alias}.txt`, `${alias}.tar.gz`]) {
			assert.doesNotThrow(() => windows(`source/${name}`), name);
			assert.doesNotThrow(() => posix(`source/${name}`), name);
		}
	}
});

test('existing Windows drive, ADS and device rejection and POSIX colon behavior remain', () => {
	for (const value of [
		'C:relative.eml',
		'C:/absolute.eml',
		'source/message.eml:stream',
		'source/CON.txt',
		'source/COM1',
		'source/LPT\u00b2.log',
		'source/trailing.',
		'source/trailing ',
		'../escape',
		'/absolute',
		'source\\file',
	]) {
		assert.throws(() => windows(value), { name: 'UnsafePathError' }, value);
	}
	for (const value of [
		'a:report.eml',
		'source/CON.txt',
		'source/trailing.',
		'source/trailing ',
	]) {
		assert.doesNotThrow(() => posix(value), value);
	}
	for (const value of ['../escape', '/absolute', 'source\\file', 'source/\0file']) {
		assert.throws(() => posix(value), { name: 'UnsafePathError' }, value);
	}
});
