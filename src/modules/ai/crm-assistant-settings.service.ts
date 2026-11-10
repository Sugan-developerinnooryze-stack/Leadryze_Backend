import mongoose from 'mongoose';
import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../types';
import { sendError } from '../../utils/response';
import { CrmAssistEngineMode, engineModeFor } from '../../config';
import { CrmAssistantSettings, ICrmAssistantSettings } from './crm-assistant-settings.model';

/** The "Try asking" questions shown until a tenant sets its own. (The chat
 * panel's connector questions are switched off until the assistant can read
 * connector data; see CONNECTOR_DATA_IN_ASSISTANT in ChatWidget.tsx.) */
export const DEFAULT_SUGGESTED_QUESTIONS: readonly string[] = [
  'How many deals do we have?',
  'How many overdue work orders?',
  "What's happening today?",
  'Which tasks are overdue?',
  'Show me the category names',
];

export const QUESTION_LIMITS = { maxQuestions: 10, minLength: 3, maxLength: 150 } as const;
/** Daily Events 'stuck lead' threshold, in days. */
export const STALE_LEAD_DAYS = { default: 7, min: 1, max: 90 } as const;

export type CrmAssistantFeature = 'dailyEvents' | 'customModule' | 'visualAnswers' | 'workflows';
type ToggleKey = 'dailyEventsEnabled' | 'customModuleEnabled' | 'visualAnswersEnabled' | 'workflowsEnabled';
const TOGGLE_KEYS: readonly ToggleKey[] = ['dailyEventsEnabled', 'customModuleEnabled', 'visualAnswersEnabled', 'workflowsEnabled'];
const FEATURE_TOGGLE: Record<CrmAssistantFeature, ToggleKey> = {
  dailyEvents: 'dailyEventsEnabled',
  customModule: 'customModuleEnabled',
  visualAnswers: 'visualAnswersEnabled',
  workflows: 'workflowsEnabled',
};
type SettingsChanges = Partial<Record<ToggleKey, boolean>> & { staleLeadDays?: number };

/** Settings → CRM Chatbot (admins). */
export interface CrmAssistantSettingsView {
  dailyEventsEnabled: boolean;
  customModuleEnabled: boolean;
  /** Tables, tiles and record cards under the assistant's replies. */
  visualAnswersEnabled: boolean;
  /** Guided forms: chat writes through a form and a review card. Off by
   * default (D15). */
  workflowsEnabled: boolean;
  questionsCustomized: boolean;
  /** What staff see now: the tenant's own list, or the built-in one. */
  questions: { id: string; text: string }[];
  defaultQuestions: string[];
  questionsRevision: number;
  limits: typeof QUESTION_LIMITS;
  staleLeadDays: number;
  updatedAt: string | null;
}

/** The chat panel's own read (every staff user of the assistant). */
export interface CrmAssistantConfigView {
  dailyEventsEnabled: boolean;
  customModuleEnabled: boolean;
  visualAnswersEnabled: boolean;
  questionsCustomized: boolean;
  questions: string[];
  /** The answer-engine mode the backend uses for this tenant (CRM_ASSIST_ENGINE). */
  engine: CrmAssistEngineMode;
  workflowsEnabled: boolean;
  /** Whether guided forms apply right now (L7): workflowsEnabled and
   * visualAnswersEnabled on, and the engine 'on'. The same rule as
   * isWorkflowsEffective (crm-assistant/operations/workflow-gate.ts). */
  workflowsEffective: boolean;
}

type SettingsDoc = Partial<Pick<ICrmAssistantSettings,
  'dailyEventsEnabled' | 'customModuleEnabled' | 'visualAnswersEnabled' | 'workflowsEnabled' | 'questionsCustomized' | 'suggestedQuestions'
  | 'questionsRevision' | 'staleLeadDays' | 'updatedAt'>>;

function toView(doc: SettingsDoc | null): CrmAssistantSettingsView {
  const customized = doc?.questionsCustomized === true;
  return {
    dailyEventsEnabled: doc?.dailyEventsEnabled !== false,
    customModuleEnabled: doc?.customModuleEnabled !== false,
    visualAnswersEnabled: doc?.visualAnswersEnabled !== false,
    // Off by default (D15): only a saved true turns guided forms on.
    workflowsEnabled: doc?.workflowsEnabled === true,
    questionsCustomized: customized,
    questions: customized
      ? (doc?.suggestedQuestions ?? []).map((q) => ({ id: String(q._id), text: q.text }))
      : DEFAULT_SUGGESTED_QUESTIONS.map((text, i) => ({ id: `default-${i}`, text })),
    defaultQuestions: [...DEFAULT_SUGGESTED_QUESTIONS],
    questionsRevision: doc?.questionsRevision ?? 0,
    limits: QUESTION_LIMITS,
    staleLeadDays: Number.isInteger(doc?.staleLeadDays) ? (doc!.staleLeadDays as number) : STALE_LEAD_DAYS.default,
    updatedAt: doc?.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
  };
}

/** Read-only: a tenant that never saved settings gets the defaults, and no
 * document is created just by reading. */
async function readDoc(tenantId: string): Promise<SettingsDoc | null> {
  return CrmAssistantSettings.findOne({ tenantId: new mongoose.Types.ObjectId(tenantId) })
    .select('dailyEventsEnabled customModuleEnabled visualAnswersEnabled workflowsEnabled questionsCustomized suggestedQuestions questionsRevision staleLeadDays updatedAt')
    .lean() as Promise<SettingsDoc | null>;
}

export async function getCrmAssistantSettings(tenantId: string): Promise<CrmAssistantSettingsView> {
  return toView(await readDoc(tenantId));
}

export async function getCrmAssistantConfig(tenantId: string): Promise<CrmAssistantConfigView> {
  const view = toView(await readDoc(tenantId));
  const engine = engineModeFor(tenantId);
  return {
    dailyEventsEnabled: view.dailyEventsEnabled,
    customModuleEnabled: view.customModuleEnabled,
    visualAnswersEnabled: view.visualAnswersEnabled,
    questionsCustomized: view.questionsCustomized,
    questions: view.questions.map((q) => q.text),
    engine,
    workflowsEnabled: view.workflowsEnabled,
    workflowsEffective: view.workflowsEnabled && view.visualAnswersEnabled && engine === 'on',
  };
}

/* ── Validation ─────────────────────────────────────────────────────────── */

/** PATCH body: any feature switch and/or staleLeadDays. */
export function parseToggleChanges(body: unknown): { changes: SettingsChanges } | { error: string } {
  const NOTHING = 'Send dailyEventsEnabled, customModuleEnabled, visualAnswersEnabled, workflowsEnabled and/or staleLeadDays.';
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: NOTHING };
  const input = body as Record<string, unknown>;
  const known: readonly string[] = [...TOGGLE_KEYS, 'staleLeadDays'];
  const unknown = Object.keys(input).filter((k) => !known.includes(k));
  if (unknown.length) return { error: `Unknown setting: ${unknown.map((k) => k.slice(0, 40)).join(', ')}.` };
  const changes: SettingsChanges = {};
  for (const key of TOGGLE_KEYS) {
    if (!(key in input)) continue;
    if (typeof input[key] !== 'boolean') return { error: `${key} must be true or false.` };
    changes[key] = input[key] as boolean;
  }
  if ('staleLeadDays' in input) {
    const days = input.staleLeadDays;
    if (typeof days !== 'number' || !Number.isInteger(days) || days < STALE_LEAD_DAYS.min || days > STALE_LEAD_DAYS.max) {
      return { error: `staleLeadDays must be a whole number from ${STALE_LEAD_DAYS.min} to ${STALE_LEAD_DAYS.max}.` };
    }
    changes.staleLeadDays = days;
  }
  if (!Object.keys(changes).length) return { error: NOTHING };
  return { changes };
}

/** Collapses whitespace and strips control characters. */
export function normaliseQuestion(text: string): string {
  return text.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** questions: a full list (saved as the tenant's own) or null (back to the
 * built-in questions). revision: the questionsRevision the change was made
 * against. */
export function parseQuestionsBody(body: unknown): { questions: string[] | null; revision: number } | { error: string } {
  const input = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as { questions?: unknown; revision?: unknown };
  const { revision } = input;
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) {
    return { error: 'revision is required (the questionsRevision the change is based on).' };
  }
  if (input.questions === null) return { questions: null, revision };
  if (!Array.isArray(input.questions)) {
    return { error: 'questions must be a list, or null to go back to the built-in questions.' };
  }
  if (input.questions.length > QUESTION_LIMITS.maxQuestions) {
    return { error: `You can have up to ${QUESTION_LIMITS.maxQuestions} suggested questions.` };
  }
  const seen = new Set<string>();
  const questions: string[] = [];
  for (let i = 0; i < input.questions.length; i += 1) {
    const raw = input.questions[i];
    if (typeof raw !== 'string') return { error: `Question ${i + 1} must be text.` };
    const text = normaliseQuestion(raw);
    if (text.length < QUESTION_LIMITS.minLength) {
      return { error: `Question ${i + 1} is too short — use at least ${QUESTION_LIMITS.minLength} characters.` };
    }
    if (text.length > QUESTION_LIMITS.maxLength) {
      return { error: `Question ${i + 1} is too long — use at most ${QUESTION_LIMITS.maxLength} characters.` };
    }
    const key = text.toLowerCase();
    if (seen.has(key)) return { error: `"${text}" is in the list twice.` };
    seen.add(key);
    questions.push(text);
  }
  return { questions, revision };
}

/* ── Writes ─────────────────────────────────────────────────────────────── */

export class CrmAssistantQuestionsConflictError extends Error {
  constructor() {
    super('Someone else changed the suggested questions just now. The latest list has been loaded — please make your change again.');
  }
}

/** Creates the tenant's settings document on first save (defaults applied). */
async function ensureDoc(tid: mongoose.Types.ObjectId): Promise<void> {
  try {
    await CrmAssistantSettings.updateOne({ tenantId: tid }, { $setOnInsert: { tenantId: tid } }, { upsert: true, setDefaultsOnInsert: true });
  } catch (err) {
    // Two first saves at once: the unique tenantId index lets one insert win.
    if ((err as { code?: number }).code !== 11000) throw err;
  }
}

export async function updateCrmAssistantToggles(
  tenantId: string, changes: SettingsChanges, actorUserId: string,
): Promise<{ before: CrmAssistantSettingsView; after: CrmAssistantSettingsView }> {
  const tid = new mongoose.Types.ObjectId(tenantId);
  await ensureDoc(tid);
  const before = await CrmAssistantSettings.findOneAndUpdate(
    { tenantId: tid },
    { $set: { ...changes, updatedBy: actorUserId } },
    { new: false },
  ).lean() as SettingsDoc | null;
  return { before: toView(before), after: toView({ ...(before ?? {}), ...changes, updatedAt: new Date() }) };
}

/** Saves the whole list at once, only if nobody saved since `expectedRevision`
 * was read — so two admins editing at the same time can never silently
 * overwrite each other. */
export async function saveSuggestedQuestions(
  tenantId: string, questions: string[] | null, expectedRevision: number, actorUserId: string,
): Promise<{ before: CrmAssistantSettingsView; after: CrmAssistantSettingsView }> {
  const tid = new mongoose.Types.ObjectId(tenantId);
  await ensureDoc(tid);
  const items = (questions ?? []).map((text) => ({ _id: new mongoose.Types.ObjectId(), text }));
  const customized = questions !== null;
  const filter: Record<string, unknown> = expectedRevision === 0
    ? { tenantId: tid, $or: [{ questionsRevision: 0 }, { questionsRevision: { $exists: false } }] }
    : { tenantId: tid, questionsRevision: expectedRevision };
  const before = await CrmAssistantSettings.findOneAndUpdate(
    filter,
    { $set: { questionsCustomized: customized, suggestedQuestions: items, updatedBy: actorUserId }, $inc: { questionsRevision: 1 } },
    { new: false },
  ).lean() as SettingsDoc | null;
  if (!before) throw new CrmAssistantQuestionsConflictError();
  return {
    before: toView(before),
    after: toView({
      ...before,
      questionsCustomized: customized,
      suggestedQuestions: items as SettingsDoc['suggestedQuestions'],
      questionsRevision: (before.questionsRevision ?? 0) + 1,
      updatedAt: new Date(),
    }),
  };
}

/* ── Server-side enforcement ────────────────────────────────────────────── */

const FEATURE_OFF_MESSAGE: Record<CrmAssistantFeature, string> = {
  dailyEvents: 'Daily Events is turned off for your organization. An admin can turn it on in Settings → CRM Chatbot.',
  customModule: 'The Custom Module builder is turned off in the assistant for your organization. An admin can turn it on in Settings → CRM Chatbot.',
  visualAnswers: 'Visual answers are turned off in the assistant for your organization. An admin can turn them on in Settings → CRM Chatbot.',
  workflows: 'Guided forms are turned off in the assistant for your organization. An admin can turn them on in Settings → CRM Chatbot.',
};

function featureEnabled(view: CrmAssistantSettingsView, feature: CrmAssistantFeature): boolean {
  return view[FEATURE_TOGGLE[feature]];
}

/** The same decision as requireCrmAssistantFeature, for code that has no
 * Express request (the internal assistant routes, the chat proxy):
 * SUPER_ADMIN always passes, everyone else gets the tenant's switch. */
export async function isCrmAssistantFeatureEnabled(
  tenantId: string, feature: CrmAssistantFeature, role: string | undefined,
): Promise<boolean> {
  if (role === 'SUPER_ADMIN') return true;
  return featureEnabled(toView(await readDoc(tenantId)), feature);
}

/** Blocks an assistant feature an admin switched off — at the server, so
 * hiding the button is never the only protection. Same SUPER_ADMIN bypass as
 * requireModuleEnabled. */
export function requireCrmAssistantFeature(feature: CrmAssistantFeature) {
  return async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    if (req.user?.role === 'SUPER_ADMIN') { next(); return; }
    try {
      const view = toView(await readDoc(req.tenantId!));
      const enabled = featureEnabled(view, feature);
      if (!enabled) { sendError(res, FEATURE_OFF_MESSAGE[feature], 403); return; }
      next();
    } catch (err) {
      next(err);
    }
  };
}
