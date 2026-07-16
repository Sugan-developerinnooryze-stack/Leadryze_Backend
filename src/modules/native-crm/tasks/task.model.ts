import mongoose from 'mongoose';
import { taskSchema } from './task.schema';

export const Task = mongoose.model('CrmTask', taskSchema, 'crm_tasks');
