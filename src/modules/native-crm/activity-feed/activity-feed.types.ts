export type ActivityKind = 'task' | 'ticket' | 'call' | 'meeting' | 'email';

export type RelatedModule = 'contact' | 'company' | 'deal' | 'customer' | 'quotation' | 'workorder' | 'contract';

export interface ActivityFeedQuery {
  relatedModule: RelatedModule;
  relatedId:     string;
  page?:  number;
  limit?: number;
}

export interface ActivityFeedItem {
  kind: ActivityKind;
  at:   Date;
  [key: string]: unknown;
}
