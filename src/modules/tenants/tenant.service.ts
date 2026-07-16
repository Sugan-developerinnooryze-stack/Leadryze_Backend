import { Tenant, ITenant } from './tenant.model';
import { parsePagination, buildSkip } from '../../utils/pagination';

export async function createTenant(data: Partial<ITenant>): Promise<ITenant> {
  if (!data.slug && data.name) {
    data.slug = data.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  }
  return Tenant.create(data);
}

export async function getTenants(query: Record<string, unknown>) {
  const { page, limit, sort, order } = parsePagination(query);
  const skip = buildSkip(page, limit);
  const filter: Record<string, unknown> = {};
  if (query.isActive !== undefined) filter.isActive = query.isActive === 'true';

  const [tenants, total] = await Promise.all([
    Tenant.find(filter)
      .sort({ [sort]: order === 'asc' ? 1 : -1 })
      .skip(skip)
      .limit(limit),
    Tenant.countDocuments(filter),
  ]);
  return { tenants, total, page, limit };
}

export async function getTenantById(id: string): Promise<ITenant | null> {
  return Tenant.findById(id);
}

export async function updateTenant(
  id: string,
  data: Partial<ITenant>
): Promise<ITenant | null> {
  return Tenant.findByIdAndUpdate(id, { $set: data }, { new: true, runValidators: true });
}

export async function deleteTenant(id: string): Promise<void> {
  await Tenant.findByIdAndUpdate(id, { isActive: false });
}
