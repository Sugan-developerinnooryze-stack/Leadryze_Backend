import { Router, Response } from 'express';
import { authenticate } from '../../middlewares/auth.middleware';
import { requireTenant } from '../../middlewares/tenant.middleware';
import { AuthRequest } from '../../types';
import { sendSuccess, sendError } from '../../utils/response';
import { NATIVE_MODULES, NativeModule } from './native-crm.config';
import {
  listRecords, getRecord, createRecord,
  updateRecord, deleteRecord, getModuleCounts,
} from './native-crm.service';
import { getLockStatus } from './record-lock/record-lock.service';

const router = Router();
router.use(authenticate, requireTenant);

function isValidModule(m: string): m is NativeModule {
  return NATIVE_MODULES.includes(m as NativeModule);
}

/* ── GET /modules — counts per module ──────────────────────────────────────── */
router.get('/modules', async (req: AuthRequest, res: Response) => {
  try {
    const counts = await getModuleCounts(req.tenantId!);
    sendSuccess(res, counts);
  } catch {
    sendError(res, 'Failed to fetch module counts', 500);
  }
});

/* ── GET /:module — list records ────────────────────────────────────────────── */
router.get('/:module', async (req: AuthRequest, res: Response) => {
  if (!isValidModule(req.params.module)) { sendError(res, 'Invalid module', 400); return; }
  try {
    const page   = Math.max(1, parseInt(String(req.query.page  || '1')));
    const limit  = Math.min(100, parseInt(String(req.query.limit || '20')));
    const search = req.query.search as string | undefined;
    const status = req.query.status as string | undefined;
    const result = await listRecords(req.tenantId!, req.params.module, { page, limit, search, status });
    sendSuccess(res, result.items, 'Success', 200, { total: result.total, page: result.page, totalPages: result.pages });
  } catch {
    sendError(res, 'Failed to fetch records', 500);
  }
});

/* ── POST /:module — create ─────────────────────────────────────────────────── */
router.post('/:module', async (req: AuthRequest, res: Response) => {
  if (!isValidModule(req.params.module)) { sendError(res, 'Invalid module', 400); return; }
  try {
    const record = await createRecord(req.tenantId!, req.params.module, req.body);
    res.status(201).json({ success: true, data: record });
  } catch {
    sendError(res, 'Failed to create record', 500);
  }
});

/* ── GET /:module/:id — get one ─────────────────────────────────────────────── */
router.get('/:module/:id', async (req: AuthRequest, res: Response) => {
  if (!isValidModule(req.params.module)) { sendError(res, 'Invalid module', 400); return; }
  try {
    const record = await getRecord(req.tenantId!, req.params.module, req.params.id);
    if (!record) { sendError(res, 'Not found', 404); return; }
    sendSuccess(res, record);
  } catch {
    sendError(res, 'Failed to fetch record', 500);
  }
});

/* ── PUT /:module/:id — update ──────────────────────────────────────────────── */
router.put('/:module/:id', async (req: AuthRequest, res: Response) => {
  if (!isValidModule(req.params.module)) { sendError(res, 'Invalid module', 400); return; }
  try {
    const ADMIN_ROLES = ['SUPER_ADMIN', 'TENANT_ADMIN'];
    if (!ADMIN_ROLES.includes(req.user?.role ?? '')) {
      const lockStatus = await getLockStatus(req.tenantId!, req.params.module, req.params.id);
      if (lockStatus.isLocked) {
        sendError(res, `This record is locked: "${lockStatus.lockReason}". Contact an administrator to unlock.`, 423);
        return;
      }
    }
    const record = await updateRecord(req.tenantId!, req.params.module, req.params.id, req.body);
    if (!record) { sendError(res, 'Not found', 404); return; }
    sendSuccess(res, record);
  } catch {
    sendError(res, 'Failed to update record', 500);
  }
});

/* ── DELETE /:module/:id — delete ──────────────────────────────────────────── */
router.delete('/:module/:id', async (req: AuthRequest, res: Response) => {
  if (!isValidModule(req.params.module)) { sendError(res, 'Invalid module', 400); return; }
  try {
    const ADMIN_ROLES = ['SUPER_ADMIN', 'TENANT_ADMIN'];
    if (!ADMIN_ROLES.includes(req.user?.role ?? '')) {
      const lockStatus = await getLockStatus(req.tenantId!, req.params.module, req.params.id);
      if (lockStatus.isLocked) {
        sendError(res, `This record is locked: "${lockStatus.lockReason}". Contact an administrator to unlock.`, 423);
        return;
      }
    }
    const ok = await deleteRecord(req.tenantId!, req.params.module, req.params.id);
    if (!ok) { sendError(res, 'Not found', 404); return; }
    sendSuccess(res, null, 'Deleted');
  } catch {
    sendError(res, 'Failed to delete record', 500);
  }
});

export default router;
