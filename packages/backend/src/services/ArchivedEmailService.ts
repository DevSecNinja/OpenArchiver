import { count, desc, eq, asc, and, inArray } from 'drizzle-orm';
import { db } from '../database';
import {
	archivedEmails,
	attachments,
	emailAttachments,
	ingestionSources,
} from '../database/schema';
import { FilterBuilder } from './FilterBuilder';
import { AuthorizationService } from './AuthorizationService';
import type {
	PaginatedArchivedEmails,
	ArchivedEmail,
	Recipient,
	ThreadEmail,
} from '@open-archiver/types';
import { StorageService } from './StorageService';
import { SearchService } from './SearchService';
import { IngestionService } from './IngestionService';
import type { Readable } from 'stream';
import { AuditService } from './AuditService';
import { User } from '@open-archiver/types';
import { checkDeletionEnabled } from '../helpers/deletionGuard';
import { RetentionHook } from '../hooks/RetentionHook';
import { logger } from '../config/logger';
import {
	cleanupUnreferencedObjects,
	storagePathLockKey,
	withStorageLocks,
} from './storage/locking';

interface DbRecipients {
	to: { name: string; address: string }[];
	cc: { name: string; address: string }[];
	bcc: { name: string; address: string }[];
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		stream.on('data', (chunk) => chunks.push(chunk));
		stream.on('error', reject);
		stream.on('end', () => resolve(Buffer.concat(chunks)));
	});
}

export class ArchivedEmailService {
	private static auditService = new AuditService();
	private static mapRecipients(dbRecipients: unknown): Recipient[] {
		const { to = [], cc = [], bcc = [] } = dbRecipients as DbRecipients;

		const allRecipients = [...to, ...cc, ...bcc];

		return allRecipients.map((r) => ({
			name: r.name,
			email: r.address,
		}));
	}

	public static async getArchivedEmails(
		ingestionSourceId: string,
		page: number,
		limit: number,
		userId: string
	): Promise<PaginatedArchivedEmails> {
		const offset = (page - 1) * limit;
		const { drizzleFilter } = await FilterBuilder.create(userId, 'archive', 'read');

		// Expand to the full merge group so emails from children appear when browsing a root source
		const groupIds = await IngestionService.findGroupSourceIds(ingestionSourceId);
		const sourceFilter = IngestionService.groupScopeFilter(groupIds);
		const where = and(sourceFilter, drizzleFilter);

		const countQuery = db
			.select({
				count: count(archivedEmails.id),
			})
			.from(archivedEmails)
			.leftJoin(ingestionSources, eq(archivedEmails.ingestionSourceId, ingestionSources.id));

		if (where) {
			countQuery.where(where);
		}

		const [total] = await countQuery;

		const itemsQuery = db
			.select()
			.from(archivedEmails)
			.leftJoin(ingestionSources, eq(archivedEmails.ingestionSourceId, ingestionSources.id))
			.orderBy(desc(archivedEmails.sentAt))
			.limit(limit)
			.offset(offset);

		if (where) {
			itemsQuery.where(where);
		}

		const results = await itemsQuery;
		const items = results.map((r) => r.archived_emails);

		return {
			items: items.map((item) => ({
				...item,
				recipients: this.mapRecipients(item.recipients),
				tags: (item.tags as string[] | null) || null,
				path: item.path || null,
			})),
			total: total.count,
			page,
			limit,
		};
	}

	/**
	 * The stored row plus its source, for permission checks that need the record itself rather
	 * than the resource type.
	 */
	public static async findRowById(emailId: string) {
		return db.query.archivedEmails.findFirst({
			where: eq(archivedEmails.id, emailId),
			with: {
				ingestionSource: true,
			},
		});
	}

	/**
	 * Whether a file in the storage layer belongs to an email the user is allowed to read.
	 *
	 * The download endpoint takes a raw storage path, so the path has to be resolved back to a
	 * record before the archive policy can be applied to it. Attachments are stored once and
	 * shared by every message carrying the same bytes, so access is granted when *any* referencing
	 * email is visible to the user.
	 */
	public static async canAccessStoragePath(
		storagePath: string,
		userId: string
	): Promise<boolean> {
		const { drizzleFilter } = await FilterBuilder.create(userId, 'archive', 'read');

		const [email] = await db
			.select({ id: archivedEmails.id })
			.from(archivedEmails)
			.leftJoin(ingestionSources, eq(archivedEmails.ingestionSourceId, ingestionSources.id))
			.where(and(eq(archivedEmails.storagePath, storagePath), drizzleFilter))
			.limit(1);

		if (email) {
			return true;
		}

		// Resolved in two steps on purpose: `attachments` also has an `ingestion_source_id`
		// column, and the permission filter names its columns unqualified, so joining that table
		// into the filtered query would make the reference ambiguous.
		const [attachment] = await db
			.select({ id: attachments.id })
			.from(attachments)
			.where(eq(attachments.storagePath, storagePath))
			.limit(1);

		if (!attachment) {
			return false;
		}

		const [carrier] = await db
			.select({ id: archivedEmails.id })
			.from(archivedEmails)
			.innerJoin(emailAttachments, eq(emailAttachments.emailId, archivedEmails.id))
			.leftJoin(ingestionSources, eq(archivedEmails.ingestionSourceId, ingestionSources.id))
			.where(and(eq(emailAttachments.attachmentId, attachment.id), drizzleFilter))
			.limit(1);

		return Boolean(carrier);
	}

	public static async getArchivedEmailById(
		emailId: string,
		userId: string,
		actor: User,
		actorIp: string
	): Promise<ArchivedEmail | null> {
		const email = await this.findRowById(emailId);

		if (!email) {
			return null;
		}

		const authorizationService = new AuthorizationService();
		const canRead = await authorizationService.can(userId, 'read', 'archive', email);

		if (!canRead) {
			return null;
		}

		await this.auditService.createAuditLog({
			actorIdentifier: actor.id,
			actionType: 'READ',
			targetType: 'ArchivedEmail',
			targetId: emailId,
			actorIp,
			details: {},
		});

		let threadEmails: ThreadEmail[] = [];

		// Expand thread query to the full merge group so threads can span across merged sources
		if (email.threadId) {
			const groupIds = await IngestionService.findGroupSourceIds(email.ingestionSourceId);
			const sourceFilter = IngestionService.groupScopeFilter(groupIds);
			threadEmails = await db.query.archivedEmails.findMany({
				where: and(eq(archivedEmails.threadId, email.threadId), sourceFilter),
				orderBy: [asc(archivedEmails.sentAt)],
				columns: {
					id: true,
					subject: true,
					sentAt: true,
					senderName: true,
					senderEmail: true,
				},
			});
		}

		const storage = new StorageService();
		const rawStream = await storage.get(email.storagePath);
		const raw = await streamToBuffer(rawStream as Readable);

		const mappedEmail = {
			...email,
			// Trim the joined ingestion source to just id + name; the full row carries
			// encrypted credentials that must never be sent to the client.
			ingestionSource: email.ingestionSource
				? { id: email.ingestionSource.id, name: email.ingestionSource.name }
				: null,
			recipients: this.mapRecipients(email.recipients),
			raw,
			thread: threadEmails,
			tags: (email.tags as string[] | null) || null,
			path: email.path || null,
		};

		if (email.hasAttachments) {
			const emailAttachmentsResult = await db
				.select({
					id: attachments.id,
					filename: attachments.filename,
					mimeType: attachments.mimeType,
					sizeBytes: attachments.sizeBytes,
					storagePath: attachments.storagePath,
				})
				.from(emailAttachments)
				.innerJoin(attachments, eq(emailAttachments.attachmentId, attachments.id))
				.where(eq(emailAttachments.emailId, emailId));

			// const attachmentsWithRaw = await Promise.all(
			//     emailAttachmentsResult.map(async (attachment) => {
			//         const rawStream = await storage.get(attachment.storagePath);
			//         const raw = await streamToBuffer(rawStream as Readable);
			//         return { ...attachment, raw };
			//     })
			// );

			return {
				...mappedEmail,
				attachments: emailAttachmentsResult,
			};
		}

		return mappedEmail;
	}

	public static async deleteArchivedEmail(
		emailId: string,
		actor: User,
		actorIp: string,
		options: {
			systemDelete?: boolean;
			/**
			 * Human-readable name of the retention rule that triggered deletion
			 */
			governingRule?: string;
		} = {}
	): Promise<void> {
		checkDeletionEnabled({ allowSystemDelete: options.systemDelete });

		const canDelete = await RetentionHook.canDelete(emailId);
		if (!canDelete) {
			throw new Error('Deletion blocked by retention policy (Legal Hold or similar).');
		}

		const storage = new StorageService();
		const cleanupPaths = await withStorageLocks<string[]>(
			[JSON.stringify(['delete-email', emailId])],
			async (tx) => {
				const [email] = await tx
					.select()
					.from(archivedEmails)
					.where(eq(archivedEmails.id, emailId));
				if (!email) throw new Error('Archived email not found');
				const attachmentsForEmail = await tx
					.select({
						attachmentId: attachments.id,
						storagePath: attachments.storagePath,
					})
					.from(emailAttachments)
					.innerJoin(attachments, eq(emailAttachments.attachmentId, attachments.id))
					.where(eq(emailAttachments.emailId, emailId));
				const paths = [
					email.storagePath,
					...attachmentsForEmail.map((file) => file.storagePath),
				];
				return {
					keys: paths.map(storagePathLockKey),
					run: async () => {
						// Confirm index removal while metadata still exists. Physical cleanup follows commit.
						const searchService = new SearchService();
						const task = await searchService.deleteDocuments('emails', [emailId]);
						await searchService.waitForTask(task.taskUid);

						for (const attachment of attachmentsForEmail) {
							await tx
								.delete(emailAttachments)
								.where(
									and(
										eq(emailAttachments.emailId, emailId),
										eq(emailAttachments.attachmentId, attachment.attachmentId)
									)
								);

							// Check if any other emails are linked to this attachment record.
							const [recordRefCount] = await tx
								.select({ count: count() })
								.from(emailAttachments)
								.where(eq(emailAttachments.attachmentId, attachment.attachmentId));

							if (recordRefCount.count === 0) {
								await tx
									.delete(attachments)
									.where(eq(attachments.id, attachment.attachmentId));
							}
						}
						await tx.delete(archivedEmails).where(eq(archivedEmails.id, emailId));
						return paths;
					},
				};
			}
		);
		// Build audit details: system-initiated deletions carry retention context
		// for GoBD compliance; manual deletions record only the reason.
		const auditDetails: Record<string, unknown> = {
			reason: options.systemDelete ? 'RetentionExpiration' : 'ManualDeletion',
		};
		if (options.systemDelete && options.governingRule) {
			auditDetails.governingRule = options.governingRule;
		}

		await this.auditService.createAuditLog({
			actorIdentifier: actor.id,
			actionType: 'DELETE',
			targetType: 'ArchivedEmail',
			targetId: emailId,
			actorIp,
			details: auditDetails,
		});
		try {
			await cleanupUnreferencedObjects(storage, cleanupPaths);
		} catch (error) {
			logger.error({ emailId, error }, 'Email metadata deleted but storage cleanup failed');
			throw error;
		}
	}
}
