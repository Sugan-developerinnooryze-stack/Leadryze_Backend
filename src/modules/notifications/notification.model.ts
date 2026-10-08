import mongoose, { Schema, Document } from 'mongoose';

export interface INotification extends Document {
  tenantId: mongoose.Types.ObjectId;
  userId?: mongoose.Types.ObjectId;
  type: 'new_lead' | 'booking' | 'message' | 'system' | 'alert';
  title: string;
  body: string;
  isRead: boolean;
  /** Per-reader read state for a tenant-wide doc (userId absent) — a single
   * `isRead` boolean would be shared by every staffer who can see it. Unused
   * (always []) on a userId-targeted doc, which has exactly one reader and
   * uses `isRead` instead. */
  readBy: string[];
  data?: Record<string, unknown>;
}

const notificationSchema = new Schema<INotification>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    type: {
      type: String,
      enum: ['new_lead', 'booking', 'message', 'system', 'alert'],
      required: true,
    },
    title: { type: String, required: true },
    body: { type: String, required: true },
    isRead: { type: Boolean, default: false },
    readBy: { type: [String], default: [] },
    data: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

notificationSchema.index({ tenantId: 1, userId: 1, isRead: 1, createdAt: -1 });

export const Notification = mongoose.model<INotification>('Notification', notificationSchema);
