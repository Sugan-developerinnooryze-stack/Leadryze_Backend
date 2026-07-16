import { Router } from 'express';
import mongoose from 'mongoose';
import crypto from 'crypto';
import { authenticate, requirePermission } from '../../middlewares/auth.middleware';
import { requireTenant } from '../../middlewares/tenant.middleware';
import { AuthRequest } from '../../types';
import { sendSuccess, sendError, sendCreated, sendPaginated } from '../../utils/response';
import { User } from '../auth/auth.model';
import { Role } from '../rbac/role.model';
import { invalidateRoleCache } from '../rbac/permission.service';
import { sendEmailNow } from '../messages/brevo.service';
import { config } from '../../config';

const router = Router();

router.use(authenticate, requireTenant);

// GET /users — list all sub-users in the tenant (excluding the requester)
router.get('/', requirePermission('users.view'), async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const page  = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, parseInt(req.query.limit as string) || 20);
    const skip  = (page - 1) * limit;

    const filter: Record<string, unknown> = {
      tenantId: new mongoose.Types.ObjectId(tenantId),
      role: { $ne: 'SUPER_ADMIN' },
    };

    if (req.query.search) {
      const re = new RegExp(String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ firstName: re }, { lastName: re }, { email: re }];
    }

    if (req.query.role) filter.role = req.query.role;

    const [users, total] = await Promise.all([
      User.find(filter)
        .select('-password -refreshToken -emailVerificationToken -passwordResetToken')
        .populate('roleId', 'name description isSystem')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(filter),
    ]);

    return sendPaginated(res, users, total, page, limit);
  } catch (err) {
    next(err);
  }
});

// POST /users — create a sub-user in the tenant
router.post('/', requirePermission('users.create'), async (req: AuthRequest, res, next) => {
  try {
    const { email, firstName, lastName, role, roleId, password: rawPassword } = req.body as {
      email?: string;
      firstName?: string;
      lastName?: string;
      role?: string;
      roleId?: string;
      password?: string;
    };

    if (!email?.trim())     return sendError(res, 'Email is required', 400);
    if (!firstName?.trim()) return sendError(res, 'First name is required', 400);
    if (!lastName?.trim())  return sendError(res, 'Last name is required', 400);

    const allowedRoles = ['MANAGER', 'AGENT', 'USER'];
    const assignedRole = role && allowedRoles.includes(role) ? role : 'AGENT';

    const tenantId = req.user!.tenantId;

    const exists = await User.findOne({ email: email.toLowerCase(), tenantId });
    if (exists) return sendError(res, 'A user with this email already exists in this tenant', 409);

    // Resolve roleId — use provided, or fall back to system role matching the role string
    let resolvedRoleId: mongoose.Types.ObjectId | null = null;
    if (roleId && mongoose.isValidObjectId(roleId)) {
      const roleDoc = await Role.findOne({ _id: roleId, tenantId }).lean();
      if (roleDoc) resolvedRoleId = roleDoc._id as mongoose.Types.ObjectId;
    } else {
      const roleNameMap: Record<string, string> = { MANAGER: 'Manager', AGENT: 'Agent', USER: 'Agent' };
      const systemRoleName = roleNameMap[assignedRole];
      if (systemRoleName) {
        const systemRole = await Role.findOne({ tenantId, name: systemRoleName }).lean();
        if (systemRole) resolvedRoleId = systemRole._id as mongoose.Types.ObjectId;
      }
    }

    // Generate temp password if not provided
    const tempPassword  = rawPassword || crypto.randomBytes(8).toString('hex');
    const isEmailVerified = true; // admin-created users skip email verification

    const user = await User.create({
      email:         email.toLowerCase().trim(),
      password:      tempPassword,
      firstName:     firstName.trim(),
      lastName:      lastName.trim(),
      role:          assignedRole,
      roleId:        resolvedRoleId,
      tenantId:      new mongoose.Types.ObjectId(tenantId),
      isActive:      true,
      emailVerified: isEmailVerified,
    });

    // Send welcome email (fire-and-forget)
    const loginUrl = `${config.app.frontendUrl}/login`;
    sendEmailNow({
      to:      email.toLowerCase(),
      toName:  `${firstName} ${lastName}`,
      subject: 'Your LeadRyze AI account has been created',
      htmlContent: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px">
          <h2 style="color:#1a1a2e">Welcome to LeadRyze AI, ${firstName}!</h2>
          <p>Your account has been created by your team administrator.</p>
          <p><strong>Login Email:</strong> ${email.toLowerCase()}</p>
          ${!rawPassword ? `<p><strong>Temporary Password:</strong> ${tempPassword}</p><p style="color:#888;font-size:13px">Please change your password after logging in.</p>` : ''}
          <div style="margin:24px 0">
            <a href="${loginUrl}" style="background:#2563eb;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">
              Log In Now
            </a>
          </div>
          <hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>
          <p style="color:#999;font-size:12px">LeadRyze AI — AI-powered lead management</p>
        </div>
      `,
    }).catch(() => {});

    const userObj = user.toObject() as unknown as Record<string, unknown>;
    delete userObj.password;
    delete userObj.refreshToken;

    return sendCreated(res, userObj);
  } catch (err) {
    next(err);
  }
});

// PUT /users/:id — update info or reassign role
router.put('/:id', requirePermission('users.edit'), async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const { firstName, lastName, roleId, isActive } = req.body as {
      firstName?: string;
      lastName?:  string;
      roleId?:    string;
      isActive?:  boolean;
    };

    const user = await User.findOne({
      _id: req.params.id,
      tenantId: new mongoose.Types.ObjectId(tenantId),
      role: { $ne: 'SUPER_ADMIN' },
    });
    if (!user) return sendError(res, 'User not found', 404);

    if (firstName?.trim()) user.firstName = firstName.trim();
    if (lastName?.trim())  user.lastName  = lastName.trim();
    if (typeof isActive === 'boolean') user.isActive = isActive;

    // Reassign role — invalidate old role cache before switching
    if (roleId !== undefined) {
      const oldRoleId = user.roleId?.toString();

      if (roleId === null || roleId === '') {
        user.roleId = null;
      } else if (mongoose.isValidObjectId(roleId)) {
        const roleDoc = await Role.findOne({ _id: roleId, tenantId }).lean();
        if (!roleDoc) return sendError(res, 'Role not found', 404);
        user.roleId = roleDoc._id as mongoose.Types.ObjectId;
      }

      if (oldRoleId) await invalidateRoleCache(tenantId, oldRoleId);
    }

    await user.save();

    const userObj = user.toObject() as unknown as Record<string, unknown>;
    delete userObj.password;
    delete userObj.refreshToken;

    return sendSuccess(res, userObj);
  } catch (err) {
    next(err);
  }
});

// DELETE /users/:id — soft deactivate (preserves data history)
router.delete('/:id', requirePermission('users.delete'), async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;

    // Prevent self-deletion
    if (req.params.id === req.user!.userId) {
      return sendError(res, 'You cannot deactivate your own account', 400);
    }

    const user = await User.findOne({
      _id: req.params.id,
      tenantId: new mongoose.Types.ObjectId(tenantId),
      role: { $ne: 'SUPER_ADMIN' },
    });
    if (!user) return sendError(res, 'User not found', 404);

    user.isActive = false;
    // Invalidate their session by clearing refresh token
    user.set('refreshToken', undefined);
    await user.save();

    return sendSuccess(res, null, 'User deactivated');
  } catch (err) {
    next(err);
  }
});

// POST /users/:id/reset-password — admin resets a user's password
router.post('/:id/reset-password', requirePermission('users.edit'), async (req: AuthRequest, res, next) => {
  try {
    const { password } = req.body as { password?: string };
    if (!password || password.length < 8) {
      return sendError(res, 'Password must be at least 8 characters', 400);
    }

    const tenantId = req.user!.tenantId;
    const user = await User.findOne({
      _id:      req.params.id,
      tenantId: new mongoose.Types.ObjectId(tenantId),
      role:     { $ne: 'SUPER_ADMIN' },
    }).select('+password');

    if (!user) return sendError(res, 'User not found', 404);

    user.password = password;
    user.set('refreshToken', undefined); // invalidate existing sessions
    await user.save();

    return sendSuccess(res, null, 'Password reset successfully');
  } catch (err) {
    next(err);
  }
});

export default router;
