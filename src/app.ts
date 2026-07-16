import express from 'express';
import path from 'path';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import mongoSanitize from 'express-mongo-sanitize';
import hpp from 'hpp';
import swaggerUi from 'swagger-ui-express';
import { config } from './config';
import { swaggerSpec } from './config/swagger';
import { globalRateLimit } from './middlewares/rate-limit.middleware';
import { auditLog } from './middlewares/audit.middleware';
import { notFound, errorHandler } from './middlewares/error.middleware';
import { logger } from './utils/logger';

import authRoutes from './modules/auth/auth.routes';
import tenantRoutes from './modules/tenants/tenant.routes';
import customerRoutes from './modules/customers/customer.routes';
import campaignRoutes from './modules/campaigns/campaign.routes';
import templateRoutes from './modules/templates/template.routes';
import messageRoutes from './modules/messages/message.routes';
import connectorRoutes from './modules/connectors/connector.routes';
import analyticsRoutes from './modules/analytics/analytics.routes';
import webhookRoutes from './modules/webhooks/webhook.routes';
import notificationRoutes from './modules/notifications/notification.routes';
import aiRoutes from './modules/ai/ai.routes';
import adminRoutes from './modules/admin/admin.routes';
import crmRoutes from './modules/crm/crm-record.routes';
import internalRoutes from './modules/internal/internal.routes';
import logRoutes from './modules/logs/log.routes';
import botRoutes from './modules/bot/qna.routes';
import calendarRoutes from './modules/calendar/calendar.routes';
import activityRoutes from './modules/activities/activity.routes';
import nativeCrmRoutes    from './modules/native-crm/native-crm.router';
import portalRoutes       from './modules/native-crm/portal/portal.routes';
import customModuleRoutes from './modules/custom-modules/custom-module.routes';
import automationRoutes from './modules/automation/automation.routes';
import roleRoutes from './modules/rbac/role.routes';
import permissionRoutes from './modules/rbac/permission.routes';
import userRoutes from './modules/users/user.routes';
import storageRoutes from './routes/storage.routes';
import { staffAuthRouter, customerAuthRouter } from './modules/app-auth/app-auth.routes';

const app = express();

app.set('trust proxy', 1);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc:  ["'self'"],
        styleSrc:   ["'self'", "'unsafe-inline'"],
        imgSrc:     ["'self'", 'data:', 'https:', 'http:', 'blob:'],
        connectSrc: ["'self'"],
        frameSrc:   ["'none'"],
        objectSrc:  ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" }, // Required so frontend on port 3000 can load images from port 5000
  })
);

const allowedOrigins = [
  config.app.frontendUrl,
  ...(config.app.env !== 'production' ? ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:5173'] : []),
].filter(Boolean) as string[];

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-tenant-id', 'X-Branch-Id'],
  })
);

const morganFormat = ':method :url :status :res[content-length]b - :response-time ms';
app.use(morgan(morganFormat, { stream: { write: (msg) => logger.http(msg.trim()) } }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(mongoSanitize()); // strips MongoDB operators ($, .) from user input
app.use(hpp());           // removes duplicate query params (HTTP Parameter Pollution)
app.use(globalRateLimit);
app.use(auditLog);

const V = `/api/${config.app.apiVersion}`;

// Swagger docs — only accessible in non-production environments
if (config.app.env !== 'production') {
  app.use(
    '/api-docs',
    swaggerUi.serve,
    swaggerUi.setup(swaggerSpec, {
      customCss: '.swagger-ui .topbar { display: none }',
      customSiteTitle: 'LeadRyze AI API',
    })
  );
  app.get('/api-docs.json', (_req, res) => res.json(swaggerSpec));
}

// Static file serving for uploaded assets
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

// Health check
app.get('/health', (_req, res) =>
  res.json({
    status: 'ok',
    service: 'leadryze-backend',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  })
);

// API Routes
app.use(`${V}/auth`, authRoutes);
app.use(`${V}/tenants`, tenantRoutes);
app.use(`${V}/customers`, customerRoutes);
app.use(`${V}/campaigns`, campaignRoutes);
app.use(`${V}/templates`, templateRoutes);
app.use(`${V}/messages`, messageRoutes);
app.use(`${V}/connectors`, connectorRoutes);
app.use(`${V}/analytics`, analyticsRoutes);
app.use(`${V}/webhooks`, webhookRoutes);
app.use(`${V}/notifications`, notificationRoutes);
app.use(`${V}/ai`, aiRoutes);
app.use(`${V}/admin`, adminRoutes);
app.use(`${V}/crm`, crmRoutes);
app.use(`${V}/logs`, logRoutes);
app.use(`${V}/bot`, botRoutes);
app.use(`${V}/calendar`, calendarRoutes);
app.use(`${V}/activities`, activityRoutes);
app.use(`${V}/portal`,     portalRoutes);    // public GET; POST has its own authenticate inside
app.use(`${V}/native-crm`,     nativeCrmRoutes);
app.use(`${V}/custom-modules`, customModuleRoutes);
app.use(`${V}/automation-runs`, automationRoutes);
app.use(`${V}/roles`,       roleRoutes);
app.use(`${V}/permissions`, permissionRoutes);
app.use(`${V}/users`,       userRoutes);
app.use(`${V}/storage`,     storageRoutes);

// Staff & customer mobile-app auth — separate JWT secret, scoped reads only
app.use(`${V}/staff-auth`,    staffAuthRouter);
app.use(`${V}/customer-auth`, customerAuthRouter);

// Internal service-to-service routes — no JWT, uses x-internal-key header
app.use('/api/internal', internalRoutes);

app.use(notFound);
app.use(errorHandler);

export default app;
