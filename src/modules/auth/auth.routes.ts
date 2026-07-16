import { Router } from 'express';
import * as controller from './auth.controller';
import { authenticate } from '../../middlewares/auth.middleware';
import { authRateLimit } from '../../middlewares/rate-limit.middleware';
import { validate } from '../../middleware/validate.middleware';
import {
  registerSchema,
  loginSchema,
  refreshSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from './auth.validation';

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Auth
 *   description: Authentication — register, login, token refresh, password reset
 */

/**
 * @swagger
 * /auth/register:
 *   post:
 *     tags: [Auth]
 *     summary: Register a new tenant account
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [firstName, lastName, email, password, companyName]
 *             properties:
 *               firstName:   { type: string, example: Sugan }
 *               lastName:    { type: string, example: A }
 *               email:       { type: string, format: email, example: sugan@example.com }
 *               password:    { type: string, minLength: 8, example: Secret123! }
 *               companyName: { type: string, example: Acme Corp }
 *     responses:
 *       201: { description: Account created — verification email sent }
 *       409: { description: Email already registered }
 */
router.post('/register', authRateLimit, validate(registerSchema), controller.register);

/**
 * @swagger
 * /auth/verify-email:
 *   post:
 *     tags: [Auth]
 *     summary: Verify email with token
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token, email]
 *             properties:
 *               token: { type: string }
 *               email: { type: string, format: email }
 *     responses:
 *       200: { description: Email verified }
 *       400: { description: Invalid or expired token }
 */
router.post('/verify-email', authRateLimit, validate(verifyEmailSchema), controller.verifyEmail);

/**
 * @swagger
 * /auth/login:
 *   post:
 *     tags: [Auth]
 *     summary: Login and receive JWT access + refresh tokens
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:    { type: string, format: email }
 *               password: { type: string }
 *     responses:
 *       200:
 *         description: Login successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 accessToken:  { type: string }
 *                 refreshToken: { type: string }
 *                 user:         { type: object }
 *       401: { description: Invalid credentials }
 */
router.post('/login', authRateLimit, validate(loginSchema), controller.login);

/**
 * @swagger
 * /auth/forgot-password:
 *   post:
 *     tags: [Auth]
 *     summary: Send password reset email
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email: { type: string, format: email }
 *     responses:
 *       200: { description: Reset email sent (always 200 to prevent enumeration) }
 */
router.post('/forgot-password', authRateLimit, validate(forgotPasswordSchema), controller.forgotPassword);

/**
 * @swagger
 * /auth/reset-password:
 *   post:
 *     tags: [Auth]
 *     summary: Reset password using token from email
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token, email, newPassword]
 *             properties:
 *               token:       { type: string }
 *               email:       { type: string, format: email }
 *               newPassword: { type: string, minLength: 8 }
 *     responses:
 *       200: { description: Password reset successful }
 *       400: { description: Invalid or expired token }
 */
router.post('/reset-password', authRateLimit, validate(resetPasswordSchema), controller.resetPassword);

/**
 * @swagger
 * /auth/refresh:
 *   post:
 *     tags: [Auth]
 *     summary: Refresh access token using refresh token
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [refreshToken]
 *             properties:
 *               refreshToken: { type: string }
 *     responses:
 *       200: { description: New access token }
 *       401: { description: Refresh token invalid or expired }
 */
router.post('/refresh', authRateLimit, validate(refreshSchema), controller.refresh);

/**
 * @swagger
 * /auth/logout:
 *   post:
 *     tags: [Auth]
 *     summary: Logout — invalidate refresh token
 *     responses:
 *       200: { description: Logged out }
 */
router.post('/logout', authenticate, controller.logout);

/**
 * @swagger
 * /auth/me:
 *   get:
 *     tags: [Auth]
 *     summary: Get current authenticated user profile
 *     responses:
 *       200: { description: User object }
 *       401: { description: Unauthorized }
 */
router.get('/me', authenticate, controller.me);

/**
 * @swagger
 * /auth/profile:
 *   put:
 *     tags: [Auth]
 *     summary: Update current user profile
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               firstName: { type: string }
 *               lastName:  { type: string }
 *               phone:     { type: string }
 *     responses:
 *       200: { description: Updated user }
 */
router.put('/profile', authenticate, controller.updateProfile);
router.put('/change-password', authenticate, controller.changePassword);

export default router;
