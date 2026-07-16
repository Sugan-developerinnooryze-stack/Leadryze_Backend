import { z } from 'zod';
import { customFields } from '../../../utils/common.schemas';

export const createMeetingSchema = z.object({
  title:         z.string().trim().min(1).max(300),
  startDate:     z.string().optional(),
  endDate:       z.string().optional(),
  location:      z.string().trim().optional(),
  attendees:     z.array(z.string()).optional(),
  meetingStatus: z.enum(['scheduled','completed','cancelled']).optional(),
  notes:         z.string().optional(),
  tags:          z.array(z.string()).optional(),
  customFields,
});

export const updateMeetingSchema = createMeetingSchema.partial();
