import { Response, NextFunction } from 'express';
import mongoose, { Model } from 'mongoose';
import { AuthRequest } from '../types';
import { logger } from '../utils/logger';
import { NativeCrmLog } from '../modules/logs/native-crm-log.model';
import { resolveClientPrefix } from '../utils/client-id';

/* ── Model map — URL segment → Mongoose model ─────────────────────────────── */
import { NativeCustomer }  from '../modules/native-crm/customers/customer.model';
import { Lead }            from '../modules/native-crm/leads/lead.model';
import { Deal }            from '../modules/native-crm/deals/deal.model';
import { Contact }         from '../modules/native-crm/contacts/contact.model';
import { Company }         from '../modules/native-crm/companies/company.model';
import { Task }            from '../modules/native-crm/tasks/task.model';
import { Ticket }          from '../modules/native-crm/tickets/ticket.model';
import { Call }            from '../modules/native-crm/calls/call.model';
import { Meeting }         from '../modules/native-crm/meetings/meeting.model';
import { NativeActivity }  from '../modules/native-crm/activities/activity.model';
import { NativeWorkorder } from '../modules/native-crm/workorders/workorder.model';
import { NativeQuotation } from '../modules/native-crm/quotations/quotation.model';
import { NativeContract }  from '../modules/native-crm/contracts/contract.model';
import { NativeInvoice }   from '../modules/native-crm/invoices/invoice.model';
import { NativeReceipt }   from '../modules/native-crm/receipts/receipt.model';
import { NativeExpense }   from '../modules/native-crm/expenses/expense.model';
import { NativePart }      from '../modules/native-crm/parts/part.model';
import { NativeService }   from '../modules/native-crm/services/service.model';
import { NativeCategory }  from '../modules/native-crm/categories/category.model';
import { NativeTeam }      from '../modules/native-crm/teams/team.model';
import { NativeStaff }     from '../modules/native-crm/staffs/staff.model';
import { NativeSite }      from '../modules/native-crm/sites/site.model';
import { NativeProduct }   from '../modules/native-crm/products/product.model';
import { NativeAsset }     from '../modules/native-crm/assets/asset.model';
import { NativeVehicle }   from '../modules/native-crm/vehicles/vehicle.model';
import { Branch }          from '../modules/native-crm/branches/branch.model';

export const MODULE_MODEL_MAP: Record<string, Model<any>> = {
  customers:  NativeCustomer,
  leads:      Lead,
  deals:      Deal,
  contacts:   Contact,
  companies:  Company,
  tasks:      Task,
  tickets:    Ticket,
  calls:      Call,
  meetings:   Meeting,
  activities: NativeActivity,
  workorders: NativeWorkorder,
  quotations: NativeQuotation,
  contracts:  NativeContract,
  invoices:   NativeInvoice,
  receipts:   NativeReceipt,
  expenses:   NativeExpense,
  parts:      NativePart,
  services:   NativeService,
  categories: NativeCategory,
  teams:      NativeTeam,
  staffs:     NativeStaff,
  sites:      NativeSite,
  products:   NativeProduct,
  assets:     NativeAsset,
  vehicles:   NativeVehicle,
  branches:   Branch,
};

const SKIP_MODULES = new Set([
  'fs-counts', 'stats', 'native-logs', 'timeline', 'pdf',
  'record-lock', 'workflow-templates', 'custom-form-templates',
  'custom-fields', 'custom-templates', 'fs-settings',
  // lead-capture IS its own audit trail (see LeadCapture's own doc comment)
  // — logging it a second time into this generic log would be pure noise,
  // same reasoning 'timeline' above is already skipped for.
  'lead-capture',
]);

const SENSITIVE_KEYS = new Set(['password', 'token', 'secret', 'apiKey', 'accessToken', 'refreshToken']);

export function sanitize(obj: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!obj || typeof obj !== 'object') return obj;
  const copy = { ...obj };
  for (const k of SENSITIVE_KEYS) { if (k in copy) copy[k] = '[REDACTED]'; }
  return copy;
}

export interface NativeCrmLogParams {
  tenantId: string;
  actorId: string;
  actorName: string;
  actorRole: string;
  action: 'create' | 'update' | 'delete' | 'error';
  module: string;
  resourceId: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  changes?: Record<string, unknown> | null;
  error?: string | null;
  statusCode?: number;
  ip?: string;
  url?: string;
}

/** The single place a NativeCrmLog document actually gets written — used by
 * this file's own Express middleware (below) for every human-driven write,
 * and reused as-is by the internal CRM-chat gateway (internal.routes.ts) so
 * a chatbot-driven write produces an audit entry that's byte-identical in
 * shape to a human one, not just similar. */
export async function writeNativeCrmLog(params: NativeCrmLogParams): Promise<void> {
  let clientId = '';
  if (params.tenantId && mongoose.Types.ObjectId.isValid(params.tenantId)) {
    clientId = await resolveClientPrefix(new mongoose.Types.ObjectId(params.tenantId)).catch(() => '') as string;
  }
  await NativeCrmLog.create({
    tenantId:   params.tenantId,
    clientId,
    actorId:    params.actorId,
    actorName:  params.actorName,
    actorRole:  params.actorRole,
    action:     params.action,
    module:     params.module,
    resourceId: params.resourceId,
    before:     params.action === 'error' ? null : sanitize(params.before ?? null),
    after:      params.action === 'error' ? null : sanitize(params.after ?? null),
    changes:    params.changes !== undefined ? sanitize(params.changes) : null,
    error:      params.error ?? null,
    statusCode: params.statusCode ?? 200,
    ip:         params.ip ?? 'unknown',
    url:        params.url ?? '',
    timestamp:  new Date(),
  });
}

function extractModule(path: string): string {
  // path looks like /customers/... or /customers (sub-router sees path without /native-crm prefix)
  const parts = path.split('/').filter(Boolean);
  return parts[0] ?? '';
}

function extractId(path: string): string {
  const parts = path.split('/').filter(Boolean);
  // Prefer a real ObjectId anywhere in the path (handles /staffs/:id/credentials)
  for (let i = parts.length - 1; i >= 1; i--) {
    if (/^[a-f0-9]{24}$/i.test(parts[i])) return parts[i];
  }
  // Start from index 1 — index 0 is always the module name, never an ID
  for (let i = parts.length - 1; i >= 1; i--) {
    if (/^[0-9a-zA-Z-]{6,}$/.test(parts[i])) return parts[i];
  }
  return '';
}

export async function nativeCrmLog(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  // Only log write operations
  if (req.method === 'GET' || req.method === 'OPTIONS' || req.method === 'HEAD') {
    next();
    return;
  }

  const module = extractModule(req.path);
  if (!module || SKIP_MODULES.has(module)) {
    next();
    return;
  }

  // Dry-run endpoints write nothing — logging them would only produce noise
  if (req.path.includes('/schedule-preview')) {
    next();
    return;
  }

  const urlParamId = extractId(req.path);

  // For updates: fetch state before modification
  let beforeState: Record<string, unknown> | null = null;
  if ((req.method === 'PUT' || req.method === 'PATCH') && urlParamId) {
    const Model = MODULE_MODEL_MAP[module];
    if (Model) {
      beforeState = await Model.findById(urlParamId).lean().catch(() => null) as Record<string, unknown> | null;
    }
  }
  // For deletes: also capture the state before deletion
  if (req.method === 'DELETE' && urlParamId) {
    const Model = MODULE_MODEL_MAP[module];
    if (Model) {
      beforeState = await Model.findById(urlParamId).lean().catch(() => null) as Record<string, unknown> | null;
    }
  }

  // Capture response body by patching res.json
  let responseBody: any;
  const originalJson = res.json.bind(res);
  res.json = (body: any) => {
    responseBody = body;
    return originalJson(body);
  };

  res.on('finish', () => {
    // Fire async — never blocks the response
    (async () => {
      try {
        const method = req.method;
        const statusCode = res.statusCode;
        const isError = statusCode >= 400;

        let action: 'create' | 'update' | 'delete' | 'error';
        if (isError) {
          action = 'error';
        } else if (method === 'POST') {
          action = 'create';
        } else if (method === 'PUT' || method === 'PATCH') {
          action = 'update';
        } else {
          action = 'delete';
        }

        // For errors also write to Winston so server log has the entry
        if (isError) {
          logger.error('NativeCRM API error', {
            module,
            method,
            path: req.originalUrl,
            statusCode,
            actorId: req.user?.userId,
            message: responseBody?.message,
          });
        }

        const responseData = responseBody?.data ?? null;
        const resourceId = urlParamId
          || (responseData?._id ? String(responseData._id) : '')
          || (responseData?.recordId ? String(responseData.recordId) : '');

        const afterState: Record<string, unknown> | null =
          (action === 'create' || action === 'update') && responseData && typeof responseData === 'object'
            ? (responseData as Record<string, unknown>)
            : null;

        const actor = req.user;
        const actorName = actor?.email ?? actor?.userId ?? 'anonymous';

        await writeNativeCrmLog({
          tenantId:   req.tenantId ?? 'unknown',
          actorId:    actor?.userId  ?? 'anonymous',
          actorName,
          actorRole:  actor?.role    ?? '',
          action,
          module,
          resourceId,
          before:   beforeState,
          after:    afterState,
          changes:  (action === 'update' && req.body && typeof req.body === 'object')
            ? (req.body as Record<string, unknown>)
            : null,
          error:      isError ? (responseBody?.message ?? `HTTP ${statusCode}`) : null,
          statusCode,
          ip:         req.ip || req.socket?.remoteAddress || 'unknown',
          url:        req.originalUrl,
        });
      } catch {
        // Logging must never crash the app
      }
    })();
  });

  next();
}
