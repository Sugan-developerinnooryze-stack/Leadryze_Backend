import mongoose from 'mongoose';
import { companySchema } from './company.schema';

export const Company = mongoose.model('CrmCompany', companySchema, 'crm_companies');
