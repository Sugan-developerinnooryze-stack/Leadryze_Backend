import dotenv from 'dotenv';
dotenv.config();

export const config = {
  app: {
    env: process.env.NODE_ENV || 'development',
    port: parseInt(process.env.PORT || '5000', 10),
    apiVersion: process.env.API_VERSION || 'v1',
    frontendUrl: process.env.FRONTEND_URL || 'http://localhost:3000',
    aiServiceUrl: process.env.AI_SERVICE_URL || 'http://localhost:5001',
  },
  mongodb: {
    uri: process.env.MONGODB_URI || 'mongodb://localhost:27017/leadryze',
  },
  redis: {
    url: process.env.REDIS_URL || '',
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || '',
    tls: process.env.REDIS_TLS === 'true',
  },
  jwt: {
    secret: process.env.JWT_SECRET || 'fallback-secret-change-in-production-32chars',
    expiresIn: process.env.JWT_EXPIRES_IN || '15m',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'refresh-fallback-change-in-prod',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
    // Separate secret for staff/customer mobile-app tokens — app tokens must never
    // validate against the admin JWT secret (and vice versa)
    appSecret: process.env.APP_JWT_SECRET || (process.env.JWT_SECRET || 'fallback-secret-change-in-production-32chars') + '.app',
    appExpiresIn: process.env.APP_JWT_EXPIRES_IN || '12h',
  },
  encryption: {
    key: process.env.ENCRYPTION_KEY || '32-char-key-change-in-production!',
  },
  brevo: {
    apiKey: process.env.BREVO_API_KEY || '',
    senderEmail: process.env.BREVO_SENDER_EMAIL || 'noreply@leadryze.ai',
    senderName: process.env.BREVO_SENDER_NAME || 'LeadRyze AI',
  },
  meta: {
    waPhoneNumberId: process.env.META_WA_PHONE_NUMBER_ID || '',
    waAccessToken: process.env.META_WA_ACCESS_TOKEN || '',
    waVerifyToken: process.env.META_WA_VERIFY_TOKEN || '',
    appSecret: process.env.META_APP_SECRET || '',
    igAccessToken: process.env.META_IG_ACCESS_TOKEN || '',
    pageId: process.env.META_PAGE_ID || '',
  },
  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID || '',
    authToken: process.env.TWILIO_AUTH_TOKEN || '',
    phoneNumber: process.env.TWILIO_PHONE_NUMBER || '',
  },
  hubspot: {
    clientId: process.env.HUBSPOT_CLIENT_ID || '',
    clientSecret: process.env.HUBSPOT_CLIENT_SECRET || '',
    redirectUri: process.env.HUBSPOT_REDIRECT_URI || '',
  },
  zoho: {
    clientId: process.env.ZOHO_CLIENT_ID || '',
    clientSecret: process.env.ZOHO_CLIENT_SECRET || '',
  },
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    redirectUri: process.env.GOOGLE_REDIRECT_URI || '',
  },
  ai: {
    internalApiKey: process.env.AI_INTERNAL_API_KEY || 'internal-key',
    internalServiceKey: process.env.INTERNAL_SERVICE_KEY || 'leadryze-service-key-change-in-prod',
  },
  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '900000', 10),
    max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10),
  },
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    dir: process.env.LOG_DIR || './logs',
  },
  s3: {
    endpoint:   process.env.SUPABASE_S3_ENDPOINT  || '',
    region:     process.env.SUPABASE_S3_REGION    || 'ap-northeast-1',
    bucket:     process.env.SUPABASE_S3_BUCKET    || 'Sugan_Devops_S3',
    keyId:      process.env.SUPABASE_S3_KEY_ID    || '',
    secret:     process.env.SUPABASE_S3_SECRET    || '',
    publicUrl:  process.env.SUPABASE_PUBLIC_URL   || '',
    backendUrl: process.env.BACKEND_URL           || 'http://localhost:5000',
  },
};

// Crash on startup in production if any secret is still using its insecure default value
if (config.app.env === 'production') {
  const insecureChecks: Array<[string, string, string]> = [
    ['JWT_SECRET',           config.jwt.secret,              'fallback-secret-change-in-production-32chars'],
    ['JWT_REFRESH_SECRET',   config.jwt.refreshSecret,       'refresh-fallback-change-in-prod'],
    ['ENCRYPTION_KEY',       config.encryption.key,          '32-char-key-change-in-production!'],
    ['INTERNAL_SERVICE_KEY', config.ai.internalServiceKey,   'leadryze-service-key-change-in-prod'],
    ['AI_INTERNAL_API_KEY',  config.ai.internalApiKey,       'internal-key'],
  ];
  for (const [name, value, badDefault] of insecureChecks) {
    if (!value || value === badDefault || value.length < 20) {
      throw new Error(
        `[CONFIG] ${name} is insecure or missing. Set a strong unique value in production .env before starting the server.`
      );
    }
  }
  // AES-256-GCM requires an exactly-32-byte key — a wrong length passes the
  // generic check above but throws later on the first encrypt()/decrypt() call.
  if (config.encryption.key.length !== 32) {
    throw new Error(
      `[CONFIG] ENCRYPTION_KEY must be exactly 32 characters (got ${config.encryption.key.length}). ` +
      `Generate one: node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"`
    );
  }
}
