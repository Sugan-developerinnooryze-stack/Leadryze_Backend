import { Router, Response, NextFunction } from 'express';
import { authenticate, requirePermission } from '../../middlewares/auth.middleware';
import { requireTenant } from '../../middlewares/tenant.middleware';
import { AuthRequest } from '../../types';
import {
  listModules,
  listRecords,
  getRecord,
  updateRecord,
  deleteRecord,
  createRecord,
  searchRecords,
} from './crm-record.controller';

const router = Router();
router.use(authenticate, requireTenant);

// Dynamic permission check — resolves permission key from URL params at request time.
// Channel and module are lowercased to match how dynamic permissions are stored after sync.
function crmPerm(action: string) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    const ch  = req.params.channel.toLowerCase();
    const mod = req.params.module.toLowerCase();
    const key = `connector.${ch}.${mod}.${action}`;
    return requirePermission(key)(req, res, next);
  };
}

// /search and /modules use broad connector.view — no module context available
router.get('/search',  requirePermission('connector.view'), searchRecords);
router.get('/modules', requirePermission('connector.view'), listModules);

// Per-module dynamic permission check
router.get('/:channel/:module',        crmPerm('view'),   listRecords);
router.post('/:channel/:module',       crmPerm('create'), createRecord);
router.get('/:channel/:module/:id',    crmPerm('view'),   getRecord);
router.put('/:channel/:module/:id',    crmPerm('edit'),   updateRecord);
router.delete('/:channel/:module/:id', crmPerm('delete'), deleteRecord);

export default router;
