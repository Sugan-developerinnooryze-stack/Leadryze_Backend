import { Router } from 'express';
import * as ctrl from './team.controller';
import { validate } from '../../../middleware/validate.middleware';
import { idParam } from '../../../utils/common.schemas';
import { createTeamSchema, updateTeamSchema } from './team.validation';

const router = Router();

router.get('/',       ctrl.list);
router.post('/',      validate({ body: createTeamSchema }),                            ctrl.create);
router.get('/:id',    validate({ params: idParam }),                                   ctrl.getOne);
router.put('/:id',    validate({ params: idParam, body: updateTeamSchema }),           ctrl.update);
router.delete('/:id', validate({ params: idParam }),                                   ctrl.remove);

export default router;
