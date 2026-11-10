import { Response } from 'express';
import { AuthRequest, DataScope } from '../../../types';
import { sendSuccess, sendError, sendCreated } from '../../../utils/response';
import * as svc from './contact.service';
import { getSettings } from '../fs-settings/fs-settings.service';
import { transformPIIResponse } from '../../../platform/pii/pii.service';
import { resolveEffectiveScope } from '../shared/data-scope';
import { findDuplicateContact } from '../shared/duplicate-check';
import { Contact } from './contact.model';

async function getPIIViewRoles(tenantId: string, branchId?: string | null): Promise<string[]> {
  const settings = await getSettings(tenantId, branchId ?? null).catch(() => null);
  return (settings as any)?.piiConfig?.find((p: any) => p.module === 'contacts')?.viewRoles ?? [];
}

/** LR-C4-PERM-003: the owner values the Contacts list already matches for
 * this user (their userId, "First Last" and User.name), so a contact the
 * list shows a Manager or Agent also opens, saves and deletes, and the KPI
 * counts it. An unscoped role (Tenant Admin) needs none. */
async function ownerValuesFor(req: AuthRequest, scope: DataScope): Promise<string[] | undefined> {
  return scope.kind === 'all' ? undefined : svc.contactOwnerValues(req.user?.userId);
}

export async function list(req: AuthRequest, res: Response) {
  try {
    const { page, limit, search, status, owner, sortBy, sortDir, companyId } = req.query as Record<string, string>;
    const ownerTab = owner === 'my' || owner === 'unassigned' ? owner : undefined;
    const result = await svc.listContacts(req.tenantId!, {
      page: parseInt(page || '1'), limit: Math.min(parseInt(limit || '20'), 100), search, status, ownerTab,
      sortBy, sortDir: sortDir as 'asc' | 'desc' | undefined,
      ...(companyId ? { companyId } : {}),
    }, req.branchId, resolveEffectiveScope(req, 'contacts'), req.user!.userId);
    const viewRoles = await getPIIViewRoles(req.tenantId!, req.branchId);
    const safeItems = transformPIIResponse(result.items, 'contacts', req.user!.role, viewRoles);
    sendSuccess(res, safeItems, 'Success', 200, { total: result.total, page: result.page, totalPages: result.pages });
  } catch { sendError(res, 'Failed to fetch contacts', 500); }
}

export async function getOne(req: AuthRequest, res: Response) {
  try {
    const scope = resolveEffectiveScope(req, 'contacts');
    const record = await svc.getContactById(req.tenantId!, req.params.id, scope, await ownerValuesFor(req, scope));
    if (!record) return void sendError(res, 'Contact not found', 404);
    const viewRoles = await getPIIViewRoles(req.tenantId!, req.branchId);
    sendSuccess(res, transformPIIResponse(record, 'contacts', req.user!.role, viewRoles));
  } catch { sendError(res, 'Failed to fetch contact', 500); }
}

export async function create(req: AuthRequest, res: Response) {
  try {
    // LR-CONTACT-003: flag (never block, per LR-IMP-001) an exact
    // email/phone match against an existing contact.
    const duplicate = await findDuplicateContact(Contact, req.tenantId!, req.body);
    const record = await svc.createContact(req.tenantId!, { ...req.body, branchId: req.body.branchId ?? req.branchId ?? null, createdBy: req.user!.userId });
    const viewRoles = await getPIIViewRoles(req.tenantId!, req.branchId);
    const safeRecord = transformPIIResponse(record, 'contacts', req.user!.role, viewRoles);
    sendCreated(res, { ...safeRecord, duplicateWarning: duplicate }, 'Contact created');
  } catch (err: any) {
    // LR-R26-USER-007: e.g. "Contact owner must be an active user".
    if (err?.statusCode === 400) return void sendError(res, err.message, 400);
    sendError(res, 'Failed to create contact', 500);
  }
}

export async function update(req: AuthRequest, res: Response) {
  try {
    const scope = resolveEffectiveScope(req, 'contacts');
    const record = await svc.updateContact(req.tenantId!, req.params.id, req.body, scope, await ownerValuesFor(req, scope));
    if (!record) return void sendError(res, 'Contact not found', 404);
    const viewRoles = await getPIIViewRoles(req.tenantId!, req.branchId);
    const safeRecord = transformPIIResponse(record, 'contacts', req.user!.role, viewRoles);
    sendSuccess(res, safeRecord, 'Contact updated');
  } catch (err: any) {
    // LR-NEG-001: see lead.controller.ts's identical comment.
    if (err?.name === 'VersionError') {
      sendError(res, 'This contact was changed by someone else — please reload and try again.', 409);
      return;
    }
    if (err?.statusCode === 400) return void sendError(res, err.message, 400); // LR-R26-USER-007
    sendError(res, 'Failed to update contact', 500);
  }
}

export async function remove(req: AuthRequest, res: Response) {
  try {
    const scope = resolveEffectiveScope(req, 'contacts');
    const ok = await svc.deleteContact(req.tenantId!, req.params.id, scope, undefined, await ownerValuesFor(req, scope));
    if (!ok) return void sendError(res, 'Contact not found', 404);
    sendSuccess(res, null, 'Contact deleted');
  } catch (err: any) {
    const status = err.statusCode ?? (err.message?.includes('Cannot delete') ? 409 : 500);
    sendError(res, err.message ?? 'Failed to delete contact', status);
  }
}

export async function stats(req: AuthRequest, res: Response) {
  try {
    const scope = resolveEffectiveScope(req, 'contacts');
    sendSuccess(res, await svc.getContactStats(req.tenantId!, scope, await ownerValuesFor(req, scope)));
  }
  catch { sendError(res, 'Failed to fetch stats', 500); }
}
