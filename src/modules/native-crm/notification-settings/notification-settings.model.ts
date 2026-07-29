import mongoose, { Schema, Document } from 'mongoose';

export interface INotificationSettings extends Document {
  tenantId:                 mongoose.Types.ObjectId;
  reminderWindowMinutes:    number;
  sendOnCreateConfirmation: boolean;
  emailEnabled:             boolean;
  smsEnabled:               boolean;
  createdAt:                Date;
  updatedAt:                Date;
}

const schema = new Schema<INotificationSettings>(
  {
    tenantId:                 { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    reminderWindowMinutes:    { type: Number, default: 15, min: 1, max: 1440 },
    sendOnCreateConfirmation: { type: Boolean, default: true },
    emailEnabled:             { type: Boolean, default: true },
    smsEnabled:               { type: Boolean, default: true },
  },
  { timestamps: true }
);

schema.index({ tenantId: 1 }, { unique: true });

export const NotificationSettings = mongoose.model<INotificationSettings>(
  'NotificationSettings',
  schema,
  'native_notification_settings'
);
