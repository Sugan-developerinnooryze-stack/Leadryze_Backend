import mongoose, { Schema, Document } from 'mongoose';
import bcrypt from 'bcryptjs';
import { UserRole } from '../../types';

/**
 * @swagger
 * components:
 *   schemas:
 *     User:
 *       type: object
 *       properties:
 *         _id: { type: string }
 *         email: { type: string, format: email }
 *         firstName: { type: string }
 *         lastName: { type: string }
 *         role: { type: string, enum: [SUPER_ADMIN, TENANT_ADMIN, MANAGER, AGENT, USER] }
 *         tenantId: { type: string }
 *         isActive: { type: boolean }
 *         lastLogin: { type: string, format: date-time }
 */
export interface IUser extends Document {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  roleId?: mongoose.Types.ObjectId | null;
  tenantId: mongoose.Types.ObjectId;
  branchId?: mongoose.Types.ObjectId | null;
  clientId?: string;
  isActive: boolean;
  lastLogin?: Date;
  refreshToken?: string;
  emailVerified: boolean;
  emailVerificationToken?: string;
  emailVerificationExpiry?: Date;
  passwordResetToken?: string;
  passwordResetExpiry?: Date;
  comparePassword(candidate: string): Promise<boolean>;
}

const userSchema = new Schema<IUser>(
  {
    email: { type: String, required: true, lowercase: true, trim: true },
    password: { type: String, required: true, select: false },
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    role: {
      type: String,
      enum: ['SUPER_ADMIN', 'TENANT_ADMIN', 'MANAGER', 'AGENT', 'USER'],
      default: 'AGENT',
    },
    roleId:   { type: Schema.Types.ObjectId, ref: 'Role',   default: null },
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    branchId: { type: Schema.Types.ObjectId, ref: 'Branch', default: null },
    clientId: { type: String, index: true },
    isActive: { type: Boolean, default: true },
    lastLogin: Date,
    refreshToken: { type: String, select: false },
    emailVerified: { type: Boolean, default: false },
    emailVerificationToken: { type: String, select: false },
    emailVerificationExpiry: { type: Date, select: false },
    passwordResetToken: { type: String, select: false },
    passwordResetExpiry: { type: Date, select: false },
  },
  { timestamps: true }
);

userSchema.index({ email: 1, tenantId: 1 }, { unique: true });
userSchema.index({ tenantId: 1 });
// TTL indexes — MongoDB auto-deletes tokens after they expire
userSchema.index({ emailVerificationExpiry: 1 }, { expireAfterSeconds: 0, sparse: true });
userSchema.index({ passwordResetExpiry: 1 }, { expireAfterSeconds: 0, sparse: true });

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.comparePassword = async function (candidate: string): Promise<boolean> {
  return bcrypt.compare(candidate, this.password);
};

export const User = mongoose.model<IUser>('User', userSchema);
