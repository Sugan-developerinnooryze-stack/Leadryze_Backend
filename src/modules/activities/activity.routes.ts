import { Router, Response } from 'express';
import { authenticate } from '../../middlewares/auth.middleware';
import { requireTenant } from '../../middlewares/tenant.middleware';
import { AuthRequest } from '../../types';
import {
  createActivity, listActivities, getActivity,
  updateActivity, deleteActivity, getActivityStats,
} from './activity.service';
import { sendEmailNow } from '../messages/brevo.service';
import { sendSmsNow } from '../messages/twilio.service';
import { Tenant } from '../tenants/tenant.model';

const router = Router();
router.use(authenticate, requireTenant);

router.get('/stats', async (req: AuthRequest, res: Response) => {
  try {
    const stats = await getActivityStats(req.tenantId!);
    res.json({ success: true, data: stats });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to fetch stats' });
  }
});

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const page  = Math.max(1, parseInt(String(req.query.page  || '1')));
    const limit = Math.min(100, parseInt(String(req.query.limit || '20')));
    const result = await listActivities(req.tenantId!, {
      type:   req.query.type   as string | undefined as any,
      status: req.query.status as string | undefined as any,
      page, limit,
    });
    res.json({ success: true, data: result.items, meta: { total: result.total, page: result.page, pages: result.pages } });
  } catch {
    res.status(500).json({ success: false, message: 'Failed to fetch activities' });
  }
});

router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    if (!req.body.title) return res.status(400).json({ success: false, message: 'title is required' });
    if (!req.body.type)  return res.status(400).json({ success: false, message: 'type is required' });
    const activity = await createActivity(req.tenantId!, req.body);
    res.status(201).json({ success: true, data: activity });
  } catch {
    res.status(500).json({ success: false, message: 'Failed to create activity' });
  }
});

router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const activity = await getActivity(req.tenantId!, req.params.id);
    if (!activity) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: activity });
  } catch {
    res.status(500).json({ success: false, message: 'Failed to fetch activity' });
  }
});

router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const activity = await updateActivity(req.tenantId!, req.params.id, req.body);
    if (!activity) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true, data: activity });
  } catch {
    res.status(500).json({ success: false, message: 'Failed to update activity' });
  }
});

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const ok = await deleteActivity(req.tenantId!, req.params.id);
    if (!ok) return res.status(404).json({ success: false, message: 'Not found' });
    res.json({ success: true });
  } catch {
    res.status(500).json({ success: false, message: 'Failed to delete activity' });
  }
});

/* ── POST /api/v1/activities/:id/notify — send email/SMS for an activity ── */
router.post('/:id/notify', async (req: AuthRequest, res: Response) => {
  try {
    const activity = await getActivity(req.tenantId!, req.params.id);
    if (!activity) { res.status(404).json({ success: false, message: 'Activity not found' }); return; }

    const { sendEmail: doEmail, sendSms: doSms } = req.body as { sendEmail?: boolean; sendSms?: boolean };
    const person = activity.linkedPerson;

    const tenant = await Tenant.findById(req.tenantId).select('name branding').lean();
    const companyName = (tenant as { branding?: { companyName?: string }; name?: string })?.branding?.companyName || (tenant as { name?: string })?.name || 'Us';

    const start = activity.startDate
      ? new Date(activity.startDate).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
      : activity.dueDate
        ? new Date(activity.dueDate).toLocaleDateString('en-US', { dateStyle: 'medium' })
        : '';

    const results: Record<string, boolean> = {};

    if (doEmail && person?.email) {
      const subject = `${activity.title} — ${start || 'Scheduled'}`;
      const html = [
        `<p style="font-family:Arial,sans-serif">Dear <strong>${person.displayName}</strong>,</p>`,
        `<p>Your <strong>${activity.type}</strong> has been confirmed.</p>`,
        `<table style="font-family:Arial,sans-serif;border-collapse:collapse;width:100%;max-width:500px">`,
        `<tr><td style="padding:6px 12px;color:#6b7280;width:40%">Title</td><td style="padding:6px 12px;font-weight:600">${activity.title}</td></tr>`,
        start ? `<tr><td style="padding:6px 12px;color:#6b7280">Date &amp; Time</td><td style="padding:6px 12px;font-weight:600">${start}</td></tr>` : '',
        activity.location ? `<tr><td style="padding:6px 12px;color:#6b7280">Location</td><td style="padding:6px 12px">${activity.location}</td></tr>` : '',
        (activity.fields as Record<string, unknown>)?.meetingLink ? `<tr><td style="padding:6px 12px;color:#6b7280">Meeting Link</td><td style="padding:6px 12px"><a href="${(activity.fields as Record<string, unknown>).meetingLink}">${(activity.fields as Record<string, unknown>).meetingLink}</a></td></tr>` : '',
        activity.notes ? `<tr><td style="padding:6px 12px;color:#6b7280">Notes</td><td style="padding:6px 12px">${activity.notes}</td></tr>` : '',
        `</table>`,
        `<p style="font-family:Arial,sans-serif;color:#6b7280;margin-top:20px">Best regards,<br/><strong>${companyName}</strong></p>`,
      ].filter(Boolean).join('');
      try {
        await sendEmailNow({ to: person.email, toName: person.displayName, subject, htmlContent: html });
        results.email = true;
      } catch { results.email = false; }
    }

    if (doSms && person?.phone) {
      const smsText = `Hi ${person.displayName}, your ${activity.type} "${activity.title}"${start ? ` is scheduled for ${start}` : ''}.${activity.location ? ` Location: ${activity.location}` : ''} — ${companyName}`;
      try {
        await sendSmsNow({ to: person.phone, body: smsText });
        results.sms = true;
      } catch { results.sms = false; }
    }

    res.json({ success: true, data: results });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Notification failed' });
  }
});

export default router;
