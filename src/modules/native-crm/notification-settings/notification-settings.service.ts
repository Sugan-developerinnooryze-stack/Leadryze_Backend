import mongoose from 'mongoose';
import { NotificationSettings, INotificationSettings } from './notification-settings.model';

export async function getOrCreateSettings(tenantId: string): Promise<INotificationSettings> {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return NotificationSettings.findOneAndUpdate(
    { tenantId: tid },
    { $setOnInsert: { tenantId: tid } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

export async function updateSettings(tenantId: string, patch: Partial<{
  reminderWindowMinutes: number;
  sendOnCreateConfirmation: boolean;
  emailEnabled: boolean;
  smsEnabled: boolean;
}>): Promise<INotificationSettings> {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const safe: Record<string, unknown> = {};
  if (typeof patch.reminderWindowMinutes === 'number') safe.reminderWindowMinutes = patch.reminderWindowMinutes;
  if (typeof patch.sendOnCreateConfirmation === 'boolean') safe.sendOnCreateConfirmation = patch.sendOnCreateConfirmation;
  if (typeof patch.emailEnabled === 'boolean') safe.emailEnabled = patch.emailEnabled;
  if (typeof patch.smsEnabled === 'boolean') safe.smsEnabled = patch.smsEnabled;
  return NotificationSettings.findOneAndUpdate(
    { tenantId: tid },
    { $set: safe, $setOnInsert: { tenantId: tid } },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
  );
}
