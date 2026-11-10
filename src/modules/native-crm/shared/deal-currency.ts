import mongoose from 'mongoose';
import { FSSettings } from '../fs-settings/fs-settings.model';

/* LR-PL-ANALYTICS-001 / LR-C4-DEAL-001: deal money is added up per currency,
 * never across currencies. Analytics and the dashboard's Revenue tile added
 * every deal's amount into one number shown with the tenant's symbol (INR
 * 6,722 and USD 280,100 became "₹286,822"); the Deals board shows "₹6,722 +
 * $280,100". A figure now comes with a list per currency, the default
 * currency first; the old single number is the default currency's part only.
 * A deal without a currency counts in the default currency, as when a deal is
 * saved. No conversion between currencies is made. */

/** An amount in one currency. */
export interface CurrencyAmount { currency: string; value: number }

/** The currency a deal without one counts in: the company's FS Settings
 * currency, else the main company's, else INR (deal.schema.ts pre-save). */
export async function resolveDealDefaultCurrency(tenantId: string, branchId?: string | null): Promise<string> {
  try {
    const tid = new mongoose.Types.ObjectId(tenantId);
    const own: any = branchId && mongoose.isValidObjectId(branchId)
      ? await FSSettings.findOne({ tenantId: tid, branchId: new mongoose.Types.ObjectId(branchId) }).select('currency').lean()
      : null;
    const main: any = own?.currency ? null : await FSSettings.findOne({ tenantId: tid, branchId: null }).select('currency').lean();
    return String(own?.currency || main?.currency || 'INR').trim().toUpperCase() || 'INR';
  } catch {
    return 'INR';
  }
}

/** Mongo expression: a deal's currency in capitals, or the default when it has none. */
export function dealCurrencyExpr(defaultCurrency: string) {
  return {
    $let: {
      vars: { c: { $trim: { input: { $toString: { $ifNull: ['$currency', ''] } } } } },
      in: { $cond: [{ $gt: [{ $strLenCP: '$$c' }, 0] }, { $toUpper: '$$c' }, defaultCurrency] },
    },
  };
}

/** Totals per currency: the default currency first, then A-Z; zero totals left out. */
export function currencyAmounts(totals: Iterable<[string, unknown]>, defaultCurrency: string): CurrencyAmount[] {
  const map = new Map<string, number>();
  for (const [currency, value] of totals) {
    const key = String(currency || defaultCurrency).toUpperCase();
    map.set(key, (map.get(key) ?? 0) + (Number(value) || 0));
  }
  return [...map.entries()]
    .filter(([, value]) => value !== 0)
    .sort(([a], [b]) => (a === defaultCurrency ? -1 : b === defaultCurrency ? 1 : a.localeCompare(b)))
    .map(([currency, value]) => ({ currency, value }));
}

/** The amount in one currency (0 when there is none). */
export function amountIn(list: CurrencyAmount[], currency: string): number {
  return list.find((e) => e.currency === currency)?.value ?? 0;
}
