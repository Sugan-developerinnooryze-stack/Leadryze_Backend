import mongoose from 'mongoose';
import { contactSchema } from './contact.schema';

export const Contact = mongoose.model('CrmContact', contactSchema, 'crm_contacts');
