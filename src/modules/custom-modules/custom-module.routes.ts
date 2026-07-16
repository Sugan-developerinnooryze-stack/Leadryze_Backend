import { Router, Response } from 'express';
import { authenticate } from '../../middlewares/auth.middleware';
import { requireTenant } from '../../middlewares/tenant.middleware';
import { AuthRequest } from '../../types';
import { sendSuccess, sendError } from '../../utils/response';
import {
  listCustomModules,
  getCustomModuleBySlug,
  getCustomModuleById,
  createCustomModule,
  updateCustomModule,
  deleteCustomModule,
  listCustomRecords,
  getCustomRecord,
  createCustomRecord,
  updateCustomRecord,
  deleteCustomRecord,
} from './custom-module.service';

const router = Router();
router.use(authenticate, requireTenant);

/* ── Module Definition CRUD ───────────────────────────────────────────────── */

// GET /api/v1/custom-modules
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const mods = await listCustomModules(req.tenantId!);
    sendSuccess(res, mods);
  } catch {
    sendError(res, 'Failed to fetch custom modules', 500);
  }
});

// POST /api/v1/custom-modules
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    if (!req.body.name) { sendError(res, 'name is required', 400); return; }
    const mod = await createCustomModule(req.tenantId!, req.body);
    res.status(201).json({ success: true, data: mod });
  } catch {
    sendError(res, 'Failed to create custom module', 500);
  }
});

// GET /api/v1/custom-modules/by-slug/:slug  (before /:id to avoid collision)
router.get('/by-slug/:slug', async (req: AuthRequest, res: Response) => {
  try {
    const mod = await getCustomModuleBySlug(req.tenantId!, req.params.slug);
    if (!mod) { sendError(res, 'Module not found', 404); return; }
    sendSuccess(res, mod);
  } catch {
    sendError(res, 'Failed to fetch custom module', 500);
  }
});

// GET /api/v1/custom-modules/:id
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const mod = await getCustomModuleById(req.tenantId!, req.params.id);
    if (!mod) { sendError(res, 'Module not found', 404); return; }
    sendSuccess(res, mod);
  } catch {
    sendError(res, 'Failed to fetch custom module', 500);
  }
});

// PUT /api/v1/custom-modules/:id
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const mod = await updateCustomModule(req.tenantId!, req.params.id, req.body);
    if (!mod) { sendError(res, 'Module not found', 404); return; }
    sendSuccess(res, mod);
  } catch {
    sendError(res, 'Failed to update custom module', 500);
  }
});

// DELETE /api/v1/custom-modules/:id
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const ok = await deleteCustomModule(req.tenantId!, req.params.id);
    if (!ok) { sendError(res, 'Module not found', 404); return; }
    sendSuccess(res, null, 'Deleted');
  } catch {
    sendError(res, 'Failed to delete custom module', 500);
  }
});

/* ── Record CRUD (per module slug) ───────────────────────────────────────── */

// GET /api/v1/custom-modules/:slug/records
router.get('/:slug/records', async (req: AuthRequest, res: Response) => {
  try {
    const page   = Math.max(1, parseInt(String(req.query.page  || '1')));
    const limit  = Math.min(100, parseInt(String(req.query.limit || '20')));
    const search = req.query.search as string | undefined;
    const result = await listCustomRecords(req.tenantId!, req.params.slug, { page, limit, search });
    sendSuccess(res, result.items, 'Success', 200, { total: result.total, page: result.page, totalPages: result.pages });
  } catch {
    sendError(res, 'Failed to fetch records', 500);
  }
});

// POST /api/v1/custom-modules/:slug/records
router.post('/:slug/records', async (req: AuthRequest, res: Response) => {
  try {
    const rec = await createCustomRecord(req.tenantId!, req.params.slug, req.body, req.user?.userId);
    res.status(201).json({ success: true, data: rec });
  } catch {
    sendError(res, 'Failed to create record', 500);
  }
});

// GET /api/v1/custom-modules/:slug/records/:id
router.get('/:slug/records/:id', async (req: AuthRequest, res: Response) => {
  try {
    const rec = await getCustomRecord(req.tenantId!, req.params.slug, req.params.id);
    if (!rec) { sendError(res, 'Record not found', 404); return; }
    sendSuccess(res, rec);
  } catch {
    sendError(res, 'Failed to fetch record', 500);
  }
});

// PUT /api/v1/custom-modules/:slug/records/:id
router.put('/:slug/records/:id', async (req: AuthRequest, res: Response) => {
  try {
    const rec = await updateCustomRecord(req.tenantId!, req.params.slug, req.params.id, req.body);
    if (!rec) { sendError(res, 'Record not found', 404); return; }
    sendSuccess(res, rec);
  } catch {
    sendError(res, 'Failed to update record', 500);
  }
});

// DELETE /api/v1/custom-modules/:slug/records/:id
router.delete('/:slug/records/:id', async (req: AuthRequest, res: Response) => {
  try {
    const ok = await deleteCustomRecord(req.tenantId!, req.params.slug, req.params.id);
    if (!ok) { sendError(res, 'Record not found', 404); return; }
    sendSuccess(res, null, 'Deleted');
  } catch {
    sendError(res, 'Failed to delete record', 500);
  }
});

export default router;
