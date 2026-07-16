import { Router, Response } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate.middleware';
import { sendSuccess, sendError, sendPaginated } from '../../utils/response';
import { authRateLimit } from '../../middlewares/rate-limit.middleware';
import { NativeStaff } from '../native-crm/staffs/staff.model';
import { NativeCustomer } from '../native-crm/customers/customer.model';
import { listWorkorders } from '../native-crm/workorders/workorder.service';
import { loginAppUser, InvalidCredentialsError } from './app-auth.service';
import { authenticateApp, AppAuthRequest } from './app-auth.middleware';

const loginSchema = z.object({
  clientId: z.string().trim().min(1),
  username: z.string().trim().min(1),
  password: z.string().min(1),
});

/* ── Staff app ─────────────────────────────────────────────────────────────── */

export const staffAuthRouter = Router();

staffAuthRouter.post('/login', authRateLimit, validate({ body: loginSchema }), async (req, res: Response) => {
  try {
    const { clientId, username, password } = req.body;
    const { token, account } = await loginAppUser(NativeStaff, 'staff', clientId, username, password, 'staffId');
    sendSuccess(res, {
      accessToken: token,
      staff: {
        _id:       account._id,
        staffId:   account.staffId,
        clientId:  account.clientId,
        firstName: account.firstName,
        lastName:  account.lastName,
        email:     account.email,
        phone:     account.phone,
        role:      account.role,
        skills:    account.skills ?? [],
      },
    }, 'Login successful');
  } catch (err: any) {
    if (err instanceof InvalidCredentialsError) return sendError(res, 'Invalid credentials', 401);
    sendError(res, 'Login failed', 500);
  }
});

staffAuthRouter.get('/me', authenticateApp('staff'), async (req: AppAuthRequest, res: Response) => {
  try {
    const staff = await NativeStaff.findOne({ _id: req.appUser!.sub, tenantId: req.appUser!.tenantId })
      .populate('teamId', 'name')
      .lean();
    if (!staff) return sendError(res, 'Account not found', 404);
    sendSuccess(res, staff);
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
});

staffAuthRouter.get('/workorders', authenticateApp('staff'), async (req: AppAuthRequest, res: Response) => {
  try {
    const { page, limit, status } = req.query as Record<string, string | undefined>;
    const { items, total, page: p } = await listWorkorders(req.appUser!.tenantId, {
      page:  page  ?? 1,
      limit: limit ?? 20,
      status,
      staffId: req.appUser!.code, // only workorders assigned to this staff
    });
    sendPaginated(res, items, total, p, Number(limit ?? 20));
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
});

/* ── Customer app ──────────────────────────────────────────────────────────── */

export const customerAuthRouter = Router();

customerAuthRouter.post('/login', authRateLimit, validate({ body: loginSchema }), async (req, res: Response) => {
  try {
    const { clientId, username, password } = req.body;
    const { token, account } = await loginAppUser(NativeCustomer, 'customer', clientId, username, password, 'customerId');
    sendSuccess(res, {
      accessToken: token,
      customer: {
        _id:        account._id,
        customerId: account.customerId,
        clientId:   account.clientId,
        name:       account.name,
        email:      account.email,
        phone:      account.phone,
        company:    account.company,
      },
    }, 'Login successful');
  } catch (err: any) {
    if (err instanceof InvalidCredentialsError) return sendError(res, 'Invalid credentials', 401);
    sendError(res, 'Login failed', 500);
  }
});

customerAuthRouter.get('/me', authenticateApp('customer'), async (req: AppAuthRequest, res: Response) => {
  try {
    const customer = await NativeCustomer.findOne({ _id: req.appUser!.sub, tenantId: req.appUser!.tenantId }).lean();
    if (!customer) return sendError(res, 'Account not found', 404);
    sendSuccess(res, customer);
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
});

customerAuthRouter.get('/workorders', authenticateApp('customer'), async (req: AppAuthRequest, res: Response) => {
  try {
    const { page, limit, status } = req.query as Record<string, string | undefined>;
    const { items, total, page: p } = await listWorkorders(req.appUser!.tenantId, {
      page:  page  ?? 1,
      limit: limit ?? 20,
      status,
      customerId: req.appUser!.code, // only this customer's workorders
    });
    sendPaginated(res, items, total, p, Number(limit ?? 20));
  } catch (err: any) {
    sendError(res, err.message, 500);
  }
});
