export type RelatedModule = 'contact' | 'company' | 'deal' | 'customer' | 'quotation' | 'workorder' | 'contract';

export interface ITask {
  _id: string;
  tenantId: string;
  title: string;
  dueDate?: Date;
  priority: 'low' | 'medium' | 'high';
  taskStatus: 'todo' | 'in_progress' | 'done' | 'cancelled';
  assignedTo?: string;
  notes?: string;
  tags?: string[];
  relatedModule?: RelatedModule;
  relatedId?: string;
  relatedLabel?: string;
  createdBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateTaskDTO {
  title: string;
  dueDate?: string;
  priority?: string;
  taskStatus?: string;
  assignedTo?: string;
  notes?: string;
  tags?: string[];
  relatedModule?: RelatedModule;
  relatedId?: string;
  relatedLabel?: string;
}

export type UpdateTaskDTO = Partial<CreateTaskDTO>;
