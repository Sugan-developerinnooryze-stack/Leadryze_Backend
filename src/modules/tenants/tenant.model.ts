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
    },
  },
  { timestamps: true }
);

export const Tenant = mongoose.model<ITenant>('Tenant', tenantSchema);
