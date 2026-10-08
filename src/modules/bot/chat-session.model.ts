import mongoose, { Schema, Document } from 'mongoose';

export interface IChatMessage {
  /** 'staff'/'system' are additive — see the Human Handoff feature's own
   * pre-implementation audit (every existing consumer of this field was
   * swept across backend/frontend/ai before this widening landed; none of
   * them can misread a 'staff'/'system' message as 'assistant', and the AI
   * service never sees or writes either value). */
  role: 'user' | 'assistant' | 'staff' | 'system';
  content: string;
  timestamp: Date;
  metadata?: {
    escalated?: boolean; provider?: string; model?: string;
    /** Set only when role === 'staff' — who actually sent it. */
    staffUserId?: string;
    staffName?: string;
  };
}

export interface IChatSession extends Document {
  tenantId: mongoose.Types.ObjectId;
  sessionId: string;
  /** The widget's own client-side visitor identity (localStorage-persisted
   * crypto.randomUUID(), survives across sessions/reloads) — parallel to
   * visitorName/visitorEmail/visitorPhone, but a stable anonymous handle
   * rather than PII. Used by GET /public/widget/history as a second
   * ownership factor alongside sessionId, narrowing a session-guessing
   * attack surface beyond sessionId's own already-high entropy. */
  visitorId?: string;
  visitorName?: string;
  visitorEmail?: string;
  visitorPhone?: string;
  channel: string;
  messages: IChatMessage[];
  escalated: boolean;
  closedAt?: Date;

  /** ── Human Handoff ("Connect with an expert") ──────────────────────────
   * Prepaid/opt-in feature — these fields are undefined for every session
   * that predates this feature or whose tenant never enabled it. Every gate
   * that reads `mode`/`handoffStatus` checks `=== 'human'`/`=== 'waiting'`/
   * `=== 'claimed'` (never `!== 'ai'`), so an undefined value always, safely
   * resolves to "ordinary AI session, no handoff" — no backfill needed. */
  mode?: 'ai' | 'human';
  handoffStatus?: 'none' | 'waiting' | 'claimed';
  handoffRequestedAt?: Date;
  claimedAt?: Date;
  assignedToUserId?: mongoose.Types.ObjectId;
  assignedToName?: string;
  handedBackAt?: Date;
  handedBackByUserId?: mongoose.Types.ObjectId;

  createdAt: Date;
  updatedAt: Date;
}

const chatMessageSchema = new Schema<IChatMessage>(
  {
    role:      { type: String, enum: ['user', 'assistant', 'staff', 'system'], required: true },
    content:   { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
    metadata:  { type: Schema.Types.Mixed },
  },
  { _id: false }
);

const chatSessionSchema = new Schema<IChatSession>(
  {
    tenantId:     { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
    sessionId:    { type: String, required: true, unique: true, index: true },
    visitorId:    { type: String },
    visitorName:  { type: String },
    visitorEmail: { type: String },
    visitorPhone: { type: String },
    channel:      { type: String, default: 'web' },
    messages:     [chatMessageSchema],
    escalated:    { type: Boolean, default: false },
    closedAt:     { type: Date },

    mode:               { type: String, enum: ['ai', 'human'] },
    handoffStatus:      { type: String, enum: ['none', 'waiting', 'claimed'] },
    handoffRequestedAt: { type: Date },
    claimedAt:          { type: Date },
    assignedToUserId:   { type: Schema.Types.ObjectId, ref: 'User' },
    assignedToName:     { type: String },
    handedBackAt:        { type: Date },
    handedBackByUserId:  { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Auto-delete sessions after 90 days
chatSessionSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

// Human Handoff inbox query: "this tenant's waiting/claimed conversations, newest first"
chatSessionSchema.index({ tenantId: 1, handoffStatus: 1, updatedAt: -1 });

export const ChatSession = mongoose.model<IChatSession>('ChatSession', chatSessionSchema);
