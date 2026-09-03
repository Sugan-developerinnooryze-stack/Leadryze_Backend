import mongoose from 'mongoose';
import { Tenant } from '../../tenants/tenant.model';
import { AuditLog } from '../../logs/audit-log.model';

/** Emergency tenant-wide automation kill switch (Phase 5) — reads/writes
 * Tenant.settings.automationsPaused directly via a single-field dot-notation
 * $set, deliberately never through the generic tenant-update path
 * (tenant.service.ts's updateTenant() doesn't apply its own dot-notation
 * merge protection to `settings`, so a naive partial update there would
 * silently wipe sibling fields like timezone/language). */
export async function getAutomationSettings(tenantId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const tenant = await Tenant.findById(tid).select('settings.automationsPaused').lean();
  const lastChange = await AuditLog.findOne({
    tenantId,
    action: { $in: ['automation.kill_switch.pause', 'automation.kill_switch.resume'] },
  }).sort({ timestamp: -1 }).select('actorEmail timestamp').lean();

  return {
    automationsPaused: tenant?.settings?.automationsPaused ?? false,
    lastChangedBy: lastChange?.actorEmail ?? null,
    lastChangedAt: lastChange?.timestamp ?? null,
  };
}

export async function setAutomationsPaused(tenantId: string, paused: boolean) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return Tenant.findByIdAndUpdate(
    tid,
    { $set: { 'settings.automationsPaused': paused } },
    { new: true },
  ).select('settings.automationsPaused').lean();
}
