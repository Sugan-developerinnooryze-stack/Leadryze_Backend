import { Response } from 'express';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError, sendCreated } from '../../../utils/response';
import * as svc from './company.service';

export async function list(req: AuthRequest, res: Response) {
  try {
    const { page, limit, search, status } = req.query as Record<string, string>;
    const result = await svc.listCompanies(req.tenantId!, {
      page: parseInt(page || '1'), limit: Math.min(parseInt(limit || '20'), 100), search, status,
    });
    sendSuccess(res, result.items, 'Success', 200, { total: result.total, page: result.page, totalPages: result.pages });
  } catch { sendError(res, 'Failed to fetch companies', 500); }
}

export async function getOne(req: AuthRequest, res: Response) {
  try {
    const record = await svc.getCompanyById(req.tenantId!, req.params.id);
    if (!record) return void sendError(res, 'Company not found', 404);
    sendSuccess(res, record);
  } catch { sendError(res, 'Failed to fetch company', 500); }
}

export async function create(req: AuthRequest, res: Response) {
  try {
    const record = await svc.createCompany(req.tenantId!, req.body);
    sendCreated(res, record, 'Company created');
  } catch { sendError(res, 'Failed to create company', 500); }
}

export async function update(req: AuthRequest, res: Response) {
  try {
    const record = await svc.updateCompany(req.tenantId!, req.params.id, req.body);
    if (!record) return void sendError(res, 'Company not found', 404);
    sendSuccess(res, record, 'Company updated');
  } catch { sendError(res, 'Failed to update company', 500); }
}

export async function remove(req: AuthRequest, res: Response) {
  try {
    const ok = await svc.deleteCompany(req.tenantId!, req.params.id);
    if (!ok) return void sendError(res, 'Company not found', 404);
    sendSuccess(res, null, 'Company deleted');
  } catch { sendError(res, 'Failed to delete company', 500); }
}

export async function stats(req: AuthRequest, res: Response) {
  try { sendSuccess(res, await svc.getCompanyStats(req.tenantId!)); }
  catch { sendError(res, 'Failed to fetch stats', 500); }
}
