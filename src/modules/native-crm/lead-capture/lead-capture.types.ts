import { CapturePlatform, CaptureStatus } from './lead-capture.model';

export interface CaptureLeadInput {
  platform:  CapturePlatform;
  sourceUrl: string;
  raw:       Record<string, any>;
  extensionVersion?: string;
  /** Only ever supplied by the AI widget's own caller (the internal
   * widget-lead-capture handler, after calling assignRoundRobin()) — the
   * browser-extension's own call sites never pass these, so they're
   * completely unaffected by this addition. */
  assignedStaffId?: string;
  assignedStaffName?: string;
  /** AI-computed conversation signals — only ever supplied by the AI
   * widget's own caller, same as assignedStaffId/assignedStaffName above.
   * leadScore/buyingIntent map onto Lead's existing score/rating fields;
   * interestedItems/requirement/conversationSummary land on the new fields
   * added alongside them (see lead.model.ts). */
  leadScore?: number;
  buyingIntent?: 'low' | 'medium' | 'high';
  interestedItems?: Array<{ datasetId: string; datasetVersion: number; recordId: string; title: string }>;
  requirement?: string;
  conversationSummary?: string;
  /** The widget's own chat sessionId — distinct from `sourceUrl` above
   * (which already exists and is populated from this same caller). */
  chatSessionId?: string;
}

export interface LeadCaptureListOptions {
  page?:             number | string;
  limit?:            number | string;
  platform?:         string;
  status?:           string;
  capturedByUserId?: string;
  startDate?:        string;
  endDate?:          string;
}
