import mongoose, { Document, Schema } from 'mongoose';

export interface ICalendarEvent extends Document {
  tenantId:      mongoose.Types.ObjectId;
  title:         string;
  startDate:     Date;
  endDate?:      Date;
  allDay:        boolean;
  description?:  string;
  color:         string;
  location?:     string;
  createdBy?:    string;
  linkedRecord?: {
    channel:     string;
    module:      string;
    externalId:  string;
    displayName: string;
  };
  createdAt: Date;
  updatedAt: Date;
}

const calendarEventSchema = new Schema<ICalendarEvent>(
  {
    tenantId:    { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    title:       { type: String, required: true, trim: true },
    startDate:   { type: Date, required: true },
    endDate:     { type: Date },
    allDay:      { type: Boolean, default: false },
    description: { type: String },
    color:       { type: String, default: '#6366f1' },
    location:    { type: String },
    createdBy:   { type: String },
    linkedRecord: {
      channel:     { type: String },
      module:      { type: String },
      externalId:  { type: String },
      displayName: { type: String },
    },
  },
  { timestamps: true }
);

calendarEventSchema.index({ tenantId: 1, startDate: 1, endDate: 1 });

export const CalendarEvent = mongoose.model<ICalendarEvent>('CalendarEvent', calendarEventSchema);
