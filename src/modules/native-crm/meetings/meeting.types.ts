export type RelatedModule = 'contact' | 'company' | 'deal' | 'customer' | 'quotation' | 'workorder' | 'contract' | 'lead';

export interface IMeeting {
  _id: string;
  tenantId: string;
  title: string;
  startDate?: Date;
  endDate?: Date;
  location?: string;
  attendees?: string[];
  meetingStatus: 'scheduled' | 'completed' | 'cancelled';
  notes?: string;
  tags?: string[];
  relatedModule?: RelatedModule;
  relatedId?: string;
  relatedLabel?: string;
  createdBy?: string;
  assignedStaffId?: string;
  assignedStaffName?: string;
  source?: 'manual' | 'widget';
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateMeetingDTO {
  title: string;
  startDate?: string;
  endDate?: string;
  location?: string;
  attendees?: string[];
  meetingStatus?: string;
  notes?: string;
  tags?: string[];
  relatedModule?: RelatedModule;
  relatedId?: string;
  relatedLabel?: string;
  assignedStaffId?: string;
  assignedStaffName?: string;
  source?: 'manual' | 'widget';
}

export type UpdateMeetingDTO = Partial<CreateMeetingDTO>;
