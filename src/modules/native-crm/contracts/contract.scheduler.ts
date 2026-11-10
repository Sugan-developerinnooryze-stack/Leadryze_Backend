import { NativeContract } from './contract.model';
import { FSSettings } from '../fs-settings/fs-settings.model';
import { createWorkorder } from '../workorders/workorder.service';
import { generateWorkordersForVisits, releaseStaleVisitClaims } from './contract.service';
import { indexNativeSearchRecord } from '../shared/search-index';
import { getOutcomeStageKey, isValidStageKey } from '../pipeline-config/pipeline-config.service';
import { logTimeline } from '../timeline/timeline.service';
import { logger } from '../../../utils/logger';

/**
 * contract.status is tenant-configurable (native-crm/pipeline-config), so a
 * hardcoded {status:'active'} Mongo filter can no longer identify "active"
 * contracts across every tenant — each tenant may have renamed that stage.
 * This resolves and caches each tenant's own "active" key once per run so
 * the per-document check below stays correct after any rename.
 */
function makeActiveKeyResolver() {
  const cache = new Map<string, Promise<string>>();
  return (tenantId: string): Promise<string> => {
    const key = String(tenantId);
    let p = cache.get(key);
    if (!p) {
      p = getOutcomeStageKey(key, 'contract', 'active', 'active');
      cache.set(key, p);
    }
    return p;
  };
}

/**
 * LR-R26-SCHED-001: the auto-generate switch of the contract's own company
 * (FS Settings are saved per company, by branchId), else Default Company's,
 * the way getSettings() resolves every company setting. It read the tenant's
 * first settings document, whichever company that was. A company with no
 * record of its own and no Default Company record has the switch off.
 * Cached once per run.
 */
function makeAutoGenerateResolver() {
  const cache = new Map<string, Promise<boolean>>();
  return (tenantId: unknown, branchId: unknown): Promise<boolean> => {
    const key = `${String(tenantId)}|${branchId ? String(branchId) : ''}`;
    let p = cache.get(key);
    if (!p) {
      p = (async () => {
        const pick = 'autoGenerateWorkOrders';
        const own      = branchId ? await FSSettings.findOne({ tenantId, branchId }).select(pick).lean() : null;
        const settings = own ?? await FSSettings.findOne({ tenantId, branchId: null }).select(pick).lean();
        return Boolean(settings?.autoGenerateWorkOrders);
      })();
      cache.set(key, p);
    }
    return p;
  };
}

type RecurringUnit = 'day' | 'week' | 'fortnight' | 'month' | 'bimonthly' | 'quarter' | 'halfyear' | 'year' | 'custom';

export function calcNextServiceDate(from: Date, unit: RecurringUnit, interval?: number): Date {
  const d = new Date(from);
  switch (unit) {
    case 'day':       d.setDate(d.getDate() + 1);        break;
    case 'week':      d.setDate(d.getDate() + 7);        break;
    case 'fortnight': d.setDate(d.getDate() + 14);       break;
    case 'month':     d.setMonth(d.getMonth() + 1);      break;
    case 'bimonthly': d.setMonth(d.getMonth() + 2);      break;
    case 'quarter':   d.setMonth(d.getMonth() + 3);      break;
    case 'halfyear':  d.setMonth(d.getMonth() + 6);      break;
    case 'year':      d.setFullYear(d.getFullYear() + 1); break;
    case 'custom':    d.setDate(d.getDate() + (interval ?? 1)); break;
  }
  return d;
}

/**
 * Master-engine branch: contracts with a generated visit schedule create WOs
 * for planned visits inside their lead window (on visit day, or N days before).
 */
async function runVisitScheduler(today: Date): Promise<void> {
  // LR-R26-SCHED-001: first give back visits a stopped run left claimed.
  await releaseStaleVisitClaims().catch((err) =>
    logger.error('Contract visit claim release failed', { error: (err as Error).message }));

  // status:'active' is resolved per-tenant below, not filtered here — see
  // makeActiveKeyResolver().
  const dueContracts = await NativeContract.find({
    woGenerationMode: { $in: ['on_visit_day', 'days_before'] },
    'visits.status': 'planned',
  }).select('_id tenantId branchId contractId status woGenerationMode woLeadDays visits').lean();

  const resolveActiveKey = makeActiveKeyResolver();
  const autoGenerateOn = makeAutoGenerateResolver();

  for (const contract of dueContracts) {
    try {
      const activeKey = await resolveActiveKey(String(contract.tenantId));
      if (contract.status !== activeKey) continue;

      if (!(await autoGenerateOn(contract.tenantId, (contract as any).branchId))) continue;

      const leadDays = contract.woGenerationMode === 'days_before'
        ? Math.max(0, Number(contract.woLeadDays) || 0)
        : 0;
      const horizon = new Date(today);
      horizon.setDate(horizon.getDate() + leadDays);

      const due = (contract.visits ?? [])
        .filter((v: any) => v.status === 'planned' && new Date(v.serviceDate) <= horizon)
        .map((v: any) => v.visitNumber);
      if (!due.length) continue;

      const result = await generateWorkordersForVisits(
        String(contract._id),
        String(contract.tenantId),
        { visitNumbers: due, createdBy: 'system' },
      );
      // LR-R26-SCHED-001: count them, as the older nextServiceDate branch
      // does (autoWoGenerated stayed 0 for visit-schedule contracts).
      if (result.created > 0) {
        await NativeContract.updateOne({ _id: contract._id }, { $inc: { autoWoGenerated: result.created } });
      }
      logger.info('Contract visit scheduler: WOs generated', {
        contractId: contract.contractId,
        created: result.created,
      });
    } catch (err) {
      logger.error('Contract visit scheduler: failed for contract', {
        contractId: (contract as any).contractId,
        error: (err as Error).message,
      });
    }
  }
}

/**
 * LR-R26-SCHED-001: contracts whose end date has passed move from the tenant's
 * Active stage to its Expired stage (the stage with key 'expired'), with a
 * timeline entry. Runs after the work orders are generated, so the last
 * visit's work order is still made. Nothing moved a contract out of Active
 * before. Automatic renewal (renewalType 'automatic') is not done here.
 * The end date is a day: contracts saved since 22 Oct store its end
 * (23:59:59.999Z), older ones its start (00:00Z), so a contract counts as
 * ended once that UTC day is over, whichever way it was stored. The search
 * index is updated; contract automations do not run for this change.
 */
export async function expireEndedContracts(now: Date = new Date()): Promise<number> {
  const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const ended = await NativeContract.find({
    noEndDate: { $ne: true },
    endDate:   { $lt: startOfToday },
    status:    { $nin: ['expired', 'completed', 'cancelled'] },
  }).select('_id tenantId contractId title status endDate').lean();

  const resolveActiveKey = makeActiveKeyResolver();
  const expiredUsable = new Map<string, Promise<boolean>>();
  let expired = 0;
  for (const contract of ended) {
    try {
      const tenantId = String(contract.tenantId);
      const activeKey = await resolveActiveKey(tenantId);
      if (contract.status !== activeKey) continue;
      if (!expiredUsable.has(tenantId)) expiredUsable.set(tenantId, isValidStageKey(tenantId, 'contract', 'expired'));
      if (!(await expiredUsable.get(tenantId))) {
        logger.warn('Contract expiry: the tenant has no active Expired stage; contract left as it is', { contractId: contract.contractId });
        continue;
      }
      // Only if it is still Active (someone may have changed it meanwhile).
      const updated: any = await NativeContract.findOneAndUpdate(
        { _id: contract._id, status: activeKey }, { $set: { status: 'expired' } }, { new: true },
      );
      if (!updated) continue;
      expired++;
      const plain = typeof updated.toObject === 'function' ? updated.toObject() : updated;
      indexNativeSearchRecord(tenantId, 'native-crm', 'contracts', plain, plain.title);
      logger.info('Contract expired: end date passed', { contractId: contract.contractId, endDate: contract.endDate });
      await logTimeline(
        contract.tenantId as any, 'contract', String(contract._id), 'status_changed',
        `Contract "${(contract as any).title ?? contract.contractId}" expired: its end date passed`, 'system',
        { from: activeKey, to: 'expired', endDate: contract.endDate },
      ).catch(() => undefined);
    } catch (err) {
      logger.error('Contract expiry: failed for contract', { contractId: (contract as any).contractId, error: (err as Error).message });
    }
  }
  return expired;
}

// LR-R26-SCHED-001: one run at a time in this process (the hourly run and
// the start-up run can meet); runs in other processes are kept apart by the
// per-visit and per-date claims.
let schedulerRunning = false;

export async function runContractScheduler(): Promise<void> {
  if (schedulerRunning) {
    logger.info('Contract scheduler: previous run still in progress, skipped');
    return;
  }
  schedulerRunning = true;
  try {
    await runContractSchedulerOnce();
    await expireEndedContracts().catch((err) =>
      logger.error('Contract expiry crashed', { error: (err as Error).message }));
  } finally {
    schedulerRunning = false;
  }
}

async function runContractSchedulerOnce(): Promise<void> {
  const today = new Date();
  today.setHours(23, 59, 59, 999);

  // New: visit-schedule based generation (contracts with generated visits)
  await runVisitScheduler(today).catch((err) =>
    logger.error('Contract visit scheduler crashed', { error: (err as Error).message }));

  try {
    // status:'active' is resolved per-tenant below, not filtered here — see
    // makeActiveKeyResolver().
    const candidates = await NativeContract.find({
      nextServiceDate: { $lte: today },
    }).lean();

    const resolveActiveKey = makeActiveKeyResolver();
    const dueContracts: typeof candidates = [];
    for (const contract of candidates) {
      const activeKey = await resolveActiveKey(String(contract.tenantId));
      if (contract.status === activeKey) dueContracts.push(contract);
    }

    if (dueContracts.length === 0) {
      logger.info('Contract scheduler: no contracts due today');
      return;
    }

    logger.info(`Contract scheduler: ${dueContracts.length} contract(s) due`);

    const autoGenerateOn = makeAutoGenerateResolver();
    for (const contract of dueContracts) {
      try {
        if (!(await autoGenerateOn(contract.tenantId, (contract as any).branchId))) continue;

        // LR-R26-SCHED-001: claim this service date first: move the contract
        // on to its next date (or clear it when it does not repeat) only if
        // it still has this one. Another run that got here first is skipped,
        // and a contract that does not repeat no longer gets a new work order
        // on every run (it did, once a day, before; hourly it would be 24).
        const unit = (contract as any).recurringUnit as RecurringUnit | undefined;
        const interval = (contract as any).recurringInterval as number | undefined;
        const next = unit
          ? calcNextServiceDate(contract.nextServiceDate!, unit, interval)
          : undefined;
        const claimed = await NativeContract.findOneAndUpdate(
          { _id: contract._id, nextServiceDate: contract.nextServiceDate },
          next
            ? { $set: { nextServiceDate: next, lastServiceDate: contract.nextServiceDate } }
            : { $set: { lastServiceDate: contract.nextServiceDate }, $unset: { nextServiceDate: 1 } },
          { projection: { _id: 1 } },
        );
        if (!claimed) continue;

        const woScheduledKey = await getOutcomeStageKey(String(contract.tenantId), 'workorder', 'scheduled', 'scheduled');
        const contractDisc = (contract.services ?? []).find((s: any) => s.discountPercent != null)?.discountPercent ?? (contract as any).discount ?? 0;
        const contractGst  = (contract.services ?? []).find((s: any) => s.taxPercent != null)?.taxPercent ?? (contract as any).gstPercentage ?? 0;

        try {
          await createWorkorder({
            tenantId:      contract.tenantId,
            branchId:      (contract as any).branchId ?? null,
            customerId:    contract.customerId,
            contractId:    contract.contractId,
            title:         `Service Visit — ${contract.title}`,
            services:      contract.services ?? [],
            parts:         contract.parts ?? [],
            discount:      contractDisc,
            gstPercentage: contractGst,
            staffId:       (contract as any).staffId,
            teamId:        (contract as any).teamId,
            scheduledDate: contract.nextServiceDate,
            status:        woScheduledKey,
            priority:      'medium',
            createdBy:     'system',
          });
        } catch (err) {
          // Give the date back so the next run tries again, only if the
          // contract still has what this run set (another run may have moved
          // it on since; rolling that back would repeat its work order).
          await NativeContract.updateOne(
            next
              ? { _id: contract._id, nextServiceDate: next }
              : { _id: contract._id, nextServiceDate: { $exists: false }, lastServiceDate: contract.nextServiceDate },
            contract.lastServiceDate
              ? { $set: { nextServiceDate: contract.nextServiceDate, lastServiceDate: contract.lastServiceDate } }
              : { $set: { nextServiceDate: contract.nextServiceDate }, $unset: { lastServiceDate: 1 } },
          ).catch(() => undefined);
          throw err;
        }

        await NativeContract.updateOne({ _id: contract._id }, { $inc: { autoWoGenerated: 1 } });

        logger.info('Contract scheduler: WO created', {
          contractId: contract.contractId,
          nextServiceDate: next,
        });
      } catch (err) {
        logger.error('Contract scheduler: failed for contract', {
          contractId: (contract as any).contractId,
          error: (err as Error).message,
        });
      }
    }
  } catch (err) {
    logger.error('Contract scheduler crashed', { error: (err as Error).message });
  }
}
