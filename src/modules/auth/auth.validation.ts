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

export const loginSchema = z.object({
  email:    z.string().email().toLowerCase(),
  password: z.string().min(1, 'Password is required'),
  tenantId: z.string().optional(),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email('Invalid email address').toLowerCase(),
});

export const resetPasswordSchema = z.object({
  token:       z.string().min(1, 'Token is required'),
  email:       z.string().email().toLowerCase(),
  newPassword: passwordRule,
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword:     passwordRule,
});

export const verifyEmailSchema = z.object({
  token: z.string().min(1, 'Token is required'),
  email: z.string().email().toLowerCase(),
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
