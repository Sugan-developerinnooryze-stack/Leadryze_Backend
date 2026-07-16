import { Router, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { authenticate } from '../../middlewares/auth.middleware';
import { requireTenant } from '../../middlewares/tenant.middleware';
import { AuthRequest } from '../../types';
import { sendSuccess, sendError, sendCreated } from '../../utils/response';
import { CalendarEvent } from './calendar-event.model';
import { getCalendarEvents } from './calendar.service';

const router = Router();
router.use(authenticate, requireTenant);

/* ── GET /api/v1/calendar/events?start=&end= ─────────────────────────────── */
router.get('/events', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const start = req.query.start ? new Date(req.query.start as string) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end   = req.query.end   ? new Date(req.query.end   as string) : new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);

    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      sendError(res, 'Invalid date range', 400);
      return;
    }

    const events = await getCalendarEvents(req.tenantId!, start, end);
    sendSuccess(res, events);
  } catch (err) { next(err); }
});

/* ── POST /api/v1/calendar/events ────────────────────────────────────────── */
router.post('/events', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { title, startDate, endDate, allDay, description, color, location, createdBy, linkedRecord } = req.body as {
      title: string; startDate: string; endDate?: string; allDay?: boolean;
      description?: string; color?: string; location?: string; createdBy?: string;
      linkedRecord?: { channel: string; module: string; externalId: string; displayName: string };
    };

    if (!title?.trim() || !startDate) {
      sendError(res, 'title and startDate are required', 400);
      return;
    }

    const event = await CalendarEvent.create({
      tenantId:    new mongoose.Types.ObjectId(req.tenantId!),
      title:       title.trim(),
      startDate:   new Date(startDate),
      endDate:     endDate ? new Date(endDate) : undefined,
      allDay:      allDay ?? false,
      description,
      color:       color || '#6366f1',
      location,
      createdBy,
      linkedRecord,
    });

    sendCreated(res, event, 'Event created');
  } catch (err) { next(err); }
});

/* ── PUT /api/v1/calendar/events/:id ─────────────────────────────────────── */
router.put('/events/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { title, startDate, endDate, allDay, description, color, location, linkedRecord } = req.body as {
      title?: string; startDate?: string; endDate?: string; allDay?: boolean;
      description?: string; color?: string; location?: string;
      linkedRecord?: { channel: string; module: string; externalId: string; displayName: string };
    };

    const update: Record<string, unknown> = {};
    if (title)       update.title       = title.trim();
    if (startDate)   update.startDate   = new Date(startDate);
    if (endDate !== undefined) update.endDate = endDate ? new Date(endDate) : null;
    if (allDay !== undefined)  update.allDay  = allDay;
    if (description !== undefined) update.description = description;
    if (color)       update.color       = color;
    if (location !== undefined) update.location = location;
    if (linkedRecord !== undefined) update.linkedRecord = linkedRecord;

    const event = await CalendarEvent.findOneAndUpdate(
      { _id: req.params.id, tenantId: new mongoose.Types.ObjectId(req.tenantId!) },
      { $set: update },
      { new: true }
    );

    if (!event) { sendError(res, 'Event not found', 404); return; }
    sendSuccess(res, event, 'Event updated');
  } catch (err) { next(err); }
});

/* ── DELETE /api/v1/calendar/events/:id ──────────────────────────────────── */
router.delete('/events/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const event = await CalendarEvent.findOneAndDelete({
      _id: req.params.id,
      tenantId: new mongoose.Types.ObjectId(req.tenantId!),
    });
    if (!event) { sendError(res, 'Event not found', 404); return; }
    sendSuccess(res, null, 'Event deleted');
  } catch (err) { next(err); }
});

export default router;
