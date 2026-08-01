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
