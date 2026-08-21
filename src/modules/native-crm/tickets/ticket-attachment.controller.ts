import { Response } from 'express';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError } from '../../../utils/response';
import { TicketAttachment } from './ticket-attachment.model';
import { uploadToS3, deleteFromS3, keyFromUrl } from '../../../services/s3.service';
import { logTimelineEvent } from './ticket-timeline.service';

/** GET /:ticketId/attachments — a ticket's uploaded files, newest first. */
export async function list(req: AuthRequest, res: Response) {
  try {
    const filter = { tenantId: req.tenantId, ticketId: req.params.ticketId };
    const items = await TicketAttachment.find(filter).sort({ createdAt: -1 }).lean();
    sendSuccess(res, items);
  } catch (err: any) {
    sendError(res, err.message ?? 'Failed to list attachments', 500);
  }
}

/** POST /:ticketId/attachments — upload a new attachment (multipart, field name "file"). */
export async function upload(req: AuthRequest, res: Response) {
  try {
    if (!req.file) return void sendError(res, 'file is required', 400);

    const url = await uploadToS3({
      tenantId: req.tenantId!,
      folder:   'tickets/attachments',
      filename: req.file.originalname,
      mimetype: req.file.mimetype,
      buffer:   req.file.buffer,
    });

    const attachment = await TicketAttachment.create({
      tenantId:   req.tenantId,
      ticketId:   req.params.ticketId,
      url,
      key:        keyFromUrl(url),
      filename:   req.file.originalname,
      mimetype:   req.file.mimetype,
      size:       req.file.size,
      uploadedBy: req.user?.userId,
    });

    logTimelineEvent({
      tenantId: req.tenantId!, ticketId: req.params.ticketId, eventType: 'attachment_added',
      toValue: req.file.originalname, actorId: req.user?.userId, actorName: req.user?.email,
    }).catch(() => {});

    res.status(201).json({ success: true, data: attachment });
  } catch (err: any) {
    sendError(res, err.message ?? 'Upload failed', 500);
  }
}

/** DELETE /attachments/:id — removes the record and best-effort deletes the S3 object. */
export async function remove(req: AuthRequest, res: Response) {
  try {
    const attachment = await TicketAttachment.findOneAndDelete({ _id: req.params.id, tenantId: req.tenantId });
    if (!attachment) return void sendError(res, 'Not found', 404);
    try {
      await deleteFromS3(attachment.key);
    } catch {
      // S3 cleanup is best-effort — the Mongo record is already gone, which
      // is what matters for the attachment no longer being listed.
    }
    logTimelineEvent({
      tenantId: req.tenantId!, ticketId: String(attachment.ticketId), eventType: 'attachment_removed',
      fromValue: attachment.filename, actorId: req.user?.userId, actorName: req.user?.email,
    }).catch(() => {});
    sendSuccess(res, null, 'Deleted');
  } catch (err: any) {
    sendError(res, err.message ?? 'Failed to delete attachment', 500);
  }
}
