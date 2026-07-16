import mongoose, { Schema, Document } from 'mongoose';

export interface IRolePermission extends Document {
  roleId:       mongoose.Types.ObjectId;
  permissionId: mongoose.Types.ObjectId;
  tenantId:     mongoose.Types.ObjectId;
  grantedBy:    mongoose.Types.ObjectId;
  grantedAt:    Date;
}

const RolePermissionSchema = new Schema<IRolePermission>(
  {
    roleId:       { type: Schema.Types.ObjectId, ref: 'Role',       required: true, index: true },
    permissionId: { type: Schema.Types.ObjectId, ref: 'Permission', required: true },
    tenantId:     { type: Schema.Types.ObjectId, ref: 'Tenant',     required: true, index: true },
    grantedBy:    { type: Schema.Types.ObjectId, ref: 'User',       required: true },
    grantedAt:    { type: Date, default: Date.now },
  },
  { timestamps: false }
);

RolePermissionSchema.index({ roleId: 1, permissionId: 1 }, { unique: true });
RolePermissionSchema.index({ tenantId: 1, roleId: 1 });

export const RolePermission = mongoose.model<IRolePermission>('RolePermission', RolePermissionSchema);
