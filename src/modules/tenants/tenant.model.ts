import mongoose, { Schema, Document } from 'mongoose';

/**
 * @swagger
 * components:
 *   schemas:
 *     Tenant:
 *       type: object
 *       properties:
 *         _id: { type: string }
 *         name: { type: string }
 *         slug: { type: string }
 *         plan: { type: string, enum: [starter, professional, enterprise] }
 *         isActive: { type: boolean }
 */
export interface IFeatureFlags {
  // Sidebar navigation visibility
  nav_dashboard:   boolean;
  nav_aiChat:      boolean;
  nav_customers:   boolean;
  nav_campaigns:   boolean;
  nav_templates:   boolean;
  nav_analytics:   boolean;
  nav_knowledge:   boolean;
  nav_logs:        boolean;
  nav_connectors:  boolean;
  nav_settings:    boolean;
  nav_crmData:     boolean;
  // Customers page tabs
  customers_tabLeads:    boolean;
  customers_tabContacts: boolean;
  customers_tabDirect:   boolean;
  // Connector visibility per type
  connector_zoho:        boolean;
  connector_hubspot:     boolean;
  connector_salesforce:  boolean;
  connector_rest:        boolean;
  connector_mysql:       boolean;
  connector_postgresql:  boolean;
  connector_mongodb:     boolean;
  // Bot / AI controls
  bot_enabled:       boolean;
  bot_leadCapture:   boolean;
  bot_escalation:    boolean;
  bot_ragSearch:     boolean;
  bot_piiMasking:    boolean;
  bot_contentGuard:  boolean;
  // Automation controls
  auto_followup:    boolean;
  auto_booking:     boolean;
  auto_reminder:    boolean;
  auto_feedback:    boolean;
}

export const DEFAULT_FEATURE_FLAGS: IFeatureFlags = {
  nav_dashboard:   true,
  nav_aiChat:      true,
  nav_customers:   true,
  nav_campaigns:   true,
  nav_templates:   true,
  nav_analytics:   true,
  nav_knowledge:   true,
  nav_logs:        true,
  nav_connectors:  true,
  nav_settings:    true,
  nav_crmData:     true,
  customers_tabLeads:    true,
  customers_tabContacts: true,
  customers_tabDirect:   true,
  connector_zoho:        true,
  connector_hubspot:     true,
  connector_salesforce:  true,
  connector_rest:        true,
  connector_mysql:       true,
  connector_postgresql:  true,
  connector_mongodb:     true,
  bot_enabled:      true,
  bot_leadCapture:  true,
  bot_escalation:   true,
  bot_ragSearch:    true,
  bot_piiMasking:   true,
  bot_contentGuard: true,
  auto_followup:    false,
  auto_booking:     false,
  auto_reminder:    false,
  auto_feedback:    false,
};

export interface ITenant extends Document {
  name: string;
  slug: string;
  clientId?: string;
  domain?: string;
  plan: 'starter' | 'professional' | 'enterprise';
  isActive: boolean;
  featureFlags: IFeatureFlags;
  settings: {
    allowedChannels: string[];
    maxUsers: number;
    maxLeadsPerMonth: number;
    timezone: string;
    language: string;
    crmOption: 'with_crm' | 'no_crm';
  };
  branding: {
    logoUrl?: string;
    primaryColor?: string;
    companyName?: string;
  };
  aiConfig: {
    systemPrompt?: string;
    language: string;
    fallbackToHuman: boolean;
    agentName?: string;
    /** Monthly token budget for the public widget's AI/LLM replies.
     * Undefined = fall back to a plan-tier default (see ai/src/services/
     * context.builder.ts) rather than being unlimited — an explicit value
     * here is a per-tenant override for a custom deal. Never applies to the
     * internal, staff-authenticated assistant (a different, unmetered
     * surface — see isPublicVisitor in base.agent.ts). */
    monthlyTokenLimit?: number;
  };
  /** Public embeddable chatbot widget — a tenant installs one <script> tag on
   * THEIR OWN website; an anonymous visitor's browser talks only to the
   * backend (never directly to the AI microservice or Mongo), resolved via
   * `widgetKey` rather than a JWT. Deliberately separate from
   * `featureFlags.bot_enabled` (which gates the INTERNAL, staff-authenticated
   * AI chat) — these gate two different surfaces and must stay independently
   * toggleable. Reuses the existing `branding`/`aiConfig` fields above for
   * the widget's own theming/persona — no duplication needed there. */
  widget: {
    enabled: boolean;
    /** "wgt_" + 32 hex chars — server-generated only (regenerateWidgetKey()),
     * NEVER accepted from the generic tenant-update payload (see
     * updateTenant()'s own dot-notation write, which deliberately never
     * includes this key). Safe to embed in a client's public page source —
     * it only identifies WHICH tenant, unlike the AI service's own internal
     * API key, which grants access to every tenant if leaked. */
    widgetKey?: string;
    /** Bare hostnames only (no scheme/port/path), lowercase — e.g.
     * "example.com", "www.example.com". Exact match only in this pass, no
     * subdomain wildcarding. */
    allowedDomains: string[];
    greeting?: string;
    /** Round-robin assignment scope for a Lead captured via this widget —
     * null/absent means rotate across every active staff member tenant-wide. */
    defaultTeamId?: mongoose.Types.ObjectId | null;
    /** The tenant's own public website — crawled (manually, via "Crawl Now")
     * into the RAG knowledge base so the widget can answer questions about
     * that specific site's own content. lastCrawledAt/crawlPageCount are
     * status fields, not user-editable config. */
    websiteUrl?: string;
    lastCrawledAt?: Date;
    crawlPageCount?: number;
    /** Real booking, tenant-wide business hours only in this pass — no
     * per-staff calendars/schedules exist anywhere in this codebase, and no
     * calendar-sync integration (Google/Outlook) is built. A booked slot is
     * simply any slot in these hours not already occupied by another
     * scheduled Meeting; round-robin still decides WHICH staff member gets
     * assigned, same as lead capture already does — this doesn't add a
     * second, competing assignment mechanism. */
    booking?: {
      enabled: boolean;
      timezone: string;
      slotMinutes: number;
      leadTimeHours: number;
      horizonDays: number;
      hours: Array<{ day: 0 | 1 | 2 | 3 | 4 | 5 | 6; start: string; end: string }>;
    };
  };
}

const tenantSchema = new Schema<ITenant>(
  {
    name:     { type: String, required: true, trim: true },
    slug:     { type: String, required: true, unique: true, lowercase: true, trim: true },
    clientId: { type: String, unique: true, sparse: true, index: true },
    domain:   String,
    plan: { type: String, enum: ['starter', 'professional', 'enterprise'], default: 'starter' },
    isActive: { type: Boolean, default: true },
    featureFlags: {
      nav_dashboard:         { type: Boolean, default: true },
      nav_aiChat:            { type: Boolean, default: true },
      nav_customers:         { type: Boolean, default: true },
      nav_campaigns:         { type: Boolean, default: true },
      nav_templates:         { type: Boolean, default: true },
      nav_analytics:         { type: Boolean, default: true },
      nav_knowledge:         { type: Boolean, default: true },
      nav_logs:              { type: Boolean, default: true },
      nav_connectors:        { type: Boolean, default: true },
      nav_settings:          { type: Boolean, default: true },
      nav_crmData:           { type: Boolean, default: true },
      customers_tabLeads:    { type: Boolean, default: true },
      customers_tabContacts: { type: Boolean, default: true },
      customers_tabDirect:   { type: Boolean, default: true },
      connector_zoho:        { type: Boolean, default: true },
      connector_hubspot:     { type: Boolean, default: true },
      connector_salesforce:  { type: Boolean, default: true },
      connector_rest:        { type: Boolean, default: true },
      connector_mysql:       { type: Boolean, default: true },
      connector_postgresql:  { type: Boolean, default: true },
      connector_mongodb:     { type: Boolean, default: true },
      bot_enabled:           { type: Boolean, default: true },
      bot_leadCapture:       { type: Boolean, default: true },
      bot_escalation:        { type: Boolean, default: true },
      bot_ragSearch:         { type: Boolean, default: true },
      bot_piiMasking:        { type: Boolean, default: true },
      bot_contentGuard:      { type: Boolean, default: true },
      auto_followup:         { type: Boolean, default: false },
      auto_booking:          { type: Boolean, default: false },
      auto_reminder:         { type: Boolean, default: false },
      auto_feedback:         { type: Boolean, default: false },
    },
    settings: {
      allowedChannels: { type: [String], default: ['web', 'whatsapp'] },
      maxUsers: { type: Number, default: 5 },
      maxLeadsPerMonth: { type: Number, default: 500 },
      timezone: { type: String, default: 'Asia/Singapore' },
      language: { type: String, default: 'en' },
      crmOption: { type: String, enum: ['with_crm', 'no_crm'], default: 'no_crm' },
    },
    branding: {
      logoUrl: String,
      primaryColor: { type: String, default: '#00B8D9' },
      companyName: String,
    },
    aiConfig: {
      systemPrompt: String,
      language: { type: String, default: 'en' },
      fallbackToHuman: { type: Boolean, default: true },
      agentName: String,
      monthlyTokenLimit: Number,
    },
    widget: {
      enabled:        { type: Boolean, default: false },
      widgetKey:      { type: String, unique: true, sparse: true, index: true },
      allowedDomains: { type: [String], default: [] },
      greeting:       String,
      defaultTeamId:  { type: Schema.Types.ObjectId, ref: 'NativeTeam', default: null },
      websiteUrl:     String,
      lastCrawledAt:  Date,
      crawlPageCount: Number,
      booking: {
        enabled:       { type: Boolean, default: false },
        timezone:      { type: String, default: 'UTC' },
        slotMinutes:   { type: Number, default: 30 },
        leadTimeHours: { type: Number, default: 2 },
        horizonDays:   { type: Number, default: 14 },
        hours: {
          type: [{
            day:   { type: Number, min: 0, max: 6 },
            start: { type: String },
            end:   { type: String },
          }],
          default: [
            { day: 1, start: '09:00', end: '17:00' },
            { day: 2, start: '09:00', end: '17:00' },
            { day: 3, start: '09:00', end: '17:00' },
            { day: 4, start: '09:00', end: '17:00' },
            { day: 5, start: '09:00', end: '17:00' },
          ],
        },
      },
    },
  },
  { timestamps: true }
);

export const Tenant = mongoose.model<ITenant>('Tenant', tenantSchema);
