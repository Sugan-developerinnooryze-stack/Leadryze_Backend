import mongoose from 'mongoose';
import { callSchema } from './call.schema';

export const Call = mongoose.model('CrmCall', callSchema, 'crm_calls');
