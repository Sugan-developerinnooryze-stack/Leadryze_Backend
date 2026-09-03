import mongoose from 'mongoose';
import { AutomationTemplate } from './automation-template.model';
import { AutomationFlow } from '../automation-flows/automation-flow.model';
import { DEFAULT_TEMPLATES } from './default-templates';
import { logger } from '../../../utils/logger';

/** System templates (tenantId:null) alongside this tenant's own — a plain
 * $or, not two separate queries, so the gallery's "System Templates" /
 * "My Templates" split is a client-side grouping over one already-scoped
 * result, not two round trips. */
export async function listTemplates(tenantId: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return AutomationTemplate.find({ $or: [{ tenantId: null }, { tenantId: tid }] }).sort({ createdAt: -1 }).lean();
}

/** Same $or scoping on the single-doc lookup — a tenant can never fetch
 * another tenant's own authored template by guessing its id; only a system
 * template (tenantId:null) or one of THIS tenant's own resolves. */
export async function getTemplateById(tenantId: string, id: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return AutomationTemplate.findOne({ _id: id, $or: [{ tenantId: null }, { tenantId: tid }] }).lean();
}

/** "Save as template" — hardened per review: never trusts nodes/edges sent
 * directly from the client. Takes a `sourceFlowId`, fetches the REAL
 * AutomationFlow scoped to {_id, tenantId} (the same ownership filter every
 * other flow read already uses — a flow belonging to a different tenant, or
 * a nonexistent id, resolves to null here, never silently copies someone
 * else's flow), and copies only its LIVE, published nodes/edges — never
 * `draft`, since an unpublished draft hasn't been through publishFlow()'s
 * own re-validation and isn't the "already-valid" content this design
 * relies on. Only the template-relevant fields are copied (nodes, edges) —
 * never _id/canvasPositions/version/publishedAt/anything else off the
 * source flow. Always stamps the CALLER's real tenantId (never null — only
 * seedDefaultTemplates() below can create a system template). */
export async function createTemplate(
  tenantId: string, sourceFlowId: string, name: string, description?: string, category?: string,
): Promise<InstanceType<typeof AutomationTemplate> | null> {
  const tid = new mongoose.Types.ObjectId(tenantId);
  const sourceFlow = await AutomationFlow.findOne({ _id: sourceFlowId, tenantId: tid }).lean();
  if (!sourceFlow) return null;
  // A flow with a staged draft has newer, unpromoted edits sitting in
  // `draft` — copying `nodes`/`edges` (the live, pre-draft content) here
  // would silently exclude them with no warning. Symmetric with
  // publishFlow()'s own `throw new Error('This flow has no unpublished
  // changes to publish')` for the opposite case.
  if (sourceFlow.draft) {
    throw new Error('This flow has unpublished changes — publish them first. Save as Template only ever copies the last published version.');
  }

  const triggerNode = sourceFlow.nodes.find((n) => n.type === 'trigger');
  return AutomationTemplate.create({
    tenantId: tid,
    name,
    description,
    category,
    triggerModule: triggerNode?.module,
    nodes: sourceFlow.nodes,
    edges: sourceFlow.edges,
  });
}

/** Own-tenant only — a plain non-null tenantId filter never matches a
 * tenantId:null document, so a tenant can never delete a system template
 * through this function regardless of what id it's given. */
export async function deleteTemplate(tenantId: string, id: string) {
  const tid = new mongoose.Types.ObjectId(tenantId);
  return AutomationTemplate.findOneAndDelete({ _id: id, tenantId: tid });
}

/** Idempotent upsert-by-name, mirroring rbac.seed.ts's own
 * _upsertSystemPermissions pattern — safe to run on every backend startup,
 * updates a template's content if its code definition changes, never
 * duplicates. Called once from server.ts alongside the existing RBAC seed
 * call. */
export async function seedDefaultTemplates(): Promise<void> {
  try {
    for (const t of DEFAULT_TEMPLATES) {
      await AutomationTemplate.findOneAndUpdate(
        { tenantId: null, name: t.name },
        { $set: { description: t.description, category: t.category, triggerModule: t.triggerModule, nodes: t.nodes, edges: t.edges } },
        { upsert: true },
      );
    }
    logger.info('Automation template seed complete', { count: DEFAULT_TEMPLATES.length });
  } catch (err) {
    logger.error('seedDefaultTemplates failed', { error: (err as Error).message });
  }
}
