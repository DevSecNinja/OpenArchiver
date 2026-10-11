const assert = require('node:assert/strict');
const { test } = require('node:test');
const { S3StorageProvider } = require('../dist/services/storage/S3StorageProvider');

test('S3 exact-object deletion is distinct from the existing prefix-delete contract', async () => {
	const provider = new S3StorageProvider({
		type: 's3',
		endpoint: 'http://s3.invalid',
		bucket: 'synthetic',
		accessKeyId: 'synthetic',
		secretAccessKey: 'synthetic',
		openArchiverFolderName: 'open-archiver',
	});
	const keys = new Set(['keyA', 'keyA-suffix', 'keyA/child', 'other']);
	const calls = [];
	provider.client.send = async (command) => {
		calls.push(command.constructor.name);
		assert.equal(command.input.Bucket, 'synthetic');
		switch (command.constructor.name) {
			case 'DeleteObjectCommand':
				keys.delete(command.input.Key);
				return {};
			case 'ListObjectsV2Command':
				return {
					Contents: [...keys]
						.filter((key) => key.startsWith(command.input.Prefix))
						.map((Key) => ({ Key })),
				};
			case 'DeleteObjectsCommand':
				for (const { Key } of command.input.Delete.Objects) keys.delete(Key);
				return {};
			default:
				assert.fail(`Unexpected command: ${command.constructor.name}`);
		}
	};
	await provider.deleteObject('keyA');
	assert.deepEqual([...keys], ['keyA-suffix', 'keyA/child', 'other']);
	assert.deepEqual(calls, ['DeleteObjectCommand']);
	await provider.delete('keyA');
	assert.deepEqual([...keys], ['other']);
	assert.deepEqual(calls, [
		'DeleteObjectCommand',
		'ListObjectsV2Command',
		'DeleteObjectsCommand',
	]);
});
