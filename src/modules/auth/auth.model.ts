import mongoose, { Schema, Document } from 'mongoose';
import bcrypt from 'bcryptjs';
import { UserRole } from '../../types';
import { resolveClientPrefix } from '../../utils/client-id';

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
  // Per-user login identifier, distinct from the tenant's shared clientId —
  // TENANT_ADMIN's is exactly the tenant clientId (unchanged login
  // behavior); every other user gets `${clientId}-U${seq}`, assigned once
  // at creation (see the pre('save') hook below) and never changed by a
  // later role change. Undefined for SUPER_ADMIN (logs in by email).
  loginId?: string;
  isActive: boolean;
  lastLogin?: Date;
  refreshToken?: string;
  emailVerified: boolean;
  emailVerificationToken?: string;
  emailVerificationExpiry?: Date;
  passwordResetToken?: string;
  passwordResetExpiry?: Date;
  mustChangePassword?: boolean;
  // AES-256-GCM encrypted copy of the password, set ONLY when a Super Admin
  // issues/regenerates a credential (Create Tenant, Approve, Add User,
  // admin Reset/Regenerate Password), never for a self-chosen password —
  // lets the Super Admin panel show/copy a currently-working password. Any
  // self-service password change (Settings, forgot-password) clears this
  // rather than leaving a stale value behind. See utils/crypto.ts.
  passwordEnc?: string;
  // Sidebar drag/pin/hide customization — UI ordering preference only, never
  // an authorization source. The frontend always re-applies its own
  // canNav()/canNavFlag() permission+feature-flag filtering to the nav
  // catalog BEFORE consulting this preference, so a key here for an item the
  // user isn't permitted to see is simply never rendered — this field can
  // only reorder/hide items that were already permitted, never grant access.
  sidebarLayout?: {
    items?:  Record<string, { order?: number; pinned?: boolean }>;
    groups?: { crmData?: boolean; customModules?: boolean };
  };
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
    // No index option here — the real index (unique + sparse) is declared
    // explicitly below via userSchema.index(), to avoid Mongoose creating
    // two separate indexes for the same field.
    loginId: { type: String },
    isActive: { type: Boolean, default: true },
    lastLogin: Date,
    refreshToken: { type: String, select: false },
    emailVerified: { type: Boolean, default: false },
    emailVerificationToken: { type: String, select: false },
    emailVerificationExpiry: { type: Date, select: false },
    passwordResetToken: { type: String, select: false },
    passwordResetExpiry: { type: Date, select: false },
    mustChangePassword: { type: Boolean, default: false },
    passwordEnc: { type: String, select: false },
    sidebarLayout: { type: Schema.Types.Mixed, default: undefined },
  },
  { timestamps: true }
);

userSchema.index({ email: 1, tenantId: 1 }, { unique: true });
userSchema.index({ tenantId: 1 });
// Cheap insurance for Client-ID login lookups (User.findOne({tenantId,
// clientId})) now that clientId is a real login credential for the first
// time — sparse, non-unique (only tenant-creating admins get one today).
userSchema.index({ tenantId: 1, clientId: 1 }, { sparse: true });
// Globally unique — a loginId is already tenant-prefixed (${clientId} or
// ${clientId}-U${seq}), so no two tenants can ever collide on one anyway.
userSchema.index({ loginId: 1 }, { unique: true, sparse: true });
// TTL indexes — MongoDB auto-deletes tokens after they expire
userSchema.index({ emailVerificationExpiry: 1 }, { expireAfterSeconds: 0, sparse: true });
userSchema.index({ passwordResetExpiry: 1 }, { expireAfterSeconds: 0, sparse: true });

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

// Assigns loginId once, at creation, regardless of which of the several
// User.create() call sites made this document — see auth.model.ts's own
// loginId doc-comment above. Never reassigns on update, so a later role
// change can never alter someone's login identifier. SUPER_ADMIN is
// skipped entirely (logs in by email, has no tenant Client ID concept).
userSchema.pre('save', async function (next) {
  if (!this.isNew || this.loginId || this.role === 'SUPER_ADMIN') return next();
  const prefix = await resolveClientPrefix(this.tenantId);
  // POST /admin/users allows creating a second TENANT_ADMIN for a tenant
  // that already has one (e.g. a co-admin) — only the first claims the
  // bare clientId as their loginId; anyone else, TENANT_ADMIN or not,
  // falls through to the suffixed counter below, so two people can never
  // collide on the same loginId (the unique index would reject it anyway,
  // but this avoids that happening as an ugly creation-time DB error).
  const bareIdTaken = this.role === 'TENANT_ADMIN'
    && await mongoose.model('User').exists({ tenantId: this.tenantId, loginId: prefix });
  if (this.role === 'TENANT_ADMIN' && !bareIdTaken) {
    this.loginId = prefix;
  } else {
    // Atomic per-tenant counter — a plain read-then-+1 (the convention
    // every other per-tenant sequence number in this codebase uses, e.g.
    // WO-0001) is a real race for a login credential specifically: two
    // concurrent invites could compute the same "next" number and produce
    // a duplicate loginId. $inc on a single document is atomic regardless,
    // no transaction/replica-set needed (same reasoning as
    // reserveUserSeat() in tenant.service.ts).
    const Tenant = mongoose.model('Tenant');
    const updated = await Tenant.findOneAndUpdate(
      { _id: this.tenantId },
      { $inc: { 'settings.userLoginSeq': 1 } },
      { new: true }
    ).select('settings.userLoginSeq').lean() as { settings?: { userLoginSeq?: number } } | null;
    const seq = updated?.settings?.userLoginSeq ?? 1;
    this.loginId = `${prefix}-U${String(seq).padStart(3, '0')}`;
  }
  next();
});

userSchema.methods.comparePassword = async function (candidate: string): Promise<boolean> {
  return bcrypt.compare(candidate, this.password);
};

export const User = mongoose.model<IUser>('User', userSchema);
