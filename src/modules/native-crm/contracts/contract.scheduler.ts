import { NativeContract } from './contract.model';
import { FSSettings } from '../fs-settings/fs-settings.model';
import { createWorkorder } from '../workorders/workorder.service';
import { generateWorkordersForVisits } from './contract.service';
import { logger } from '../../../utils/logger';

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
  const dueContracts = await NativeContract.find({
    status: 'active',
    woGenerationMode: { $in: ['on_visit_day', 'days_before'] },
    'visits.status': 'planned',
  }).select('_id tenantId contractId woGenerationMode woLeadDays visits').lean();

  for (const contract of dueContracts) {
    try {
      const settings = await FSSettings.findOne({ tenantId: contract.tenantId }).lean();
      if (!settings?.autoGenerateWorkOrders) continue;

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

export async function runContractScheduler(): Promise<void> {
  const today = new Date();
  today.setHours(23, 59, 59, 999);

  // New: visit-schedule based generation (contracts with generated visits)
  await runVisitScheduler(today).catch((err) =>
    logger.error('Contract visit scheduler crashed', { error: (err as Error).message }));

  try {
    const dueContracts = await NativeContract.find({
      status: 'active',
      nextServiceDate: { $lte: today },
    }).lean();

    if (dueContracts.length === 0) {
      logger.info('Contract scheduler: no contracts due today');
      return;
    }

    logger.info(`Contract scheduler: ${dueContracts.length} contract(s) due`);

    for (const contract of dueContracts) {
      try {
        const settings = await FSSettings.findOne({ tenantId: contract.tenantId }).lean();
        if (!settings?.autoGenerateWorkOrders) continue;

        await createWorkorder({
          tenantId:      contract.tenantId,
          customerId:    contract.customerId,
          contractId:    contract.contractId,
          title:         `Service Visit — ${contract.title}`,
          services:      contract.services ?? [],
          parts:         contract.parts ?? [],
          staffId:       (contract as any).staffId,
          teamId:        (contract as any).teamId,
          scheduledDate: contract.nextServiceDate,
          status:        'scheduled',
          priority:      'medium',
          createdBy:     'system',
        });

        const unit = (contract as any).recurringUnit as RecurringUnit | undefined;
        const interval = (contract as any).recurringInterval as number | undefined;
        const next = unit
          ? calcNextServiceDate(contract.nextServiceDate!, unit, interval)
          : undefined;

        await NativeContract.findByIdAndUpdate(contract._id, {
          lastServiceDate: contract.nextServiceDate,
          ...(next ? { nextServiceDate: next } : {}),
          $inc: { autoWoGenerated: 1 },
        });

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
