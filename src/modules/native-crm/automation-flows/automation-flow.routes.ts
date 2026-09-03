import { Router } from 'express';
import * as ctrl from './automation-flow.controller';
import { validate } from '../../../middleware/validate.middleware';
import { requirePermission } from '../../../middlewares/auth.middleware';
import { idParam } from '../../../utils/common.schemas';
import { createAutomationFlowSchema, updateAutomationFlowSchema, decideApprovalSchema, dryRunFlowSchema } from './automation-flow.validation';

const router = Router();

// NOTE: /runs and /runs/:id are registered BEFORE /:id — Express matches
// routes in registration order, so /:id would otherwise greedily swallow
// "runs" as if it were a flow id.
router.get('/runs',     requirePermission('automation.view_executions'), ctrl.listRuns);
// Registered BEFORE /runs/:id for the identical reason as the top-of-file
// note — otherwise :id would swallow the literal "stats" segment.
router.get('/runs/stats', requirePermission('automation.view_executions'), ctrl.getStats);
// decide's own inline APPROVAL_DECISION_ROLES check (controller) is already
// more precise than a coarse permission key — automation.execute is an
// additional floor, not a replacement for it.
router.patch('/runs/:id/decision', requirePermission('automation.execute'), validate({ params: idParam, body: decideApprovalSchema }), ctrl.decide);
router.get('/runs/:id', requirePermission('automation.view_executions'), validate({ params: idParam }), ctrl.getOneRun);

router.get('/',       requirePermission('automation.view'), ctrl.list);
router.get('/:id',    requirePermission('automation.view'), validate({ params: idParam }), ctrl.getOne);
router.post('/',      requirePermission('automation.create'), validate({ body: createAutomationFlowSchema }), ctrl.create);
router.put('/:id',    requirePermission('automation.edit'), validate({ params: idParam, body: updateAutomationFlowSchema }), ctrl.update);
router.delete('/:id', requirePermission('automation.delete'), validate({ params: idParam }), ctrl.remove);

router.post('/:id/publish',      requirePermission('automation.publish'), validate({ params: idParam }), ctrl.publish);
router.post('/:id/discard-draft', requirePermission('automation.edit'), validate({ params: idParam }), ctrl.discardDraftHandler);
router.post('/:id/dry-run',      requirePermission('automation.execute'), validate({ params: idParam, body: dryRunFlowSchema }), ctrl.dryRun);

export default router;
