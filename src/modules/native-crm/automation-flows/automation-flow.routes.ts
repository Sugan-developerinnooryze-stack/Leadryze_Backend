import { Router } from 'express';
import * as ctrl from './automation-flow.controller';
import { validate } from '../../../middleware/validate.middleware';
import { idParam } from '../../../utils/common.schemas';
import { createAutomationFlowSchema, updateAutomationFlowSchema, decideApprovalSchema } from './automation-flow.validation';

const router = Router();

// NOTE: /runs and /runs/:id are registered BEFORE /:id — Express matches
// routes in registration order, so /:id would otherwise greedily swallow
// "runs" as if it were a flow id.
router.get('/runs',     ctrl.listRuns);
router.patch('/runs/:id/decision', validate({ params: idParam, body: decideApprovalSchema }), ctrl.decide);
router.get('/runs/:id', validate({ params: idParam }), ctrl.getOneRun);

router.get('/',       ctrl.list);
router.get('/:id',    validate({ params: idParam }), ctrl.getOne);
router.post('/',      validate({ body: createAutomationFlowSchema }), ctrl.create);
router.put('/:id',    validate({ params: idParam, body: updateAutomationFlowSchema }), ctrl.update);
router.delete('/:id', validate({ params: idParam }), ctrl.remove);

export default router;
