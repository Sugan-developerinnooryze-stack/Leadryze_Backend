import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../types';
import * as analyticsService from './analytics.service';
import { sendSuccess } from '../../utils/response';

export async function getDashboard(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const stats = await analyticsService.getDashboardStats(req.tenantId!);
    sendSuccess(res, stats, 'Dashboard stats fetched');
  } catch (err) { next(err); }
}

export async function getAnalytics(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { startDate, endDate, channel } = req.query as Record<string, string>;
    const start = startDate || new Date(Date.now() - 30 * 86400000).toISOString();
    const end = endDate || new Date().toISOString();
    const data = await analyticsService.getAnalyticsByRange(req.tenantId!, start, end, channel);
    sendSuccess(res, data);
  } catch (err) { next(err); }
}
