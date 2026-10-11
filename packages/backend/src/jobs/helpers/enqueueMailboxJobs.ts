import { ingestionQueue } from '../queues';
import { SyncSessionService } from '../../services/SyncSessionService';
import { logger } from '../../config/logger';

/**
 * One page per Redis round trip. Bounded because a single command carrying every mailbox of a
 * hundred-thousand-user tenant is its own problem.
 */
const ENQUEUE_PAGE_SIZE = 500;

/**
 * Dispatches one `process-mailbox` job per mailbox.
 *
 * Enqueued in pages rather than one call per mailbox. A FlowProducer is still deliberately avoided —
 * the memory and Redis cost of one atomic write for thousands of children is what ruled it out — but
 * a round trip per mailbox was the opposite extreme, and paging sits between the two.
 *
 * Shared by the initial-import and continuous-sync master jobs, which differ only in which id they
 * pass: a continuous sync resolves the source itself, while the initial import carries the id from
 * its own job data.
 */
export const enqueueMailboxJobs = async (
	ingestionSourceId: string,
	userEmails: string[],
	sessionId: string,
	uploadInputPath?: string
): Promise<void> => {
	try {
		for (let i = 0; i < userEmails.length; i += ENQUEUE_PAGE_SIZE) {
			await ingestionQueue.addBulk(
				userEmails.slice(i, i + ENQUEUE_PAGE_SIZE).map((userEmail) => ({
					name: 'process-mailbox',
					data: {
						ingestionSourceId,
						userEmail,
						sessionId,
						...(uploadInputPath ? { uploadInputPath } : {}),
					},
				}))
			);
		}
	} catch (error) {
		if (uploadInputPath) {
			try {
				const aborted = await SyncSessionService.abortUploadDispatch(
					sessionId,
					ingestionSourceId,
					uploadInputPath
				);
				if (!aborted) {
					logger.warn(
						{ error, ingestionSourceId, sessionId },
						'Dispatch failed after independently proven canonical upload success'
					);
					return;
				}
			} catch (abortError) {
				throw new AggregateError(
					[error, abortError],
					'Mailbox dispatch and upload receipt abort failed'
				);
			}
		}
		throw error;
	}
};
