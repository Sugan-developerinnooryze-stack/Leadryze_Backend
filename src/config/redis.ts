import Redis from 'ioredis';
import { config } from './index';
import { logger } from '../utils/logger';

let redisClient: Redis | null = null;
let redisAvailable = false;

export function isRedisAvailable(): boolean {
  return redisAvailable;
}

export function getRedisClient(): Redis | null {
  return redisClient;
}

/** Returns a new ioredis instance configured for BullMQ (maxRetriesPerRequest: null required) */
export function createBullMQConnection(): Redis {
  return config.redis.url
    ? new Redis(config.redis.url, { maxRetriesPerRequest: null, enableOfflineQueue: false })
    : new Redis({
        host: config.redis.host,
        port: config.redis.port,
        password: config.redis.password || undefined,
        tls: config.redis.tls ? { rejectUnauthorized: false } : undefined,
        maxRetriesPerRequest: null,
        enableOfflineQueue: false,
      });
}

/**
 * Try to connect to Redis. Never throws — if Redis is unavailable the server
 * starts in degraded mode (no rate limiting, no BullMQ queues).
 */
export async function connectRedis(): Promise<void> {
  const client = config.redis.url
    ? new Redis(config.redis.url, { retryStrategy: () => null, enableOfflineQueue: false })
    : new Redis({
        host: config.redis.host,
        port: config.redis.port,
        password: config.redis.password || undefined,
        tls: config.redis.tls ? { rejectUnauthorized: false } : undefined,
        retryStrategy: () => null,
        enableOfflineQueue: false,
      });

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      client.disconnect();
      resolve();
    }, 5000);

    client.once('ready', () => {
      clearTimeout(timer);
      redisAvailable = true;
      redisClient = client;
      logger.info('Redis connected');

      client.on('error', () => { redisAvailable = false; });
      client.on('close', () => { redisAvailable = false; });
      client.on('ready', () => { redisAvailable = true; });
      resolve();
    });

    client.once('error', () => {
      clearTimeout(timer);
      client.disconnect();
      resolve();
    });
  });
}

export async function disconnectRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    logger.info('Redis disconnected gracefully');
  }
}

// ── Cache helpers (safe — no-op when Redis is unavailable) ──────────────────

export async function cacheGet(key: string): Promise<string | null> {
  const r = getRedisClient();
  return r ? r.get(key) : null;
}

export async function cacheSet(key: string, value: string, ttlSeconds: number): Promise<void> {
  const r = getRedisClient();
  if (r) await r.setex(key, ttlSeconds, value);
}

export async function cacheDel(...keys: string[]): Promise<void> {
  const r = getRedisClient();
  if (r && keys.length) await r.del(...keys);
}

export async function cacheDelPattern(pattern: string): Promise<void> {
  const r = getRedisClient();
  if (!r) return;
  const keys = await r.keys(pattern);
  if (keys.length) await r.del(...keys);
}
