import { createHash } from 'crypto';
import { and, asc, gt, inArray, sql } from 'drizzle-orm';
import { db, type Database } from '../../database';
import { archivedEmails, attachments, ingestionSources, syncSessions } from '../../database/schema';
import type { IngestionCredentials, IStorageProvider } from '@open-archiver/types';
import { readUploadReceipt, uploadReceiptSuccessful } from '../../helpers/uploadCompletion';
import { CryptoService } from '../CryptoService';

export const STORAGE_LOCK_NAMESPACE = 0x4f415243;
export const STORAGE_LOCK_STRIPES = 64;

export const storagePathIdentity = (path: string): string =>
	process.platform === 'win32' ? path.normalize('NFC').toLowerCase() : path.normalize('NFC');

export const storagePathLockKey = (path: string): string =>
	JSON.stringify(['storage-path', storagePathIdentity(path)]);

export function storageLockStripes(keys: readonly string[]): number[] {
	return [
		...new Set(
			keys.map(
				(key) =>
					createHash('sha256').update(key).digest().readUInt32BE(0) % STORAGE_LOCK_STRIPES
			)
		),
	].sort((a, b) => a - b);
}

interface StoragePlan<T> {
	keys: string[];
	run: () => Promise<T>;
}

class ExpandStorageLocks extends Error {
	constructor(readonly stripes: number[]) {
		super('Storage paths changed during lock discovery');
	}
}

/** Discovery only reads state; external writes belong exclusively in the returned run callback. */
export async function withStorageLocks<T>(
	keys: readonly string[],
	discover: (tx: Database) => Promise<StoragePlan<T>>
): Promise<T> {
	return runStoragePlan(storageLockStripes(keys), discover);
}

export async function withStoragePurgeLock<T>(
	discover: (tx: Database) => Promise<StoragePlan<T>>
): Promise<T> {
	return runStoragePlan(
		Array.from({ length: STORAGE_LOCK_STRIPES }, (_, i) => i),
		discover
	);
}

async function runStoragePlan<T>(
	stripes: number[],
	discover: (tx: Database) => Promise<StoragePlan<T>>
): Promise<T> {
	const held = new Set(stripes);
	for (;;) {
		try {
			return await db.transaction(
				async (tx) => {
					for (const stripe of [...held].sort((a, b) => a - b)) {
						await tx.execute(
							sql`SELECT pg_advisory_xact_lock(${STORAGE_LOCK_NAMESPACE}, ${stripe})`
						);
					}

					const plan = await discover(tx);
					const missing = storageLockStripes(plan.keys).filter(
						(stripe) => !held.has(stripe)
					);
					if (missing.length > 0) {
						throw new ExpandStorageLocks(missing);
					}
					return plan.run();
				},
				{ isolationLevel: 'read committed' }
			);
		} catch (error) {
			if (!(error instanceof ExpandStorageLocks)) throw error;
			// Every rollback adds a previously absent stripe, so discovery expands at most 64 times.
			for (const stripe of error.stripes) held.add(stripe);
		}
	}
}

/** Called only after row removal committed; a failed cleanup can leave bytes, never revived references. */
export async function cleanupUnreferencedObjects(
	storage: Pick<IStorageProvider, 'deleteObject'>,
	candidates: readonly string[]
): Promise<void> {
	const paths = [...new Set(candidates)];
	if (paths.length === 0) return;
	await withStorageLocks(paths.map(storagePathLockKey), async (tx) => {
		const identities = paths.map(storagePathIdentity);
		const emailPath = sql<string>`normalize(${archivedEmails.storagePath}, NFC)`;
		const attachmentPath = sql<string>`normalize(${attachments.storagePath}, NFC)`;
		const emails = await tx
			.select({ path: archivedEmails.storagePath })
			.from(archivedEmails)
			.where(
				inArray(
					process.platform === 'win32' ? sql<string>`lower(${emailPath})` : emailPath,
					identities
				)
			);
		const files = await tx
			.select({ path: attachments.storagePath })
			.from(attachments)
			.where(
				inArray(
					process.platform === 'win32'
						? sql<string>`lower(${attachmentPath})`
						: attachmentPath,
					identities
				)
			);
		const referenced = new Set([
			...[...emails, ...files].map((row) => storagePathIdentity(row.path)),
			...(await referencedUploads(tx, paths)).map(storagePathIdentity),
		]);
		return {
			keys: [],
			run: async () => {
				for (const path of paths) {
					if (!referenced.has(storagePathIdentity(path)))
						await storage.deleteObject(path);
				}
			},
		};
	});
}

export function pendingUploadPath(credentials: unknown): string | undefined {
	if (!credentials || typeof credentials !== 'object' || !('type' in credentials)) return;
	if (
		credentials.type !== 'pst_import' &&
		credentials.type !== 'eml_import' &&
		credentials.type !== 'mbox_import'
	)
		return;
	if ('uploadedFilePath' in credentials && typeof credentials.uploadedFilePath === 'string') {
		return credentials.uploadedFilePath || undefined;
	}
}

export function pendingUploadFromRow(
	row: Pick<typeof ingestionSources.$inferSelect, 'id' | 'credentials'>
): string | undefined {
	if (!row.credentials) return;
	const credentials = CryptoService.decryptObject<IngestionCredentials>(row.credentials);
	if (!credentials)
		throw new Error(`Cannot verify pending upload references for source ${row.id}`);
	return pendingUploadPath(credentials);
}

export async function referencedUploads(
	tx: Database,
	candidates: readonly string[],
	prefix = false
): Promise<string[]> {
	if (candidates.length === 0) return [];
	const found = new Set<string>(await referencedReceiptInputs(tx, candidates, prefix));
	let cursor: string | undefined;
	for (;;) {
		const rows = await tx
			.select({ id: ingestionSources.id, credentials: ingestionSources.credentials })
			.from(ingestionSources)
			.where(
				and(
					inArray(ingestionSources.provider, ['pst_import', 'eml_import', 'mbox_import']),
					cursor ? gt(ingestionSources.id, cursor) : undefined
				)
			)
			.orderBy(asc(ingestionSources.id))
			.limit(100);
		for (const row of rows) {
			const path = pendingUploadFromRow(row);
			if (!path) continue;
			const identity = storagePathIdentity(path);
			for (const candidate of candidates) {
				if (
					prefix
						? identity.startsWith(storagePathIdentity(candidate))
						: identity === storagePathIdentity(candidate)
				) {
					found.add(candidate);
				}
			}
		}
		if (rows.length < 100 || found.size === candidates.length) return [...found];
		cursor = rows[rows.length - 1].id;
	}
}

async function referencedReceiptInputs(
	tx: Database,
	candidates: readonly string[],
	prefix = false
): Promise<string[]> {
	const found = new Set<string>();
	let cursor: string | undefined;
	for (;;) {
		const rows = await tx
			.select({
				id: syncSessions.id,
				sourceId: syncSessions.ingestionSourceId,
				total: syncSessions.totalMailboxes,
				receipt: syncSessions.uploadReceipt,
			})
			.from(syncSessions)
			.where(cursor ? gt(syncSessions.id, cursor) : undefined)
			.orderBy(asc(syncSessions.id))
			.limit(100);
		for (const row of rows) {
			if (row.receipt === null) continue;
			const receipt = readUploadReceipt(row.receipt);
			if (
				!receipt ||
				receipt.sourceId !== row.sourceId ||
				receipt.expectedMailboxes.length !== row.total
			) {
				throw new Error(`Cannot verify upload receipt references for session ${row.id}`);
			}
			if (uploadReceiptSuccessful(receipt)) continue;
			for (const candidate of candidates) {
				const input = storagePathIdentity(receipt.inputPath);
				if (
					prefix
						? input.startsWith(storagePathIdentity(candidate))
						: input === storagePathIdentity(candidate)
				) {
					found.add(candidate);
				}
			}
		}
		if (rows.length < 100 || found.size === candidates.length) return [...found];
		cursor = rows[rows.length - 1].id;
	}
}
