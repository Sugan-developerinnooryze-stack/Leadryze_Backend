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

  // Meilisearch index setup — non-blocking, falls back to MongoDB if not configured
  ensureMeiliIndex().catch((err) => logger.warn('Meilisearch init skipped', { err: (err as Error).message }));

  // initQueues starts cron jobs regardless of Redis availability
  initQueues();

  const httpServer = http.createServer(app);

  const io = new SocketServer(httpServer, {
    cors: {
      origin: config.app.frontendUrl,
      methods: ['GET', 'POST'],
      credentials: true,
    },
  });

  // Require a valid JWT before allowing any socket connection
  io.use((socket, next) => {
    const token = (socket.handshake.auth?.token || socket.handshake.query?.token) as string | undefined;
    if (!token) {
      return next(new Error('Authentication required'));
    }
    try {
      const payload = jwt.verify(token, config.jwt.secret) as { tenantId: string; userId: string };
      socket.data.tenantId = payload.tenantId;
      socket.data.userId   = payload.userId;
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
    logger.info('WebSocket client connected', { socketId: socket.id, tenantId: socket.data.tenantId });

    socket.on('join-tenant', (tenantId: string) => {
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
