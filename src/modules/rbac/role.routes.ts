import { Router } from 'express';
import mongoose from 'mongoose';
import { authenticate, authorize, requirePermission } from '../../middlewares/auth.middleware';
import { requireTenant } from '../../middlewares/tenant.middleware';
import { AuthRequest } from '../../types';
import { sendSuccess, sendError, sendCreated } from '../../utils/response';
import { Role } from './role.model';
import { Permission } from './permission.model';
import { RolePermission } from './role-permission.model';
import { getPermissionArray, invalidateRoleCache } from './permission.service';
import { User } from '../auth/auth.model';
import { NativeCrmLog } from '../logs/native-crm-log.model';

const router = Router();

router.use(authenticate, requireTenant);

// GET /roles/my-permissions — must come before /:id to avoid route conflict
router.get('/my-permissions', async (req: AuthRequest, res, next) => {
  try {
    const { role, roleId, tenantId } = req.user!;

    if (role === 'SUPER_ADMIN' || role === 'TENANT_ADMIN') {
      return sendSuccess(res, null, 'Full access — no restrictions');
    }

    if (!roleId || !tenantId) {
      return sendSuccess(res, [], 'No role assigned');
    }

    const permissions = await getPermissionArray(tenantId, roleId);
    return sendSuccess(res, permissions);
  } catch (err) {
    next(err);
  }
});

// GET /roles — list all roles in the tenant
router.get('/', requirePermission('roles.view'), async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const roles = await Role.find({ tenantId }).sort({ isSystem: -1, name: 1 }).lean();

    // Count users per role
    const roleCounts = await User.aggregate([
      { $match: { tenantId: new mongoose.Types.ObjectId(tenantId), isActive: true } },
      { $group: { _id: '$roleId', count: { $sum: 1 } } },
    ]);
    const countMap: Record<string, number> = {};
    for (const r of roleCounts) {
      if (r._id) countMap[r._id.toString()] = r.count;
    }

    const result = roles.map((r) => ({
      ...r,
      userCount: countMap[(r._id as mongoose.Types.ObjectId).toString()] ?? 0,
    }));

    return sendSuccess(res, result);
  } catch (err) {
    next(err);
  }
});

// POST /roles — create custom role
router.post('/', requirePermission('roles.create'), async (req: AuthRequest, res, next) => {
  try {
    const { name, description } = req.body as { name?: string; description?: string };
    if (!name?.trim()) return sendError(res, 'Role name is required', 400);

    const tenantId = req.user!.tenantId;
    const userId   = req.user!.userId;

    const exists = await Role.findOne({ tenantId, name: name.trim() });
    if (exists) return sendError(res, 'A role with this name already exists', 409);

    const role = await Role.create({
      tenantId: new mongoose.Types.ObjectId(tenantId),
      name:     name.trim(),
      description: description?.trim() ?? '',
      isSystem: false,
      createdBy: new mongoose.Types.ObjectId(userId),
    });

    return sendCreated(res, role);
  } catch (err) {
    next(err);
  }
});

// GET /roles/:id — get single role
router.get('/:id', requirePermission('roles.view'), async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const role = await Role.findOne({ _id: req.params.id, tenantId }).lean();
    if (!role) return sendError(res, 'Role not found', 404);
    return sendSuccess(res, role);
  } catch (err) {
    next(err);
  }
});

// PUT /roles/:id — update name/description
router.put('/:id', requirePermission('roles.edit'), async (req: AuthRequest, res, next) => {
  try {
    const { name, description } = req.body as { name?: string; description?: string };
    const tenantId = req.user!.tenantId;

    const role = await Role.findOne({ _id: req.params.id, tenantId });
    if (!role) return sendError(res, 'Role not found', 404);

    if (name?.trim() && name.trim() !== role.name) {
      const exists = await Role.findOne({ tenantId, name: name.trim(), _id: { $ne: role._id } });
      if (exists) return sendError(res, 'A role with this name already exists', 409);
      role.name = name.trim();
    }

    if (description !== undefined) role.description = description.trim();
    await role.save();

    return sendSuccess(res, role);
  } catch (err) {
    next(err);
  }
});

// DELETE /roles/:id — delete (system roles cannot be deleted)
router.delete('/:id', requirePermission('roles.delete'), async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const role = await Role.findOne({ _id: req.params.id, tenantId });
    if (!role) return sendError(res, 'Role not found', 404);
    if (role.isSystem) return sendError(res, 'System roles cannot be deleted', 403);

    // Unassign role from all users first
    await User.updateMany(
      { tenantId: new mongoose.Types.ObjectId(tenantId), roleId: role._id },
      { $unset: { roleId: 1 } }
    );

    // Delete all role permissions
    await RolePermission.deleteMany({ roleId: role._id });

    // Invalidate cache
    await invalidateRoleCache(tenantId, (role._id as mongoose.Types.ObjectId).toString());

    await role.deleteOne();

    return sendSuccess(res, null, 'Role deleted');
  } catch (err) {
    next(err);
  }
});

// GET /roles/:id/permissions — get permission keys assigned to this role
router.get('/:id/permissions', requirePermission('roles.view'), async (req: AuthRequest, res, next) => {
  try {
    const tenantId = req.user!.tenantId;
    const role = await Role.findOne({ _id: req.params.id, tenantId }).lean();
    if (!role) return sendError(res, 'Role not found', 404);

    const rolePerms = await RolePermission
      .find({ roleId: req.params.id, tenantId })
      .populate<{ permissionId: { key: string; label: string; module: string; resource: string; action: string } }>(
        'permissionId', 'key label module resource action scope'
      )
      .lean();

    const permissions = rolePerms
      .filter((rp) => rp.permissionId)
      .map((rp) => rp.permissionId);

    return sendSuccess(res, permissions);
  } catch (err) {
    next(err);
  }
});

// PUT /roles/:id/permissions — replace the full permission list for a role
router.put('/:id/permissions', requirePermission('roles.edit'), async (req: AuthRequest, res, next) => {
  try {
    const { permissions: permKeys } = req.body as { permissions: string[] };
    if (!Array.isArray(permKeys)) return sendError(res, 'permissions must be an array of keys', 400);

    const tenantId = req.user!.tenantId;
    const userId   = req.user!.userId;
    const roleObjId = new mongoose.Types.ObjectId(req.params.id);
    const tenantObjId = new mongoose.Types.ObjectId(tenantId);

    const role = await Role.findOne({ _id: roleObjId, tenantId }).lean();
    if (!role) return sendError(res, 'Role not found', 404);

    // Snapshot previous permission keys (for the permission change log)
    const prevRolePerms = await RolePermission
      .find({ roleId: roleObjId, tenantId: tenantObjId })
      .populate<{ permissionId: { key: string } }>('permissionId', 'key')
      .lean();
    const prevPermKeys = prevRolePerms
      .filter((rp) => rp.permissionId)
      .map((rp) => rp.permissionId.key);

    // Resolve permission keys → IDs (system-level permissions have tenantId: null)
    const permDocs = await Permission.find(
      { key: { $in: permKeys }, $or: [{ tenantId: null }, { tenantId: tenantObjId }] },
      '_id key'
    ).lean();

    const permIdMap: Record<string, mongoose.Types.ObjectId> = {};
    for (const p of permDocs) permIdMap[p.key] = p._id as mongoose.Types.ObjectId;

    // Delete existing RolePermissions and insert new ones atomically
    await RolePermission.deleteMany({ roleId: roleObjId, tenantId: tenantObjId });

    const newPerms = permKeys
      .filter((k) => permIdMap[k])
      .map((k) => ({
        roleId:       roleObjId,
        permissionId: permIdMap[k],
        tenantId:     tenantObjId,
        grantedBy:    new mongoose.Types.ObjectId(userId),
        grantedAt:    new Date(),
      }));

    if (newPerms.length) {
      await RolePermission.insertMany(newPerms, { ordered: false });
    }

    // Invalidate cache so next request re-fetches from DB
    await invalidateRoleCache(tenantId, req.params.id);

    // Fire-and-forget permission change log — never blocks the response
    const grantedKeys = permKeys.filter((k) => permIdMap[k]);
    NativeCrmLog.create({
      tenantId,
      actorId:    userId,
      actorName:  req.user!.email ?? userId,
      actorRole:  req.user!.role  ?? '',
      action:     'permission',
      module:     'permissions',
      resourceId: req.params.id,
      before:     { roleName: role.name, roleId: req.params.id, permissions: prevPermKeys },
      after:      { roleName: role.name, roleId: req.params.id, permissions: grantedKeys },
      changes:    null,
      error:      null,
      statusCode: 200,
      ip:         req.ip || 'unknown',
      url:        req.originalUrl,
      timestamp:  new Date(),
    }).catch(() => {});

    return sendSuccess(res, { granted: newPerms.length }, 'Permissions updated');
  } catch (err) {
    next(err);
  }
});

// POST /roles/:id/clone — clone role with all its permissions
router.post('/:id/clone', requirePermission('roles.create'), async (req: AuthRequest, res, next) => {
  try {
    const { name } = req.body as { name?: string };
    const tenantId = req.user!.tenantId;
    const userId   = req.user!.userId;

    const original = await Role.findOne({ _id: req.params.id, tenantId }).lean();
    if (!original) return sendError(res, 'Role not found', 404);

    const cloneName = name?.trim() || `${original.name} (Copy)`;
    const exists = await Role.findOne({ tenantId, name: cloneName });
    if (exists) return sendError(res, `A role named "${cloneName}" already exists`, 409);

    const cloned = await Role.create({
      tenantId:    new mongoose.Types.ObjectId(tenantId),
      name:        cloneName,
      description: original.description,
      isSystem:    false,
      createdBy:   new mongoose.Types.ObjectId(userId),
    });

    // Copy all permissions from the original role to the clone
    const originalPerms = await RolePermission.find({ roleId: original._id }).lean();
    if (originalPerms.length) {
      const clonePerms = originalPerms.map((rp) => ({
        roleId:       cloned._id,
        permissionId: rp.permissionId,
        tenantId:     new mongoose.Types.ObjectId(tenantId),
        grantedBy:    new mongoose.Types.ObjectId(userId),
        grantedAt:    new Date(),
      }));
      await RolePermission.insertMany(clonePerms, { ordered: false });
    }

    return sendCreated(res, { role: cloned, copiedPermissions: originalPerms.length });
  } catch (err) {
    next(err);
  }
});

export default router;
