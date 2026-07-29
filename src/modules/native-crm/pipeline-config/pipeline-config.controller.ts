import { Response } from 'express';
import { AuthRequest } from '../../../types';
import { sendSuccess, sendError } from '../../../utils/response';
import { getOrCreateStages, updateStages } from './pipeline-config.service';
import { PipelineModule, BuiltInPipelineModule } from './pipeline-config.model';
import { getCustomModuleBySlug } from '../../custom-modules/custom-module.service';

const BUILT_IN_MODULES: BuiltInPipelineModule[] = ['lead', 'deal', 'task', 'ticket', 'quotation', 'workorder', 'contract', 'invoice'];

/** Built-ins are a closed list; `custom:<slug>` is valid only if that Custom
 * Module actually exists for this tenant — otherwise a typo'd slug would
 * silently create an orphaned PipelineConfig no UI ever points at. */
async function isValidModule(tenantId: string, module: string): Promise<boolean> {
  if ((BUILT_IN_MODULES as string[]).includes(module)) return true;
  if (module.startsWith('custom:')) {
    const slug = module.slice('custom:'.length);
    return !!(await getCustomModuleBySlug(tenantId, slug));
  }
  return false;
}

export async function getStages(req: AuthRequest, res: Response) {
  try {
    const module = req.params.module as PipelineModule;
    if (!(await isValidModule(req.tenantId!, module))) return sendError(res, 'Invalid module', 400);
    const stages = await getOrCreateStages(req.tenantId!, module);
    sendSuccess(res, stages);
  } catch (err: any) {
    sendError(res, err.message ?? 'Failed to fetch pipeline stages', 500);
  }
}

export async function putStages(req: AuthRequest, res: Response) {
  try {
    const module = req.params.module as PipelineModule;
    if (!(await isValidModule(req.tenantId!, module))) return sendError(res, 'Invalid module', 400);
    const { stages } = req.body;
    if (!Array.isArray(stages) || stages.length === 0) return sendError(res, 'stages must be a non-empty array', 400);
    for (const s of stages) {
      if (!s.key || !s.label) return sendError(res, 'Each stage requires a key and label', 400);
    }
    const updated = await updateStages(req.tenantId!, module, stages);
    sendSuccess(res, updated);
  } catch (err: any) {
    sendError(res, err.message ?? 'Failed to update pipeline stages', 500);
  }
}
