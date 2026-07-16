import mongoose from 'mongoose';
import { Permission, IPermission } from './permission.model';
import { Role, IRole } from './role.model';
import { RolePermission } from './role-permission.model';
import { logger } from '../../utils/logger';

// ── System permission definitions ────────────────────────────────────────────

type PermDef = { key: string; module: string; resource: string; action: string; label: string; scope?: 'platform' | 'connector' };

const SYSTEM_PERMISSIONS: PermDef[] = [
  // Settings
  { key: 'settings.view',     module: 'settings',  resource: 'settings',  action: 'view',      label: 'Settings — View'     },
  { key: 'settings.edit',     module: 'settings',  resource: 'settings',  action: 'edit',      label: 'Settings — Edit'     },
  { key: 'settings.manage',   module: 'settings',  resource: 'settings',  action: 'manage',    label: 'Settings — Manage'   },

  // User management
  { key: 'users.view',        module: 'users',     resource: 'users',     action: 'view',      label: 'Users — View'        },
  { key: 'users.create',      module: 'users',     resource: 'users',     action: 'create',    label: 'Users — Create'      },
  { key: 'users.edit',        module: 'users',     resource: 'users',     action: 'edit',      label: 'Users — Edit'        },
  { key: 'users.delete',      module: 'users',     resource: 'users',     action: 'delete',    label: 'Users — Delete'      },

  // Role management
  { key: 'roles.view',        module: 'roles',     resource: 'roles',     action: 'view',      label: 'Roles — View'        },
  { key: 'roles.create',      module: 'roles',     resource: 'roles',     action: 'create',    label: 'Roles — Create'      },
  { key: 'roles.edit',        module: 'roles',     resource: 'roles',     action: 'edit',      label: 'Roles — Edit'        },
  { key: 'roles.delete',      module: 'roles',     resource: 'roles',     action: 'delete',    label: 'Roles — Delete'      },

  // Customers
  { key: 'customers.view',    module: 'customers', resource: 'customers', action: 'view',      label: 'Customers — View'    },
  { key: 'customers.create',  module: 'customers', resource: 'customers', action: 'create',    label: 'Customers — Create'  },
  { key: 'customers.edit',    module: 'customers', resource: 'customers', action: 'edit',      label: 'Customers — Edit'    },
  { key: 'customers.delete',  module: 'customers', resource: 'customers', action: 'delete',    label: 'Customers — Delete'  },
  { key: 'customers.export',  module: 'customers', resource: 'customers', action: 'export',    label: 'Customers — Export'  },
  { key: 'customers.import',  module: 'customers', resource: 'customers', action: 'import',    label: 'Customers — Import'  },
  { key: 'customers.assign',  module: 'customers', resource: 'customers', action: 'assign',    label: 'Customers — Assign'  },

  // Campaigns
  { key: 'campaigns.view',    module: 'campaigns', resource: 'campaigns', action: 'view',      label: 'Campaigns — View'    },
  { key: 'campaigns.create',  module: 'campaigns', resource: 'campaigns', action: 'create',    label: 'Campaigns — Create'  },
  { key: 'campaigns.edit',    module: 'campaigns', resource: 'campaigns', action: 'edit',      label: 'Campaigns — Edit'    },
  { key: 'campaigns.delete',  module: 'campaigns', resource: 'campaigns', action: 'delete',    label: 'Campaigns — Delete'  },

  // Templates
  { key: 'templates.view',    module: 'templates', resource: 'templates', action: 'view',      label: 'Templates — View'    },
  { key: 'templates.create',  module: 'templates', resource: 'templates', action: 'create',    label: 'Templates — Create'  },
  { key: 'templates.edit',    module: 'templates', resource: 'templates', action: 'edit',      label: 'Templates — Edit'    },
  { key: 'templates.delete',  module: 'templates', resource: 'templates', action: 'delete',    label: 'Templates — Delete'  },

  // Analytics
  { key: 'analytics.view',    module: 'analytics', resource: 'analytics', action: 'view',      label: 'Analytics — View'    },
  { key: 'analytics.export',  module: 'analytics', resource: 'analytics', action: 'export',    label: 'Analytics — Export'  },

  // Knowledge Base
  { key: 'knowledge.view',    module: 'knowledge', resource: 'knowledge', action: 'view',      label: 'Knowledge — View'    },
  { key: 'knowledge.create',  module: 'knowledge', resource: 'knowledge', action: 'create',    label: 'Knowledge — Create'  },
  { key: 'knowledge.edit',    module: 'knowledge', resource: 'knowledge', action: 'edit',      label: 'Knowledge — Edit'    },
  { key: 'knowledge.delete',  module: 'knowledge', resource: 'knowledge', action: 'delete',    label: 'Knowledge — Delete'  },

  // Logs
  { key: 'logs.view',         module: 'logs',      resource: 'logs',      action: 'view',      label: 'Logs — View'         },
  { key: 'logs.export',       module: 'logs',      resource: 'logs',      action: 'export',    label: 'Logs — Export'       },

  // Bot / AI Chat
  { key: 'bot.view',          module: 'bot',       resource: 'bot',       action: 'view',      label: 'Bot — View'          },
  { key: 'bot.use',           module: 'bot',       resource: 'bot',       action: 'use',       label: 'Bot — Use'           },
  { key: 'bot.configure',     module: 'bot',       resource: 'bot',       action: 'configure', label: 'Bot — Configure'     },
  { key: 'bot.manage',        module: 'bot',       resource: 'bot',       action: 'manage',    label: 'Bot — Manage'        },

  // Connectors (generic)
  { key: 'connector.view',      module: 'connector', resource: 'connector', action: 'view',      label: 'Connectors — View',      scope: 'connector' },
  { key: 'connector.configure', module: 'connector', resource: 'connector', action: 'configure', label: 'Connectors — Configure', scope: 'connector' },
  { key: 'connector.sync',      module: 'connector', resource: 'connector', action: 'sync',      label: 'Connectors — Sync',      scope: 'connector' },
  { key: 'connector.delete',    module: 'connector', resource: 'connector', action: 'delete',    label: 'Connectors — Delete',    scope: 'connector' },

  // Per-connector type permissions
  ...(['zoho', 'salesforce', 'hubspot', 'postgresql', 'mysql', 'mongodb', 'rest'] as const).flatMap(
    (type) => ([
      { key: `connector.${type}.view`,      module: 'connector', resource: type, action: 'view',      label: `${type} — View`,      scope: 'connector' as const },
      { key: `connector.${type}.configure`, module: 'connector', resource: type, action: 'configure', label: `${type} — Configure`, scope: 'connector' as const },
      { key: `connector.${type}.sync`,      module: 'connector', resource: type, action: 'sync',      label: `${type} — Sync`,      scope: 'connector' as const },
      { key: `connector.${type}.delete`,    module: 'connector', resource: type, action: 'delete',    label: `${type} — Delete`,    scope: 'connector' as const },
    ])
  ),

  // Native CRM modules (seeded for structure — actual routes built in Phase 3)
  ...(['contacts', 'leads', 'deals', 'tasks', 'meetings', 'calendar', 'notes', 'companies', 'activities'] as const).flatMap(
    (mod) => ([
      { key: `native_crm.${mod}.view`,   module: 'native_crm', resource: mod, action: 'view',   label: `CRM ${mod} — View`   },
      { key: `native_crm.${mod}.create`, module: 'native_crm', resource: mod, action: 'create', label: `CRM ${mod} — Create` },
      { key: `native_crm.${mod}.edit`,   module: 'native_crm', resource: mod, action: 'edit',   label: `CRM ${mod} — Edit`   },
      { key: `native_crm.${mod}.delete`, module: 'native_crm', resource: mod, action: 'delete', label: `CRM ${mod} — Delete` },
      { key: `native_crm.${mod}.export`, module: 'native_crm', resource: mod, action: 'export', label: `CRM ${mod} — Export` },
    ])
  ),

  // Field Service modules
  ...(['workorders', 'quotations', 'contracts', 'invoices', 'receipts', 'expenses',
       'customers', 'sites', 'teams', 'staffs', 'parts', 'categories', 'services',
       'products', 'assets', 'vehicles', 'activities'] as const).flatMap(
    (mod) => ([
      { key: `fs.${mod}.view`,   module: 'fs', resource: mod, action: 'view',   label: `FS ${mod} — View`   },
      { key: `fs.${mod}.create`, module: 'fs', resource: mod, action: 'create', label: `FS ${mod} — Create` },
      { key: `fs.${mod}.edit`,   module: 'fs', resource: mod, action: 'edit',   label: `FS ${mod} — Edit`   },
      { key: `fs.${mod}.delete`, module: 'fs', resource: mod, action: 'delete', label: `FS ${mod} — Delete` },
    ])
  ),
  // FS Settings / Custom Fields (admin-only)
  { key: 'fs.settings.view',         module: 'fs', resource: 'settings',      action: 'view',   label: 'FS Settings — View'          },
  { key: 'fs.settings.edit',         module: 'fs', resource: 'settings',      action: 'edit',   label: 'FS Settings — Edit'          },
  { key: 'fs.custom_fields.view',    module: 'fs', resource: 'custom_fields', action: 'view',   label: 'FS Custom Fields — View'     },
  { key: 'fs.custom_fields.manage',  module: 'fs', resource: 'custom_fields', action: 'manage', label: 'FS Custom Fields — Manage'   },
];

// ── Default permission sets per system role ───────────────────────────────────

const ADMIN_PERMISSIONS   = ['*']; // wildcard — full access to everything
const MANAGER_PERMISSIONS = [
  'customers.*', 'campaigns.*', 'templates.*',
  'analytics.view', 'analytics.export',
  'knowledge.*',
  'logs.view',
  'bot.view', 'bot.use',
  'connector.view', 'connector.sync',
  'native_crm.*',
  'fs.*',
  'users.view',
  'roles.view',
  'settings.view',
];
const AGENT_PERMISSIONS = [
  'customers.view', 'customers.create', 'customers.edit', 'customers.assign',
  'campaigns.view',
  'templates.view',
  'analytics.view',
  'knowledge.view',
  'bot.view', 'bot.use',
  'native_crm.contacts.view', 'native_crm.contacts.create', 'native_crm.contacts.edit',
  'native_crm.leads.view',    'native_crm.leads.create',
  'native_crm.tasks.view',    'native_crm.tasks.create',    'native_crm.tasks.edit',
  'native_crm.meetings.view', 'native_crm.calendar.view',
];

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Idempotent — safe to call on every startup.
 * 1. Upserts all system permissions (tenantId: null).
 * 2. Creates Admin / Manager / Agent system roles for the tenant if missing.
 * 3. Assigns default permissions to each system role.
 * 4. Backfills roleId for existing users in the tenant who don't have one.
 */
export async function ensureSystemPermissions(tenantId: string): Promise<void> {
  try {
    await _upsertSystemPermissions();
    await _ensureSystemRoles(tenantId);
    await _backfillUserRoles(tenantId);
  } catch (err) {
    logger.error('ensureSystemPermissions failed', { tenantId, error: (err as Error).message });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function _upsertSystemPermissions(): Promise<void> {
  const ops = SYSTEM_PERMISSIONS.map((p) => ({
    updateOne: {
      filter: { tenantId: null, key: p.key },
      update: {
        $setOnInsert: {
          tenantId:    null,
          key:         p.key,
          module:      p.module,
          resource:    p.resource,
          action:      p.action,
          label:       p.label,
          isSystem:    true,
          scope:       p.scope ?? 'platform',
          connectorId: null,
        },
      },
      upsert: true,
    },
  }));
  if (ops.length) await Permission.bulkWrite(ops, { ordered: false });
}

async function _ensureSystemRoles(tenantId: string): Promise<void> {
  const tidObj = new mongoose.Types.ObjectId(tenantId);

  const systemRoles: { name: string; description: string; perms: string[] }[] = [
    { name: 'Admin',   description: 'Full access to all features and settings', perms: ADMIN_PERMISSIONS   },
    { name: 'Manager', description: 'Access to core CRM and customer features', perms: MANAGER_PERMISSIONS },
    { name: 'Agent',   description: 'Basic access for daily operational tasks',  perms: AGENT_PERMISSIONS   },
  ];

  for (const sr of systemRoles) {
    // Create role if it doesn't exist
    let role = await Role.findOne({ tenantId: tidObj, name: sr.name });
    if (!role) {
      role = await Role.create({
        tenantId:    tidObj,
        name:        sr.name,
        description: sr.description,
        isSystem:    true,
        createdBy:   null,
      });
    }

    // Grant permissions (skip if already granted)
    await _grantPermissionsToRole(tenantId, (role._id as mongoose.Types.ObjectId).toString(), sr.perms);
  }
}

async function _grantPermissionsToRole(tenantId: string, roleId: string, permKeys: string[]): Promise<void> {
  const tidObj = new mongoose.Types.ObjectId(tenantId);
  const ridObj = new mongoose.Types.ObjectId(roleId);

  // Wildcard '*' — grant all system permissions
  let targetKeys = permKeys;
  if (permKeys.includes('*')) {
    const allPerms = await Permission.find({ tenantId: null }, 'key').lean();
    targetKeys = allPerms.map((p) => p.key);
  } else {
    // Expand wildcard entries like 'customers.*' → all customers.* keys
    const expanded: string[] = [];
    for (const k of permKeys) {
      if (k.endsWith('.*')) {
        const prefix = k.slice(0, -2);
        const matched = await Permission.find({ tenantId: null, key: new RegExp(`^${prefix}\\.`) }, 'key').lean();
        expanded.push(...matched.map((p) => p.key));
      } else {
        expanded.push(k);
      }
    }
    targetKeys = [...new Set(expanded)];
  }

  // Look up permission documents
  const permDocs = await Permission.find({ tenantId: null, key: { $in: targetKeys } }, '_id').lean();

  const ops = permDocs.map((perm) => ({
    updateOne: {
      filter: { roleId: ridObj, permissionId: perm._id },
      update: {
        $setOnInsert: {
          roleId:       ridObj,
          permissionId: perm._id,
          tenantId:     tidObj,
          grantedBy:    ridObj, // system grant — no real user
          grantedAt:    new Date(),
        },
      },
      upsert: true,
    },
  }));
  if (ops.length) await RolePermission.bulkWrite(ops, { ordered: false });
}

async function _backfillUserRoles(tenantId: string): Promise<void> {
  // Lazy import to avoid circular deps
  const { User } = await import('../auth/auth.model');
  const tidObj = new mongoose.Types.ObjectId(tenantId);

  const roleMap: Record<string, string | null> = {};
  for (const roleName of ['Admin', 'Manager', 'Agent']) {
    const r = await Role.findOne({ tenantId: tidObj, name: roleName }, '_id').lean();
    if (r) roleMap[roleName] = (r._id as mongoose.Types.ObjectId).toString();
  }

  const legacyToSystem: Record<string, string> = {
    TENANT_ADMIN: 'Admin',
    MANAGER:      'Manager',
    AGENT:        'Agent',
    USER:         'Agent',
  };

  const usersWithoutRole = await User.find({ tenantId: tidObj, roleId: null, role: { $ne: 'SUPER_ADMIN' } }, '_id role').lean();
  for (const u of usersWithoutRole) {
    const systemRoleName = legacyToSystem[u.role as string];
    const systemRoleId   = systemRoleName ? roleMap[systemRoleName] : null;
    if (systemRoleId) {
      await User.findByIdAndUpdate(u._id, { roleId: new mongoose.Types.ObjectId(systemRoleId) });
    }
  }
}
