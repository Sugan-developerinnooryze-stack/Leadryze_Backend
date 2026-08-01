import { Response } from 'express';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError, sendCreated, sendPaginated } from '../../../utils/response';
import {
  listCatalogItems, getCatalogItemById, createCatalogItem, updateCatalogItem, deleteCatalogItem,
  importCatalogRows,
} from './catalog-item.service';
import { KnowledgeSource } from './knowledge-source.model';

export async function list(req: AuthRequest, res: Response) {
  try {
    const { items, total, page } = await listCatalogItems(req.tenantId!, req.query as any, req.branchId);
    sendPaginated(res, items, total, page, Number(req.query.limit ?? 20));
  } catch (err: any) { sendError(res, err.message, 500); }
}
export async function getOne(req: AuthRequest, res: Response) {
  try {
    const item = await getCatalogItemById(req.params.id, req.tenantId!);
    if (!item) return sendError(res, 'Catalog item not found', 404);
    sendSuccess(res, item);
  } catch (err: any) { sendError(res, err.message, 500); }
}
export async function create(req: AuthRequest, res: Response) {
  try {
    const item = await createCatalogItem({
      ...req.body, source: 'manual',
      tenantId: req.tenantId!, branchId: req.body.branchId ?? req.branchId ?? null,
    });
    sendCreated(res, item);
  } catch (err: any) { sendError(res, err.message, 400); }
}
export async function update(req: AuthRequest, res: Response) {
  try {
    const item = await updateCatalogItem(req.params.id, req.tenantId!, req.body);
    if (!item) return sendError(res, 'Catalog item not found', 404);
    sendSuccess(res, item);
  } catch (err: any) { sendError(res, err.message, 400); }
}
export async function remove(req: AuthRequest, res: Response) {
  try {
    const item = await deleteCatalogItem(req.params.id, req.tenantId!);
    if (!item) return sendError(res, 'Catalog item not found', 404);
    sendSuccess(res, null, 'Deleted successfully');
  } catch (err: any) { sendError(res, err.message, 500); }
}

export async function importRows(req: AuthRequest, res: Response) {
  try {
    const { fileType, fileLabel, rows } = req.body;
    const summary = await importCatalogRows(req.tenantId!, fileType, fileLabel, rows);
    sendCreated(res, summary, 'Catalog import complete');
  } catch (err: any) { sendError(res, err.message, 400); }
}

export async function listSources(req: AuthRequest, res: Response) {
  try {
    const sources = await KnowledgeSource.find({ tenantId: req.tenantId! }).sort({ updatedAt: -1 });
    sendSuccess(res, sources);
  } catch (err: any) { sendError(res, err.message, 500); }
}
