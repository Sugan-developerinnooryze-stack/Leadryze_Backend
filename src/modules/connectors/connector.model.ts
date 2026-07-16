import mongoose, { Schema, Document } from 'mongoose';

/**
 * @swagger
 * components:
 *   schemas:
 *     Connector:
 *       type: object
 *       properties:
 *         _id: { type: string }
 *         tenantId: { type: string }
 *         name: { type: string }
 *         type: { type: string, enum: [mongodb, mysql, postgresql, rest, hubspot, zoho, salesforce] }
 *         isActive: { type: boolean }
 *         syncStatus: { type: string, enum: [idle, syncing, success, failed] }
 */
export interface IConnector extends Document {
  tenantId: mongoose.Types.ObjectId;
  name: string;
  type: 'mongodb' | 'mysql' | 'postgresql' | 'rest' | 'hubspot' | 'zoho' | 'salesforce';
  isActive: boolean;
  config: {
    host?: string;
    port?: number;
    database?: string;
    username?: string;
    password?: string;
    uri?: string;
    baseUrl?: string;
    apiKey?: string;
    accessToken?: string;
    refreshToken?: string;
    headers?: Record<string, string>;
    hubId?: string;      // HubSpot portalId — used to route inbound webhooks to the right tenant
    webhookSecret?: string; // per-connector secret for HubSpot webhook signature verification
  };
  mapping: {
    customerFields: Record<string, string>;
    orderFields?: Record<string, string>;
  };
  lastSyncAt?: Date;
  syncStatus: 'idle' | 'syncing' | 'success' | 'failed';
  syncError?: string;
}

const connectorSchema = new Schema<IConnector>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    name: { type: String, required: true, trim: true },
    type: {
      type: String,
      enum: ['mongodb', 'mysql', 'postgresql', 'rest', 'hubspot', 'zoho', 'salesforce'],
      required: true,
    },
    isActive: { type: Boolean, default: true },
    config: {
      host: String,
      port: Number,
      database: String,
      username: String,
      password: { type: String, select: false },
      uri: { type: String, select: false },
      baseUrl: String,
      apiKey: { type: String, select: false },
      accessToken: { type: String, select: false },
      refreshToken: { type: String, select: false },
      headers: { type: Schema.Types.Mixed, default: {} },
      hubId: String,
      webhookSecret: { type: String, select: false },
    },
    mapping: {
      customerFields: { type: Schema.Types.Mixed, default: {} },
      orderFields: { type: Schema.Types.Mixed, default: {} },
    },
    lastSyncAt: Date,
    syncStatus: {
      type: String,
      enum: ['idle', 'syncing', 'success', 'failed'],
      default: 'idle',
    },
    syncError: String,
  },
  { timestamps: true }
);

connectorSchema.index({ tenantId: 1, type: 1 });

export const Connector = mongoose.model<IConnector>('Connector', connectorSchema);
