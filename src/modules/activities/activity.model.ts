import mongoose, { Schema, Document } from 'mongoose';

export interface IActivity extends Document {
  tenantId:     mongoose.Types.ObjectId;
  type:         'task' | 'event' | 'booking' | 'appointment' | 'schedule' | 'followup' | 'custom';
  customType?:  string;
  category?:    string;
  subcategory?: string;
  title:        string;
  status:       'pending' | 'in_progress' | 'completed' | 'cancelled';
  priority?:    'low' | 'medium' | 'high';
  startDate?:   Date;
  endDate?:     Date;
  dueDate?:     Date;
  allDay?:      boolean;
  color?:       string;
  location?:    string;
  notes?:       string;
  tags?:        string[];
  linkedPerson?: {
    externalId:  string;
    displayName: string;
    email?:      string;
    phone?:      string;
    module:      string;
    channel:     string;
  };
  fields:       Record<string, unknown>;
  createdBy?:   string;
  reminderSentAt?: Date;
  followupSentAt?: Date;
}

const activitySchema = new Schema<IActivity>(
  {
    tenantId:    { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    type:        {
      type: String,
      enum: ['task', 'event', 'booking', 'appointment', 'schedule', 'followup', 'custom'],
      required: true,
    },
    customType:  String,
    category:    String,
    subcategory: String,
    title:       { type: String, required: true, trim: true },
    status:      {
      type: String,
      enum: ['pending', 'in_progress', 'completed', 'cancelled'],
      default: 'pending',
    },
    priority:    { type: String, enum: ['low', 'medium', 'high'] },
    startDate:   Date,
    endDate:     Date,
    dueDate:     Date,
    allDay:      { type: Boolean, default: false },
    color:       String,
    location:    String,
    notes:       String,
    tags:        [String],
    linkedPerson: {
      externalId:  String,
      displayName: String,
      email:       String,
      phone:       String,
      module:      String,
      channel:     String,
    },
    fields:          { type: Schema.Types.Mixed, default: {} },
    createdBy:       String,
    reminderSentAt:  Date,
    followupSentAt:  Date,
  },
  { timestamps: true }
);

activitySchema.index({ tenantId: 1, type: 1 });
activitySchema.index({ tenantId: 1, status: 1 });
activitySchema.index({ tenantId: 1, dueDate: 1 });
activitySchema.index({ tenantId: 1, startDate: 1 });
activitySchema.index({ startDate: 1, reminderSentAt: 1, status: 1 });
activitySchema.index({ endDate: 1, followupSentAt: 1, status: 1 });

export const Activity = mongoose.model<IActivity>('Activity', activitySchema, 'crmactivities');
