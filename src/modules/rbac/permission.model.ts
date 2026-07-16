import mongoose, { Schema, Document } from 'mongoose';

export type PermissionScope = 'platform' | 'connector' | 'dynamic';

export interface IPermission extends Document {
  tenantId:    mongoose.Types.ObjectId | null;
  key:         string;
  module:      string;
  resource:    string;
  action:      string;
  label:       string;
  isSystem:    boolean;
  scope:       PermissionScope;
  connectorId: mongoose.Types.ObjectId | null;
  createdAt:   Date;
}

const PermissionSchema = new Schema<IPermission>(
  {
    tenantId:    { type: Schema.Types.ObjectId, ref: 'Tenant', default: null, index: true },
    key:         { type: String, required: true, trim: true },
    module:      { type: String, required: true },
    resource:    { type: String, required: true },
    action:      { type: String, required: true },
    label:       { type: String, required: true },
    isSystem:    { type: Boolean, default: true },
    scope:       { type: String, enum: ['platform', 'connector', 'dynamic'], default: 'platform' },
    connectorId: { type: Schema.Types.ObjectId, ref: 'Connector', default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Unique per (tenantId, key) — null tenantId = system-wide, shared across all tenants
PermissionSchema.index({ tenantId: 1, key: 1 }, { unique: true });
PermissionSchema.index({ module: 1 });
PermissionSchema.index({ scope: 1 });

export const Permission = mongoose.model<IPermission>('Permission', PermissionSchema);
