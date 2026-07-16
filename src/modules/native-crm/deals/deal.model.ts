import mongoose from 'mongoose';
import { dealSchema } from './deal.schema';

export const Deal = mongoose.model('CrmDeal', dealSchema, 'crm_deals');
