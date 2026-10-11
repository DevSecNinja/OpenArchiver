import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(new URL('../package.json', import.meta.url));
const { S3StorageProvider } = require('./dist/services/storage/S3StorageProvider.js');
export const { StorageObjectExistsError } = require('./dist/services/storage/errors.js');

export async function mockS3(t, handler) {
	const failures = [];
	const server = createServer(async (request, response) => {
		try {
			const chunks = [];
			for await (const chunk of request) chunks.push(chunk);
			const result = await handler({
				method: request.method,
				url: new URL(request.url, 'http://localhost'),
				headers: request.headers,
				body: Buffer.concat(chunks),
			});
			response.writeHead(
				result.status ?? 200,
				result.headers ?? { 'Content-Type': 'application/xml' }
			);
			response.end(result.body ?? '');
		} catch (error) {
			failures.push(error);
			response.writeHead(500);
			response.end('<Error><Code>InternalError</Code></Error>');
		}
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	t.after(async () => {
		server.closeAllConnections();
		await new Promise((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve()))
		);
		assert.deepEqual(failures, []);
	});
	const address = server.address();
	assert.ok(address && typeof address !== 'string');
	return new S3StorageProvider({
		type: 's3',
		endpoint: `http://127.0.0.1:${address.port}`,
		region: 'us-east-1',
		bucket: 'test-archive',
		accessKeyId: 'synthetic-access-key',
		secretAccessKey: 'synthetic-secret-key',
		forcePathStyle: true,
		openArchiverFolderName: 'open-archiver',
	});
}
