/**
 * Centralized environment + security configuration for Noir Detailing.
 * Loads environment variables from server/.env or root .env, resolves the
 * JWT signing secret, and exposes shared config to the rest of the app.
 */

const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// Load environment variables from server/.env or root .env (first match wins)
const envPaths = [
  path.join(__dirname, '../.env'),
  path.join(__dirname, '../../.env'),
  path.join(process.cwd(), 'server/.env'),
  path.join(process.cwd(), '.env')
];
for (const envPath of envPaths) {
  if (fs.existsSync(envPath)) {
    // Real environment variables win over .env (standard precedence, and it
    // lets CI / Docker / tests override local development values).
    dotenv.config({ path: envPath });
    break;
  }
}

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProduction = NODE_ENV === 'production';

/**
 * JWT signing secret. A hardcoded fallback is intentionally NOT provided so a
 * misconfigured deployment fails fast instead of silently using a known secret.
 */
const JWT_SECRET = process.env.JWT_SECRET;

if (isProduction && !JWT_SECRET) {
  console.error('CRITICAL SECURITY WARNING: JWT_SECRET environment variable is missing in production!');
}

const toBool = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
};

const toIntList = (value, fallback) => {
  if (!value) return fallback;
  const parts = String(value)
    .split(',')
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((part) => Number.isFinite(part) && part >= 0);
  return parts.length ? parts : fallback;
};

module.exports = {
  NODE_ENV,
  isProduction,
  JWT_SECRET,
  PORT: process.env.PORT || 5001,
  ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGIN || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),

  // PayMongo (server-side secret only; the public key lives in the SPA)
  PAYMONGO_SECRET_KEY: (process.env.PAYMONGO_SECRET_KEY || '').trim(),

  // Public origin of the SPA, used for links inside billing emails
  PUBLIC_APP_URL: (process.env.PUBLIC_APP_URL || 'http://localhost:5173').replace(/\/+$/, ''),

  // Recurring billing (Option C: card autopay where available, auto-invoice otherwise)
  AUTO_BILLING: {
    enabled: toBool(process.env.AUTO_BILLING_ENABLED, true),
    // When true the job only logs what it would do - nothing is charged or written.
    dryRun: toBool(process.env.AUTO_BILLING_DRY_RUN, true),
    cron: process.env.AUTO_BILLING_CRON || '0 8 * * *',
    timezone: process.env.BUSINESS_TIMEZONE || 'Asia/Manila',
    monthlyFee: Number.parseFloat(process.env.SUBSCRIPTION_MONTHLY_FEE || '1500'),
    // Days of continued VIP access after a failed/unpaid renewal before expiry
    graceDays: Number.parseInt(process.env.AUTO_BILLING_GRACE_DAYS || '5', 10),
    // Day offsets (since the billing date) at which a failed charge is retried
    retryDays: toIntList(process.env.AUTO_BILLING_RETRY_DAYS, [0, 3, 7]),
    // Reminder email sent this many days before the renewal date
    reminderDays: Number.parseInt(process.env.AUTO_BILLING_REMINDER_DAYS || '3', 10)
  }
};
