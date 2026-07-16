import mongoose from 'mongoose';
import { Response, NextFunction } from 'express';
import { AuthRequest } from '../types';
import { sendError } from '../utils/response';
import { Branch } from '../modules/native-crm/branches/branch.model';

export async function resolveBranch(
  req: AuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const branchId = req.headers['x-branch-id'] as string | undefined;

  if (!branchId) {
    return next();
  }

  if (!mongoose.isValidObjectId(branchId)) {
    sendError(res, 'Invalid X-Branch-Id header', 400);
    return;
  }

  const branch = await Branch.findOne({
    _id:      new mongoose.Types.ObjectId(branchId),
    tenantId: new mongoose.Types.ObjectId(req.tenantId!),
    status:   'active',
  }).lean();

  if (!branch) {
    sendError(res, 'Branch not found or inactive', 403);
    return;
  }

  req.branchId = branchId;
  next();
}
