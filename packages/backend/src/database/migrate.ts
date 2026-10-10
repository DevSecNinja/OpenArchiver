import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { config } from 'dotenv';
import path from 'node:path';
import { encodeDatabaseUrl } from '../helpers/db';

config();

const runMigrate = async () => {
	if (!process.env.DATABASE_URL) {
		throw new Error('DATABASE_URL is not set in the .env file');
	}

	const connectionString = encodeDatabaseUrl(process.env.DATABASE_URL);
	const connection = postgres(connectionString, { max: 1, max_lifetime: 0, idle_timeout: 0 });
	try {
		// Drizzle's journal check must not race another replica's migration transaction.
		await connection`SELECT pg_advisory_lock(1868652914, 1)`;
		try {
			console.log('Running migrations...');
			const db = drizzle(connection);
			await migrate(db, {
				migrationsFolder: path.resolve(__dirname, '../../src/database/migrations'),
			});
			console.log('Migrations completed!');
		} finally {
			await connection`SELECT pg_advisory_unlock(1868652914, 1)`;
		}
	} finally {
		await connection.end();
	}
};

runMigrate().catch((err) => {
	console.error('Migration failed!', err);
	process.exit(1);
});
