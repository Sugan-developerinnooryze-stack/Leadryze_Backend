import mongoose from 'mongoose';
import { ActivityLog } from './log.model';

export interface WriteLogParams {
  tenantId: string;
  service: 'ai' | 'backend';
  level?: 'info' | 'warn' | 'error' | 'debug';
  event: string;
  message: string;
  metadata?: Record<string, unknown>;
  sessionId?: string;
  userId?: string;
}

/** Write a log entry — never throws, silent on failure */
export async function writeLog(params: WriteLogParams): Promise<void> {
  try {
    if (!mongoose.isValidObjectId(params.tenantId)) return;
    await ActivityLog.create({
      tenantId:  new mongoose.Types.ObjectId(params.tenantId),
      service:   params.service,
      level:     params.level || 'info',
      event:     params.event,
      message:   params.message,
      metadata:  params.metadata || {},
      sessionId: params.sessionId,
      userId:    params.userId,
    });
  } catch {
    // Logging must never crash the app
  }
}

export interface GetLogsParams {
  tenantId: string;
  service?: 'ai' | 'backend';
  level?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
}

export async function getTenantLogs(params: GetLogsParams) {
  const query: Record<string, unknown> = {
    tenantId: new mongoose.Types.ObjectId(params.tenantId),
  };

  if (params.service) query.service = params.service;
  if (params.level)   query.level   = params.level;

  if (params.from || params.to) {
    const dateRange: Record<string, unknown> = {};
    if (params.from) dateRange['$gte'] = params.from;
    if (params.to)   dateRange['$lte'] = params.to;
    query.createdAt = dateRange;
  }

  const limit  = Math.min(params.limit  || 50, 200);
  const offset = params.offset || 0;

  const [logs, total] = await Promise.all([
    ActivityLog.find(query).sort({ createdAt: -1 }).skip(offset).limit(limit).lean(),
    ActivityLog.countDocuments(query),
  ]);

  return { logs, total, limit, offset };
}

export async function getAllTenantsLogs(params: Omit<GetLogsParams, 'tenantId'> & { tenantId?: string }) {
  const query: Record<string, unknown> = {};
  if (params.tenantId && mongoose.isValidObjectId(params.tenantId)) {
    query.tenantId = new mongoose.Types.ObjectId(params.tenantId);
  }
  if (params.service) query.service = params.service;
  if (params.level)   query.level   = params.level;

  if (params.from || params.to) {
    const dateRange: Record<string, unknown> = {};
    if (params.from) dateRange['$gte'] = params.from;
    if (params.to)   dateRange['$lte'] = params.to;
    query.createdAt = dateRange;
  }

  const limit  = Math.min(params.limit  || 100, 500);
  const offset = params.offset || 0;

  const [logs, total] = await Promise.all([
    ActivityLog.find(query)
      .sort({ createdAt: -1 })
      .skip(offset)
      .limit(limit)
      .populate('tenantId', 'name slug')
      .lean(),
    ActivityLog.countDocuments(query),
  ]);

  return { logs, total, limit, offset };
}
