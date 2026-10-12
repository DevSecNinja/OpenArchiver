import { z } from 'zod';
import { normalizeEmailAddress } from './emailAddress';

const receiptSchema = z
	.object({
		version: z.literal(1),
		sourceId: z.string().uuid(),
		inputPath: z.string().min(1),
		discoveryClosed: z.literal(true),
		dispatchAborted: z.literal(true).optional(),
		inputClaim: z.enum(['owned', 'released']).optional(),
		disposition: z.literal('handled').optional(),
		expectedMailboxes: z.array(z.string().min(1)).min(1),
		results: z.array(
			z.object({
				mailbox: z.string(),
				outcome: z.enum(['success', 'failure', 'skip']),
			})
		),
	})
	.strict()
	.superRefine((receipt, context) => {
		const expected = new Set(receipt.expectedMailboxes);
		const reported = new Set(receipt.results.map((result) => result.mailbox));
		if (
			expected.size !== receipt.expectedMailboxes.length ||
			receipt.expectedMailboxes.some(
				(mailbox) => mailbox !== normalizeEmailAddress(mailbox)
			) ||
			reported.size !== receipt.results.length ||
			receipt.results.some((result) => !expected.has(result.mailbox))
		) {
			context.addIssue({ code: 'custom', message: 'Ambiguous upload completion receipt' });
		}
	});

export type UploadCompletionReceipt = z.infer<typeof receiptSchema>;

export interface UploadMailboxIdentity {
	sourceId: string;
	inputPath: string;
	mailbox: string;
}

export function hasNewerUploadClaim(
	session: { id: string; createdAt: Date },
	lastSyncStartedAt: Date | null,
	sessions: readonly { id: string; createdAt: Date }[]
): boolean {
	return (
		Boolean(lastSyncStartedAt && lastSyncStartedAt > session.createdAt) ||
		sessions.some((other) => other.id !== session.id && other.createdAt >= session.createdAt)
	);
}

export function readUploadReceipt(value: unknown): UploadCompletionReceipt | null {
	const parsed = receiptSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

export function uploadReceiptComplete(receipt: UploadCompletionReceipt): boolean {
	return !receipt.dispatchAborted && receipt.results.length === receipt.expectedMailboxes.length;
}

export function uploadReceiptSuccessful(receipt: UploadCompletionReceipt): boolean {
	return (
		uploadReceiptComplete(receipt) &&
		receipt.results.every((result) => result.outcome === 'success')
	);
}

export function uploadedInputPath(credentials: unknown): string | undefined {
	if (!credentials || typeof credentials !== 'object' || !('type' in credentials)) return;
	if (
		credentials.type !== 'pst_import' &&
		credentials.type !== 'eml_import' &&
		credentials.type !== 'mbox_import'
	)
		return;
	if ('localFilePath' in credentials && credentials.localFilePath) return;
	if ('uploadedFilePath' in credentials && typeof credentials.uploadedFilePath === 'string') {
		return credentials.uploadedFilePath || undefined;
	}
}
