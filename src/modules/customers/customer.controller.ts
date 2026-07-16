import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../types';
import * as customerService from './customer.service';
import { sendSuccess, sendCreated, sendError, sendPaginated } from '../../utils/response';
import { writeLog } from '../logs/log.service';
import { pushCustomerUpdate, pushCustomerDelete } from '../connectors/connector.service';

function actor(req: AuthRequest) {
  return {
    userId:    req.user?.userId,
    userEmail: req.user?.email,
    userRole:  req.user?.role,
  };
}

export async function createCustomer(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const customer = await customerService.createCustomer(req.tenantId!, req.body);
    sendCreated(res, customer, 'Customer created');
    writeLog({
      tenantId: req.tenantId!,
      service:  'backend',
      level:    'info',
      event:    'customer.created',
      message:  `Customer "${customer.name}" created`,
      metadata: {
        customerId:   String(customer._id),
        name:         customer.name,
        email:        customer.email,
        phone:        customer.phone,
        channel:      customer.channel,
        status:       customer.status,
        ...actor(req),
      },
    });
  } catch (err) { next(err); }
}

export async function getCustomers(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { customers, total, page, limit } = await customerService.getCustomers(req.tenantId!, req.query as Record<string, unknown>);
    sendPaginated(res, customers, total, page, limit);
  } catch (err) { next(err); }
}

export async function getCustomer(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const customer = await customerService.getCustomerById(req.tenantId!, req.params.id);
    if (!customer) { sendError(res, 'Customer not found', 404); return; }
    sendSuccess(res, customer);
  } catch (err) { next(err); }
}

export async function updateCustomer(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const customer = await customerService.updateCustomer(req.tenantId!, req.params.id, req.body);
    if (!customer) { sendError(res, 'Customer not found', 404); return; }
    sendSuccess(res, customer, 'Customer updated');
    writeLog({
      tenantId: req.tenantId!,
      service:  'backend',
      level:    'info',
      event:    'customer.updated',
      message:  `Customer "${customer.name}" updated`,
      metadata: {
        customerId:    String(customer._id),
        name:          customer.name,
        email:         customer.email,
        changedFields: Object.keys(req.body),
        ...actor(req),
      },
    });
    // Fire-and-forget write-back → pushes the update to the source CRM
    pushCustomerUpdate(req.tenantId!, {
      externalId: customer.externalId,
      channel:    customer.channel,
      recordType: customer.recordType,
      name:       customer.name,
      firstName:  customer.firstName,
      lastName:   customer.lastName,
      email:      customer.email,
      phone:      customer.phone,
      company:    customer.company,
      leadSource: customer.leadSource,
    });
  } catch (err) { next(err); }
}

export async function deleteCustomer(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    // Fetch before delete so we have channel/externalId for write-back
    const customer = await customerService.getCustomerById(req.tenantId!, req.params.id);
    await customerService.deleteCustomer(req.tenantId!, req.params.id);
    sendSuccess(res, null, 'Customer deleted');
    writeLog({
      tenantId: req.tenantId!,
      service:  'backend',
      level:    'warn',
      event:    'customer.deleted',
      message:  `Customer "${customer?.name || req.params.id}" deleted`,
      metadata: {
        customerId: req.params.id,
        name:       customer?.name,
        channel:    customer?.channel,
        ...actor(req),
      },
    });
    // Fire-and-forget delete write-back → removes record from source CRM
    if (customer) {
      pushCustomerDelete(req.tenantId!, {
        externalId: customer.externalId,
        channel:    customer.channel,
        recordType: customer.recordType,
        name:       customer.name,
      });
    }
  } catch (err) { next(err); }
}

export async function getCustomerStats(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const channels = req.query.channels
      ? String(req.query.channels).split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;
    const stats = await customerService.getCustomerStats(req.tenantId!, channels);
    sendSuccess(res, stats, 'Stats fetched');
  } catch (err) { next(err); }
}
