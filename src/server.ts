import 'dotenv/config';
import http from 'http';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { Server as SocketServer } from 'socket.io';
import app from './app';
import { config } from './config';
import { connectDatabase } from './config/database';
import { connectRedis } from './config/redis';
import { initQueues } from './modules/scheduler/scheduler.service';
import { ensureMeiliIndex } from './services/meilisearch.service';
import { logger } from './utils/logger';
import { logSecurityEvent } from './modules/logs/security-event.model';
import { hasPermission } from './modules/rbac/permission.service';

async function ensureSuperAdmin(): Promise<void> {
  try {
    const { User }   = await import('./modules/auth/auth.model');
    const { Tenant } = await import('./modules/tenants/tenant.model');

    // Ensure all SUPER_ADMIN accounts always have emailVerified: true
    // (Super admins don't go through email verification — this prevents lockout after restart)
    const updated = await User.updateMany(
      { role: 'SUPER_ADMIN', emailVerified: { $ne: true } },
      { $set: { emailVerified: true } }
    );
    if (updated.modifiedCount > 0) {
      logger.info(`ensureSuperAdmin: set emailVerified=true on ${updated.modifiedCount} SUPER_ADMIN account(s)`);
    }

    // If no SUPER_ADMIN exists at all, create one from config
    const adminEmail = process.env.SUPER_ADMIN_EMAIL || 'admin@leadryze.ai';
    const existing   = await User.findOne({ role: 'SUPER_ADMIN', email: adminEmail });
    if (!existing) {
      logger.warn(`ensureSuperAdmin: no SUPER_ADMIN found — creating default admin account`);
      let adminTenant = await Tenant.findOne({ slug: 'leadryze-system' });
      if (!adminTenant) {
        adminTenant = await Tenant.create({
          name: 'LeadRyze System', slug: 'leadryze-system', plan: 'enterprise', isActive: true,
          settings: { allowedChannels: ['web'], maxUsers: 100, maxLeadsPerMonth: 100000, timezone: 'UTC', language: 'en', crmOption: 'no_crm' },
          branding: { companyName: 'LeadRyze AI' },
          aiConfig:  { agentName: 'LeadBot', language: 'en', fallbackToHuman: true },
        });
      }
      const adminPassword = process.env.SUPER_ADMIN_PASSWORD || 'Admin@123';
      await User.create({
        email: adminEmail, password: adminPassword,
        firstName: 'Super', lastName: 'Admin',
        role: 'SUPER_ADMIN', tenantId: adminTenant._id,
        isActive: true, emailVerified: true,
      });
      logger.info(`ensureSuperAdmin: created SUPER_ADMIN account: ${adminEmail}`);
    }
  } catch (err) {
    logger.error('ensureSuperAdmin failed', { error: (err as Error).message });
  }
}

async function dropLegacyIndexes(): Promise<void> {
  try {
    const col = mongoose.connection.collection('native_fs_settings');
    await col.dropIndex('tenantId_1');
    logger.info('Dropped legacy tenantId_1 index from native_fs_settings');
  } catch (err: any) {
    // IndexNotFound is fine — index was already gone
    if (err?.codeName !== 'IndexNotFound' && err?.code !== 27) {
      logger.warn('dropLegacyIndexes: could not drop tenantId_1', { error: (err as Error).message });
    }
  }
}

async function bootstrap(): Promise<void> {
  await connectDatabase();

  await dropLegacyIndexes();

  await connectRedis(); // never throws — logs its own status

  // Ensure super admin account always exists and is verified — prevents daily lockout
  await ensureSuperAdmin();

  // Seed system permissions + default roles for all existing tenants (idempotent, fire-and-forget)
  import('./modules/rbac/rbac.seed').then(async ({ ensureSystemPermissions }) => {
    const { Tenant } = await import('./modules/tenants/tenant.model');
    const tenantIds  = await Tenant.distinct('_id', { isActive: true });
    await Promise.allSettled(tenantIds.map((id: unknown) => ensureSystemPermissions(String(id))));
    logger.info(`RBAC seed complete for ${tenantIds.length} tenant(s)`);
  }).catch((err) => logger.warn('RBAC seed skipped on startup', { error: (err as Error).message }));

  // Seed the 5 system Automation Flow templates (idempotent upsert-by-name,
  // global — not per-tenant, unlike RBAC above) — fire-and-forget, same posture.
  import('./modules/native-crm/automation-templates/automation-template.service')
    .then(({ seedDefaultTemplates }) => seedDefaultTemplates())
    .catch((err) => logger.warn('Automation template seed skipped on startup', { error: (err as Error).message }));

  // Meilisearch index setup — non-blocking, falls back to MongoDB if not configured
  ensureMeiliIndex().catch((err) => logger.warn('Meilisearch init skipped', { err: (err as Error).message }));

  // initQueues starts cron jobs regardless of Redis availability
  initQueues();

  const httpServer = http.createServer(app);

  const io = new SocketServer(httpServer, {
    cors: {
      // Reflects whatever Origin sent the handshake, rather than the single
      // fixed config.app.frontendUrl this was before — the admin dashboard
      // is still the only connector of STAFF-shaped tokens, but the Human
      // Handoff widget socket (leadryze-widget/src/loader.ts) connects from
      // an arbitrary tenant website, exactly like the existing public-widget
      // REST routes already allow (see public-widget.controller.ts's own
      // per-tenant isOriginAllowed() check). CORS is not the real security
      // boundary here either way — io.use()'s JWT verification is: a staff
      // token and the narrowly-scoped widget token (scope:'widget', no
      // userId/role) are checked there regardless of what Origin connected.
      origin: (_origin, callback) => callback(null, true),
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  // Require a valid JWT before allowing any socket connection. Two shapes
  // are accepted: a normal staff/admin login token (tenantId/userId/role/
  // roleId — same token the REST API uses), or a narrowly-scoped
  // Human-Handoff widget token (scope:'widget', tenantId, sessionId — no
  // userId/role at all) minted server-side when a visitor requests a
  // handoff (see public-widget.controller.ts's postHandoffRequest). Both
  // are verified with the same secret (no second secret to manage), but a
  // widget token structurally cannot satisfy anything gated on
  // socket.data.role/roleId below — it never reuses or extends staff-level
  // access, it's a separate, deliberately minimal capability.
  io.use((socket, next) => {
    const token = (socket.handshake.auth?.token || socket.handshake.query?.token) as string | undefined;
    if (!token) {
      return next(new Error('Authentication required'));
    }
    try {
      const payload = jwt.verify(token, config.jwt.secret) as {
        scope?: string; tenantId: string; userId?: string; role?: string; roleId?: string; sessionId?: string;
      };
      if (payload.scope === 'widget') {
        socket.data.isWidgetVisitor = true;
        socket.data.tenantId        = payload.tenantId;
        socket.data.widgetSessionId = payload.sessionId;
        // Deliberately NOT setting userId/role/roleId — this connection
        // must never be able to pass a staff-gated check below.
      } else {
        socket.data.tenantId = payload.tenantId;
        socket.data.userId   = payload.userId;
        socket.data.role     = payload.role;
        socket.data.roleId   = payload.roleId;
      }
      next();
    } catch {
      logSecurityEvent('websocket.auth_failed', {
        ip:        socket.handshake.address ?? 'unknown',
        userAgent: (socket.handshake.headers['user-agent'] as string) ?? 'unknown',
        detail:    { reason: 'invalid_or_missing_token' },
      });
      next(new Error('Invalid or expired token'));
    }
  });

  io.on('connection', (socket) => {
    logger.info('WebSocket client connected', { socketId: socket.id, tenantId: socket.data.tenantId, isWidgetVisitor: !!socket.data.isWidgetVisitor });

    socket.on('join-tenant', (tenantId: string) => {
      // Widget-scoped connections can never join a tenant-wide room —
      // only their own single conversation (see join-own-session below).
      if (socket.data.isWidgetVisitor) {
        socket.emit('error', { message: 'Access denied' });
        return;
      }
      // Only allow joining own tenant room
      if (tenantId !== socket.data.tenantId) {
        socket.emit('error', { message: 'Access denied: cannot join another tenant room' });
        return;
      }
      socket.join(`tenant:${tenantId}`);
    });

    socket.on('join-session', (sessionId: string) => {
      // Session IDs are UUIDs — validated to be non-empty string only
      if (typeof sessionId === 'string' && sessionId.length > 0) {
        socket.join(`session:${sessionId}`);
      }
    });

    // Human Handoff — staff-only shared inbox room, gated by the exact same
    // permission check requirePermission('native_crm.conversations.view')
    // already enforces on the REST routes (same hasPermission() call), so
    // the socket-level gate and the REST-level gate can never drift apart.
    // Deliberately a NARROWER room than the existing bare tenant:{id} one
    // above — that room has no per-permission check at all, and handoff
    // payloads carry visitor name/email/message previews that must not
    // reach a staff connection without conversations.view.
    socket.on('join-conversations', async (tenantId: string) => {
      if (socket.data.isWidgetVisitor) { socket.emit('error', { message: 'Access denied' }); return; }
      if (tenantId !== socket.data.tenantId) { socket.emit('error', { message: 'Access denied: cannot join another tenant room' }); return; }
      const { role, roleId } = socket.data as { role?: string; roleId?: string };
      const allowed = role === 'SUPER_ADMIN' || role === 'TENANT_ADMIN'
        || (!!roleId && await hasPermission(tenantId, roleId, 'native_crm.conversations.view'));
      if (!allowed) { socket.emit('error', { message: 'Access denied' }); return; }
      socket.join(`tenant:${tenantId}:conversations`);
    });

    // Human Handoff — the ONLY room a widget-scoped visitor connection may
    // ever join, and only the single session its own token was minted for
    // (read off the verified token payload, never a client-supplied
    // sessionId) — structurally impossible to join any other visitor's
    // conversation, let alone a tenant-wide room.
    socket.on('join-own-session', () => {
      if (!socket.data.isWidgetVisitor || !socket.data.widgetSessionId) { socket.emit('error', { message: 'Access denied' }); return; }
      socket.join(`session:${socket.data.widgetSessionId}`);
    });

    socket.on('disconnect', () => {
      logger.info('WebSocket client disconnected', { socketId: socket.id });
    });
  });

  app.set('io', io);

  httpServer.listen(config.app.port, () => {
    logger.info(`LeadRyze backend running`, {
      port: config.app.port,
      env: config.app.env,
      swagger: `http://localhost:${config.app.port}/api-docs`,
      health: `http://localhost:${config.app.port}/health`,
    });
  });

  const shutdown = (): void => {
    logger.info('Shutdown signal received — closing server gracefully');
    httpServer.close(() => {
      logger.info('HTTP server closed');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', { reason });
    process.exit(1);
  });

  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { error: err.message, stack: err.stack });
    process.exit(1);
  });
}

bootstrap().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
