import { Router } from 'express';
import * as ctrl from './team.controller';
import { validate } from '../../../middleware/validate.middleware';
import { idParam } from '../../../utils/common.schemas';
import { createTeamSchema, updateTeamSchema } from './team.validation';
import { requirePermission } from '../../../middlewares/auth.middleware';

const router = Router();

router.get('/',       requirePermission('fs.teams.view'),   ctrl.list);
router.post('/',      requirePermission('fs.teams.create'), validate({ body: createTeamSchema }),                            ctrl.create);
router.get('/:id/stats', requirePermission('fs.teams.view'), validate({ params: idParam }),                                  ctrl.stats);
router.get('/:id',    requirePermission('fs.teams.view'),   validate({ params: idParam }),                                   ctrl.getOne);
router.put('/:id',    requirePermission('fs.teams.edit'),   validate({ params: idParam, body: updateTeamSchema }),           ctrl.update);
router.delete('/:id', requirePermission('fs.teams.delete'), validate({ params: idParam }),                                   ctrl.remove);

export default router;
