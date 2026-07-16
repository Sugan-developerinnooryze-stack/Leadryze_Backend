import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../types';
import * as authService from './auth.service';
import { sendSuccess, sendCreated, sendError } from '../../utils/response';
import { User } from './auth.model';

export async function register(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { email, password, firstName, lastName, companyName } = req.body;
    if (!email || !password || !firstName || !lastName) {
      sendError(res, 'email, password, firstName and lastName are required', 400);
      return;
    }
    const result = await authService.registerUser({ email, password, firstName, lastName, companyName });
    sendCreated(res, result, 'Registration successful');
  } catch (err) { next(err); }
}

export async function verifyEmail(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { token, email } = req.body;
    if (!token || !email) { sendError(res, 'token and email are required', 400); return; }
    const result = await authService.verifyEmail(token, email);
    sendSuccess(res, result, 'Email verified successfully');
  } catch (err) { next(err); }
}

export async function login(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { email, password, tenantId } = req.body;
    if (!email || !password) { sendError(res, 'email and password are required', 400); return; }
    const result = await authService.loginUser(email, password, tenantId, {
      ip:        req.ip,
      userAgent: req.headers['user-agent'] as string,
    });
    sendSuccess(res, result, 'Login successful');
  } catch (err) { next(err); }
}

export async function forgotPassword(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { email } = req.body;
    if (!email) { sendError(res, 'email is required', 400); return; }
    await authService.forgotPassword(email);
    sendSuccess(res, null, 'If that email exists, a reset link has been sent.');
  } catch (err) { next(err); }
}

export async function resetPassword(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { token, email, password } = req.body;
    if (!token || !email || !password) { sendError(res, 'token, email and password are required', 400); return; }
    await authService.resetPassword(token, email, password);
    sendSuccess(res, null, 'Password reset successfully. You can now log in.');
  } catch (err) { next(err); }
}

export async function refresh(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) { sendError(res, 'Refresh token required', 400); return; }
    const tokens = await authService.refreshTokens(refreshToken);
    sendSuccess(res, tokens, 'Tokens refreshed');
  } catch (err) { next(err); }
}

export async function logout(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    if (req.user?.userId) {
      await authService.logoutUser(req.user.userId, {
        ip:        req.ip,
        userAgent: req.headers['user-agent'],
        tenantId:  req.user.tenantId,
      });
    }
    sendSuccess(res, null, 'Logged out successfully');
  } catch (err) { next(err); }
}

export async function me(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = await User.findById(req.user?.userId);
    if (!user) { sendError(res, 'User not found', 404); return; }
    sendSuccess(res, user, 'Profile fetched');
  } catch (err) { next(err); }
}

export async function changePassword(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      sendError(res, 'currentPassword and newPassword are required', 400);
      return;
    }
    if (newPassword.length < 8) {
      sendError(res, 'New password must be at least 8 characters', 400);
      return;
    }
    await authService.changePassword(req.user!.userId, currentPassword, newPassword);
    sendSuccess(res, null, 'Password changed successfully');
  } catch (err) { next(err); }
}

export async function updateProfile(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const { firstName, lastName } = req.body;
    const user = await User.findByIdAndUpdate(
      req.user?.userId,
      { ...(firstName && { firstName }), ...(lastName && { lastName }) },
      { new: true }
    );
    if (!user) { sendError(res, 'User not found', 404); return; }
    sendSuccess(res, user, 'Profile updated');
  } catch (err) { next(err); }
}
