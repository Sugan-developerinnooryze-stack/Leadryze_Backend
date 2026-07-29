import { Response } from 'express';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError } from '../../../utils/response';
import { getOrCreateSettings, updateSettings } from './notification-settings.service';

export async function get(req: AuthRequest, res: Response) {
  try {
    const settings = await getOrCreateSettings(req.tenantId!);
    sendSuccess(res, settings);
  } catch (err: any) {
    sendError(res, err.message ?? 'Failed to fetch notification settings', 500);
  }
}

export async function update(req: AuthRequest, res: Response) {
  try {
    const settings = await updateSettings(req.tenantId!, req.body);
    sendSuccess(res, settings);
  } catch (err: any) {
    sendError(res, err.message ?? 'Failed to update notification settings', 400);
  }
}
