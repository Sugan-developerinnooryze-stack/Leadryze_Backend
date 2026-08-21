import mongoose, { Schema, Document } from 'mongoose';
import { resolveClientPrefix } from '../../../utils/client-id';

/** A file attached to a Ticket — a dedicated sub-collection (not an inline
 * array on Ticket, unlike WorkOrder's simpler `photos: string[]`) because
 * tickets need real per-file metadata (filename/size/mimetype) and an
 * independent delete flow. Mirrors custom-templates/template-asset.model.ts's
 * proven shape closely — same S3-backed storage architecture already in
 * production use elsewhere in this codebase. */
export interface ITicketAttachmentDoc extends Document {
  tenantId:    mongoose.Types.ObjectId;
  clientId?:   string;
  ticketId:    mongoose.Types.ObjectId;
  url:         string;
  key:         string;
  filename:    string;
  mimetype:    string;
  size:        number;
  uploadedBy?: string;
  createdAt:   Date;
  updatedAt:   Date;
}

const schema = new Schema<ITicketAttachmentDoc>(
  {
    tenantId:   { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    clientId:   { type: String, index: true },
    ticketId:   { type: Schema.Types.ObjectId, ref: 'CrmTicket', required: true },
    url:        { type: String, required: true },
    key:        { type: String, required: true },
    filename:   { type: String, required: true, trim: true },
    mimetype:   { type: String, required: true },
    size:       { type: Number, required: true },
    uploadedBy: { type: String },
  },
  { timestamps: true }
);

schema.pre('save', async function (next) {
  if (!this.isNew || this.clientId) return next();
  this.clientId = await resolveClientPrefix(this.tenantId as mongoose.Types.ObjectId);
  next();
});

schema.index({ tenantId: 1, ticketId: 1, createdAt: -1 });

export const TicketAttachment = mongoose.model<ITicketAttachmentDoc>(
  'TicketAttachment',
  schema,
  'native_ticket_attachments'
);
