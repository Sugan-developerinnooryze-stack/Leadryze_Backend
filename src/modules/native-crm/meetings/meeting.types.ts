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
}

export type UpdateMeetingDTO = Partial<CreateMeetingDTO>;
