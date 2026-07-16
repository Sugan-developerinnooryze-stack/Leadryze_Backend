import mongoose, { Schema, Document } from 'mongoose';

export interface IRole extends Document {
  tenantId:    mongoose.Types.ObjectId;
  name:        string;
  description: string;
  isSystem:    boolean;
  createdBy:   mongoose.Types.ObjectId | null;
  createdAt:   Date;
  updatedAt:   Date;
}

const RoleSchema = new Schema<IRole>(
  {
    tenantId:    { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    name:        { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    isSystem:    { type: Boolean, default: false },
    createdBy:   { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

RoleSchema.index({ tenantId: 1, name: 1 }, { unique: true });

export const Role = mongoose.model<IRole>('Role', RoleSchema);
