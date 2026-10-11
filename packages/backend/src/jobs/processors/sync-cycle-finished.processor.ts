import { Job } from 'bullmq';
import { IngestionService } from '../../services/IngestionService';
import { SyncSessionService } from '../../services/SyncSessionService';
import { logger } from '../../config/logger';
import { IngestionStatus } from '@open-archiver/types';

interface ISyncCycleFinishedJob {
	ingestionSourceId: string;
	sessionId: string;
	isInitialImport: boolean;
}

/**
 * Finalizes a sync cycle after all process-mailbox jobs have completed.
 *
 * This processor no longer uses BullMQ's job.getChildrenValues() or deepmerge.
 * Instead, it reads the aggregated results from the sync_sessions table in PostgreSQL,
 * where each process-mailbox job has already atomically recorded its outcome and
 * incrementally merged its SyncState into ingestion_sources.sync_state.
 */
export default async (job: Job<ISyncCycleFinishedJob>) => {
	const { ingestionSourceId, sessionId, isInitialImport } = job.data;

	logger.info(
		{ ingestionSourceId, sessionId, isInitialImport },
		'Sync cycle finished job started'
	);

	let foundSession = false;
	let uploadSession = false;
	try {
		const session = await SyncSessionService.findById(sessionId);
		foundSession = true;
		const completion = await SyncSessionService.completionState(sessionId);
		uploadSession = completion.upload;
		if (!completion.complete || session.ingestionSourceId !== ingestionSourceId) {
			logger.warn(
				{ ingestionSourceId, sessionId },
				'Retaining upload input: canonical session completion is not established'
			);
			return;
		}
		const failedMailboxes = completion.upload
			? completion.failedMailboxes
			: session.failedMailboxes;
		if (failedMailboxes === undefined)
			throw new Error('Upload receipt has no canonical failure result');
		if (
			completion.upload &&
			(!completion.matchesCurrentInput || completion.dispositionHandled)
		) {
			// An old input's disposition must not alter the replacement import's status.
			if (failedMailboxes === 0) await IngestionService.releaseCompletedUpload(sessionId);
			if ((await SyncSessionService.completionState(sessionId)).finalizable) {
				await SyncSessionService.finalize(sessionId);
			} else {
				logger.warn(
					{ ingestionSourceId, sessionId },
					'Retaining old upload receipt until input disposition is handled'
				);
			}
			return;
		}

		let status: IngestionStatus = 'active';
		let message: string;

		const fileBasedIngestions = IngestionService.returnFileBasedIngestions();
		const source = await IngestionService.findById(ingestionSourceId);

		if (fileBasedIngestions.includes(source.provider)) {
			status = 'imported';
		}

		// The message array holds notes, of which errors are one kind — a mailbox that was
		// skipped for having nothing to archive also leaves one. Only failedMailboxes decides
		// whether the cycle failed, so a tenant whose sole "problem" is guest accounts settles
		// in 'active' instead of being retried every tick forever (#351).
		const notes = session.errorMessages.join('\n');

		if (failedMailboxes > 0) {
			status = 'error';
			message = `Sync cycle completed with ${failedMailboxes} error(s):\n${notes}`;
			logger.error(
				{ ingestionSourceId, sessionId, errors: notes },
				'Sync cycle finished with errors.'
			);
		} else {
			message = isInitialImport
				? `Initial import finished for ${session.completedMailboxes} mailboxes.`
				: 'Continuous sync cycle finished successfully.';
			// Named rather than merely counted: the operator needs to see WHICH accounts were
			// passed over, or a mailbox missing from the archive by mistake looks identical to
			// one skipped on purpose.
			if (notes) {
				message += `\n${notes}`;
			}
			logger.info({ ingestionSourceId, sessionId }, 'Sync cycle finished successfully.');
		}

		// syncState was already merged incrementally by each process-mailbox job via
		// SyncSessionService.recordMailboxResult() — no deepmerge needed here.
		await IngestionService.update(
			ingestionSourceId,
			{
				status: source.status === 'paused' ? 'paused' : status, // Don't override paused status
				lastSyncFinishedAt: new Date(),
				lastSyncStatusMessage: message,
			},
			undefined,
			undefined,
			completion.upload ? completion.inputPath : undefined,
			completion.upload ? sessionId : undefined
		);

		if (completion.upload && failedMailboxes === 0) {
			await IngestionService.releaseCompletedUpload(sessionId);
		}
		if (
			completion.upload &&
			!(await SyncSessionService.completionState(sessionId)).finalizable
		) {
			logger.warn(
				{ ingestionSourceId, sessionId },
				'Retaining upload receipt until input disposition is handled'
			);
			return;
		}
		// Clean up the session row
		await SyncSessionService.finalize(sessionId);

		logger.info({ ingestionSourceId, sessionId, status }, 'Sync cycle finalized');
	} catch (error) {
		logger.error(
			{ err: error, ingestionSourceId, sessionId },
			'An unexpected error occurred while finalizing the sync cycle.'
		);
		if (!foundSession || uploadSession) {
			// Retain failed upload cleanup/proof for retry; never reset a newer import's status.
			return;
		}
		await IngestionService.update(ingestionSourceId, {
			status: 'error',
			lastSyncFinishedAt: new Date(),
			lastSyncStatusMessage: 'An unexpected error occurred while finalizing the sync cycle.',
		});
		// The session is dropped on this path too. 'error' is a status the scheduler picks up again,
		// so the cycle is already accounted for; leaving the row behind would only make the stale
		// sweep re-dispatch this same failing finalizer every threshold period.
		await SyncSessionService.finalize(sessionId).catch((err) =>
			logger.warn({ err, sessionId }, 'Failed to delete session after a failed finalization')
		);
	}
};
