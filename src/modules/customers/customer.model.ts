import mongoose, { Schema, Document } from 'mongoose';

/**
 * @swagger
 * components:
 *   schemas:
 *     Customer:
 *       type: object
 *       properties:
 *         _id: { type: string }
 *         tenantId: { type: string }
 *         firstName: { type: string }
 *         lastName: { type: string }
 *         email: { type: string }
 *         phone: { type: string }
 *         channel: { type: string, enum: [web, whatsapp, instagram, email, phone] }
 *         status: { type: string, enum: [new, contacted, qualified, booked, lost] }
 */
export interface ICustomer extends Document {
  tenantId: mongoose.Types.ObjectId;
  name: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  company?: string;
  leadSource?: string;
  channel: 'web' | 'whatsapp' | 'instagram' | 'email' | 'phone' | 'zoho' | 'hubspot' | 'salesforce' | 'rest' | 'mysql' | 'postgresql' | 'mongodb';
  // All connectors this customer was found in: ['zoho', 'hubspot', 'mysql']
  sources: string[];
  // externalId per connector: { zoho: '123', hubspot: '456', mysql: 'db001' }
  externalIds: Map<string, string>;
  recordType: 'lead' | 'contact' | 'customer';
  status: 'new' | 'contacted' | 'qualified' | 'booked' | 'lost';
  source?: string;
  intent?: string;
  address?: string;
  tags: string[];
  notes?: string;
  crmId?: string;
  externalId?: string;
  lastContactedAt?: Date;
  assignedTo?: mongoose.Types.ObjectId;
  customFields: Record<string, unknown>;
}

const customerSchema = new Schema<ICustomer>(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true },
    name: { type: String, required: true, trim: true },
    firstName: { type: String, trim: true },
    lastName: { type: String, trim: true },
    email: { type: String, lowercase: true, trim: true },
    phone: { type: String, trim: true },
    company: { type: String, trim: true },
    leadSource: { type: String, trim: true },
    channel: {
      type: String,
      enum: ['web', 'whatsapp', 'instagram', 'email', 'phone', 'zoho', 'hubspot', 'salesforce', 'rest', 'mysql', 'postgresql', 'mongodb'],
      default: 'web',
    },
    recordType: {
      type: String,
      enum: ['lead', 'contact', 'customer'],
      default: 'customer',
    },
    status: {
      type: String,
      enum: ['new', 'contacted', 'qualified', 'booked', 'lost'],
      default: 'new',
    },
    source: String,
    intent: String,
    address: String,
    sources:     { type: [String], default: [] },
    externalIds: { type: Map, of: String, default: {} },
    tags: { type: [String], default: [] },
    notes: String,
    crmId: String,
    externalId: String,
    lastContactedAt: Date,
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User' },
    customFields: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

customerSchema.index({ tenantId: 1, status: 1 });
customerSchema.index({ tenantId: 1, email: 1 });
customerSchema.index({ tenantId: 1, phone: 1 });
customerSchema.index({ tenantId: 1, channel: 1 });
customerSchema.index({ tenantId: 1, createdAt: -1 });
// Channel-scoped: same email allowed across different connectors (zoho + hubspot both can have john@..)
customerSchema.index({ tenantId: 1, channel: 1, email: 1 });

export const Customer = mongoose.model<ICustomer>('Customer', customerSchema);
