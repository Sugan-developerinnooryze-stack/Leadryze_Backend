import { Router } from 'express';
import * as ctrl from './custom-template.controller';

const router = Router();

router.get('/',               ctrl.list);
router.get('/:id',            ctrl.getOne);
router.post('/',              ctrl.create);
router.put('/:id',            ctrl.update);
router.delete('/:id',         ctrl.remove);
router.put('/:id/set-default',ctrl.setDefault);

export default router;
