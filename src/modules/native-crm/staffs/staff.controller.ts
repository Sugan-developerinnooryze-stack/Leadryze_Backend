import { Response } from 'express';
import mongoose from 'mongoose';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError, sendCreated, sendPaginated } from '../../../utils/response';
import { listStaffs, getStaffById, createStaff, updateStaff, deleteStaff } from './staff.service';
import { NativeStaff } from './staff.model';
import { getSettings } from '../fs-settings/fs-settings.service';
import { transformPIIResponse } from '../../../platform/pii/pii.service';

async function getPIIViewRoles(tenantId: string, branchId?: string | null): Promise<string[]> {
  const settings = await getSettings(tenantId, branchId ?? null).catch(() => null);
  return (settings as any)?.piiConfig?.find((p: any) => p.module === 'staffs')?.viewRoles ?? [];
}

export async function list(req: AuthRequest, res: Response) {
  try {
    const { items, total, page } = await listStaffs(req.tenantId!, req.query as any, req.branchId);
    const viewRoles = await getPIIViewRoles(req.tenantId!, req.branchId);
    const safeItems = transformPIIResponse(items, 'staffs', req.user!.role, viewRoles);
    sendPaginated(res, safeItems, total, page, Number(req.query.limit ?? 20));
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function getOne(req: AuthRequest, res: Response) {
  try {
    const item = await getStaffById(req.params.id, req.tenantId!);
    if (!item) return sendError(res, 'Staff not found', 404);
    const viewRoles = await getPIIViewRoles(req.tenantId!, req.branchId);
    sendSuccess(res, transformPIIResponse(item, 'staffs', req.user!.role, viewRoles));
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function create(req: AuthRequest, res: Response) {
  try {
    const item = await createStaff({
      ...req.body,
      tenantId:  req.tenantId!,
      branchId:  req.body.branchId ?? req.branchId ?? null,
      createdBy: req.user?.userId,
    });
    sendCreated(res, item);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

export async function update(req: AuthRequest, res: Response) {
  try {
    const item = await updateStaff(req.params.id, req.tenantId!, req.body);
    if (!item) return sendError(res, 'Staff not found', 404);
    sendSuccess(res, item);
  } catch (err: any) {
    sendError(res, err.message, 400);
  }
}

export async function remove(req: AuthRequest, res: Response) {
  try {
    const item = await deleteStaff(req.params.id, req.tenantId!);
    if (!item) return sendError(res, 'Staff not found', 404);
    sendSuccess(res, null, 'Deleted successfully');
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}

export async function updateLocation(req: AuthRequest, res: Response) {
  try {
    const { lat, lng } = req.body as { lat?: number; lng?: number };
    if (lat === undefined || lng === undefined) return sendError(res, 'lat and lng are required', 400);
    const tid  = new mongoose.Types.ObjectId(req.tenantId!);
    const item = await NativeStaff.findOneAndUpdate(
      { _id: req.params.id, tenantId: tid },
      { location: { lat, lng, updatedAt: new Date() } },
      { new: true }
    );
    if (!item) return sendError(res, 'Staff not found', 404);
    sendSuccess(res, item);
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
}
