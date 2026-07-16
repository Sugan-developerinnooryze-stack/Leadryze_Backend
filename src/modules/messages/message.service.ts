import mongoose from 'mongoose';
import { Message, IMessage } from './message.model';
import { parsePagination, buildSkip } from '../../utils/pagination';

export async function createMessage(tenantId: string, data: Partial<IMessage>): Promise<IMessage> {
  return Message.create({ ...data, tenantId: new mongoose.Types.ObjectId(tenantId) });
}

export async function getMessages(tenantId: string, query: Record<string, unknown>) {
  const { page, limit } = parsePagination(query);
  const skip = buildSkip(page, limit);
  const filter: Record<string, unknown> = { tenantId };
  if (query.customerId) filter.customerId = query.customerId;
  if (query.sessionId) filter.sessionId = query.sessionId;
  if (query.channel) filter.channel = query.channel;

  const [messages, total] = await Promise.all([
    Message.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Message.countDocuments(filter),
  ]);
  return { messages, total, page, limit };
}

export async function getConversationHistory(
  tenantId: string,
  sessionId: string
): Promise<IMessage[]> {
  return Message.find({ tenantId, sessionId }).sort({ createdAt: 1 }).limit(50);
}
