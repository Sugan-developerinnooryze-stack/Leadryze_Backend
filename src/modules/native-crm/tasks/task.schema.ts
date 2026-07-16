import mongoose, { Schema } from 'mongoose';
import { resolveClientPrefix } from '../../../utils/client-id';

export const taskSchema = new Schema(
  {
    tenantId:   { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    clientId:   { type: String, index: true },
    title:      { type: String, required: true, trim: true },
    dueDate:    { type: Date },
    priority:   { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
    taskStatus: { type: String, enum: ['todo', 'in_progress', 'done', 'cancelled'], default: 'todo' },
    assignedTo: { type: String, trim: true },
    notes:      { type: String },
    tags:       [{ type: String }],
    customFields: { type: Schema.Types.Mixed },
    createdBy:  { type: String },
  },
  { timestamps: true }
);

taskSchema.pre('save', async function (next) {
  if (!this.isNew || this.clientId) return next();
  this.clientId = await resolveClientPrefix(this.tenantId as mongoose.Types.ObjectId);
  next();
});

taskSchema.index({ tenantId: 1 });
taskSchema.index({ tenantId: 1, taskStatus: 1 });
taskSchema.index({ tenantId: 1, dueDate: 1 });
taskSchema.index({ tenantId: 1, priority: 1 });
