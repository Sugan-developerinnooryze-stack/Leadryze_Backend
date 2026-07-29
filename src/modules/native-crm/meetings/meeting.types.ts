export type RelatedModule = 'contact' | 'company' | 'deal' | 'customer' | 'quotation' | 'workorder' | 'contract';

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
}

export type UpdateMeetingDTO = Partial<CreateMeetingDTO>;
