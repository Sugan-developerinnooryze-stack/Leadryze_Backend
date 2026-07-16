import { Router } from 'express';
import * as ctrl from './task.controller';
import { validate } from '../../../middleware/validate.middleware';
import { idParam } from '../../../utils/common.schemas';
import { createTaskSchema, updateTaskSchema } from './task.validation';

const router = Router();
router.get('/',        ctrl.list);
router.post('/',       validate({ body: createTaskSchema }),                           ctrl.create);
router.get('/stats',   ctrl.stats);
router.get('/:id',     validate({ params: idParam }),                                  ctrl.getOne);
router.put('/:id',     validate({ params: idParam, body: updateTaskSchema }),          ctrl.update);
router.delete('/:id',  validate({ params: idParam }),                                  ctrl.remove);

export default router;
