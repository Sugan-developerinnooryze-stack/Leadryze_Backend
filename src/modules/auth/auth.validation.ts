import { z, ZodSchema } from 'zod';
import { Request, Response, NextFunction } from 'express';

const passwordRule = z.string()
  .min(8, 'Password must be at least 8 characters')
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/[0-9]/, 'Password must contain at least one number');

export const registerSchema = z.object({
  email:       z.string().email('Invalid email address').toLowerCase(),
  password:    passwordRule,
  firstName:   z.string().min(1).max(50).trim(),
  lastName:    z.string().min(1).max(50).trim(),
  companyName: z.string().max(100).trim().optional(),
  role:        z.enum(['SUPER_ADMIN', 'TENANT_ADMIN', 'MANAGER', 'AGENT', 'USER']).optional(),
  tenantId:    z.string().optional(),
});

// Either email (plain login) or clientId (Client ID + password login,
// no email needed — see loginUserByClientId's candidate-loop resolution)
// must be present.
export const loginSchema = z.object({
  email:    z.string().email().toLowerCase().optional(),
  clientId: z.string().trim().min(1).max(20).optional(),
  password: z.string().min(1, 'Password is required'),
  tenantId: z.string().optional(),
}).refine((data) => !!data.email || !!data.clientId, {
  message: 'Either email or clientId is required',
  path: ['email'],
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email('Invalid email address').toLowerCase(),
});

// Field is named `password` here (not `newPassword`) to match what the
// frontend's ResetPasswordPage.tsx actually sends and what the controller
// actually reads — those two already agreed with each other; this schema
// was the one out of step, silently rejecting every real reset attempt
// with a generic "Validation failed" before the controller ever ran.
export const resetPasswordSchema = z.object({
  token:    z.string().min(1, 'Token is required'),
  email:    z.string().email().toLowerCase(),
  password: passwordRule,
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword:     passwordRule,
});

export const verifyEmailSchema = z.object({
  token: z.string().min(1, 'Token is required'),
  email: z.string().email().toLowerCase(),
});

// Sidebar customization — see the doc-comment on IUser.sidebarLayout in
// auth.model.ts: this validates the STORED SHAPE only (reasonable types,
// bounded size, known key prefixes), it is not the authorization boundary.
// Unknown-prefixed item keys are silently dropped rather than rejecting the
// whole save — one bad/stale key from an older client build shouldn't block
// an otherwise-valid layout update.
const SIDEBAR_ITEM_PREFIXES = ['nav:', 'native:', 'fs:', 'config:', 'automation:'];

const sidebarItemSchema = z.object({
  order:  z.number().int().min(0).max(999).optional(),
  pinned: z.boolean().optional(),
});

export const sidebarLayoutSchema = z.object({
  items: z.record(z.string(), sidebarItemSchema)
    .optional()
    .transform((items) => {
      if (!items) return items;
      const cleaned: Record<string, { order?: number; pinned?: boolean }> = {};
      // 200 is comfortably above the real catalog's total item count across
      // every customizable section — a bound against an oversized payload,
      // not a realistic limit anyone should ever hit.
      for (const [key, val] of Object.entries(items).slice(0, 200)) {
        if (SIDEBAR_ITEM_PREFIXES.some((p) => key.startsWith(p)) && key.length <= 80) {
          cleaned[key] = val;
        }
      }
      return cleaned;
    }),
  groups: z.object({
    crmData:       z.boolean().optional(),
    customModules: z.boolean().optional(),
  }).partial().optional(),
});

export function validate(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: result.error.flatten().fieldErrors,
      });
      return;
    }
    req.body = result.data;
    next();
  };
}
