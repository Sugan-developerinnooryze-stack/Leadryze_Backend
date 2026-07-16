import mongoose from 'mongoose';
import { meetingSchema } from './meeting.schema';

export const Meeting = mongoose.model('CrmMeeting', meetingSchema, 'crm_meetings');
