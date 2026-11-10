/** Response contract of GET /api/v1/daily-events — the chat panel's
 * "Daily Events" view. Strictly read-only and deterministic (no AI call).
 * Mirrored by frontend/src/components/daily-events/types.ts. */

export type DailyEventBucket = 'today' | 'overdue' | 'upcoming';

export type DailyEventCategory =
  | 'meeting' | 'call' | 'task' | 'ticket' | 'workorder' | 'invoice'
  | 'contract' | 'quotation' | 'lead' | 'deal' | 'activity';

/** 'native_crm' | 'field_service' | 'connector:<type>' — never merged. */
export type DailyEventSourceKey = string;

export interface DailyEventStatus {
  key: string;
  label: string;
  /** open = still to do, done = finished, cancelled = called off, alert = past due */
  tone: 'open' | 'done' | 'cancelled' | 'alert';
}

export interface DailyEvent {
  /** Unique across the whole response: `<source>:<module>:<record id>[:<suffix>]`. */
  id: string;
  source: DailyEventSourceKey;
  module: string;
  moduleLabel: string;
  category: DailyEventCategory;
  bucket: DailyEventBucket;
  title: string;
  subtitle?: string;
  /** What the date means for this record: "Starts", "Due", "SLA due", "Closes"… */
  kind: string;
  /** Calendar date (YYYY-MM-DD) in the tenant's timezone. */
  date: string;
  /** HH:mm in the tenant's timezone; absent for all-day (date-only) items. */
  time?: string;
  endTime?: string;
  allDay: boolean;
  /** The stored instant, for sorting. */
  at: string;
  status?: DailyEventStatus;
  related?: { module: string; label: string };
  /** Linked to a lead (a task / call / meeting / activity about a lead). */
  leadFollowUp: boolean;
  assignee?: string;
  /** exact = the record's own page; otherwise the module's list page. */
  link?: { path: string; exact: boolean };
}

export interface DailyEventCounts { today: number; overdue: number; upcoming: number }

export type DailyEventModuleStatus = 'ok' | 'no_permission' | 'disabled' | 'error' | 'not_synced' | 'no_dates';

export interface DailyEventsModuleSummary {
  module: string;
  label: string;
  category: DailyEventCategory;
  status: DailyEventModuleStatus;
  /** Exact counts — present only when status is 'ok'. Never a fake zero. */
  counts?: DailyEventCounts;
  /** true where fewer events were returned than the count. */
  truncated?: { today: boolean; overdue: boolean; upcoming: boolean };
  /** Only part of the module could be checked (a scan limit was hit), so
   * its counts are a lower bound, not exact. */
  incomplete?: boolean;
  /** Which sections this module can appear in at all. */
  buckets: DailyEventBucket[];
  note?: string;
}

export interface DailyEventsSource {
  key: DailyEventSourceKey;
  label: string;
  kind: 'native' | 'connector';
  /** Sum over this source's 'ok' modules only. */
  counts: DailyEventCounts;
  /** true when at least one module could not be read. */
  partial: boolean;
  /** true when the source itself could not be read (no modules listed). */
  unavailable?: boolean;
  modules: DailyEventsModuleSummary[];
  connector?: { type: string; syncStatus: string; lastSyncAt: string | null };
}

/* ── Lead Activity & Conversion (Field Service leads) ─────────────────── */

export interface LeadStageInfo {
  key: string;
  label: string;
  color: string;
  order: number;
  /** A finished stage (won, lost, disqualified…) in the tenant's own pipeline. */
  finished: boolean;
  outcome: string | null;
  /** false for a stage switched off in the pipeline (old leads can still sit in it). */
  active: boolean;
  /** A stage found on leads but missing from the pipeline settings. */
  unknown?: boolean;
  count: number;
}

export type LeadSuggestionKind = 'convert' | 'follow_up_overdue' | 'plan_follow_up' | 're_engage' | 'assign_owner' | 'advance';

export interface LeadCard {
  id: string;
  name: string;
  company?: string;
  leadId?: string;
  stage: { key: string; label: string; color: string; finished: boolean; outcome: string | null };
  source?: string;
  /** The owner's name; "Assigned" when the lead has an owner whose name this user can't see. */
  owner?: string;
  /** Tenant-local calendar dates. lastActivityDate is the later of the lead's
   * own last update and the last completed call / meeting / task / activity
   * linked to it (from modules this user can see). */
  createdDate?: string;
  lastActivityDate?: string;
  daysSinceActivity?: number;
  /** The earliest open task / call / meeting / activity linked to the lead. */
  nextFollowUp?: { date: string; time?: string; kind: 'meeting' | 'call' | 'task' | 'activity'; title: string; overdue: boolean };
  conversion: { contact: boolean; opportunity: boolean; customer: boolean };
  /** A next step worked out from the record and the tenant's pipeline — never from AI. */
  suggestion?: { kind: LeadSuggestionKind; text: string };
  /** Today's conversion step (the furthest one)… */
  change?: 'customer' | 'contact' | 'opportunity';
  /** …and today's move into a won / lost stage, when the lead is still there. */
  outcome?: 'won' | 'lost';
  link: { path: string; exact: boolean };
}

/** One open call / meeting / task / activity linked to a lead. */
export interface LeadFollowUpItem {
  id: string;
  kind: 'meeting' | 'call' | 'task' | 'activity';
  title: string;
  /** Tenant-local date (YYYY-MM-DD) and time (absent for all-day items). */
  date: string;
  time?: string;
  overdue: boolean;
  lead: { id: string; name: string; stage: LeadCard['stage'] };
  /** The follow-up's own screen, and the lead. */
  link: { path: string; exact: boolean };
  leadLink: { path: string; exact: boolean };
}

export interface LeadInsightCounts {
  total: number;
  open: number;
  newToday: number;
  /** null when no follow-up module could be read (no access, switched off or
   * failed) — never a zero. With some modules failed they are lower bounds. */
  followUpsToday: number | null;
  followUpsOverdue: number | null;
  /** null unless every follow-up module was read: a missing module would
   * wrongly add its leads here. */
  noFollowUp: number | null;
  stuck: number;
  readyToConvert: number;
  convertedToday: number;
  wonToday: number;
  lostToday: number;
}

export interface LeadInsights {
  source: 'field_service';
  status: 'ok' | 'no_permission' | 'disabled' | 'error';
  /** "Stuck" = no activity for at least this many days (Settings → CRM Chatbot). */
  staleDays: number;
  stages: LeadStageInfo[];
  counts?: LeadInsightCounts;
  lists?: {
    needsAction: LeadCard[];
    /** true when more leads need action than the list holds. */
    needsActionTruncated: boolean;
    newToday: LeadCard[];
    noFollowUp: LeadCard[];
    stuck: LeadCard[];
    readyToConvert: LeadCard[];
    convertedToday: LeadCard[];
    /** Leads moved to a won or lost stage today (counts: wonToday + lostToday). */
    outcomesToday: LeadCard[];
    /** The open follow-ups behind the two follow-up counts, built by the same rule. */
    followUpsToday: LeadFollowUpItem[];
    followUpsOverdue: LeadFollowUpItem[];
  };
  /** Up to a few leads per stage, most recently active first. */
  byStage?: Record<string, LeadCard[]>;
  /** Linked modules checked for follow-ups (only the ones this user can see)… */
  followUpModules: string[];
  /** …and any of them that could not be read (follow-up numbers are then incomplete). */
  followUpFailed: string[];
}

export interface DailyEventsResponse {
  /** Today in the tenant's timezone (YYYY-MM-DD). */
  date: string;
  timezone: string;
  /** true when the tenant's timezone setting was invalid and UTC was used. */
  timezoneFallback: boolean;
  generatedAt: string;
  /** Last day (YYYY-MM-DD) covered by "upcoming". */
  upcomingThrough: string;
  sources: DailyEventsSource[];
  events: DailyEvent[];
  /** Plain-language list of what this view does not cover. */
  notIncluded: string[];
  /** Lead pipeline, follow-ups and conversions (absent when not built). */
  leads?: LeadInsights;
}
