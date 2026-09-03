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
  ...(['contacts', 'leads', 'deals', 'tasks', 'meetings', 'calendar', 'notes', 'companies', 'activities', 'tickets', 'calls'] as const).flatMap(
    (mod) => ([
      { key: `native_crm.${mod}.view`,   module: 'native_crm', resource: mod, action: 'view',   label: `CRM ${mod} — View`   },
      { key: `native_crm.${mod}.create`, module: 'native_crm', resource: mod, action: 'create', label: `CRM ${mod} — Create` },
      { key: `native_crm.${mod}.edit`,   module: 'native_crm', resource: mod, action: 'edit',   label: `CRM ${mod} — Edit`   },
      { key: `native_crm.${mod}.delete`, module: 'native_crm', resource: mod, action: 'delete', label: `CRM ${mod} — Delete` },
      { key: `native_crm.${mod}.export`, module: 'native_crm', resource: mod, action: 'export', label: `CRM ${mod} — Export` },
    ])
  ),

  // One-off Ticket SLA policy permission — the flatMap above only generates
  // view/create/edit/delete/export, not this custom action.
  { key: 'native_crm.tickets.manage_sla', module: 'native_crm', resource: 'tickets', action: 'manage_sla', label: 'CRM Tickets — Manage SLA Policy' },

  // Field Service modules
  // 'datasets' added after dataset.routes.ts's own requirePermission()
  // calls (fs.datasets.*) were found to reference a key that never existed
  // here — every non-admin role was silently 403ing on the whole module.
  ...(['workorders', 'quotations', 'contracts', 'invoices', 'receipts', 'expenses',
       'customers', 'sites', 'teams', 'staffs', 'parts', 'categories', 'services',
       'products', 'assets', 'vehicles', 'activities', 'catalog', 'datasets'] as const).flatMap(
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

  // Custom Modules — split in two: 'definitions' is the module BUILDER
  // (schema design — create/edit/delete a module's own fields), kept
  // admin/manager-only like fs.custom_fields.manage above; 'records' is the
  // actual DATA within a module (e.g. a tenant's own "Site Visit Reports"
  // entries) — genuinely day-to-day operational data, not config, so it
  // follows the Companies/Deals/Tickets/Calls precedent below instead.
  { key: 'custom_modules.definitions.view',   module: 'custom_modules', resource: 'definitions', action: 'view',   label: 'Custom Modules — View Definitions'   },
  { key: 'custom_modules.definitions.manage', module: 'custom_modules', resource: 'definitions', action: 'manage', label: 'Custom Modules — Manage Definitions' },
  { key: 'custom_modules.records.view',       module: 'custom_modules', resource: 'records',     action: 'view',   label: 'Custom Modules — View Records'       },
  { key: 'custom_modules.records.create',     module: 'custom_modules', resource: 'records',     action: 'create', label: 'Custom Modules — Create Records'     },
  { key: 'custom_modules.records.edit',       module: 'custom_modules', resource: 'records',     action: 'edit',   label: 'Custom Modules — Edit Records'       },
  { key: 'custom_modules.records.delete',     module: 'custom_modules', resource: 'records',     action: 'delete', label: 'Custom Modules — Delete Records'     },

  // Automation Flows (Advanced Mode workflow builder) — deliberately its own
  // tier rather than folded into native_crm.* or fs.*: a workflow can send
  // messages and create/mutate records across every other module, so it's
  // more powerful than editing a normal record and is gated more tightly
  // (Manager+ for day-to-day authoring, Admin-only for publish/delete).
  { key: 'automation.view',            module: 'automation', resource: 'flows',      action: 'view',            label: 'Automation — View Flows'       },
  { key: 'automation.create',          module: 'automation', resource: 'flows',      action: 'create',          label: 'Automation — Create Flows'     },
  { key: 'automation.edit',            module: 'automation', resource: 'flows',      action: 'edit',            label: 'Automation — Edit Flows'       },
  { key: 'automation.delete',          module: 'automation', resource: 'flows',      action: 'delete',          label: 'Automation — Delete Flows'     },
  { key: 'automation.publish',         module: 'automation', resource: 'flows',      action: 'publish',         label: 'Automation — Publish Flows'    },
  { key: 'automation.execute',         module: 'automation', resource: 'flows',      action: 'execute',         label: 'Automation — Test/Execute Flows' },
  { key: 'automation.view_executions', module: 'automation', resource: 'executions', action: 'view_executions', label: 'Automation — View Execution History' },
  // Phase 5 emergency kill switch — tenant-wide "stop all automation right
  // now," strictly more consequential than publish/delete (those affect one
  // flow; this affects every flow AND every Simple Mode rule at once), so
  // it gets the same Admin-only treatment (excluded from MANAGER_PERMISSIONS
  // below, falls to Admin-only via the '*' wildcard) rather than Manager access.
  { key: 'automation.manage_settings', module: 'automation', resource: 'settings',   action: 'manage',          label: 'Automation — Manage Settings (Kill Switch)' },

  // Tenant-wide configuration surfaces found with ZERO requirePermission()
  // coverage in the Phase 4 RBAC audit (any authenticated user of any role
  // previously had full access) — admin/manager-only, same posture as
  // fs.settings/fs.custom_fields above, since these affect every user in
  // the tenant, not just the editor's own records.
  { key: 'pipeline_config.view',        module: 'pipeline_config',        resource: 'stages',   action: 'view',   label: 'Pipeline Config — View'   },
  { key: 'pipeline_config.manage',      module: 'pipeline_config',        resource: 'stages',   action: 'manage', label: 'Pipeline Config — Manage' },
  { key: 'doc_templates.view',          module: 'doc_templates',          resource: 'templates', action: 'view',   label: 'Document Templates — View'   },
  { key: 'doc_templates.manage',        module: 'doc_templates',          resource: 'templates', action: 'manage', label: 'Document Templates — Manage' },
  { key: 'notification_settings.view',   module: 'notification_settings', resource: 'settings',  action: 'view',   label: 'Notification Settings — View'   },
  { key: 'notification_settings.manage', module: 'notification_settings', resource: 'settings',  action: 'manage', label: 'Notification Settings — Manage' },
  { key: 'form_templates.view',         module: 'form_templates',         resource: 'templates', action: 'view',   label: 'Form Templates — View'   },
  { key: 'form_templates.manage',       module: 'form_templates',         resource: 'templates', action: 'manage', label: 'Form Templates — Manage' },
  { key: 'workflow_templates.view',     module: 'workflow_templates',     resource: 'templates', action: 'view',   label: 'Workflow Templates — View'   },
  { key: 'workflow_templates.manage',   module: 'workflow_templates',     resource: 'templates', action: 'manage', label: 'Workflow Templates — Manage' },
  // Read-only, tied to records the viewer can already reasonably see
  // elsewhere (an activity feed or timeline entry only ever surfaces on a
  // record's own detail page) — granted broadly rather than Manager-only.
  { key: 'activity_feed.view',          module: 'activity_feed',          resource: 'feed',      action: 'view',   label: 'Activity Feed — View' },
  { key: 'timeline.view',               module: 'timeline',               resource: 'timeline',  action: 'view',   label: 'Timeline — View'      },
  // Branches/Record Lock previously used a hardcoded authorize('SUPER_ADMIN',
  // 'TENANT_ADMIN') for mutations (now requirePermission('*.manage'), same
  // posture, not loosened) and had NO check at all on several GET routes
  // (now '*.view', granted more broadly since the branch-filter dropdown and
  // record-lock status banners are used tenant-wide, including by Agents).
  { key: 'branches.view',               module: 'branches',               resource: 'branches',  action: 'view',   label: 'Branches — View'   },
  { key: 'branches.manage',             module: 'branches',               resource: 'branches',  action: 'manage', label: 'Branches — Manage' },
  { key: 'record_lock.view',            module: 'record_lock',            resource: 'locks',      action: 'view',   label: 'Record Lock — View'   },
  { key: 'record_lock.manage',          module: 'record_lock',            resource: 'locks',      action: 'manage', label: 'Record Lock — Manage' },
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
  'custom_modules.*',
  // publish/delete deliberately excluded — Admin-only, per this section's
  // own comment on why Automation Flows are gated tighter than a normal
  // record: a Manager can author/test a flow but not put it live or remove
  // one outright.
  'automation.view', 'automation.create', 'automation.edit',
  'automation.execute', 'automation.view_executions',
  'pipeline_config.*', 'doc_templates.*', 'notification_settings.*',
  'form_templates.*', 'workflow_templates.*',
  'activity_feed.view', 'timeline.view',
  // .manage stays out — same admin-only posture the prior authorize()
  // hardcode already enforced for branch/lock mutations.
  'branches.view', 'record_lock.view',
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
  // Added when native_crm.leads/meetings/fs.customers/fs.teams/fs.staffs
  // permission checks were first actually wired up on their routes — this
  // one, specifically, mirrors the legacy 'customers.view' grant just above
  // (the same concept, the native-crm Customers module) so an existing
  // Agent isn't unexpectedly locked out of a Customer view they already had
  // access to under the old, unenforced grant. fs.teams.*/fs.staffs.* are
  // deliberately NOT added here — those were never granted to Agents even
  // before enforcement existed, so this is enforcement catching up to
  // already-expressed intent, not a new restriction.
  'fs.customers.view',
  // Added when Companies/Deals/Tickets/Calls first got a real
  // requirePermission gate (previously wide open to any authenticated
  // user) — mirrors the exact same view/create/edit level already granted
  // to Contacts/Tasks above, so an existing Agent isn't unexpectedly locked
  // out of routine day-to-day CRM work they could already freely do. The
  // fs.* catalog/asset/vehicle/site/receipt/expense/activity/product
  // modules deliberately stay Manager+Admin-only for Agent, same posture
  // as fs.teams.*/fs.staffs.* above — those are configuration/reference/
  // financial data, not an Agent's own day-to-day record-keeping.
  'native_crm.companies.view', 'native_crm.companies.create', 'native_crm.companies.edit',
  'native_crm.deals.view',     'native_crm.deals.create',     'native_crm.deals.edit',
  'native_crm.tickets.view',   'native_crm.tickets.create',   'native_crm.tickets.edit',
  'native_crm.calls.view',     'native_crm.calls.create',     'native_crm.calls.edit',
  // Added when Custom Module records first got a real requirePermission gate
  // (previously wide open to any authenticated user, same starting point as
  // Companies/Deals/Tickets/Calls above) — same view/create/edit tier, no
  // delete, matching that exact precedent. Module BUILDING (definitions.*)
  // deliberately stays Manager+Admin-only, same posture as fs.custom_fields.
  'custom_modules.records.view', 'custom_modules.records.create', 'custom_modules.records.edit',
  // Read-only and tied to whatever record the Agent is already viewing (the
  // Activity/Timeline tabs on a Contract/Customer/Deal detail page) — not
  // granting these would break tabs Agents already use day to day.
  // Branches/Record Lock .view mirror the same "was unenforced, don't make
  // it MORE restrictive than it already was" reasoning as fs.customers.view
  // above — an Agent could already list branches / see lock status before
  // enforcement existed.
  'activity_feed.view', 'timeline.view', 'branches.view', 'record_lock.view',
  // pipeline_config.view: read-only stage labels rendered on nearly every
  // module page (Leads/Deals/Tasks/Tickets/etc, via usePipelineStages) —
  // without it, an Agent viewing a tenant that renamed its stages would
  // silently fall back to hardcoded default labels instead of the real
  // configured ones. form_templates.view: needed to render the correct
  // form when creating/editing a Custom Module record, which Agent already
  // has data-level access to above (custom_modules.records.*).
  'pipeline_config.view', 'form_templates.view',
  // fs.custom_fields.view: Lead/Deal create/edit forms render tenant-defined
  // custom fields via CustomFieldRenderer (useCustomFieldsQuery) — without
  // this, an Agent's Lead/Deal forms would silently hide any custom field
  // the tenant configured, even though Agent already has create/edit on
  // both of those modules above.
  'fs.custom_fields.view',
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
  const systemRoleIdSet = new Set<string>();
  for (const roleName of ['Admin', 'Manager', 'Agent']) {
    const r = await Role.findOne({ tenantId: tidObj, name: roleName }, '_id').lean();
    if (r) {
      const id = (r._id as mongoose.Types.ObjectId).toString();
      roleMap[roleName] = id;
      systemRoleIdSet.add(id);
    }
  }

  const legacyToSystem: Record<string, string> = {
    TENANT_ADMIN: 'Admin',
    MANAGER:      'Manager',
    AGENT:        'Agent',
    USER:         'Agent',
  };

  // Two cases get repaired here, not just one: (1) roleId was never set at
  // all, and (2) roleId is set but DANGLING — points at a Role document
  // that no longer exists for this tenant (e.g. left behind by an earlier
  // role reseed/migration). Case (2) would otherwise silently deny every
  // permission check forever, since requirePermission() fails closed on an
  // unresolvable roleId and this backfill's own original query (roleId:
  // null) never matched a non-null-but-dangling value.
  const candidateUsers = await User.find(
    { tenantId: tidObj, role: { $ne: 'SUPER_ADMIN' } },
    '_id role roleId'
  ).lean();

  for (const u of candidateUsers) {
    const hasDanglingRoleId = u.roleId && !systemRoleIdSet.has(u.roleId.toString());
    // A dangling roleId might legitimately point at a real, still-existing
    // CUSTOM (non-system) role — only repair when it points at NOTHING.
    if (u.roleId && !hasDanglingRoleId) continue;
    if (u.roleId && hasDanglingRoleId) {
      const stillExists = await Role.exists({ _id: u.roleId, tenantId: tidObj });
      if (stillExists) continue;
    }

    const systemRoleName = legacyToSystem[u.role as string];
    const systemRoleId   = systemRoleName ? roleMap[systemRoleName] : null;
    if (systemRoleId) {
      await User.findByIdAndUpdate(u._id, { roleId: new mongoose.Types.ObjectId(systemRoleId) });
    }
  }
}
