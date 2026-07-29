import mongoose from 'mongoose';
import { EmailLog, IEmailLog } from './email-log.model';
import { PaginatedResult } from '../native-crm/native-crm.types';

export interface WriteLogInput {
  tenantId:           string;
  channel:            IEmailLog['channel'];
  kind:               IEmailLog['kind'];
  sourceModule:       IEmailLog['sourceModule'];
  sourceId:           string;
  relatedModule?:     string | null;
  relatedId?:         string | null;
  relatedLabel?:      string | null;
  recipientName?:     string;
  recipientEmail?:    string;
  recipientPhone?:    string;
  subject?:           string;
  bodyPreview?:       string;
  status:             IEmailLog['status'];
  errorMessage?:      string;
  providerMessageId?: string;
}

export async function writeLog(entry: WriteLogInput): Promise<void> {
  await EmailLog.create({
    ...entry,
    tenantId: new mongoose.Types.ObjectId(entry.tenantId),
    bodyPreview: entry.bodyPreview?.slice(0, 300),
  });
}

export interface ListLogsFilters {
  channel?: string;
  kind?:    string;
  status?:  string;
  from?:    string;
  to?:      string;
}

export async function listLogs(
  tenantId: string,
  filters: ListLogsFilters = {},
  opts: { page?: number; limit?: number } = {}
): Promise<PaginatedResult<unknown>> {
  const { page = 1, limit = 20 } = opts;
  const tid = new mongoose.Types.ObjectId(tenantId);
  const filter: Record<string, unknown> = { tenantId: tid };
  if (filters.channel) filter.channel = filters.channel;
  if (filters.kind)    filter.kind    = filters.kind;
  if (filters.status)  filter.status  = filters.status;
  if (filters.from || filters.to) {
    const range: Record<string, Date> = {};
    if (filters.from) range.$gte = new Date(filters.from);
    if (filters.to)   range.$lte = new Date(filters.to);
    filter.sentAt = range;
  }
  const [items, total] = await Promise.all([
    EmailLog.find(filter).sort({ sentAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    EmailLog.countDocuments(filter),
  ]);
  return { items, total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}
