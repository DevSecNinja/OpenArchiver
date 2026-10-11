import { db, type Database } from '../database';
import { ingestionSources } from '../database/schema';
import type {
	CreateIngestionSourceDto,
	UpdateIngestionSourceDto,
	IngestionSource,
	IngestionCredentials,
	OAuthMailboxCredentials,
	IngestionProvider,
	PendingEmail,
	ProcessEmailError,
} from '@open-archiver/types';
import {
	and,
	count,
	countDistinct,
	desc,
	eq,
	gte,
	inArray,
	max,
	min,
	notInArray,
	or,
	sql,
	type SQL,
} from 'drizzle-orm';
import { CryptoService } from './CryptoService';
import { EmailProviderFactory } from './EmailProviderFactory';
import { mergeOAuthCredentials, validateOAuthMailboxConfig } from './oauth/oauthHelpers';
import { mergeProviderCredentials } from './credentialMerge';
import { ingestionQueue, indexingQueue } from '../jobs/queues';
import { continuousSyncJobId, initialImportJobId } from '../jobs/helpers/jobIds';
import { claimJobId } from '../jobs/helpers/claimJobId';
import type { JobType } from 'bullmq';
import { StorageService } from './StorageService';
import type {
	IInitialImportJob,
	EmailObject,
	ReindexMode,
	IReindexDispatch,
	IngestionStats,
} from '@open-archiver/types';
import { stripAttachmentsFromEml } from '../helpers/emlUtils';
import { streamToBuffer } from '../helpers/streamToBuffer';
import { isStorageObjectExistsError } from './storage/errors';
import {
	cleanupUnreferencedObjects,
	pendingUploadFromRow,
	pendingUploadPath,
	referencedUploads,
	storagePathIdentity,
	storagePathLockKey,
	withStorageLocks,
	withStoragePurgeLock,
} from './storage/locking';
import {
	archivedEmails,
	attachments as attachmentsSchema,
	emailAttachments,
	syncSessions,
} from '../database/schema';
import { createHash } from 'crypto';
import { readFile, unlink } from 'fs/promises';
import { logger } from '../config/logger';
import { SearchService } from './SearchService';
import { config } from '../config/index';
import { FilterBuilder } from './FilterBuilder';
import { AuditService } from './AuditService';
import { User } from '@open-archiver/types';
import { checkDeletionEnabled } from '../helpers/deletionGuard';
import { normalizeEmailAddress } from '../helpers/emailAddress';
import { mapWithConcurrency } from '../helpers/mapWithConcurrency';
import { truncateToBytes } from '../helpers/truncateToBytes';
import { assertSafeRelativePath } from '../helpers/relativePath';
import {
	readUploadReceipt,
	hasNewerUploadClaim,
	uploadReceiptSuccessful,
	uploadedInputPath,
} from '../helpers/uploadCompletion';
import { quoteMeiliString } from '../helpers/meiliFilter';
import { isIndexingWorkerAlive } from '../jobs/helpers/workerLiveness';
import { buildReindexWhere } from '../jobs/helpers/indexBacklog';

/** Placeholder used when an email has no parseable From address. sender_email is NOT NULL,
 * so inserting null (from a missing/unparseable sender, e.g. Exchange "Deleted Items"
 * system messages) would fail with Postgres 23502 and drop the email entirely. */
const UNKNOWN_SENDER = 'unknown@no-sender.invalid';

/**
 * How many of one email's attachments are stored at once. Small on purpose: this runs inside the
 * per-email concurrency of the mailbox loop, so the real parallelism is the product of the two.
 */
const ATTACHMENT_STORE_CONCURRENCY = 3;

/**
 * The mailbox column reduced to its canonical form.
 *
 * Rows archived before addresses were normalized on the way in still hold whatever casing and
 * padding the provider sent, so the column is reduced the same way the value was. Used for grouping
 * as well as matching: without it the same mailbox archived under two casings shows up as two rows
 * in the per-mailbox table and inflates `mailboxCount`.
 */
const normalizedMailbox = sql<string>`lower(btrim(${archivedEmails.userEmail}))`;

/**
 * Matches the mailbox column against an already-normalized address. Without this a provider that
 * changes the casing of a mailbox between syncs misses every dedup check and archives the whole
 * mailbox a second time.
 */
// Exported for the provider-id backfill job, which must scope rows to a mailbox with exactly
// the same normalization the dedup checks here use — two spellings of this predicate would
// only have to disagree once.
export const matchesMailbox = (normalizedAddress: string) =>
	eq(normalizedMailbox, normalizedAddress);

export class IngestionService {
	private static auditService = new AuditService();

	// ── Per-instance memo caches ──────────────────────────────────────────────
	// One IngestionService is constructed per process-mailbox job, so these live and die with the
	// mailbox. Every entry is invariant for the duration of that job: a source's merge topology and
	// its credentials do not change mid-sync, and an attachment's content hash maps to one row.
	//
	// Promises are cached rather than values, so that concurrent first callers — which now exist,
	// since a mailbox archives several emails at a time — collapse onto one query instead of racing
	// and each doing their own.
	private groupIdsCache = new Map<string, Promise<string[]>>();
	private effectiveSourceCache = new Map<string, Promise<IngestionSource>>();

	/**
	 * The Message-ID header as a string, or undefined when the email carries none usable.
	 *
	 * Exists so `dedupKeyFor` and `processEmail` cannot drift apart: the concurrency invariant is
	 * that emails serialized under the same key are exactly the emails that will collide at the
	 * dedup gate, and two independent copies of this unwrapping would only have to disagree once.
	 * The `typeof` guard covers the array branch too — a connector yielding a non-string there would
	 * otherwise reach `Buffer.byteLength` and throw outside any per-email catch, taking the whole
	 * mailbox down on one malformed header.
	 */
	private static messageIdHeaderOf(email: EmailObject): string | undefined {
		const header = email.headers.get('message-id');
		if (typeof header === 'string') {
			return header;
		}
		if (Array.isArray(header) && typeof header[0] === 'string') {
			return header[0];
		}
		return undefined;
	}

	/**
	 * The key an email will be deduplicated under, resolved without reading the message body.
	 *
	 * Callers that archive several emails from one mailbox concurrently need this: gate 1 in
	 * processEmail is a check-then-insert with no unique index behind it, so two emails carrying the
	 * same Message-ID (the same message filed in two folders, a Sent copy) would both find nothing
	 * and both insert. Serializing on this key is what keeps that impossible.
	 *
	 * `collapseGenerated` is for preserve-original (GoBD) sources. Those have a SECOND check-then-
	 * insert gate, on the sha256 of the raw message, which exists precisely for byte-identical
	 * emails whose Message-ID is missing or differs — and those are exactly the emails that fall to
	 * the per-message fallback key below and so would NOT serialize against each other. Collapsing
	 * every header-less email onto one shared key restores the serial loop's guarantee for that
	 * mode, at the cost of processing header-less messages one at a time.
	 *
	 * Elsewhere the fallback is exact rather than approximate: a generated key embeds `email.id`, so
	 * no two of them can collide and there is nothing to serialize.
	 */
	public static dedupKeyFor(email: EmailObject, collapseGenerated = false): string {
		const header = IngestionService.messageIdHeaderOf(email);
		if (header) {
			return IngestionService.boundMessageKey(header);
		}
		return collapseGenerated ? 'keyless' : `id:${email.id}`;
	}
	private static decryptSource(
		source: typeof ingestionSources.$inferSelect
	): IngestionSource | null {
		const decryptedCredentials = CryptoService.decryptObject<IngestionCredentials>(
			source.credentials as string
		);

		if (!decryptedCredentials) {
			logger.error(
				{ sourceId: source.id },
				'Failed to decrypt ingestion source credentials.'
			);
			return null;
		}

		return { ...source, credentials: decryptedCredentials } as IngestionSource;
	}

	public static returnFileBasedIngestions(): IngestionProvider[] {
		return ['pst_import', 'eml_import', 'mbox_import'];
	}

	private static async protectUploadReference<T>(
		next: string | undefined,
		previous: string | undefined,
		persist: (tx: Database) => Promise<T>
	): Promise<T> {
		const paths = [next, previous].filter((path): path is string => Boolean(path));
		if (paths.length === 0) return persist(db);
		return withStorageLocks(paths.map(storagePathLockKey), async (tx) => {
			return {
				keys: [],
				run: async () => {
					if (next && next !== previous && !(await new StorageService().exists(next))) {
						throw new Error(
							'Uploaded import file is missing; upload it again before selecting it'
						);
					}
					return persist(tx);
				},
			};
		});
	}

	public static async releaseCompletedUpload(sessionId: string): Promise<boolean> {
		const [session] = await db
			.select()
			.from(syncSessions)
			.where(eq(syncSessions.id, sessionId));
		const initial = readUploadReceipt(session?.uploadReceipt);
		if (
			!session ||
			!initial ||
			initial.sourceId !== session.ingestionSourceId ||
			initial.expectedMailboxes.length !== session.totalMailboxes ||
			!uploadReceiptSuccessful(initial)
		)
			return false;
		if (initial.disposition === 'handled') return true;
		if (initial.inputClaim === undefined) return false;
		const released = await withStorageLocks(
			[storagePathLockKey(initial.inputPath)],
			async (tx) => {
				const [source] = await tx
					.select()
					.from(ingestionSources)
					.where(eq(ingestionSources.id, initial.sourceId))
					.for('update');
				const sessions = await tx
					.select()
					.from(syncSessions)
					.where(eq(syncSessions.ingestionSourceId, initial.sourceId))
					.for('update');
				const current = sessions.find((row) => row.id === sessionId);
				const receipt = readUploadReceipt(current?.uploadReceipt);
				const credentials = source?.credentials
					? CryptoService.decryptObject<IngestionCredentials>(source.credentials)
					: null;
				if (
					!source ||
					!credentials ||
					!current ||
					!receipt ||
					receipt.sourceId !== current.ingestionSourceId ||
					receipt.inputPath !== initial.inputPath ||
					receipt.expectedMailboxes.length !== current.totalMailboxes ||
					!uploadReceiptSuccessful(receipt)
				)
					return { keys: [], run: async () => false };
				if (receipt.disposition === 'handled' || receipt.inputClaim === undefined) {
					return { keys: [], run: async () => false };
				}
				const matchesCurrentInput = uploadedInputPath(credentials) === receipt.inputPath;
				const ownsCurrentClaim =
					receipt.inputClaim === 'owned' &&
					matchesCurrentInput &&
					!hasNewerUploadClaim(current, source.lastSyncStartedAt, sessions);
				if (ownsCurrentClaim && (source.status === 'paused' || source.status === 'error')) {
					return { keys: [], run: async () => false };
				}
				const otherInputNeeded = sessions.some((row) => {
					if (row.id === sessionId) return false;
					const other = readUploadReceipt(row.uploadReceipt);
					return (
						!other ||
						other.sourceId !== row.ingestionSourceId ||
						other.expectedMailboxes.length !== row.totalMailboxes ||
						(other.inputPath === receipt.inputPath && !uploadReceiptSuccessful(other))
					);
				});
				if (receipt.inputClaim === 'owned' && otherInputNeeded)
					return { keys: [], run: async () => false };
				return {
					keys: [],
					run: async () => {
						// Keep display/original-name metadata, but consumed inputs no longer count as pending references.
						if (ownsCurrentClaim) {
							const updated = { ...credentials };
							if ('uploadedFilePath' in updated) delete updated.uploadedFilePath;
							await tx
								.update(ingestionSources)
								.set({
									credentials: CryptoService.encryptObject(updated),
								})
								.where(eq(ingestionSources.id, source.id));
						}
						if (receipt.inputClaim !== 'released') {
							await tx
								.update(syncSessions)
								.set({ uploadReceipt: { ...receipt, inputClaim: 'released' } })
								.where(eq(syncSessions.id, sessionId));
						}
						return true;
					},
				};
			}
		);
		if (released) {
			await cleanupUnreferencedObjects(new StorageService(), [initial.inputPath]);
			await withStorageLocks([storagePathLockKey(initial.inputPath)], async (tx) => {
				const [current] = await tx
					.select()
					.from(syncSessions)
					.where(eq(syncSessions.id, sessionId))
					.for('update');
				const receipt = readUploadReceipt(current?.uploadReceipt);
				if (
					!current ||
					!receipt ||
					receipt.inputPath !== initial.inputPath ||
					receipt.sourceId !== initial.sourceId ||
					receipt.expectedMailboxes.length !== current.totalMailboxes ||
					receipt.inputClaim !== 'released' ||
					!uploadReceiptSuccessful(receipt)
				) {
					throw new Error('Upload receipt changed before recording input disposition');
				}
				return {
					keys: [],
					run: async () => {
						await tx
							.update(syncSessions)
							.set({ uploadReceipt: { ...receipt, disposition: 'handled' } })
							.where(eq(syncSessions.id, sessionId));
					},
				};
			});
		}
		return released;
	}

	public static async markUploadDispatchFailed(
		id: string,
		inputPath: string,
		claimStartedAt: Date | null | undefined,
		sessionId: string | undefined,
		failure: Pick<UpdateIngestionSourceDto, 'lastSyncStatusMessage' | 'lastSyncFinishedAt'>
	): Promise<boolean> {
		return withStorageLocks([storagePathLockKey(inputPath)], async (tx) => {
			const [source] = await tx
				.select()
				.from(ingestionSources)
				.where(eq(ingestionSources.id, id))
				.for('update');
			const sessions = await tx
				.select()
				.from(syncSessions)
				.where(eq(syncSessions.ingestionSourceId, id))
				.for('update');
			const current = sessions.find((row) => row.id === sessionId);
			const credentials = source ? this.decryptSource(source)?.credentials : null;
			const ownsClaim = Boolean(
				source &&
					credentials &&
					claimStartedAt &&
					source.lastSyncStartedAt?.getTime() === claimStartedAt.getTime() &&
					uploadedInputPath(credentials) === inputPath &&
					['importing', 'syncing'].includes(source.status) &&
					(sessionId
						? current &&
							!hasNewerUploadClaim(current, source.lastSyncStartedAt, sessions)
						: !sessions.some((row) => row.createdAt >= claimStartedAt))
			);
			return {
				keys: [],
				run: async () => {
					if (!ownsClaim) {
						logger.warn(
							{ ingestionSourceId: id, sessionId },
							'Preserving current source state after an obsolete or unknown upload failure'
						);
						return false;
					}
					await tx
						.update(ingestionSources)
						.set({ ...failure, status: 'error' })
						.where(eq(ingestionSources.id, id));
					return true;
				},
			};
		});
	}

	public static async create(
		dto: CreateIngestionSourceDto,
		userId: string,
		actor: User,
		actorIp: string
	): Promise<IngestionSource> {
		const { providerConfig, mergedIntoId, ...rest } = dto;

		if (dto.provider === 'oauth_mailbox') {
			const validation = validateOAuthMailboxConfig(providerConfig);
			if (!validation.ok) {
				throw new Error(validation.message);
			}
			// Server-managed fields never arrive from a client. A crafted create carrying
			// its own tokens would otherwise skip authorization entirely.
			delete providerConfig.tokens;
			delete providerConfig.pendingAuth;
		}

		const encryptedCredentials = CryptoService.encryptObject(providerConfig);

		// Resolve merge target: if mergedIntoId points to a child, follow to the root.
		let resolvedMergedIntoId: string | undefined;
		if (mergedIntoId) {
			const target = await this.findById(mergedIntoId);
			resolvedMergedIntoId = target.mergedIntoId ?? target.id;
		}

		const valuesToInsert = {
			userId,
			...rest,
			status: 'pending_auth' as const,
			credentials: encryptedCredentials,
			mergedIntoId: resolvedMergedIntoId ?? null,
		};

		const [newSource] = await this.protectUploadReference(
			pendingUploadPath(providerConfig),
			undefined,
			async (tx) => tx.insert(ingestionSources).values(valuesToInsert).returning()
		);

		await this.auditService.createAuditLog({
			actorIdentifier: actor.id,
			actionType: 'CREATE',
			targetType: 'IngestionSource',
			targetId: newSource.id,
			actorIp,
			details: {
				sourceName: newSource.name,
				sourceType: newSource.provider,
			},
		});

		const decryptedSource = this.decryptSource(newSource);
		if (!decryptedSource) {
			await this.delete(newSource.id, actor, actorIp, true);
			throw new Error(
				'Failed to process newly created ingestion source due to a decryption error.'
			);
		}
		// An OAuth mailbox has no tokens until its authorization flow completes, so there
		// is nothing to test yet — and the failure path below DELETES the source, which
		// would destroy the row the OAuth callback needs. It stays pending_auth (inert to
		// the scheduler) until the flow flips it to auth_success.
		if (decryptedSource.provider === 'oauth_mailbox') {
			return await this.update(
				decryptedSource.id,
				{ lastSyncStatusMessage: 'Waiting for mailbox authorization.' },
				actor,
				actorIp
			);
		}

		const connector = EmailProviderFactory.createConnector(decryptedSource);

		try {
			const connectionValid = await connector.testConnection();
			// If connection succeeds, update status to auth_success, which triggers the initial import.
			if (connectionValid) {
				return await this.update(
					decryptedSource.id,
					{ status: 'auth_success' },
					actor,
					actorIp
				);
			} else {
				throw Error('Ingestion authentication failed.');
			}
		} catch (error) {
			// If connection fails, delete the newly created source and throw the error.
			await this.delete(decryptedSource.id, actor, actorIp, true);
			throw error;
		}
	}

	public static async findAll(userId: string): Promise<IngestionSource[]> {
		const { drizzleFilter } = await FilterBuilder.create(userId, 'ingestion', 'read');
		let query = db.select().from(ingestionSources).$dynamic();

		if (drizzleFilter) {
			query = query.where(drizzleFilter);
		}

		// Sort alphabetically by name (case-insensitive) so large source lists and the source
		// dropdowns are navigable; createdAt is a stable tiebreaker for duplicate names (#407).
		const sources = await query.orderBy(
			sql`lower(${ingestionSources.name})`,
			desc(ingestionSources.createdAt)
		);
		return sources.flatMap((source) => {
			const decrypted = this.decryptSource(source);
			return decrypted ? [decrypted] : [];
		});
	}

	/**
	 * The stored row, without decrypting credentials.
	 *
	 * Permission checks only read plain columns (`id`, `userId`, `name`, `provider`, `status`), and
	 * a source whose credentials fail to decrypt must still be authorized rather than error.
	 */
	public static async findRowById(
		id: string
	): Promise<typeof ingestionSources.$inferSelect | undefined> {
		const [source] = await db
			.select()
			.from(ingestionSources)
			.where(eq(ingestionSources.id, id));
		return source;
	}

	public static async findById(id: string): Promise<IngestionSource> {
		const [source] = await db
			.select()
			.from(ingestionSources)
			.where(eq(ingestionSources.id, id));
		if (!source) {
			throw new Error('Ingestion source not found');
		}
		const decryptedSource = this.decryptSource(source);
		if (!decryptedSource) {
			throw new Error('Failed to decrypt ingestion source credentials.');
		}
		return decryptedSource;
	}

	/**
	 * Takes exclusive ownership of a source for one sync cycle, or reports that someone else has it.
	 *
	 * Reading the status and then writing it in a second statement is a check-then-act, and two
	 * `continuous-sync` jobs dispatched in the same tick both read `active` before either writes
	 * `syncing`. Both then proceeded, each created its own session, and the two sets of
	 * `process-mailbox` jobs raced the check-then-insert dedup in `processEmail` — which has no
	 * unique index behind it — and archived the same message twice, milliseconds apart. That is why
	 * sources of the same mailbox drift apart in email count while all of them report success.
	 *
	 * One conditional UPDATE closes it: PostgreSQL serializes the two writers on the row, the second
	 * sees the already-committed `syncing` and matches nothing. `RETURNING` gives the caller the row
	 * it just claimed, so nothing has to be re-read.
	 *
	 * @returns the claimed source, or null when another cycle already holds it.
	 */
	public static async claimForSync(id: string): Promise<IngestionSource | null> {
		const [claimed] = await db
			.update(ingestionSources)
			.set({ status: 'syncing', lastSyncStartedAt: new Date() })
			.where(
				and(
					eq(ingestionSources.id, id),
					inArray(ingestionSources.status, ['active', 'error'])
				)
			)
			.returning();

		if (!claimed) {
			return null;
		}

		const decryptedSource = this.decryptSource(claimed);
		if (!decryptedSource) {
			throw new Error('Failed to decrypt ingestion source credentials.');
		}
		return decryptedSource;
	}

	/**
	 * The initial-import counterpart of {@link claimForSync}.
	 *
	 * Excluded rather than included statuses, because an import is legitimate from every state a
	 * source can reach except one already running — a re-import of a `paused` or `imported` source is
	 * something the operator asks for explicitly, while `importing` and `syncing` mean a cycle is
	 * already in flight and a second would duplicate its work.
	 */
	public static async claimForImport(id: string): Promise<IngestionSource | null> {
		const [claimed] = await db
			.update(ingestionSources)
			.set({
				status: 'importing',
				lastSyncStartedAt: new Date(),
				lastSyncStatusMessage: 'Starting initial import...',
			})
			.where(
				and(
					eq(ingestionSources.id, id),
					notInArray(ingestionSources.status, ['importing', 'syncing'])
				)
			)
			.returning();

		if (!claimed) {
			return null;
		}

		const decryptedSource = this.decryptSource(claimed);
		if (!decryptedSource) {
			throw new Error('Failed to decrypt ingestion source credentials.');
		}
		return decryptedSource;
	}

	public static async update(
		id: string,
		dto: UpdateIngestionSourceDto,
		actor?: User,
		actorIp?: string,
		expectedUploadInput?: string,
		expectedUploadSessionId?: string
	): Promise<IngestionSource> {
		const { providerConfig, ...rest } = dto;
		// The preflight only seeds lock discovery, never the credentials eventually persisted.
		const preflight = await this.findById(id);
		const initialPaths = [
			pendingUploadPath(preflight.credentials),
			pendingUploadPath(providerConfig),
		].filter((path): path is string => Boolean(path));
		const { updatedSource, originalSource } = await withStorageLocks(
			initialPaths.map(storagePathLockKey),
			async (tx) => {
				const [fresh] = await tx
					.select()
					.from(ingestionSources)
					.where(eq(ingestionSources.id, id))
					.for('update');
				if (!fresh) throw new Error('Ingestion source not found');
				const originalSource = this.decryptSource(fresh);
				if (!originalSource) throw new Error('Cannot decrypt current source credentials');
				let preserveCurrentClaim = false;
				if (
					expectedUploadInput !== undefined &&
					uploadedInputPath(originalSource.credentials) !== expectedUploadInput
				) {
					throw new Error('Upload input changed before status publication');
				}
				if (expectedUploadSessionId !== undefined) {
					const sessions = await tx
						.select()
						.from(syncSessions)
						.where(eq(syncSessions.ingestionSourceId, id))
						.for('update');
					const session = sessions.find((row) => row.id === expectedUploadSessionId);
					const receipt = readUploadReceipt(session?.uploadReceipt);
					if (
						!session ||
						!receipt ||
						receipt.dispatchAborted ||
						receipt.sourceId !== id ||
						receipt.inputPath !== expectedUploadInput ||
						receipt.disposition === 'handled' ||
						receipt.expectedMailboxes.length !== session.totalMailboxes ||
						receipt.results.length !== receipt.expectedMailboxes.length
					)
						throw new Error('Upload receipt changed before status publication');
					preserveCurrentClaim =
						receipt.inputClaim !== 'owned' ||
						hasNewerUploadClaim(session, fresh.lastSyncStartedAt, sessions);
				}
				const valuesToUpdate: Partial<typeof ingestionSources.$inferInsert> = { ...rest };
				const previous = pendingUploadPath(originalSource.credentials);
				let nextUpload = previous;
				if (providerConfig) {
					if (originalSource.provider === 'oauth_mailbox') {
						// The edit form starts blank (SafeIngestionSource omits credentials), so a
						// wholesale replace would wipe the tokens on every save. Merge instead:
						// server-managed fields carry over, a blank clientSecret keeps the stored
						// one, and only a change to WHO or WHERE to authenticate invalidates the
						// tokens and sends the source back to pending_auth for re-authorization.
						const { merged, connectionChanged } = mergeOAuthCredentials(
							originalSource.credentials as OAuthMailboxCredentials,
							providerConfig
						);
						if (connectionChanged) {
							const validation = validateOAuthMailboxConfig(merged);
							if (!validation.ok) {
								throw new Error(validation.message);
							}
							valuesToUpdate.status = 'pending_auth';
							valuesToUpdate.lastSyncStatusMessage =
								'Connection settings changed - re-authorization required.';
						}
						valuesToUpdate.credentials = CryptoService.encryptObject(merged);
					} else {
						// The edit form starts blank for every provider (SafeIngestionSource omits
						// credentials), so what arrives here is not the new truth — it is whatever
						// the admin typed over a form that could not show the old values. Merging
						// keeps stored fields wherever the incoming ones are blank; storing the
						// incoming object wholesale is how a rename-only edit once wiped a working
						// Microsoft 365 source down to two IMAP form defaults.
						const result = mergeProviderCredentials(
							originalSource.credentials,
							providerConfig
						);
						if (!result.ok) {
							throw new Error(result.message);
						}
						valuesToUpdate.credentials = CryptoService.encryptObject(result.merged);
						nextUpload = pendingUploadPath(result.merged);
					}
				}
				return {
					keys: [previous, nextUpload]
						.filter((path): path is string => Boolean(path))
						.map(storagePathLockKey),
					run: async () => {
						if (
							preserveCurrentClaim ||
							(expectedUploadInput !== undefined &&
								originalSource.status === 'paused')
						) {
							return { updatedSource: fresh, originalSource };
						}
						if (
							nextUpload &&
							nextUpload !== previous &&
							!(await new StorageService().exists(nextUpload))
						) {
							throw new Error(
								'Uploaded import file is missing; upload it again before selecting it'
							);
						}
						const [updatedSource] = await tx
							.update(ingestionSources)
							.set(valuesToUpdate)
							.where(eq(ingestionSources.id, id))
							.returning();
						return { updatedSource, originalSource };
					},
				};
			}
		);

		if (!updatedSource) {
			throw new Error('Ingestion source not found');
		}

		const decryptedSource = this.decryptSource(updatedSource);

		if (!decryptedSource) {
			throw new Error(
				'Failed to process updated ingestion source due to a decryption error.'
			);
		}

		// If the status has changed to auth_success, trigger the initial import
		if (originalSource.status !== 'auth_success' && decryptedSource.status === 'auth_success') {
			await this.triggerInitialImport(decryptedSource.id);
		}
		if (actor && actorIp) {
			const changedFields = Object.keys(dto).filter(
				(key) =>
					key !== 'providerConfig' &&
					originalSource[key as keyof IngestionSource] !==
						decryptedSource[key as keyof IngestionSource]
			);
			if (changedFields.length > 0) {
				await this.auditService.createAuditLog({
					actorIdentifier: actor.id,
					actionType: 'UPDATE',
					targetType: 'IngestionSource',
					targetId: id,
					actorIp,
					details: {
						changedFields,
					},
				});
			}
		}

		return decryptedSource;
	}

	/**
	 * Returns all ingestionSourceId values in a merge group given any member's ID.
	 * If the source is standalone (no parent, no children), returns just its own ID.
	 */
	public static async findGroupSourceIds(
		sourceId: string,
		known?: Pick<IngestionSource, 'id' | 'mergedIntoId'>
	): Promise<string[]> {
		// `known` lets a caller that already holds the row skip a second SELECT — and, more to the
		// point, a second AES decrypt of its credentials, which findById does on every call.
		const source = known ?? (await this.findById(sourceId));
		const rootId = source.mergedIntoId ?? source.id;

		const children = await db
			.select({ id: ingestionSources.id })
			.from(ingestionSources)
			.where(eq(ingestionSources.mergedIntoId, rootId));

		return [rootId, ...children.map((c) => c.id)];
	}

	/**
	 * Restricts a query to one merge group's archived emails.
	 *
	 * `inArray` handles a single-element list perfectly well, so the `length === 1 ? eq : inArray`
	 * ternary this replaces was branching for no reason — in nine separate copies.
	 */
	public static groupScopeFilter(sourceIds: string[]): SQL {
		return inArray(archivedEmails.ingestionSourceId, sourceIds);
	}

	/**
	 * Bulk id → name lookup for ingestion sources. Used to attach human-readable
	 * labels to counts computed elsewhere (e.g. Meilisearch facet distributions).
	 * Ids with no matching row are simply absent from the returned record.
	 */
	public static async getSourceNames(ids: string[]): Promise<Record<string, string>> {
		if (ids.length === 0) return {};
		const rows = await db
			.select({ id: ingestionSources.id, name: ingestionSources.name })
			.from(ingestionSources)
			.where(inArray(ingestionSources.id, ids));
		const map: Record<string, string> = {};
		for (const row of rows) {
			map[row.id] = row.name;
		}
		return map;
	}

	/**
	 * Detaches a child source from its merge group, making it standalone.
	 */
	public static async unmerge(
		id: string,
		actor: User,
		actorIp: string
	): Promise<IngestionSource> {
		const source = await this.findById(id);
		if (!source.mergedIntoId) {
			throw new Error('Source is not merged into another source.');
		}

		const [updated] = await db
			.update(ingestionSources)
			.set({ mergedIntoId: null })
			.where(eq(ingestionSources.id, id))
			.returning();

		await this.auditService.createAuditLog({
			actorIdentifier: actor.id,
			actionType: 'UPDATE',
			targetType: 'IngestionSource',
			targetId: id,
			actorIp,
			details: {
				action: 'unmerge',
				previousParentId: source.mergedIntoId,
			},
		});

		const decrypted = this.decryptSource(updated);
		if (!decrypted) {
			throw new Error('Failed to decrypt unmerged source.');
		}
		return decrypted;
	}

	public static async delete(
		id: string,
		actor: User,
		actorIp: string,
		force: boolean = false
	): Promise<IngestionSource> {
		if (!force) {
			checkDeletionEnabled();
		}
		const source = await this.findById(id);
		if (!source) {
			throw new Error('Ingestion source not found');
		}

		const scope = source.mergedIntoId
			? eq(ingestionSources.id, id)
			: or(eq(ingestionSources.id, id), eq(ingestionSources.mergedIntoId, id));
		const planned = await db.select().from(ingestionSources).where(scope);
		const ids = planned.map((row) => row.id);
		const { deletedRows, pendingUploads } = await withStoragePurgeLock(async (tx) => {
			const fresh = await tx.select().from(ingestionSources).where(scope).for('update');
			if (
				fresh.length !== planned.length ||
				!fresh.some((row) => row.id === id) ||
				fresh.some(
					(row) =>
						!planned.some(
							(old) => old.id === row.id && old.mergedIntoId === row.mergedIntoId
						)
				)
			) {
				throw new Error(
					'Ingestion source group changed before deletion; retry the operation'
				);
			}
			const [outsideCarrier] = await tx
				.select({ id: archivedEmails.id })
				.from(emailAttachments)
				.innerJoin(
					attachmentsSchema,
					eq(attachmentsSchema.id, emailAttachments.attachmentId)
				)
				.innerJoin(archivedEmails, eq(archivedEmails.id, emailAttachments.emailId))
				.where(
					and(
						inArray(attachmentsSchema.ingestionSourceId, ids),
						notInArray(archivedEmails.ingestionSourceId, ids)
					)
				)
				.limit(1);
			if (outsideCarrier) {
				throw new Error(
					'Source attachments are still referenced by another source; deletion refused'
				);
			}
			const receipts = await tx
				.select()
				.from(syncSessions)
				.where(inArray(syncSessions.ingestionSourceId, ids));
			const receiptPaths = receipts.flatMap((session) => {
				if (session.uploadReceipt === null) return [];
				const receipt = readUploadReceipt(session.uploadReceipt);
				if (!receipt || receipt.sourceId !== session.ingestionSourceId) {
					throw new Error(
						`Cannot verify upload receipt for source deletion: ${session.id}`
					);
				}
				return [receipt.inputPath];
			});
			const pendingUploads = [
				...new Set([
					...receiptPaths,
					...fresh
						.map((row) => pendingUploadFromRow(row))
						.filter((path): path is string => Boolean(path)),
				]),
			];
			return {
				keys: [],
				run: async () => {
					const searchService = new SearchService();
					for (const sourceId of ids) {
						const task = await searchService.deleteDocumentsByFilter(
							'emails',
							`ingestionSourceId = ${quoteMeiliString(sourceId)}`
						);
						await searchService.waitForTask(task.taskUid);
					}
					const deletedRows = await tx
						.delete(ingestionSources)
						.where(inArray(ingestionSources.id, ids))
						.returning();
					return { deletedRows, pendingUploads };
				},
			};
		});
		const deletedSource = deletedRows.find((row) => row.id === id);
		if (!deletedSource) throw new Error('Ingestion source not found');
		for (const deleted of deletedRows) {
			await this.auditService.createAuditLog({
				actorIdentifier: actor.id,
				actionType: 'DELETE',
				targetType: 'IngestionSource',
				targetId: deleted.id,
				actorIp,
				details: { sourceName: deleted.name },
			});
		}
		// Refused or rolled-back purges leave queued work intact. Late workers reject the deleted source.
		try {
			const jobs = await ingestionQueue.getJobs([
				'waiting',
				'delayed',
				'paused',
				'prioritized',
			]);
			for (const job of jobs) {
				if (ids.includes(job.data.ingestionSourceId)) await job.remove();
			}
		} catch (error) {
			logger.error(
				{ error, sourceIds: ids },
				'Source metadata deleted but queued-job cleanup failed'
			);
			throw error;
		}
		const storage = new StorageService();
		try {
			await withStoragePurgeLock(async (tx) => {
				const removable: string[] = [];
				const prefixes = ids.map(
					(sourceId) => `${config.storage.openArchiverFolderName}/${sourceId}/`
				);
				const uploadPrefixes = new Set(await referencedUploads(tx, prefixes, true));
				for (const sourceId of ids) {
					const prefix = `${config.storage.openArchiverFolderName}/${sourceId}/`;
					const [liveSource] = await tx
						.select({ id: ingestionSources.id })
						.from(ingestionSources)
						.where(eq(ingestionSources.id, sourceId))
						.limit(1);
					const [emailRef] = await tx
						.select({ id: archivedEmails.id })
						.from(archivedEmails)
						.where(
							sql`left(${archivedEmails.storagePath}, ${prefix.length}) = ${prefix}`
						)
						.limit(1);
					const [attachmentRef] = await tx
						.select({ id: attachmentsSchema.id })
						.from(attachmentsSchema)
						.where(
							sql`left(${attachmentsSchema.storagePath}, ${prefix.length}) = ${prefix}`
						)
						.limit(1);
					if (!liveSource && !emailRef && !attachmentRef && !uploadPrefixes.has(prefix))
						removable.push(prefix);
				}
				return {
					keys: [],
					run: async () => {
						for (const prefix of removable) await storage.delete(prefix);
					},
				};
			});
			await cleanupUnreferencedObjects(storage, pendingUploads);
		} catch (error) {
			logger.error(
				{ error, sourceIds: ids },
				'Source metadata deleted but storage cleanup failed'
			);
			throw error;
		}

		const decryptedSource = this.decryptSource(deletedSource);
		if (!decryptedSource) {
			// Even if decryption fails, we should confirm deletion.
			// We might return a simpler object or just a success message.
			// For now, we'll indicate the issue but still confirm deletion happened.
			logger.warn(
				{ sourceId: deletedSource.id },
				'Could not decrypt credentials of deleted source, but deletion was successful.'
			);
			return { ...deletedSource, credentials: null } as unknown as IngestionSource;
		}
		return decryptedSource;
	}

	public static async triggerInitialImport(id: string): Promise<void> {
		const source = await this.findById(id);

		// A fixed job id, so a second import cannot be queued beside a running one, and so the
		// stale-source rescue can tell an abandoned import from one still enumerating mailboxes.
		// Claimed rather than merely added: BullMQ drops an add whose id still has a record, and a
		// completed record is retained, so without clearing it a later re-import would silently do
		// nothing — the failure mode behind #446.
		const alreadyRunning = await claimJobId(ingestionQueue, initialImportJobId(source.id));
		if (alreadyRunning) {
			logger.info(
				{ ingestionSourceId: source.id },
				'Initial import already queued or running - not starting a second one'
			);
			return;
		}

		await ingestionQueue.add(
			'initial-import',
			{ ingestionSourceId: source.id },
			{ jobId: initialImportJobId(source.id) }
		);
	}

	/**
	 * Enqueues a reindex of a single ingestion source (and its merge group).
	 * Rebuilds search documents from existing archived rows — never re-ingests.
	 * @param mode 'missing' (default) reindexes only emails not yet in the index;
	 *   'full' rebuilds every document for the source.
	 */
	public static async triggerReindex(
		id: string,
		mode: ReindexMode = 'missing'
	): Promise<IReindexDispatch> {
		const source = await this.findById(id);
		if (!source) {
			throw new Error('Ingestion source not found');
		}

		const groupIds = await this.findGroupSourceIds(id, source);
		const scopeFilter = this.groupScopeFilter(groupIds);
		const [pending, workerAlive] = await Promise.all([
			this.countReindexTargets(mode, scopeFilter),
			isIndexingWorkerAlive(),
		]);

		// attempts: 1 — the master reindex resets is_indexed=false before dispatching, so an
		// auto-retry would re-reset rows workers already re-indexed. A failed dispatch is
		// re-triggerable by hand and the periodic reconcile job backstops any gap. The
		// per-batch index-email-batch jobs keep the default retries (they are idempotent).
		await indexingQueue.add(
			'reindex',
			{
				scope: 'source',
				ingestionSourceId: source.id,
				mode,
			},
			{ attempts: 1 }
		);

		return { pending, workerAlive };
	}

	/**
	 * Enqueues a reindex of the entire archive across all sources.
	 * @param mode 'missing' (default) or 'full'.
	 */
	public static async triggerReindexAll(
		mode: ReindexMode = 'missing'
	): Promise<IReindexDispatch> {
		const [pending, workerAlive] = await Promise.all([
			this.countReindexTargets(mode),
			isIndexingWorkerAlive(),
		]);

		// attempts: 1 — see triggerReindex; the destructive is_indexed reset must not auto-retry.
		await indexingQueue.add('reindex', { scope: 'all', mode }, { attempts: 1 });

		return { pending, workerAlive };
	}

	/**
	 * How many emails the dispatched reindex job will hand to the indexer, using the same predicate
	 * the processor applies: `full` rebuilds everything in scope, `missing` only what the database
	 * believes is absent from the index.
	 *
	 * Counted here rather than reported by the job so the answer can travel back on the HTTP
	 * response. It is a snapshot — ingestion may add rows between this count and the job running —
	 * but the distinction that matters to a user, "some" versus "none at all", is exact.
	 */
	private static async countReindexTargets(
		mode: ReindexMode,
		scopeFilter?: SQL
	): Promise<number> {
		const [row] = await db
			.select({ total: count() })
			.from(archivedEmails)
			.where(buildReindexWhere(mode, scopeFilter));

		return row?.total ?? 0;
	}

	/**
	 * Index-health snapshot for a single source (and its merge group): how many
	 * emails are archived in the database vs. how many documents exist in the index.
	 * A gap indicates emails missing from search that a reindex can repair.
	 */
	public static async getIndexHealth(
		id: string
	): Promise<{ archivedCount: number; indexedCount: number }> {
		const groupIds = await this.findGroupSourceIds(id);
		const sourceFilter = IngestionService.groupScopeFilter(groupIds);

		// Count archived rows vs. rows the DB knows are indexed in a single scan.
		// `is_indexed` is set by IndexingService.markIndexed only after Meilisearch
		// confirms the write, so this is an exact, uncapped indexed count. (The global
		// dashboard health cross-checks the true Meili document count instead; per-source
		// we trust the flag, which is also what reindex/reconcile act on.)
		const [row] = await db
			.select({
				archivedCount: count(),
				indexedCount:
					sql<number>`count(*) filter (where ${archivedEmails.isIndexed})`.mapWith(
						Number
					),
			})
			.from(archivedEmails)
			.where(sourceFilter);

		return { archivedCount: row?.archivedCount ?? 0, indexedCount: row?.indexedCount ?? 0 };
	}

	/**
	 * Rich read-only statistics for a source, aggregated across its whole merge group.
	 * Backs the per-source statistics page. All queries are group-scoped.
	 */
	public static async getIngestionStats(id: string): Promise<IngestionStats> {
		const source = await this.findById(id);
		const rootId = source.mergedIntoId ?? source.id;
		const groupIds = await this.findGroupSourceIds(id);

		const emailFilter = IngestionService.groupScopeFilter(groupIds);
		const attachmentFilter = inArray(attachmentsSchema.ingestionSourceId, groupIds);

		const thirtyDaysAgo = new Date();
		thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

		// Run the independent aggregate queries concurrently.
		const [
			emailAggRows,
			physicalRows,
			attachmentAggRows,
			mailboxRows,
			mailboxBytesRows,
			children,
			recentActivity,
		] = await Promise.all([
			// Email aggregates in a single scan.
			db
				.select({
					totalEmails: count(),
					// Counted on the normalized address so one mailbox archived under two
					// casings is one mailbox, not two.
					mailboxCount: countDistinct(normalizedMailbox),
					threadCount: countDistinct(archivedEmails.threadId),
					firstEmailAt: min(archivedEmails.sentAt),
					lastEmailAt: max(archivedEmails.sentAt),
					journaledCount:
						sql<number>`count(*) filter (where ${archivedEmails.isJournaled})`.mapWith(
							Number
						),
					legalHoldCount:
						sql<number>`count(*) filter (where ${archivedEmails.isOnLegalHold})`.mapWith(
							Number
						),
					emailsWithAttachments:
						sql<number>`count(*) filter (where ${archivedEmails.hasAttachments})`.mapWith(
							Number
						),
					// Exact, uncapped index coverage from the DB `is_indexed` flag (set only
					// after Meilisearch confirms the write) — same source of truth reindex uses.
					indexedCount:
						sql<number>`count(*) filter (where ${archivedEmails.isIndexed})`.mapWith(
							Number
						),
				})
				.from(archivedEmails)
				.where(emailFilter),
			// Physical email storage: dedup by file hash so shared-file reference rows
			// (same physical .eml reused across mailboxes) are not double-counted.
			db
				.select({
					bytes: sql<number>`coalesce(sum(t.size_bytes), 0)`.mapWith(Number),
				})
				.from(
					sql`(select distinct ${archivedEmails.storageHashSha256} as hash, ${archivedEmails.sizeBytes} as size_bytes from ${archivedEmails} where ${emailFilter}) as t`
				),
			// Attachment aggregates (attachments are already deduplicated per root source).
			db
				.select({
					attachmentCount: count(),
					attachmentBytes:
						sql<number>`coalesce(sum(${attachmentsSchema.sizeBytes}), 0)`.mapWith(
							Number
						),
				})
				.from(attachmentsSchema)
				.where(attachmentFilter),
			// Per-mailbox email counts (raw, ordered by count desc). Storage is computed
			// separately below with hash-dedup so it matches the group `emailBytes` basis.
			db
				.select({
					userEmail: normalizedMailbox,
					emailCount: count(),
				})
				.from(archivedEmails)
				.where(emailFilter)
				.groupBy(normalizedMailbox)
				.orderBy(desc(count())),
			// Per-mailbox physical storage, deduplicated by file hash within each mailbox
			// (same methodology as the group-level `emailBytes`). A file shared across
			// different mailboxes is still attributed to each mailbox that received it, so
			// the parts can exceed the deduped group total — that is inherent to per-mailbox
			// attribution of shared storage.
			db
				.select({
					userEmail: sql<string>`t.user_email`,
					bytes: sql<number>`coalesce(sum(t.size_bytes), 0)`.mapWith(Number),
				})
				// Normalized to the same expression as the per-mailbox counts above: the two
				// results are joined on this value in JS, so normalizing only one of them would
				// make every lookup miss and report zero bytes for each mailbox.
				.from(
					sql`(select distinct ${normalizedMailbox} as user_email, ${archivedEmails.storageHashSha256} as hash, ${archivedEmails.sizeBytes} as size_bytes from ${archivedEmails} where ${emailFilter}) as t`
				)
				.groupBy(sql`t.user_email`),
			// Merge-group children metadata.
			db
				.select({
					id: ingestionSources.id,
					name: ingestionSources.name,
					provider: ingestionSources.provider,
					status: ingestionSources.status,
				})
				.from(ingestionSources)
				.where(eq(ingestionSources.mergedIntoId, rootId)),
			// Emails archived per day over the last 30 days.
			db
				.select({
					date: sql<string>`date_trunc('day', ${archivedEmails.archivedAt})`,
					count: count(),
				})
				.from(archivedEmails)
				.where(and(emailFilter, gte(archivedEmails.archivedAt, thirtyDaysAgo)))
				.groupBy(sql`date_trunc('day', ${archivedEmails.archivedAt})`)
				.orderBy(sql`date_trunc('day', ${archivedEmails.archivedAt})`),
		]);

		const emailAgg = emailAggRows[0];
		const emailBytes = physicalRows[0]?.bytes ?? 0;
		const attachmentBytes = attachmentAggRows[0]?.attachmentBytes ?? 0;

		// Merge the raw per-mailbox counts with the hash-deduped per-mailbox bytes.
		const bytesByMailbox = new Map(mailboxBytesRows.map((r) => [r.userEmail, r.bytes]));
		const mailboxes = mailboxRows.map((m) => ({
			userEmail: m.userEmail,
			emailCount: m.emailCount,
			bytes: bytesByMailbox.get(m.userEmail) ?? 0,
		}));

		return {
			sourceId: source.id,
			name: source.name,
			provider: source.provider,
			status: source.status,
			totalEmails: emailAgg?.totalEmails ?? 0,
			mailboxCount: emailAgg?.mailboxCount ?? 0,
			threadCount: emailAgg?.threadCount ?? 0,
			emailBytes,
			attachmentBytes,
			totalBytes: emailBytes + attachmentBytes,
			attachmentCount: attachmentAggRows[0]?.attachmentCount ?? 0,
			emailsWithAttachments: emailAgg?.emailsWithAttachments ?? 0,
			indexedCount: emailAgg?.indexedCount ?? 0,
			journaledCount: emailAgg?.journaledCount ?? 0,
			legalHoldCount: emailAgg?.legalHoldCount ?? 0,
			firstEmailAt: emailAgg?.firstEmailAt
				? new Date(emailAgg.firstEmailAt).toISOString()
				: null,
			lastEmailAt: emailAgg?.lastEmailAt
				? new Date(emailAgg.lastEmailAt).toISOString()
				: null,
			lastSyncStartedAt: source.lastSyncStartedAt ?? null,
			lastSyncFinishedAt: source.lastSyncFinishedAt ?? null,
			lastSyncStatusMessage: source.lastSyncStatusMessage ?? null,
			mailboxes,
			children,
			recentActivity,
		};
	}

	public static async triggerForceSync(id: string, actor: User, actorIp: string): Promise<void> {
		const source = await this.findById(id);
		logger.info({ ingestionSourceId: id }, 'Force syncing started.');
		if (!source) {
			throw new Error('Ingestion source not found');
		}

		// Clean up existing jobs for this source to break any stuck flows
		const jobTypes: JobType[] = ['active', 'waiting', 'failed', 'delayed', 'paused'];
		const jobs = await ingestionQueue.getJobs(jobTypes);
		for (const job of jobs) {
			if (job.data.ingestionSourceId === id) {
				try {
					await job.remove();
					logger.info(
						{ jobId: job.id, ingestionSourceId: id },
						'Removed stale job during force sync.'
					);
				} catch (error) {
					logger.error({ err: error, jobId: job.id }, 'Failed to remove stale job.');
				}
			}
		}

		// Reset status to 'active'
		await this.update(
			id,
			{
				status: 'active',
				lastSyncStatusMessage: 'Force sync triggered by user.',
			},
			actor,
			actorIp
		);

		await this.auditService.createAuditLog({
			actorIdentifier: actor.id,
			actionType: 'SYNC',
			targetType: 'IngestionSource',
			targetId: id,
			actorIp,
			details: {
				sourceName: source.name,
			},
		});

		// Same per-source job id the scheduler uses, so a force sync pressed while a cycle is already
		// running joins it instead of starting a competing one.
		await ingestionQueue.add(
			'continuous-sync',
			{ ingestionSourceId: source.id },
			{
				jobId: continuousSyncJobId(source.id),
				removeOnComplete: true,
				removeOnFail: true,
			}
		);

		// If this is a root source, also trigger sync for all non-file-based active/error children
		if (!source.mergedIntoId) {
			const fileBasedProviders = this.returnFileBasedIngestions();
			const children = await db
				.select({
					id: ingestionSources.id,
					provider: ingestionSources.provider,
					status: ingestionSources.status,
				})
				.from(ingestionSources)
				.where(eq(ingestionSources.mergedIntoId, id));

			for (const child of children) {
				if (
					!fileBasedProviders.includes(child.provider) &&
					(child.status === 'active' || child.status === 'error')
				) {
					logger.info(
						{ childId: child.id, parentId: id },
						'Cascading force sync to child source.'
					);
					await ingestionQueue.add(
						'continuous-sync',
						{ ingestionSourceId: child.id },
						{
							jobId: continuousSyncJobId(child.id),
							removeOnComplete: true,
							removeOnFail: true,
						}
					);
				}
			}
		}
	}

	public static async performBulkImport(
		job: IInitialImportJob,
		actor: User,
		actorIp: string
	): Promise<void> {
		const { ingestionSourceId } = job;
		const source = await IngestionService.findById(ingestionSourceId);
		if (!source) {
			throw new Error(`Ingestion source ${ingestionSourceId} not found.`);
		}

		logger.info(`Starting bulk import for source: ${source.name} (${source.id})`);
		await IngestionService.update(
			ingestionSourceId,
			{
				status: 'importing',
				lastSyncStartedAt: new Date(),
			},
			actor,
			actorIp
		);

		const connector = EmailProviderFactory.createConnector(source);

		try {
			if (connector.listAllUsers) {
				// For multi-mailbox providers, dispatch a job for each user
				for await (const user of connector.listAllUsers()) {
					// Normalized here so the mailbox identity is canonical before it is queued.
					const userEmail = user.primaryEmail
						? normalizeEmailAddress(user.primaryEmail)
						: '';
					if (userEmail) {
						await ingestionQueue.add('process-mailbox', {
							ingestionSourceId: source.id,
							userEmail: userEmail,
						});
					}
				}
			} else {
				// For single-mailbox providers, dispatch a single job
				await ingestionQueue.add('process-mailbox', {
					ingestionSourceId: source.id,
					userEmail:
						source.credentials.type === 'generic_imap'
							? normalizeEmailAddress(source.credentials.username)
							: 'default',
				});
			}
		} catch (error) {
			logger.error(`Bulk import failed for source: ${source.name} (${source.id})`, error);
			await IngestionService.update(
				ingestionSourceId,
				{
					status: 'error',
					lastSyncFinishedAt: new Date(),
					lastSyncStatusMessage:
						error instanceof Error ? error.message : 'An unknown error occurred.',
				},
				actor,
				actorIp
			);
			throw error; // Re-throw to allow BullMQ to handle the job failure
		}
	}

	/**
	 * Pre-fetch duplicate check to avoid unnecessary API calls during ingestion.
	 * Checks both providerMessageId (for Google/Microsoft API IDs) and
	 * messageIdHeader (for IMAP/PST/EML/Mbox RFC Message-IDs and pre-migration rows).
	 *
	 * `rawInternetMessageId` is the RFC 5322 Message-ID when the connector's listing already
	 * carries it (Microsoft Graph's does). It is the key that stays valid when the provider's
	 * own id has drifted: rows written before provider ids were stored hold NULL there, and
	 * Graph re-keys messages on folder moves and re-keyed everything once on the switch to
	 * immutable ids. Matching the header directly is what turns those from a full re-download
	 * into a skip.
	 *
	 * SIDE EFFECT, deliberately here and not in processEmail: when the header matched but the
	 * stored provider id is stale (NULL, or a different id for the same message), the row is
	 * updated to the incoming id. Gate 1 in processEmail only runs when THIS check missed, so
	 * a row this check keeps matching by header would otherwise never converge to the current
	 * id format. One single-row indexed UPDATE, only on the paths that pass the header, so
	 * IMAP/Google/file callers can never rewrite anything.
	 *
	 * The check is scoped to a specific mailbox (userEmail) within the merge group.
	 * This allows different mailbox owners to each get their own archived_emails row
	 * for the same physical email — only skipping the download when this particular
	 * mailbox already has the email.
	 */
	public static async doesEmailExist(
		rawMessageId: string,
		ingestionSourceId: string,
		rawUserEmail: string,
		knownGroupIds?: string[],
		rawInternetMessageId?: string
	): Promise<boolean> {
		// Bounded on the way in so this pre-fetch check compares against the same key processEmail
		// stored. Without it an over-long id would look absent here and be downloaded again on
		// every sync.
		const messageId = IngestionService.boundMessageKey(rawMessageId);
		const headerCandidate = rawInternetMessageId
			? IngestionService.boundMessageKey(rawInternetMessageId)
			: undefined;
		const userEmail = normalizeEmailAddress(rawUserEmail);
		// The group is invariant for a whole mailbox job, so the caller resolves it once and passes
		// it in. Without that this ran a SELECT for every message the connector offered — before the
		// message was even downloaded.
		const groupIds = knownGroupIds ?? (await this.findGroupSourceIds(ingestionSourceId));
		const sourceFilter = IngestionService.groupScopeFilter(groupIds);

		const keyMatches = [
			eq(archivedEmails.providerMessageId, messageId),
			eq(archivedEmails.messageIdHeader, messageId),
		];
		if (headerCandidate) {
			keyMatches.push(eq(archivedEmails.messageIdHeader, headerCandidate));
		}

		const existingEmail = await db.query.archivedEmails.findFirst({
			where: and(sourceFilter, matchesMailbox(userEmail), or(...keyMatches)),
			columns: { id: true, providerMessageId: true },
		});
		if (!existingEmail) {
			return false;
		}

		// The refresh described in the docblock. Restricted to callers that passed the header:
		// that is what proves the incoming id is a provider id for this very message rather
		// than a Message-ID (IMAP) or an id the row was never keyed by.
		if (headerCandidate && existingEmail.providerMessageId !== messageId) {
			await db
				.update(archivedEmails)
				.set({ providerMessageId: messageId })
				.where(eq(archivedEmails.id, existingEmail.id));
			logger.debug(
				{ archivedEmailId: existingEmail.id, ingestionSourceId },
				'Refreshed stale provider message id on dedup match'
			);
		}
		return true;
	}

	/** Reads the Message-ID out of an .eml's header block, or undefined when it carries none. */
	private static messageIdOfRawEml(eml: Buffer): string | undefined {
		// Headers end at the first blank line; 64 KiB is far past any real header block and keeps
		// a malformed file from being scanned in full.
		const head = eml.subarray(0, Math.min(eml.length, 64 * 1024)).toString('latin1');
		const headerBlock = head.split(/\r?\n\r?\n/, 1)[0];
		// Unfolded: a continuation line starts with whitespace.
		const match = headerBlock.match(/^message-id:[ \t]*((?:.|\r?\n[ \t])*)$/im);
		return match ? match[1].replace(/\r?\n[ \t]+/g, ' ').trim() : undefined;
	}

	/**
	 * Writes an email's bytes without ever replacing what is already at the path, and reports
	 * where they ended up together with the hash and size of that object.
	 *
	 * The path is derived from `email.id`, so two workers archiving the same message — a journal
	 * report delivered twice, both copies racing the check-then-insert dedup — target one path.
	 * An unconditional write let the second silently replace the first's bytes while both rows
	 * kept the hash of what they had written; every row but the last writer's then failed its
	 * integrity check against bytes that no longer existed.
	 *
	 * A path collision is not proof of the same message, though. `email.id` falls back to the
	 * IMAP UID when a message has no Message-ID, and a UIDVALIDITY reset reassigns those, so a
	 * different email can land on a taken path — as can a re-ingest after a purge that left the
	 * file behind. Adopting blindly there would store one message under a row describing another,
	 * and the integrity report would call it verified. So adoption requires the stored object to
	 * carry the same Message-ID; anything else gets its own content-addressed path.
	 */
	private async storeEmailOrAdopt(
		storage: StorageService,
		emailPath: string,
		content: Buffer,
		context: {
			messageId: string;
			userEmail: string;
			ingestionSourceId: string;
			/** The incoming email's own Message-ID header, when it has one. */
			messageIdHeader?: string;
			/** sha256 of `content`, when the caller has already computed it. */
			knownHash?: string;
		}
	): Promise<{ storagePath: string; hash: string; sizeBytes: number }> {
		const hashOf = (buffer: Buffer): string =>
			createHash('sha256').update(buffer).digest('hex');

		try {
			await storage.put(emailPath, content, { overwrite: false });
			return {
				storagePath: emailPath,
				hash: context.knownHash ?? hashOf(content),
				sizeBytes: content.length,
			};
		} catch (error) {
			if (!isStorageObjectExistsError(error)) {
				throw error;
			}
		}

		// Read through StorageService, so these are the plaintext bytes — the same ones
		// IntegrityService will hash when it verifies the row.
		const stored = await streamToBuffer(await storage.get(emailPath));
		const storedMessageId = IngestionService.messageIdOfRawEml(stored);
		const incomingMessageId =
			context.messageIdHeader ?? IngestionService.messageIdOfRawEml(content);

		if (
			storedMessageId &&
			incomingMessageId &&
			storedMessageId.trim() === incomingMessageId.trim()
		) {
			logger.warn(
				{ ...context, storagePath: emailPath, knownHash: undefined },
				'Archive file already existed at this path for the same message; adopting the stored bytes instead of overwriting them'
			);
			return {
				storagePath: emailPath,
				hash: hashOf(stored),
				sizeBytes: stored.length,
			};
		}

		// Different message, or one of the two has no Message-ID to compare. Give this content its
		// own name. The suffix is the content hash, so a genuine retry of this same email lands on
		// the same path and its EEXIST means byte-identical content — safe to adopt directly.
		const contentHash = context.knownHash ?? hashOf(content);
		const disambiguated = `${emailPath.replace(/\.eml$/, '')}-${contentHash.slice(0, 8)}.eml`;
		logger.warn(
			{
				...context,
				storagePath: emailPath,
				storedMessageId,
				incomingMessageId,
				disambiguatedPath: disambiguated,
			},
			'Archive path already held a different message; storing this one under a content-addressed path'
		);

		try {
			await storage.put(disambiguated, content, { overwrite: false });
		} catch (error) {
			if (!isStorageObjectExistsError(error)) {
				throw error;
			}
			// Same content hash in the name, so the object there is these very bytes.
		}
		return { storagePath: disambiguated, hash: contentHash, sizeBytes: content.length };
	}

	/**
	 * Builds the filesystem-safe filename component for an email's .eml from its id.
	 * The provider id / Message-ID becomes an actual filename, but Exchange-style ids can
	 * exceed the 255-byte filename limit or contain '/', producing ENAMETOOLONG / bad-path
	 * mkdir errors that drop the email (#405). When the id is unsafe we substitute its
	 * sha256 hash; archived_emails.message_id_header still holds the Message-ID, clamped by
	 * boundMessageKey only in the pathological case, and the stored .eml always holds the header
	 * exactly as it arrived. Short, safe ids are left as-is so common filenames stay
	 * human-readable.
	 *
	 * Byte budget: the last folder segment of email.path is glued into the SAME path
	 * component as this filename (`${sanitizedPath}${fileName}.eml` with no separator), so
	 * the two share the 255-byte limit: folder segment ≤ PATH_SEGMENT_MAX_BYTES (100 + 9
	 * hash suffix) + id ≤ EMAIL_ID_MAX_BYTES (140) + '.eml' (4) = 253 bytes worst case.
	 * Lengths are measured in BYTES (Buffer.byteLength), not chars — a 140-char multibyte
	 * id can be several times that in bytes.
	 */
	private buildEmailFileName(id: string): string {
		if (Buffer.byteLength(id) <= IngestionService.EMAIL_ID_MAX_BYTES && !/[/\\]/.test(id)) {
			return id;
		}
		return createHash('sha256').update(id).digest('hex');
	}

	/** See buildEmailFileName's byte-budget comment for how these two limits interact. */
	private static readonly EMAIL_ID_MAX_BYTES = 140;
	private static readonly PATH_SEGMENT_MAX_BYTES = 100;

	/**
	 * RFC 5322 caps a header line at 998 octets, so a Message-ID longer than this is already
	 * malformed. The number that actually matters is the ceiling it stays under: both dedup keys
	 * sit in a btree (`msgid_header_source_idx`, `provider_msg_source_idx`), and PostgreSQL refuses
	 * an index tuple over 8191 bytes and a btree tuple over roughly 2704. 998 plus the uuid beside
	 * it clears both with room to spare.
	 */
	private static readonly MESSAGE_KEY_MAX_BYTES = 998;

	/**
	 * Clamps a value used as a deduplication key — the Message-ID header, or the provider id, which
	 * for IMAP and the file-based connectors is the Message-ID header again.
	 *
	 * A hostile or malformed Message-ID can run to kilobytes. Stored raw it made the whole INSERT
	 * fail with "index row requires N bytes, maximum size is 8191", so the email was never archived
	 * and failed identically on every retry (#440). The column itself has no limit; the btree
	 * indexes over it do.
	 *
	 * The sha256 suffix is the part that matters for correctness. Truncating alone would let two
	 * different messages that share a long prefix collapse into one dedup key, and the second would
	 * be discarded as a duplicate — a silent loss, which is the one outcome an archive must not
	 * have. The full header is untouched in the stored .eml either way.
	 */
	public static boundMessageKey(value: string): string {
		if (Buffer.byteLength(value) <= IngestionService.MESSAGE_KEY_MAX_BYTES) {
			return value;
		}
		const digest = createHash('sha256').update(value).digest('hex');
		const truncated = truncateToBytes(
			value,
			IngestionService.MESSAGE_KEY_MAX_BYTES - digest.length - 1
		);
		return `${truncated}-${digest}`;
	}

	/**
	 * Clamps one folder segment of email.path for use in a storage path. Folder names come
	 * from mail servers / PST files and can exceed the 255-byte per-component filesystem
	 * limit (#405). Over-long segments are byte-truncated with a short sha256 suffix of the
	 * original so distinct folders stay distinct. The original path is still stored
	 * unmodified in archived_emails.path.
	 */
	private clampPathSegment(segment: string): string {
		if (Buffer.byteLength(segment) <= IngestionService.PATH_SEGMENT_MAX_BYTES) {
			return segment;
		}
		const truncated = truncateToBytes(segment, IngestionService.PATH_SEGMENT_MAX_BYTES);
		return `${truncated}-${createHash('sha256').update(segment).digest('hex').slice(0, 8)}`;
	}

	/**
	 * The merge group's source ids, resolved once per source per job.
	 *
	 * findGroupSourceIds costs a SELECT — and, when the source is a merge child, a findById whose
	 * AES credential decrypt is the expensive part. This ran on every single email.
	 *
	 * Public so the mailbox processor's duplicate pre-check warms and shares this exact memo rather
	 * than resolving the group through a second, separate path. The tradeoff, accepted: a merge or
	 * unmerge performed while a mailbox is mid-import is not seen until that job ends, so the
	 * remaining emails of the run miss the shared-file reference check and store their own copy.
	 * Rare, self-correcting on the next sync, and cheaper than a SELECT per message.
	 */
	public resolveGroupSourceIds(source: IngestionSource): Promise<string[]> {
		const cached = this.groupIdsCache.get(source.id);
		if (cached) {
			return cached;
		}
		// `source` is already in hand, so pass it as `known` and skip the findById entirely.
		const resolved = IngestionService.findGroupSourceIds(source.id, source);
		this.groupIdsCache.set(source.id, resolved);
		// A failure must not be remembered as the answer: a transient database blip would otherwise
		// be re-thrown at every remaining email in the mailbox instead of being retried once.
		resolved.catch(() => this.groupIdsCache.delete(source.id));
		return resolved;
	}

	/**
	 * The root source that owns storage and DB rows for a merge child, resolved once per job.
	 *
	 * findById decrypts the source's credentials every call, so doing this per email spent real CPU
	 * re-deriving a value that is fixed for the whole mailbox.
	 */
	private resolveEffectiveSource(mergedIntoId: string): Promise<IngestionSource> {
		const cached = this.effectiveSourceCache.get(mergedIntoId);
		if (cached) {
			return cached;
		}
		const resolved = IngestionService.findById(mergedIntoId);
		this.effectiveSourceCache.set(mergedIntoId, resolved);
		resolved.catch(() => this.effectiveSourceCache.delete(mergedIntoId));
		return resolved;
	}

	/**
	 * The attachments row id for a piece of content, created if this is the first sighting.
	 *
	 * The caller holds the root/content advisory lock. Duplicate content within this transaction
	 * shares one promise; no cached ID survives rollback or crosses transaction boundaries.
	 */
	private getOrCreateAttachmentId(
		tx: Database,
		attachmentIds: Map<string, Promise<string>>,
		attachmentHash: string,
		effectiveSourceId: string,
		attachment: EmailObject['attachments'][number],
		storage: StorageService
	): Promise<string> {
		const cacheKey = `${effectiveSourceId}:${attachmentHash}`;
		const cached = attachmentIds.get(cacheKey);
		if (cached) {
			return cached;
		}

		const resolved = (async (): Promise<string> => {
			const existingAttachment = await tx.query.attachments.findFirst({
				where: and(
					eq(attachmentsSchema.contentHashSha256, attachmentHash),
					eq(attachmentsSchema.ingestionSourceId, effectiveSourceId)
				),
			});

			if (existingAttachment) {
				logger.debug(
					{
						attachmentHash,
						ingestionSourceId: effectiveSourceId,
						reusedPath: existingAttachment.storagePath,
					},
					'Reusing existing attachment file for deduplication.'
				);
				return existingAttachment.id;
			}

			const storagePath = this.attachmentStoragePath(effectiveSourceId, attachmentHash);
			try {
				await storage.put(storagePath, attachment.content, { overwrite: false });
			} catch (error) {
				if (!isStorageObjectExistsError(error)) throw error;
				const winner = await streamToBuffer(await storage.get(storagePath));
				if (
					winner.length !== attachment.content.length ||
					createHash('sha256').update(winner).digest('hex') !== attachmentHash
				) {
					throw new Error(
						`Attachment content does not match its storage key: ${storagePath}`
					);
				}
			}

			const [newRecord] = await tx
				.insert(attachmentsSchema)
				.values({
					filename: attachment.filename,
					mimeType: attachment.contentType,
					sizeBytes: attachment.size,
					contentHashSha256: attachmentHash,
					storagePath,
					// Always assign attachment ownership to root (effectiveSource)
					ingestionSourceId: effectiveSourceId,
				})
				.returning();
			return newRecord.id;
		})();

		attachmentIds.set(cacheKey, resolved);
		return resolved;
	}

	private attachmentStoragePath(rootId: string, hash: string): string {
		return `${config.storage.openArchiverFolderName}/${rootId}/attachments/sha256-${hash}`;
	}

	/**
	 * @param skipTempFileCleanup When true, the caller is responsible for deleting
	 *   email.tempFilePath. Used by the journaling fan-out loop which calls
	 *   processEmail() multiple times with the same EmailObject — only the last
	 *   caller should clean up the temp file.
	 * @returns The pending email on success, `null` when the email was deduplicated /
	 *   intentionally skipped, or a ProcessEmailError when archiving failed. Callers must
	 *   count error returns towards their failure totals — treating them as skips is what
	 *   allowed silent data loss to report success (#403).
	 */
	public async processEmail(
		email: EmailObject,
		source: IngestionSource,
		storage: StorageService,
		rawUserEmail: string,
		skipTempFileCleanup: boolean = false
	): Promise<PendingEmail | ProcessEmailError | null> {
		// Normalized once here so the dedup gates and all three inserts below agree on what
		// counts as the same mailbox, whatever casing or padding the provider sent.
		const userEmail = normalizeEmailAddress(rawUserEmail);
		try {
			if (email.path !== undefined && email.path !== '') {
				assertSafeRelativePath(email.path);
			}
			// Read the raw bytes from the temp file written by the connector
			const rawEmlBuffer = await readFile(email.tempFilePath);

			// If this source is a child in a merge group, redirect all storage and DB
			// ownership to the root source. Child sources are "assistants" — they fetch
			// emails on behalf of the root but never own any stored content.
			const effectiveSource = source.mergedIntoId
				? await this.resolveEffectiveSource(source.mergedIntoId)
				: source;

			// Generate a unique message ID for the email. If the email already has a message-id header, use that.
			// Otherwise, generate a new one based on the email's hash, source ID, and email ID.
			let messageId = IngestionService.messageIdHeaderOf(email);
			if (!messageId) {
				messageId = `generated-${createHash('sha256')
					.update(rawEmlBuffer)
					.digest('hex')}-${source.id}-${email.id}`;
			}
			// Both keys are bounded here, once, so the two dedup gates below and all three inserts
			// agree on them (#440). The provider id needs it as much as the header does: for IMAP
			// and the file-based connectors email.id IS the parsed Message-ID, and it lands in a
			// btree of its own via provider_msg_source_idx.
			messageId = IngestionService.boundMessageKey(messageId);
			const providerMessageId = IngestionService.boundMessageKey(email.id);
			// ── Three-gate deduplication ──────────────────────────────────────
			// Gate 1: Per-mailbox idempotency — has THIS mailbox already archived
			//         this email? If so, skip entirely (handles re-sync / retry).
			// Gate 2: Shared-file reference — does the email exist in ANOTHER
			//         mailbox within the merge group? If so, skip file write and
			//         create a reference row pointing to the existing storagePath.
			// Gate 3: Full new ingestion — first time this email is seen anywhere
			//         in the group. Write file + create row.
			// ─────────────────────────────────────────────────────────────────

			const attachmentHashes = email.attachments.map((attachment) =>
				createHash('sha256').update(attachment.content).digest('hex')
			);
			const lockKey = (kind: string, key: string) =>
				JSON.stringify(['open-archiver:ingestion', effectiveSource.id, kind, key]);
			const lockKeys = [
				lockKey('message', messageId),
				...(effectiveSource.preserveOriginalFile
					? [lockKey('raw', createHash('sha256').update(rawEmlBuffer).digest('hex'))]
					: attachmentHashes.map((hash) => lockKey('attachment', hash))),
			];
			const sanitizedPath = email.path
				? email.path
						.split('/')
						.map((segment) => this.clampPathSegment(segment))
						.join('/')
				: '';
			const emailPath = `${config.storage.openArchiverFolderName}/${effectiveSource.id}/emails/${sanitizedPath}${this.buildEmailFileName(email.id)}.eml`;
			let strippedMessage: Promise<Buffer> | undefined;

			return await withStorageLocks<PendingEmail | null>(lockKeys, async (tx) => {
				const freshSource = await tx.query.ingestionSources.findFirst({
					where: eq(ingestionSources.id, source.id),
				});
				const freshRoot =
					source.id === effectiveSource.id
						? freshSource
						: await tx.query.ingestionSources.findFirst({
								where: eq(ingestionSources.id, effectiveSource.id),
							});
				if (
					!freshSource ||
					!freshRoot ||
					(freshSource.mergedIntoId ?? freshSource.id) !== effectiveSource.id ||
					freshRoot.preserveOriginalFile !== effectiveSource.preserveOriginalFile
				) {
					throw new Error('Ingestion source was deleted or changed during processing');
				}
				const children = await tx
					.select({ id: ingestionSources.id })
					.from(ingestionSources)
					.where(eq(ingestionSources.mergedIntoId, effectiveSource.id));
				const groupSourceFilter = IngestionService.groupScopeFilter([
					effectiveSource.id,
					...children.map((child) => child.id),
				]);
				const attachmentIdCache = new Map<string, Promise<string>>();

				// Gates 1 and 2 in one round trip. They ask the same index the same question and differ
				// only by the mailbox predicate, so ordering this mailbox's row first answers both: if
				// the row that comes back belongs to this mailbox it is gate 1, and if one exists at all
				// but belongs to another mailbox it is gate 2. Two queries per email were one more than
				// the question needed.
				// Postgres both orders on and returns the mailbox predicate, so the answer to gate 1 is
				// the one the database computed — not a second opinion formed in JavaScript, which
				// would have to reproduce btrim's exact idea of whitespace to stay in agreement.
				const isThisMailbox = sql<boolean>`${normalizedMailbox} = ${userEmail}`;
				const groupMatch = await tx.query.archivedEmails.findFirst({
					where: and(eq(archivedEmails.messageIdHeader, messageId), groupSourceFilter),
					columns: {
						id: true,
						storagePath: true,
						storageHashSha256: true,
						sizeBytes: true,
						hasAttachments: true,
					},
					extras: {
						isThisMailbox: isThisMailbox.as('is_this_mailbox'),
					},
					orderBy: desc(isThisMailbox),
				});

				const existingLinks = groupMatch?.hasAttachments
					? await tx
							.select({
								attachmentId: emailAttachments.attachmentId,
								storagePath: attachmentsSchema.storagePath,
							})
							.from(emailAttachments)
							.innerJoin(
								attachmentsSchema,
								eq(emailAttachments.attachmentId, attachmentsSchema.id)
							)
							.where(eq(emailAttachments.emailId, groupMatch.id))
					: [];
				const rawHash = createHash('sha256').update(rawEmlBuffer).digest('hex');
				const hashDuplicate =
					!groupMatch && effectiveSource.preserveOriginalFile
						? await tx.query.archivedEmails.findFirst({
								where: and(
									eq(archivedEmails.storageHashSha256, rawHash),
									matchesMailbox(userEmail),
									eq(archivedEmails.ingestionSourceId, effectiveSource.id)
								),
								columns: { id: true },
							})
						: undefined;
				const hashExistingOther =
					!groupMatch && effectiveSource.preserveOriginalFile
						? await tx.query.archivedEmails.findFirst({
								where: and(
									eq(archivedEmails.storageHashSha256, rawHash),
									eq(archivedEmails.ingestionSourceId, effectiveSource.id)
								),
							})
						: undefined;
				const emlBuffer =
					!groupMatch && !effectiveSource.preserveOriginalFile
						? await (strippedMessage ??= stripAttachmentsFromEml(rawEmlBuffer))
						: rawEmlBuffer;
				const existingAttachments =
					!groupMatch && !effectiveSource.preserveOriginalFile && attachmentHashes.length
						? await tx.query.attachments.findMany({
								where: and(
									eq(attachmentsSchema.ingestionSourceId, effectiveSource.id),
									inArray(attachmentsSchema.contentHashSha256, [
										...new Set(attachmentHashes),
									])
								),
							})
						: [];
				const paths = [
					emailPath,
					`${emailPath.replace(/\.eml$/, '')}-${createHash('sha256').update(emlBuffer).digest('hex').slice(0, 8)}.eml`,
					...(groupMatch ? [groupMatch.storagePath] : []),
					...(hashExistingOther ? [hashExistingOther.storagePath] : []),
					...existingLinks.map((link) => link.storagePath),
					...existingAttachments.map((attachment) => attachment.storagePath),
					...(!effectiveSource.preserveOriginalFile
						? attachmentHashes.map((hash) =>
								this.attachmentStoragePath(effectiveSource.id, hash)
							)
						: []),
				];

				return {
					keys: paths.map(storagePathLockKey),
					run: async () => {
						// Gate 1: Per-mailbox duplicate check (idempotency guard for re-sync)
						if (groupMatch?.isThisMailbox) {
							logger.debug(
								{ messageId, userEmail, ingestionSourceId: source.id },
								'Skipping duplicate email (same mailbox already has this email)'
							);
							return null;
						}

						// Gate 2: Another mailbox in the group already has this email. Skip the file write and
						// create a reference row sharing the existing storagePath and storageHashSha256.
						const existingGroupEmail = groupMatch;

						if (existingGroupEmail) {
							// Shared-file reference path: no file write, just a new DB row
							// pointing to the same physical storagePath.
							const [referenceRow] = await tx
								.insert(archivedEmails)
								.values({
									ingestionSourceId: effectiveSource.id,
									userEmail,
									threadId: email.threadId,
									messageIdHeader: messageId,
									providerMessageId,
									sentAt: email.receivedAt,
									subject: email.subject,
									senderName: email.from[0]?.name,
									senderEmail: email.from[0]?.address || UNKNOWN_SENDER,
									recipients: {
										to: email.to,
										cc: email.cc,
										bcc: email.bcc ?? [],
									},
									// Re-use existing physical file and hash
									storagePath: existingGroupEmail.storagePath,
									storageHashSha256: existingGroupEmail.storageHashSha256,
									sizeBytes: existingGroupEmail.sizeBytes,
									hasAttachments: existingGroupEmail.hasAttachments,
									// The delivering source, NOT effectiveSource. How a message was captured is
									// a property of the source that brought it in; storage ownership is not.
									// A journaling child merged into a mailbox root has an effectiveSource of
									// microsoft_365 or the like, so reading the provider off the root recorded
									// every journaled message as not journaled — and the integrity report,
									// which exists to state the capture path, printed the opposite of the truth.
									isJournaled: source.provider === 'smtp_journaling',
									path: email.path,
									tags: email.tags,
								})
								.returning();

							// Copy attachment links from the existing email to this reference row
							// so that per-mailbox attachment queries return correct results.
							if (existingGroupEmail.hasAttachments) {
								if (existingLinks.length > 0) {
									await tx
										.insert(emailAttachments)
										.values(
											existingLinks.map((link) => ({
												emailId: referenceRow.id,
												attachmentId: link.attachmentId,
											}))
										)
										.onConflictDoNothing();
								}
							}

							logger.debug(
								{
									messageId,
									userEmail,
									existingEmailId: existingGroupEmail.id,
									referenceEmailId: referenceRow.id,
								},
								'Created shared-file reference row for another mailbox owner'
							);

							return {
								archivedEmailId: referenceRow.id,
							};
						}

						// GoBD / Preserve Original File mode: store the unmodified raw EML as-is.
						// No attachment stripping, no attachment table records — the full MIME body
						// including attachments is preserved in the single .eml file.
						// Use the root (effectiveSource) compliance mode as authoritative.
						if (effectiveSource.preserveOriginalFile) {
							const emailHash = rawHash;

							if (hashDuplicate) {
								logger.debug(
									{ emailHash, userEmail, ingestionSourceId: effectiveSource.id },
									'Skipping duplicate email (hash-level dedup, preserve original mode)'
								);
								return null;
							}

							let storagePath: string;
							let storedHash = emailHash;
							let storedSize = rawEmlBuffer.length;
							if (hashExistingOther) {
								// File already on disk — create a reference row
								storagePath = hashExistingOther.storagePath;
							} else {
								// First occurrence — store the unmodified raw buffer. The hash-level checks
								// above cannot see a same-Message-ID copy with different bytes (a second
								// delivery with its own Received headers), so the write itself must refuse to
								// replace whatever such a copy already put at this path, and reports back
								// where the bytes actually landed.
								({
									storagePath,
									hash: storedHash,
									sizeBytes: storedSize,
								} = await this.storeEmailOrAdopt(storage, emailPath, rawEmlBuffer, {
									messageId,
									userEmail,
									ingestionSourceId: effectiveSource.id,
									messageIdHeader: IngestionService.messageIdHeaderOf(email),
									knownHash: emailHash,
								}));
							}

							const [archivedEmail] = await tx
								.insert(archivedEmails)
								.values({
									ingestionSourceId: effectiveSource.id,
									userEmail,
									threadId: email.threadId,
									messageIdHeader: messageId,
									providerMessageId,
									sentAt: email.receivedAt,
									subject: email.subject,
									senderName: email.from[0]?.name,
									senderEmail: email.from[0]?.address || UNKNOWN_SENDER,
									recipients: {
										to: email.to,
										cc: email.cc,
										bcc: email.bcc ?? [],
									},
									storagePath,
									storageHashSha256: storedHash,
									sizeBytes: storedSize,
									hasAttachments: email.attachments.length > 0,
									// Delivering source, not the merge root — see the reference-row insert above.
									isJournaled: source.provider === 'smtp_journaling',
									path: email.path,
									tags: email.tags,
								})
								.returning();

							return {
								archivedEmailId: archivedEmail.id,
							};
						}

						// Default mode: strip non-inline attachments from the .eml to avoid double-storing
						// attachment data (attachments are stored separately).
						const {
							storagePath: emailStoragePath,
							hash: emailHash,
							sizeBytes: emailSize,
						} = await this.storeEmailOrAdopt(storage, emailPath, emlBuffer, {
							messageId,
							userEmail,
							ingestionSourceId: effectiveSource.id,
							messageIdHeader: IngestionService.messageIdHeaderOf(email),
						});

						// All writes use this transaction, including attachment lookup/publication.
						const results = await mapWithConcurrency(
							email.attachments,
							ATTACHMENT_STORE_CONCURRENCY,
							async (attachment, index) => {
								return this.getOrCreateAttachmentId(
									tx,
									attachmentIdCache,
									attachmentHashes[index],
									effectiveSource.id,
									attachment,
									storage
								);
							}
						);
						const attachmentIds: string[] = [];
						for (const result of results) {
							if (result.status === 'rejected') {
								throw result.reason;
							}
							attachmentIds.push(result.value);
						}

						// The surrounding transaction publishes all rows and links or rolls them all back.
						const [archivedEmail] = await tx
							.insert(archivedEmails)
							.values({
								ingestionSourceId: effectiveSource.id,
								userEmail,
								threadId: email.threadId,
								messageIdHeader: messageId,
								providerMessageId,
								sentAt: email.receivedAt,
								subject: email.subject,
								senderName: email.from[0]?.name,
								senderEmail: email.from[0]?.address || UNKNOWN_SENDER,
								recipients: {
									to: email.to,
									cc: email.cc,
									bcc: email.bcc ?? [],
								},
								storagePath: emailStoragePath,
								storageHashSha256: emailHash,
								sizeBytes: emailSize,
								hasAttachments: email.attachments.length > 0,
								// Delivering source, not the merge root — see the reference-row insert above.
								isJournaled: source.provider === 'smtp_journaling',
								path: email.path,
								tags: email.tags,
							})
							.returning();
						if (attachmentIds.length > 0) {
							await tx
								.insert(emailAttachments)
								.values(
									attachmentIds.map((attachmentId) => ({
										emailId: archivedEmail.id,
										attachmentId,
									}))
								)
								.onConflictDoNothing();
						}
						return { archivedEmailId: archivedEmail.id };
					},
				};
			});
		} catch (error) {
			logger.error({
				message: `Failed to process email ${email.id} for source ${source.id}`,
				error,
				emailId: email.id,
				ingestionSourceId: source.id,
			});
			// Return a distinct error object rather than null so callers can count
			// genuine failures separately from dedup skips (#403).
			return {
				error: true,
				message: `Email ${email.id}: ${error instanceof Error ? error.message : 'unknown error'}`,
			};
		} finally {
			// Clean up the temp file unless the caller opted out (e.g. journaling
			// fan-out loop that calls processEmail() multiple times with the same
			// EmailObject — temp file must survive until the last call finishes).
			if (!skipTempFileCleanup) {
				await unlink(email.tempFilePath).catch((err) =>
					logger.warn(
						{ err, tempFilePath: email.tempFilePath },
						'Failed to delete temp email file'
					)
				);
			}
		}
	}
}
