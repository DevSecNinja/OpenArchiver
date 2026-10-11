import { db } from '../database';
import { syncSessions, ingestionSources } from '../database/schema';
import { and, eq, inArray, lt, notExists, sql, type SQL } from 'drizzle-orm';
import type { SyncState, ProcessMailboxError, ProcessMailboxSkip } from '@open-archiver/types';
import { logger } from '../config/logger';
import { ingestionQueue } from '../jobs/queues';
import { isJobLive } from '../jobs/helpers/claimJobId';
import {
	continuousSyncJobId,
	initialImportJobId,
	uploadFinalizerOptions,
} from '../jobs/helpers/jobIds';
import { normalizeEmailAddress } from '../helpers/emailAddress';
import { truncateToBytes } from '../helpers/truncateToBytes';
import {
	readUploadReceipt,
	hasNewerUploadClaim,
	uploadReceiptComplete,
	uploadReceiptSuccessful,
	uploadedInputPath,
	type UploadMailboxIdentity,
} from '../helpers/uploadCompletion';
import { storagePathLockKey, withStorageLocks } from './storage/locking';
import { CryptoService } from './CryptoService';
import { StorageService } from './StorageService';
import type { IngestionCredentials } from '@open-archiver/types';

/** Top-level SyncState keys whose value is a per-mailbox map and so must merge, not replace. */
const NESTED_STATE_KEYS = new Set(['google', 'microsoft', 'imap']);

/**
 * The expression that folds one mailbox's sync state into the source's stored state.
 *
 * jsonb `||` is a shallow concat: writing `{ microsoft: { alice: ... } }` replaces the whole
 * `microsoft` object, so with N mailboxes reporting in only the last job's tokens would survive
 * and every other mailbox would re-enumerate on the next cycle. Concatenating inside each provider
 * bucket keeps the other mailboxes' entries; scalar keys such as `lastSyncTimestamp` and
 * `statusMessage` are meant to replace, so they stay on a plain top-level concat.
 *
 * Built as one expression rather than a read-modify-write because process-mailbox jobs run
 * concurrently — reading the column in JS would need `SELECT ... FOR UPDATE` to avoid lost updates.
 * The `->` reads the pre-update row, which is what an UPDATE SET expression sees.
 */
const buildSyncStateMerge = (state: SyncState): SQL => {
	let expression: SQL = sql`COALESCE(${ingestionSources.syncState}, '{}'::jsonb)`;
	const scalars: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(state)) {
		if (NESTED_STATE_KEYS.has(key) && value && typeof value === 'object') {
			// Both keys carry an explicit ::text — `jsonb -> $n` with an untyped parameter is
			// ambiguous between the text and integer forms of the operator and fails to resolve.
			expression = sql`${expression} || jsonb_build_object(${key}::text, COALESCE(${ingestionSources.syncState} -> ${key}::text, '{}'::jsonb) || ${JSON.stringify(value)}::jsonb)`;
		} else {
			scalars[key] = value;
		}
	}

	if (Object.keys(scalars).length > 0) {
		expression = sql`${expression} || ${JSON.stringify(scalars)}::jsonb`;
	}

	return expression;
};

export interface SyncSessionRecord {
	id: string;
	ingestionSourceId: string;
	isInitialImport: boolean;
	totalMailboxes: number;
	completedMailboxes: number;
	failedMailboxes: number;
	errorMessages: string[];
	createdAt: Date;
	lastActivityAt: Date;
}

export interface MailboxResultOutcome {
	/** True if this was the last mailbox job in the session (should trigger finalization) */
	isLast: boolean;
	totalCompleted: number;
	totalFailed: number;
	errorMessages: string[];
}

export type UploadDispatchOutcome = 'aborted' | 'complete' | 'obsolete' | 'unknown';

export class SyncSessionService {
	/**
	 * Creates a new sync session for a given ingestion source and returns its ID.
	 * Must be called before any process-mailbox jobs are dispatched.
	 */
	public static async create(
		ingestionSourceId: string,
		totalMailboxes: number,
		isInitialImport: boolean,
		upload?: { inputPath: string; expectedMailboxes: string[] }
	): Promise<string> {
		if (upload) {
			const expectedMailboxes = [
				...new Set(upload.expectedMailboxes.map(normalizeEmailAddress)),
			].sort();
			const expectedMailboxSet = new Set(expectedMailboxes);
			const receipt = readUploadReceipt({
				version: 1,
				sourceId: ingestionSourceId,
				inputPath: upload.inputPath,
				discoveryClosed: true,
				inputClaim: 'owned',
				expectedMailboxes,
				results: [],
			});
			if (!receipt || upload.expectedMailboxes.length !== totalMailboxes) {
				throw new Error('Cannot declare an ambiguous upload mailbox set');
			}
			return withStorageLocks([storagePathLockKey(upload.inputPath)], async (tx) => {
				const [source] = await tx
					.select()
					.from(ingestionSources)
					.where(eq(ingestionSources.id, ingestionSourceId))
					.for('update');
				const credentials = source?.credentials
					? CryptoService.decryptObject<IngestionCredentials>(source.credentials)
					: null;
				if (!source || uploadedInputPath(credentials) !== upload.inputPath) {
					throw new Error('Uploaded input changed during mailbox discovery');
				}
				return {
					keys: [],
					run: async () => {
						if (!(await new StorageService().exists(upload.inputPath))) {
							throw new Error('Uploaded input is missing before mailbox dispatch');
						}
						const previous = await tx
							.select()
							.from(syncSessions)
							.where(eq(syncSessions.ingestionSourceId, ingestionSourceId))
							.for('update');
						const replaced: string[] = [];
						for (const row of previous) {
							const old = readUploadReceipt(row.uploadReceipt);
							if (
								!old?.dispatchAborted ||
								old.sourceId !== ingestionSourceId ||
								old.inputPath !== upload.inputPath ||
								old.expectedMailboxes.length !== row.totalMailboxes
							)
								continue;
							if (
								old.expectedMailboxes.length !== expectedMailboxes.length ||
								old.expectedMailboxes.some(
									(mailbox) => !expectedMailboxSet.has(mailbox)
								)
							)
								throw new Error(
									'Aborted upload dispatch has a different declared mailbox set'
								);
							replaced.push(row.id);
						}
						const [session] = await tx
							.insert(syncSessions)
							.values({
								ingestionSourceId,
								totalMailboxes: expectedMailboxes.length,
								isInitialImport,
								uploadReceipt: receipt,
							})
							.returning({ id: syncSessions.id });
						if (replaced.length > 0) {
							// The new receipt owns the same complete input claim before old jobs lose their identities.
							await tx.delete(syncSessions).where(inArray(syncSessions.id, replaced));
						}
						return session.id;
					},
				};
			});
		}
		const [session] = await db
			.insert(syncSessions)
			.values({
				ingestionSourceId,
				totalMailboxes,
				isInitialImport,
				completedMailboxes: 0,
				failedMailboxes: 0,
				errorMessages: [],
			})
			.returning({ id: syncSessions.id });

		logger.info(
			{ sessionId: session.id, ingestionSourceId, totalMailboxes, isInitialImport },
			'Sync session created'
		);

		return session.id;
	}

	public static async abortUploadDispatch(
		sessionId: string,
		ingestionSourceId: string,
		inputPath: string,
		claimStartedAt?: Date | null
	): Promise<UploadDispatchOutcome> {
		return withStorageLocks<UploadDispatchOutcome>(
			[storagePathLockKey(inputPath)],
			async (tx) => {
				const [source] = await tx
					.select()
					.from(ingestionSources)
					.where(eq(ingestionSources.id, ingestionSourceId))
					.for('update');
				const sessions = await tx
					.select()
					.from(syncSessions)
					.where(eq(syncSessions.ingestionSourceId, ingestionSourceId))
					.for('update');
				const session = sessions.find((row) => row.id === sessionId);
				const receipt = readUploadReceipt(session?.uploadReceipt);
				if (
					session &&
					(!receipt ||
						receipt.sourceId !== ingestionSourceId ||
						session.ingestionSourceId !== ingestionSourceId ||
						receipt.inputPath !== inputPath ||
						receipt.expectedMailboxes.length !== session.totalMailboxes)
				)
					throw new Error('Cannot abort an unknown upload dispatch receipt');
				if (receipt && uploadReceiptSuccessful(receipt))
					return { keys: [], run: async () => 'complete' };
				if (!source) return { keys: [], run: async () => 'obsolete' };
				const credentials = source.credentials
					? CryptoService.decryptObject<IngestionCredentials>(source.credentials)
					: null;
				if (!credentials)
					throw new Error('Cannot verify upload dispatch source credentials');
				if (
					uploadedInputPath(credentials) !== inputPath ||
					!['importing', 'syncing'].includes(source.status) ||
					(claimStartedAt &&
						source.lastSyncStartedAt?.getTime() !== claimStartedAt.getTime()) ||
					(session
						? hasNewerUploadClaim(session, source.lastSyncStartedAt, sessions)
						: claimStartedAt && sessions.some((row) => row.createdAt >= claimStartedAt))
				)
					return { keys: [], run: async () => 'obsolete' };
				if (!session || !receipt || !claimStartedAt) {
					return {
						keys: [],
						run: async () => {
							logger.error(
								{
									sessionId,
									ingestionSourceId,
									reason: !session
										? 'missing-current-receipt'
										: 'missing-claim-epoch',
								},
								'Upload dispatch outcome is unknown; retaining current input and status for sessionless recovery'
							);
							return 'unknown';
						},
					};
				}
				return {
					keys: [],
					run: async () => {
						await tx
							.update(syncSessions)
							.set({
								uploadReceipt: { ...receipt, dispatchAborted: true },
								lastActivityAt: new Date(),
							})
							.where(eq(syncSessions.id, sessionId));
						return 'aborted';
					},
				};
			}
		);
	}

	/**
	 * Atomically records the result of a single process-mailbox job.
	 * Increments either completedMailboxes or failedMailboxes depending on the result.
	 * If the result is a successful SyncState, it is merged into the ingestion source's
	 * syncState column using PostgreSQL's jsonb merge operator.
	 *
	 * A third outcome sits between the two: a SKIP, for a directory entry with no mailbox to
	 * read (see ProcessMailboxSkip). It counts as completed — nothing failed, and the cycle
	 * must be allowed to end in success — while its reason is appended to the same message
	 * array a failure uses, so the finalizer can repeat it without a schema change. The array
	 * is therefore "notes about this cycle", of which errors are one kind; `failedMailboxes`
	 * alone decides whether the cycle failed.
	 *
	 * Returns whether this was the last mailbox job in the session.
	 */
	public static async recordMailboxResult(
		sessionId: string,
		result: SyncState | ProcessMailboxError | ProcessMailboxSkip,
		identity?: UploadMailboxIdentity
	): Promise<MailboxResultOutcome> {
		const [existing] = await db
			.select({ uploadReceipt: syncSessions.uploadReceipt })
			.from(syncSessions)
			.where(eq(syncSessions.id, sessionId));
		if (existing?.uploadReceipt !== null && existing?.uploadReceipt !== undefined) {
			return this.recordUploadResult(sessionId, result, identity);
		}
		if (identity) {
			throw new Error(
				'Legacy upload session has no canonical completion receipt; retaining input'
			);
		}
		const isError = (result as ProcessMailboxError).error === true;
		const isSkip = (result as ProcessMailboxSkip).skipped === true;
		const note = isError || isSkip ? (result as { message: string }).message : null;

		// Atomically increment the appropriate counter and append the note if there is one.
		// The RETURNING clause ensures we get the post-update values to check if this is the last job.
		const [updated] = await db
			.update(syncSessions)
			.set({
				completedMailboxes: isError
					? syncSessions.completedMailboxes
					: sql`${syncSessions.completedMailboxes} + 1`,
				failedMailboxes: isError
					? sql`${syncSessions.failedMailboxes} + 1`
					: syncSessions.failedMailboxes,
				errorMessages:
					note !== null
						? sql`array_append(${syncSessions.errorMessages}, ${note})`
						: syncSessions.errorMessages,
				// Touch lastActivityAt on every result so the stale-session detector
				// knows this session is still alive, regardless of how long it has been running.
				lastActivityAt: new Date(),
			})
			.where(eq(syncSessions.id, sessionId))
			.returning({
				completedMailboxes: syncSessions.completedMailboxes,
				failedMailboxes: syncSessions.failedMailboxes,
				totalMailboxes: syncSessions.totalMailboxes,
				errorMessages: syncSessions.errorMessages,
				ingestionSourceId: syncSessions.ingestionSourceId,
			});

		if (!updated) {
			throw new Error(`Sync session ${sessionId} not found when recording mailbox result.`);
		}

		// If the result is a successful SyncState with actual content, merge it into the
		// ingestion source's syncState column in Postgres. This is done incrementally per mailbox
		// to avoid the large deepmerge at the end — see buildSyncStateMerge for why the merge has
		// to reach one level below the top.
		// A skip is excluded as firmly as an error: its object is {skipped, message}, not sync
		// state, and merging it would write those two keys into the source's syncState column.
		if (!isError && !isSkip) {
			const syncState = result as SyncState;
			if (Object.keys(syncState).length > 0) {
				await db
					.update(ingestionSources)
					.set({ syncState: buildSyncStateMerge(syncState) })
					.where(eq(ingestionSources.id, updated.ingestionSourceId));
			}
		}

		const totalProcessed = updated.completedMailboxes + updated.failedMailboxes;
		const isLast = totalProcessed >= updated.totalMailboxes;

		logger.info(
			{
				sessionId,
				completed: updated.completedMailboxes,
				failed: updated.failedMailboxes,
				total: updated.totalMailboxes,
				isLast,
			},
			'Mailbox result recorded'
		);

		return {
			isLast,
			totalCompleted: updated.completedMailboxes,
			totalFailed: updated.failedMailboxes,
			errorMessages: updated.errorMessages,
		};
	}

	private static async recordUploadResult(
		sessionId: string,
		result: SyncState | ProcessMailboxError | ProcessMailboxSkip,
		identity?: UploadMailboxIdentity
	): Promise<MailboxResultOutcome> {
		// No storage stripes are acquired while this row lock is held.
		return db.transaction(async (tx) => {
			const [session] = await tx
				.select()
				.from(syncSessions)
				.where(eq(syncSessions.id, sessionId))
				.for('update');
			const receipt = readUploadReceipt(session?.uploadReceipt);
			const mailbox = identity ? normalizeEmailAddress(identity.mailbox) : '';
			if (
				!session ||
				!receipt ||
				receipt.dispatchAborted ||
				receipt.inputClaim !== 'owned' ||
				!identity ||
				receipt.sourceId !== session.ingestionSourceId ||
				receipt.expectedMailboxes.length !== session.totalMailboxes ||
				identity.sourceId !== receipt.sourceId ||
				identity.inputPath !== receipt.inputPath ||
				!receipt.expectedMailboxes.includes(mailbox)
			) {
				logger.warn(
					{ sessionId },
					'Rejected unknown or ambiguous upload completion identity'
				);
				throw new Error(
					'Upload completion identity does not match the declared input and mailbox'
				);
			}
			const isError = (result as ProcessMailboxError).error === true;
			const isSkip = (result as ProcessMailboxSkip).skipped === true;
			const outcome = isError ? 'failure' : isSkip ? 'skip' : 'success';
			const previous = receipt.results.find((entry) => entry.mailbox === mailbox);
			const proven = uploadReceiptSuccessful(receipt);
			const changesResult =
				!previous || (!proven && previous.outcome === 'success' && outcome !== 'success');
			if (changesResult) {
				receipt.results = [
					...receipt.results.filter((entry) => entry.mailbox !== mailbox),
					{ mailbox, outcome },
				];
			}
			const completed = receipt.results.filter((entry) => entry.outcome === 'success').length;
			const failed = receipt.results.length - completed;
			const notes = [...session.errorMessages];
			if (changesResult && outcome !== 'success' && notes.length < 5) {
				const diagnostic =
					'message' in result && typeof result.message === 'string'
						? result.message.replace(/[\r\n\0]+/g, ' ').trim()
						: '';
				notes.push(
					truncateToBytes(
						`${mailbox}: ${diagnostic || 'upload mailbox did not complete successfully'}`.replace(
							/[\r\n\0]+/g,
							' '
						),
						1024
					)
				);
			}
			await tx
				.update(syncSessions)
				.set({
					uploadReceipt: receipt,
					completedMailboxes: completed,
					failedMailboxes: failed,
					errorMessages: notes,
					lastActivityAt: new Date(),
				})
				.where(eq(syncSessions.id, sessionId));
			return {
				isLast: uploadReceiptComplete(receipt),
				totalCompleted: completed,
				totalFailed: failed,
				errorMessages: notes,
			};
		});
	}

	public static async uploadInputForMailbox(
		sessionId: string,
		identity: UploadMailboxIdentity
	): Promise<boolean> {
		const [session] = await db
			.select()
			.from(syncSessions)
			.where(eq(syncSessions.id, sessionId));
		if (!session) throw new Error('Upload session no longer exists');
		if (session.uploadReceipt === null) return false;
		const receipt = readUploadReceipt(session.uploadReceipt);
		if (
			!receipt ||
			receipt.dispatchAborted ||
			receipt.inputClaim !== 'owned' ||
			receipt.sourceId !== session.ingestionSourceId ||
			receipt.expectedMailboxes.length !== session.totalMailboxes ||
			identity.sourceId !== receipt.sourceId ||
			identity.inputPath !== receipt.inputPath ||
			!receipt.expectedMailboxes.includes(normalizeEmailAddress(identity.mailbox))
		) {
			throw new Error('Upload job does not match the closed discovery receipt');
		}
		return true;
	}

	public static async completionState(sessionId: string): Promise<{
		complete: boolean;
		upload: boolean;
		matchesCurrentInput?: boolean;
		inputPath?: string;
		finalizable?: boolean;
		failedMailboxes?: number;
		dispositionHandled?: boolean;
		inputClaimReleased?: boolean;
	}> {
		const [session] = await db
			.select()
			.from(syncSessions)
			.where(eq(syncSessions.id, sessionId));
		if (!session) throw new Error('Sync session not found');
		const [source] = await db
			.select()
			.from(ingestionSources)
			.where(eq(ingestionSources.id, session.ingestionSourceId));
		const credentials = source?.credentials
			? CryptoService.decryptObject<IngestionCredentials>(source.credentials)
			: null;
		const localInput =
			credentials && 'localFilePath' in credentials && Boolean(credentials.localFilePath);
		const fileSource =
			source && ['pst_import', 'eml_import', 'mbox_import'].includes(source.provider);
		const upload =
			session.uploadReceipt !== null ||
			Boolean(uploadedInputPath(credentials)) ||
			Boolean(fileSource && !localInput);
		if (upload) {
			const receipt = readUploadReceipt(session.uploadReceipt);
			const currentPath = uploadedInputPath(credentials);
			const complete = Boolean(
				receipt &&
					receipt.sourceId === session.ingestionSourceId &&
					receipt.expectedMailboxes.length === session.totalMailboxes &&
					uploadReceiptComplete(receipt)
			);
			const matchesCurrentInput = Boolean(receipt && currentPath === receipt.inputPath);
			return {
				upload: true,
				complete,
				matchesCurrentInput,
				inputPath: receipt?.inputPath,
				finalizable:
					complete &&
					Boolean(
						receipt &&
							(uploadReceiptSuccessful(receipt)
								? receipt.disposition === 'handled'
								: matchesCurrentInput)
					),
				failedMailboxes: receipt?.results.filter((result) => result.outcome !== 'success')
					.length,
				dispositionHandled: receipt?.disposition === 'handled',
				inputClaimReleased: receipt?.inputClaim === 'released',
			};
		}
		return {
			upload: false,
			complete:
				session.completedMailboxes + session.failedMailboxes >= session.totalMailboxes,
		};
	}

	/**
	 * Fetches a sync session by its ID.
	 */
	public static async findById(sessionId: string): Promise<SyncSessionRecord> {
		const [session] = await db
			.select()
			.from(syncSessions)
			.where(eq(syncSessions.id, sessionId));

		if (!session) {
			throw new Error(`Sync session ${sessionId} not found.`);
		}

		const { uploadReceipt: _uploadReceipt, ...record } = session;
		return record;
	}

	/**
	 * Updates lastActivityAt for the session without changing any counters.
	 * Should be called periodically during a long-running process-mailbox job
	 * to prevent cleanStaleSessions() from incorrectly treating an actively
	 * processing mailbox as stale.
	 *
	 */
	public static async heartbeat(sessionId: string): Promise<void> {
		try {
			await db
				.update(syncSessions)
				.set({ lastActivityAt: new Date() })
				.where(eq(syncSessions.id, sessionId));
		} catch (error) {
			logger.warn({ err: error, sessionId }, 'Failed to update session heartbeat');
		}
	}

	/**
	 * Deletes a sync session after finalization to keep the table clean.
	 */
	public static async finalize(sessionId: string): Promise<void> {
		const completion = await this.completionState(sessionId);
		if (!completion.complete || (completion.upload && !completion.finalizable)) {
			throw new Error('Cannot finalize a session without canonical completion');
		}
		if (completion.upload) {
			if (!completion.inputPath) throw new Error('Upload input identity is missing');
			await withStorageLocks([storagePathLockKey(completion.inputPath)], async (tx) => {
				const [original] = await tx
					.select()
					.from(syncSessions)
					.where(eq(syncSessions.id, sessionId));
				if (!original) throw new Error('Sync session no longer exists');
				const [source] = await tx
					.select()
					.from(ingestionSources)
					.where(eq(ingestionSources.id, original.ingestionSourceId))
					.for('update');
				const [session] = await tx
					.select()
					.from(syncSessions)
					.where(eq(syncSessions.id, sessionId))
					.for('update');
				const receipt = readUploadReceipt(session?.uploadReceipt);
				const credentials = source?.credentials
					? CryptoService.decryptObject<IngestionCredentials>(source.credentials)
					: null;
				if (
					!session ||
					!receipt ||
					receipt.sourceId !== session.ingestionSourceId ||
					receipt.inputPath !== completion.inputPath ||
					receipt.expectedMailboxes.length !== session.totalMailboxes ||
					!uploadReceiptComplete(receipt) ||
					(uploadReceiptSuccessful(receipt)
						? receipt.disposition !== 'handled'
						: uploadedInputPath(credentials) !== receipt.inputPath)
				)
					throw new Error('Upload receipt disposition changed before finalization');
				return {
					keys: [],
					run: async () => {
						await tx.delete(syncSessions).where(eq(syncSessions.id, sessionId));
					},
				};
			});
			logger.info({ sessionId }, 'Upload session finalized after guarded disposition check');
			return;
		}
		await db.delete(syncSessions).where(eq(syncSessions.id, sessionId));
		logger.info({ sessionId }, 'Sync session finalized and deleted');
	}

	/**
	 * Finds all sync sessions that are stale and marks the associated ingestion source
	 * as 'error', then deletes the orphaned session row.
	 *
	 * Staleness is determined by lastActivityAt — the timestamp updated every time a
	 * process-mailbox job reports a result. This correctly handles large imports that run
	 * for many hours: as long as mailboxes are actively completing, lastActivityAt stays
	 * fresh and the session is never considered stale.
	 *
	 * A session is stale when:
	 *   completedMailboxes + failedMailboxes < totalMailboxes
	 *   AND lastActivityAt < (now - thresholdMs)
	 *
	 * Default threshold: 30 minutes of inactivity. This covers the crash scenario where
	 * the processor died after creating the session but before all process-mailbox jobs
	 * were enqueued — those jobs will never report back, causing permanent inactivity.
	 *
	 * Once cleaned up, the source is set to 'error' so the next scheduler tick will
	 * re-queue a continuous-sync job.
	 */
	public static async cleanStaleSessions(
		thresholdMs: number = 30 * 60 * 1000 // 30 minutes of inactivity
	): Promise<void> {
		const cutoffTime = new Date(Date.now() - thresholdMs);

		// Find sessions with no recent activity (regardless of how old they are)
		const staleSessions = await db
			.select()
			.from(syncSessions)
			.where(lt(syncSessions.lastActivityAt, cutoffTime));

		for (const session of staleSessions) {
			const completion = await this.completionState(session.id);
			if (completion.complete) {
				// Every mailbox reported, but the sync-cycle-finished job never ran — it was lost,
				// or the worker died between the last result and dispatching it. Deleting the row
				// and walking away used to leave the source in 'syncing' with nothing left to move
				// it: the scheduler only selects 'active'/'error', so it silently stopped syncing
				// and drifted behind its siblings for as long as nobody noticed. Re-dispatching the
				// finalizer instead lets the normal path set the status, message and counters.
				await ingestionQueue.add(
					'sync-cycle-finished',
					{
						ingestionSourceId: session.ingestionSourceId,
						sessionId: session.id,
						isInitialImport: session.isInitialImport,
					},
					// Remove terminal jobs so retained upload receipts can retry this same finalizer ID.
					completion.upload
						? uploadFinalizerOptions(session.id)
						: {
								jobId: `sync-cycle-finished:${session.id}`,
								removeOnComplete: true,
								removeOnFail: true,
							}
				);
				logger.warn(
					{ sessionId: session.id, ingestionSourceId: session.ingestionSourceId },
					'Re-dispatched sync-cycle-finished for a completed-but-unfinalized sync session'
				);
				continue;
			}
			if (completion.upload) {
				const recovered = await this.recoverStaleUpload(session, cutoffTime);
				logger.warn(
					{ sessionId: session.id, recovered },
					'Retaining incomplete upload receipt; only a freshly verified stale current input is made retryable'
				);
				continue;
			}

			// Session is genuinely stuck — no mailbox activity for the threshold period.
			const inactiveMinutes = Math.round(
				(Date.now() - session.lastActivityAt.getTime()) / 60000
			);

			logger.warn(
				{
					sessionId: session.id,
					ingestionSourceId: session.ingestionSourceId,
					totalMailboxes: session.totalMailboxes,
					completedMailboxes: session.completedMailboxes,
					failedMailboxes: session.failedMailboxes,
					inactiveMinutes,
				},
				'Stale sync session detected — marking source as error and cleaning up'
			);

			await db
				.update(ingestionSources)
				.set({
					status: 'error',
					lastSyncFinishedAt: new Date(),
					lastSyncStatusMessage: `Sync interrupted: no activity for ${inactiveMinutes} minutes. ${session.completedMailboxes} of ${session.totalMailboxes} mailboxes completed. Will retry on next sync cycle.`,
				})
				.where(eq(ingestionSources.id, session.ingestionSourceId));

			await db.delete(syncSessions).where(eq(syncSessions.id, session.id));

			logger.info(
				{ sessionId: session.id, ingestionSourceId: session.ingestionSourceId },
				'Stale sync session cleaned up, source set to error for retry'
			);
		}

		await this.releaseSessionlessSources(thresholdMs);
	}

	private static async recoverStaleUpload(
		original: typeof syncSessions.$inferSelect,
		cutoffTime: Date
	): Promise<boolean> {
		const initial = readUploadReceipt(original.uploadReceipt);
		if (!initial || initial.sourceId !== original.ingestionSourceId) return false;
		return withStorageLocks([storagePathLockKey(initial.inputPath)], async (tx) => {
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
			const current = sessions.find((session) => session.id === original.id);
			const receipt = readUploadReceipt(current?.uploadReceipt);
			const credentials = source?.credentials
				? CryptoService.decryptObject<IngestionCredentials>(source.credentials)
				: null;
			if (
				!source ||
				!current ||
				!receipt ||
				receipt.sourceId !== current.ingestionSourceId ||
				receipt.inputPath !== initial.inputPath ||
				receipt.expectedMailboxes.length !== current.totalMailboxes ||
				uploadReceiptComplete(receipt) ||
				current.lastActivityAt >= cutoffTime ||
				uploadedInputPath(credentials) !== receipt.inputPath ||
				!['importing', 'syncing'].includes(source.status) ||
				(source.lastSyncStartedAt && source.lastSyncStartedAt > current.createdAt)
			)
				return { keys: [], run: async () => false };
			const newerOrActive = sessions.some((session) => {
				if (session.id === current.id) return false;
				const other = readUploadReceipt(session.uploadReceipt);
				const unfinished =
					!other ||
					other.sourceId !== session.ingestionSourceId ||
					other.expectedMailboxes.length !== session.totalMailboxes ||
					!uploadReceiptComplete(other);
				return (
					session.createdAt >= current.createdAt ||
					(unfinished && session.lastActivityAt >= cutoffTime)
				);
			});
			if (newerOrActive) return { keys: [], run: async () => false };
			return {
				keys: [],
				run: async () => {
					await tx
						.update(syncSessions)
						.set({ uploadReceipt: { ...receipt, dispatchAborted: true } })
						.where(eq(syncSessions.id, current.id));
					await tx
						.update(ingestionSources)
						.set({
							status: 'error',
							lastSyncFinishedAt: new Date(),
							lastSyncStatusMessage:
								'Upload processing stopped before canonical completion. Input retained; retry the import.',
						})
						.where(eq(ingestionSources.id, source.id));
					return true;
				},
			};
		});
	}

	/**
	 * Frees sources left mid-cycle with no session row to account for them.
	 *
	 * The sweep above can only see sources a session points at, and there is a window with no
	 * session at all: both master jobs claim the source ('syncing' / 'importing') before
	 * SyncSessionService.create() runs, so a worker that dies in between — an OOM kill, a deploy, a
	 * lost Redis connection — leaves the source claimed and nothing anywhere referring to it. The
	 * scheduler only selects 'active' and 'error', so that source silently stopped syncing and
	 * drifted further behind its siblings every day while the UI still displayed "syncing". Three
	 * sources on the dev instance had been wedged this way for four months.
	 *
	 * Setting them to 'error' is what puts them back in the scheduler's reach; the next tick
	 * re-syncs them and dedup skips everything already archived.
	 *
	 * The threshold is shared with the session sweep and measured from lastSyncStartedAt, so a cycle
	 * whose enumeration phase legitimately runs long is not cut off — and if one ever exceeds it,
	 * claimForSync is what stops the second cycle from doing damage.
	 */
	private static async releaseSessionlessSources(thresholdMs: number): Promise<void> {
		const cutoffTime = new Date(Date.now() - thresholdMs);

		// Selected first, then filtered, then released. An UPDATE straight from the predicate would
		// be one statement fewer, but it cannot ask the queue whether the master job is still alive,
		// and releasing a source whose job is still running is what re-opens the very window this
		// changeset closes — see below.
		const candidates = await db
			.select({ id: ingestionSources.id, name: ingestionSources.name })
			.from(ingestionSources)
			.where(
				and(
					inArray(ingestionSources.status, ['syncing', 'importing']),
					lt(ingestionSources.lastSyncStartedAt, cutoffTime),
					notExists(
						db
							.select({ one: sql`1` })
							.from(syncSessions)
							.where(eq(syncSessions.ingestionSourceId, ingestionSources.id))
					)
				)
			);

		for (const source of candidates) {
			// Both master jobs create their session only after enumerating mailboxes, so a tenant
			// whose enumeration runs past the threshold looks exactly like an abandoned one from the
			// database alone. Releasing it to 'error' would let the scheduler start a competing
			// cycle: a continuous sync is protected by its shared job id, which the still-active job
			// holds, but an initial import is a different job under a different id and nothing would
			// absorb the add — two cycles over the same mailboxes, the overlap that duplicates mail.
			//
			// Probing the ids answers the question the timestamp cannot. It is also self-correcting:
			// a process that died leaves its job to be failed by the stalled-job check well inside
			// this threshold (maxStalledCount 0, ten-minute lock), after which it is no longer live
			// and the rescue proceeds as intended.
			const [importing, syncing] = await Promise.all([
				isJobLive(ingestionQueue, initialImportJobId(source.id)),
				isJobLive(ingestionQueue, continuousSyncJobId(source.id)),
			]);

			if (importing || syncing) {
				logger.info(
					{ ingestionSourceId: source.id, name: source.name },
					'Source has no sync session yet, but its master job is still running - leaving it alone'
				);
				continue;
			}

			await db
				.update(ingestionSources)
				.set({
					status: 'error',
					lastSyncFinishedAt: new Date(),
					lastSyncStatusMessage:
						'Sync interrupted before it started reporting progress, and no sync session was found. Will retry on the next sync cycle.',
				})
				.where(eq(ingestionSources.id, source.id));

			logger.warn(
				{ ingestionSourceId: source.id, name: source.name },
				'Source was stuck mid-cycle with no sync session - set to error so the scheduler retries it'
			);
		}
	}
}
