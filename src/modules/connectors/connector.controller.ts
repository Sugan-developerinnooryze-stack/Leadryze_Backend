import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../types';
import * as connectorService from './connector.service';
import { sendSuccess, sendCreated, sendError } from '../../utils/response';
import { writeLog } from '../logs/log.service';

function actor(req: AuthRequest) {
  return {
    userId:    req.user?.userId,
    userEmail: req.user?.email,
    userRole:  req.user?.role,
  };
}

export async function createConnector(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const connector = await connectorService.createConnector(req.tenantId!, req.body);
    sendCreated(res, connector, 'Connector created');
    writeLog({
      tenantId: req.tenantId!,
      service:  'backend',
      level:    'info',
      event:    'connector.created',
      message:  `Connector "${connector.name}" (${connector.type}) connected`,
      metadata: {
        connectorId:   String(connector._id),
        connectorName: connector.name,
        connectorType: connector.type,
        ...actor(req),
      },
    });
  } catch (err) { next(err); }
}

export async function getConnectors(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const connectors = await connectorService.getConnectors(req.tenantId!);
    sendSuccess(res, connectors);
  } catch (err) { next(err); }
}

export async function getConnector(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const connector = await connectorService.getConnectorById(req.tenantId!, req.params.id);
    if (!connector) { sendError(res, 'Connector not found', 404); return; }
    sendSuccess(res, connector);
  } catch (err) { next(err); }
}

export async function updateConnector(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const connector = await connectorService.updateConnector(req.tenantId!, req.params.id, req.body);
    if (!connector) { sendError(res, 'Connector not found', 404); return; }
    sendSuccess(res, connector, 'Connector updated');
    writeLog({
      tenantId: req.tenantId!,
      service:  'backend',
      level:    'info',
      event:    'connector.updated',
      message:  `Connector "${connector.name}" (${connector.type}) settings updated`,
      metadata: {
        connectorId:   String(connector._id),
        connectorName: connector.name,
        connectorType: connector.type,
        changedFields: Object.keys(req.body),
        ...actor(req),
      },
    });
  } catch (err) { next(err); }
}

export async function deleteConnector(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    await connectorService.deleteConnector(req.tenantId!, req.params.id);
    sendSuccess(res, null, 'Connector removed');
    writeLog({
      tenantId: req.tenantId!,
      service:  'backend',
      level:    'warn',
      event:    'connector.deleted',
      message:  `Connector ${req.params.id} disconnected and removed`,
      metadata: {
        connectorId: req.params.id,
        ...actor(req),
      },
    });
  } catch (err) { next(err); }
}

export async function testConnector(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const result = await connectorService.testConnector(req.tenantId!, req.params.id);
    sendSuccess(res, result, result.message);
  } catch (err) { next(err); }
}

export async function fetchCRMCustomers(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const customers = await connectorService.fetchCRMCustomers(req.tenantId!, req.params.id);
    sendSuccess(res, customers, `${customers.length} customers fetched from CRM`);
  } catch (err) { next(err); }
}

export async function syncCRMCustomers(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const connector = await connectorService.getConnectorById(req.tenantId!, req.params.id);
    if (!connector) { sendError(res, 'Connector not found', 404); return; }

    // Respond immediately — Salesforce/HubSpot syncs take 3-10 minutes with large orgs.
    // Waiting synchronously causes browser HTTP timeouts (red X) even though the sync is running.
    // The sync runs in the background; the sidebar auto-updates after cron or on next page load.
    sendSuccess(res, { status: 'syncing', type: connector.type }, 'Sync started — data will update in a few minutes');

    // Fire-and-forget: runs after response is sent
    connectorService.syncCRMToLocal(req.tenantId!, req.params.id)
      .then((result) => {
        const hasChanges = result.created > 0 || result.updated > 0 || result.deleted > 0;
        writeLog({
          tenantId: req.tenantId!,
          service:  'backend',
          level:    hasChanges ? 'info' : 'debug',
          event:    'connector.sync',
          message:  `CRM sync — ${connector.name} (${connector.type}): +${result.created} created, ~${result.updated} updated, -${result.deleted} deleted`,
          metadata: {
            connectorId:   req.params.id,
            connectorName: connector.name,
            connectorType: connector.type,
            created:       result.created,
            updated:       result.updated,
            deleted:       result.deleted,
            total:         result.total,
            triggeredBy:   'manual',
            ...actor(req),
          },
        });
      })
      .catch((err: Error) => {
        writeLog({
          tenantId: req.tenantId!,
          service:  'backend',
          level:    'error',
          event:    'connector.sync_failed',
          message:  `Manual sync failed — ${connector.name} (${connector.type}): ${err.message}`,
          metadata: { connectorId: req.params.id, error: err.message },
        });
      });
  } catch (err) { next(err); }
}
