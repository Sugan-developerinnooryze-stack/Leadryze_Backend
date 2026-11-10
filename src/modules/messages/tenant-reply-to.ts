import mongoose from 'mongoose';
import { Tenant } from '../tenants/tenant.model';
import { FSSettings } from '../native-crm/fs-settings/fs-settings.model';

/* LR-PL-CAMP-003: campaign and template e-mails go out from the platform
 * sender (BREVO_SENDER_EMAIL) with the tenant's name. They only carried a
 * Reply-To when the tenant had a Widget contact e-mail, so for every other
 * tenant a customer's reply went to the platform sender's mailbox (Brevo sets
 * the original Gmail sender as Reply-To when it rewrites a free-mail From).
 * The Reply-To is now the tenant's own address, and an e-mail is not sent
 * without one (product owner decision). Automation, PDF, reminder and
 * confirmation e-mails are not changed by this. */

/** Shown when a tenant has no address for replies. */
export const REPLY_TO_MISSING_MESSAGE =
  'Set a company e-mail in FS Settings (or a contact e-mail in Widget Settings) before sending e-mail, so customer replies reach your business.';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function usable(value: unknown): string | null {
  const s = typeof value === 'string' ? value.trim() : '';
  return EMAIL_RE.test(s) ? s : null;
}

/**
 * The address a tenant's campaign and template e-mails are answered to: the
 * Widget contact e-mail (tenant.branding.contactEmail), else the company
 * e-mail in the main FS Settings, else null. Pass the tenant when it is
 * already loaded. A database error is thrown, not treated as "no address".
 */
export async function resolveTenantReplyTo(
  tenantId: string,
  tenant?: { branding?: { contactEmail?: string } } | null,
): Promise<string | null> {
  const t = tenant !== undefined ? tenant : await Tenant.findById(tenantId).select('branding').lean();
  const contact = usable(t?.branding?.contactEmail);
  if (contact) return contact;
  if (!mongoose.isValidObjectId(tenantId)) return null;
  const fs: any = await FSSettings.findOne({ tenantId: new mongoose.Types.ObjectId(tenantId), branchId: null })
    .select('companyEmail').lean();
  return usable(fs?.companyEmail);
}
