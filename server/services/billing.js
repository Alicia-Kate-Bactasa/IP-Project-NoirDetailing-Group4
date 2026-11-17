/**
 * Recurring VIP membership billing — "Option C": card autopay where available,
 * auto-invoicing (with grace + dunning) for every other payment method.
 *
 * Design notes
 * ------------
 * - A `BillingPeriod` row is the unit of work. Its unique
 *   (subscription_id, period_start) constraint plus an optimistic claim on
 *   `last_attempt_at` makes the job safe to run twice or concurrently.
 * - Card charges use a stable PayMongo `Idempotency-Key`, so a retried run
 *   cannot double-charge the same member for the same period.
 * - GCash / Maya cannot be charged unattended, so those members get an invoice
 *   email and keep access until the grace window closes.
 * - Nothing is charged or written when `AUTO_BILLING_DRY_RUN=true`.
 */

const cron = require('node-cron');
const prisma = require('../config/db');
const config = require('../config');
const paymongo = require('./paymongo');
const mailer = require('./mailer');
const {
  todayInTimezone,
  startOfDate,
  addMonthsClamped,
  addDaysClamped,
  dateOnlyKey,
  daysBetween,
  TIMEZONE
} = require('./scheduling');

const { AUTO_BILLING, PUBLIC_APP_URL } = config;
const MEMBER_AREA_URL = `${PUBLIC_APP_URL}/dashboard`;
const DAY_MS = 24 * 60 * 60 * 1000;
const RETRY_COOLDOWN_HOURS = 20;
const CLAIM_LEASE_MINUTES = 5;

const money = (value) => Number(value || 0).toFixed(2);
const lastRetryDay = () => AUTO_BILLING.retryDays[AUTO_BILLING.retryDays.length - 1] ?? 0;

const safeEmail = (promise, label) => {
  Promise.resolve(promise).catch((err) => console.error(`Billing email failed (${label}):`, err.message));
};

/** Period start/end for the cycle that begins on the subscription's due date. */
const computePeriodWindow = (nextBillingDate) => {
  const start = startOfDate(nextBillingDate);
  if (!start) return null;
  return { start, end: addDaysClamped(addMonthsClamped(start, 1), -1) };
};

/** Creates (or reuses) the idempotent BillingPeriod row for a cycle. */
const ensurePeriod = (subscriptionId, start, end, amount) =>
  prisma.billingPeriod.upsert({
    where: {
      subscription_id_period_start: { subscription_id: subscriptionId, period_start: start }
    },
    create: {
      subscription_id: subscriptionId,
      period_start: start,
      period_end: end,
      amount,
      status: 'Scheduled'
    },
    update: {}
  });

/**
 * Optimistically claims a period for this run. Returns false when another worker
 * (or an earlier run within the lease window) already owns it.
 */
const claimPeriod = async (periodId, now) => {
  const result = await prisma.billingPeriod.updateMany({
    where: {
      period_id: periodId,
      status: { in: ['Scheduled', 'Invoiced', 'Failed'] },
      OR: [
        { last_attempt_at: null },
        { last_attempt_at: { lt: new Date(now.getTime() - CLAIM_LEASE_MINUTES * 60 * 1000) } }
      ]
    },
    data: {
      status: 'Processing',
      last_attempt_at: now,
      attempt_count: { increment: 1 }
    }
  });
  return result.count === 1;
};

/** Marks a cycle paid and advances the membership by exactly one month. */
const recordPaidPeriod = async ({
  subscription,
  period,
  amount,
  periodStart,
  now,
  paymentMethod,
  provider,
  providerPaymentId
}) => {
  const nextBillingDate = addMonthsClamped(periodStart, 1);

  const result = await prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.create({
      data: {
        subscription_id: subscription.subscription_id,
        total_amount: amount,
        invoice_type: 'Monthly_Roster',
        invoice_status: 'Paid'
      }
    });

    const payment = await tx.payment.create({
      data: {
        invoice_id: invoice.invoice_id,
        amount,
        payment_method: paymentMethod,
        proof_of_payment: 'AUTO_BILLING_VERIFIED',
        payment_status: 'Paid',
        provider,
        provider_payment_id: providerPaymentId || null
      }
    });

    await tx.billingPeriod.update({
      where: { period_id: period.period_id },
      data: {
        status: 'Paid',
        invoice_id: invoice.invoice_id,
        last_error: null,
        last_attempt_at: now
      }
    });

    await tx.subscription.update({
      where: { subscription_id: subscription.subscription_id },
      data: {
        plan_status: 'Active',
        last_billing_date: periodStart,
        next_billing_date: nextBillingDate,
        retry_count: 0,
        grace_period_start: null,
        last_billing_attempt_at: now,
        reminder_sent_at: null
      }
    });

    return { invoice, payment };
  });

  return { ...result, nextBillingDate };
};

/** Records a failed attempt and starts/extends the grace window. */
const recordFailure = async ({ subscription, period, reason, now }) => {
  await prisma.billingPeriod.update({
    where: { period_id: period.period_id },
    data: { status: 'Failed', last_error: reason, last_attempt_at: now }
  });

  return prisma.subscription.update({
    where: { subscription_id: subscription.subscription_id },
    data: {
      plan_status: 'Payment_Pending',
      grace_period_start: subscription.grace_period_start || now,
      retry_count: { increment: 1 },
      last_billing_attempt_at: now
    }
  });
};

/**
 * Creates (or reuses) the pending renewal invoice for auto-invoice members.
 * Reusing avoids invoice spam when the job runs daily or a member clicks twice.
 */
const issueInvoice = async ({ subscription, period, amount, now, dueDate }) => {
  if (period.invoice_id) {
    const existing = await prisma.invoice.findUnique({ where: { invoice_id: period.invoice_id } });
    if (existing && existing.invoice_status === 'Pending') {
      return { invoice: existing, created: false };
    }
  }

  const reusable = await prisma.invoice.findFirst({
    where: {
      subscription_id: subscription.subscription_id,
      invoice_status: 'Pending',
      invoice_type: 'Monthly_Roster'
    },
    orderBy: { invoice_id: 'desc' }
  });

  const invoice =
    reusable ||
    (await prisma.invoice.create({
      data: {
        subscription_id: subscription.subscription_id,
        total_amount: amount,
        invoice_type: 'Monthly_Roster',
        invoice_status: 'Pending'
      }
    }));

  await prisma.billingPeriod.update({
    where: { period_id: period.period_id },
    data: {
      status: 'Invoiced',
      invoice_id: invoice.invoice_id,
      last_attempt_at: now,
      last_error: null
    }
  });

  return { invoice, created: !reusable };
};

const expireSubscription = async ({ subscription, dryRun, reason }) => {
  if (dryRun) return { action: 'would_expire', reason };

  const member = subscription.user;

  const updated = await prisma.subscription.update({
    where: { subscription_id: subscription.subscription_id },
    data: { plan_status: 'Expired', grace_period_start: null, retry_count: 0 },
    include: { user: true }
  });

  const email = member?.email || updated.user?.email;
  if (email) {
    safeEmail(
      mailer.sendSubscriptionExpiredEmail({
        to: email,
        clientName: member?.username || updated.user?.username,
        subscriptionId: updated.subscription_id,
        amount: money(AUTO_BILLING.monthlyFee),
        payUrl: MEMBER_AREA_URL
      }),
      'expired'
    );
  }

  return { action: 'expired', reason };
};

/** True when enough time has passed since the last attempt to try again. */
const retryWindowOpen = (subscription, periodStart, now) => {
  const daysSinceStart = Math.max(0, Math.round((now - periodStart) / DAY_MS));
  if (daysSinceStart > lastRetryDay()) return false;
  if (subscription.retry_count >= AUTO_BILLING.retryDays.length) return false;

  const lastAttempt = subscription.last_billing_attempt_at
    ? new Date(subscription.last_billing_attempt_at)
    : null;
  const hoursSince = lastAttempt ? (now - lastAttempt) / (60 * 60 * 1000) : Infinity;
  return hoursSince >= RETRY_COOLDOWN_HOURS;
};

/**
 * Processes one subscription whose renewal date has arrived.
 * @returns {Promise<{action: string, reason?: string, amount?: string}>}
 */
const processSubscription = async (subscription, ctx) => {
  const { today, now, dryRun } = ctx;
  const nextDate = startOfDate(subscription.next_billing_date);
  if (!nextDate) return { action: 'skipped', reason: 'no_billing_date' };

  // Cancel-at-period-end: access simply runs out, nothing is charged.
  if (subscription.plan_status === 'Cancellation_Pending') {
    return expireSubscription({ subscription, dryRun, reason: 'cancellation_effective' });
  }

  // Auto-renew switched off: expire at period end instead of charging.
  if (subscription.plan_status === 'Active' && !subscription.auto_renew) {
    return expireSubscription({ subscription, dryRun, reason: 'auto_renew_disabled' });
  }

  const window = computePeriodWindow(nextDate);
  const amount = AUTO_BILLING.monthlyFee;

  // A dry run must not write anything, so it only *reads* the existing ledger
  // row for this cycle instead of creating one.
  const period = dryRun
    ? await prisma.billingPeriod.findUnique({
        where: {
          subscription_id_period_start: {
            subscription_id: subscription.subscription_id,
            period_start: window.start
          }
        }
      })
    : await ensurePeriod(subscription.subscription_id, window.start, window.end, amount);

  if (period?.status === 'Paid') {
    // Self-heal: the cycle is settled but the subscription dates lag behind.
    if (!dryRun) {
      await prisma.subscription.update({
        where: { subscription_id: subscription.subscription_id },
        data: {
          plan_status: 'Active',
          last_billing_date: window.start,
          next_billing_date: addMonthsClamped(window.start, 1),
          retry_count: 0,
          grace_period_start: null
        }
      });
    }
    return { action: 'skipped', reason: 'period_already_paid' };
  }

  const canAutopay = Boolean(subscription.payment_method_id) && paymongo.isConfigured();
  const graceAnchor = subscription.grace_period_start
    ? new Date(subscription.grace_period_start)
    : window.start;
  const graceEndsAt = new Date(graceAnchor.getTime() + AUTO_BILLING.graceDays * DAY_MS);
  const graceExpired = now >= graceEndsAt;
  const daysSinceStart = Math.max(0, daysBetween(window.start, today));

  // ---------------------------------------------------------------------------
  // Path A — saved card: charge silently, fall back to invoicing on failure.
  // ---------------------------------------------------------------------------
  if (canAutopay) {
    if (graceExpired) {
      return expireSubscription({ subscription, dryRun, reason: 'grace_period_elapsed' });
    }
    if (!retryWindowOpen(subscription, window.start, now)) {
      return { action: 'skipped', reason: 'retry_cooldown' };
    }

    if (dryRun) {
      return { action: 'would_charge', amount: money(amount) };
    }

    const claimed = await claimPeriod(period.period_id, now);
    if (!claimed) return { action: 'skipped', reason: 'already_in_progress' };

    const charge = await paymongo.chargeSavedCard({
      amount,
      paymentMethodId: subscription.payment_method_id,
      description: `Noir Detailing VIP membership — ${dateOnlyKey(window.start)}`,
      metadata: {
        subscription_id: String(subscription.subscription_id),
        billing_period: dateOnlyKey(window.start)
      },
      returnUrl: MEMBER_AREA_URL,
      idempotencyKey: `sub-${subscription.subscription_id}-${dateOnlyKey(window.start)}`
    });

    if (charge.ok && charge.status === 'succeeded') {
      const paid = await recordPaidPeriod({
        subscription,
        period,
        amount,
        periodStart: window.start,
        now,
        paymentMethod: subscription.payment_method_brand
          ? `${subscription.payment_method_brand} ending ${subscription.payment_method_last4 || '****'}`
          : 'Saved card (autopay)',
        provider: 'paymongo',
        providerPaymentId: charge.paymentIntentId
      });

      const email = subscription.user?.email;
      if (email) {
        safeEmail(
          mailer.sendMonthlySubscriptionPaymentEmail({
            to: email,
            clientName: subscription.user?.username,
            subscriptionId: subscription.subscription_id,
            invoiceId: paid.invoice.invoice_id,
            amount: money(amount),
            nextBillingDate: dateOnlyKey(paid.nextBillingDate)
          }),
          'autopay-receipt'
        );
      }

      return { action: 'charged', amount: money(amount) };
    }

    const reason = charge.ok
      ? `Card requires member action (${charge.status})`
      : charge.error || 'Card charge failed';

    await recordFailure({ subscription, period, reason, now });

    const email = subscription.user?.email;
    if (email) {
      safeEmail(
        mailer.sendSubscriptionPaymentFailedEmail({
          to: email,
          clientName: subscription.user?.username,
          subscriptionId: subscription.subscription_id,
          amount: money(amount),
          reason,
          graceEndsAt: dateOnlyKey(addDaysClamped(now, AUTO_BILLING.graceDays)),
          payUrl: MEMBER_AREA_URL
        }),
        'autopay-failed'
      );
    }

    return { action: 'failed', reason };
  }

  // ---------------------------------------------------------------------------
  // Path B — no saved card (GCash / Maya / walk-in): auto-invoice + dunning.
  // ---------------------------------------------------------------------------
  if (daysSinceStart >= AUTO_BILLING.graceDays + lastRetryDay()) {
    return expireSubscription({ subscription, dryRun, reason: 'invoice_unpaid' });
  }

  if (dryRun) {
    return { action: 'would_invoice', amount: money(amount) };
  }

  const { invoice, created } = await issueInvoice({
    subscription,
    period,
    amount,
    now,
    dueDate: addDaysClamped(window.start, AUTO_BILLING.graceDays)
  });

  const email = subscription.user?.email;
  if (email && created) {
    safeEmail(
      mailer.sendSubscriptionInvoiceReadyEmail({
        to: email,
        clientName: subscription.user?.username,
        subscriptionId: subscription.subscription_id,
        invoiceId: invoice.invoice_id,
        amount: money(amount),
        dueDate: dateOnlyKey(addDaysClamped(window.start, AUTO_BILLING.graceDays)),
        payUrl: MEMBER_AREA_URL
      }),
      'invoice-ready'
    );
  }

  // Grace is over but the invoice is still open: start dunning, keep perks a
  // little longer while the retry window runs out.
  if (subscription.plan_status === 'Active' && daysSinceStart >= AUTO_BILLING.graceDays) {
    await prisma.subscription.update({
      where: { subscription_id: subscription.subscription_id },
      data: {
        plan_status: 'Payment_Pending',
        grace_period_start: subscription.grace_period_start || now,
        last_billing_attempt_at: now
      }
    });

    if (email) {
      safeEmail(
        mailer.sendSubscriptionPaymentFailedEmail({
          to: email,
          clientName: subscription.user?.username,
          subscriptionId: subscription.subscription_id,
          amount: money(amount),
          reason: `Renewal invoice INV-${invoice.invoice_id} is still unpaid`,
          graceEndsAt: dateOnlyKey(addDaysClamped(window.start, AUTO_BILLING.graceDays + lastRetryDay())),
          payUrl: MEMBER_AREA_URL
        }),
        'invoice-dunning'
      );
    }

    return { action: 'dunning', invoiceId: invoice.invoice_id };
  }

  return { action: created ? 'invoiced' : 'invoice_pending', invoiceId: invoice.invoice_id };
};

/** Sends the "your membership renews soon" email a few days ahead. */
const runReminderPass = async ({ today, now, dryRun, summary }) => {
  if (AUTO_BILLING.reminderDays <= 0) return;

  const targetDate = addDaysClamped(today, AUTO_BILLING.reminderDays);
  const subscriptions = await prisma.subscription.findMany({
    where: {
      plan_status: 'Active',
      auto_renew: true,
      next_billing_date: targetDate
    },
    include: { user: true }
  });

  for (const subscription of subscriptions) {
    const alreadySent =
      subscription.reminder_sent_at &&
      startOfDate(subscription.reminder_sent_at) >= addDaysClamped(targetDate, -AUTO_BILLING.reminderDays);
    if (alreadySent) continue;

    if (dryRun) {
      summary.reminded.push({ subscription_id: subscription.subscription_id, dry_run: true });
      continue;
    }

    await prisma.subscription.update({
      where: { subscription_id: subscription.subscription_id },
      data: { reminder_sent_at: now }
    });

    const email = subscription.user?.email;
    if (email) {
      safeEmail(
        mailer.sendSubscriptionRenewalReminderEmail({
          to: email,
          clientName: subscription.user?.username,
          subscriptionId: subscription.subscription_id,
          amount: money(AUTO_BILLING.monthlyFee),
          renewalDate: dateOnlyKey(targetDate),
          payUrl: MEMBER_AREA_URL
        }),
        'renewal-reminder'
      );
    }

    summary.reminded.push({ subscription_id: subscription.subscription_id, renewal: dateOnlyKey(targetDate) });
  }
};

/**
 * Runs one billing sweep.
 * @param {object} [options]
 * @param {boolean} [options.dryRun]      Override the env dry-run flag.
 * @param {Date}    [options.now]
 * @param {number}  [options.subscriptionId] Restrict to a single subscription.
 */
const runBillingCycle = async ({ dryRun = AUTO_BILLING.dryRun, now = new Date(), subscriptionId } = {}) => {
  const startedAt = new Date();
  const today = todayInTimezone(AUTO_BILLING.timezone, now);
  const summary = {
    startedAt,
    finishedAt: null,
    timezone: AUTO_BILLING.timezone,
    dryRun,
    scanned: 0,
    charged: [],
    invoiced: [],
    dunning: [],
    failed: [],
    expired: [],
    reminded: [],
    skipped: [],
    errors: []
  };

  await runReminderPass({ today, now, dryRun, summary });

  const dueSubscriptions = await prisma.subscription.findMany({
    where: {
      ...(subscriptionId ? { subscription_id: subscriptionId } : {}),
      plan_status: { in: ['Active', 'Payment_Pending', 'Cancellation_Pending'] },
      next_billing_date: { not: null, lte: today }
    },
    include: { user: true },
    orderBy: { subscription_id: 'asc' }
  });

  summary.scanned = dueSubscriptions.length;

  for (const subscription of dueSubscriptions) {
    try {
      const result = await processSubscription(subscription, { today, now, dryRun });
      const entry = { subscription_id: subscription.subscription_id, ...result };

      switch (result.action) {
        case 'charged':
        case 'would_charge':
          summary.charged.push(entry);
          break;
        case 'invoiced':
        case 'invoice_pending':
        case 'would_invoice':
          summary.invoiced.push(entry);
          break;
        case 'dunning':
          summary.dunning.push(entry);
          break;
        case 'failed':
          summary.failed.push(entry);
          break;
        case 'expired':
        case 'would_expire':
          summary.expired.push(entry);
          break;
        default:
          summary.skipped.push(entry);
      }
    } catch (err) {
      console.error(`Billing error for subscription ${subscription.subscription_id}:`, err);
      summary.errors.push({ subscription_id: subscription.subscription_id, message: err.message });
    }
  }

  summary.finishedAt = new Date();
  return summary;
};

/** Logs a compact, greppable summary of a billing run. */
const logSummary = (summary) => {
  const parts = [
    `scanned=${summary.scanned}`,
    `charged=${summary.charged.length}`,
    `invoiced=${summary.invoiced.length}`,
    `dunning=${summary.dunning.length}`,
    `failed=${summary.failed.length}`,
    `expired=${summary.expired.length}`,
    `reminded=${summary.reminded.length}`,
    `errors=${summary.errors.length}`
  ];
  console.log(`[billing] ${summary.dryRun ? 'DRY-RUN ' : ''}${parts.join(' ')}`);
  for (const error of summary.errors) {
    console.error(`[billing] subscription ${error.subscription_id}: ${error.message}`);
  }
};

let schedulerTask = null;

/** Starts the daily node-cron sweep. Safe to call once at boot. */
const startBillingScheduler = () => {
  if (!AUTO_BILLING.enabled) {
    console.log('[billing] Auto-billing disabled (AUTO_BILLING_ENABLED=false).');
    return null;
  }

  if (!cron.validate(AUTO_BILLING.cron)) {
    console.error(`[billing] Invalid AUTO_BILLING_CRON expression: "${AUTO_BILLING.cron}". Scheduler not started.`);
    return null;
  }

  schedulerTask = cron.schedule(
    AUTO_BILLING.cron,
    async () => {
      try {
        const summary = await runBillingCycle();
        logSummary(summary);
      } catch (err) {
        console.error('[billing] Scheduled run failed:', err);
      }
    },
    { timezone: AUTO_BILLING.timezone, noOverlap: true, name: 'noir-auto-billing' }
  );

  console.log(
    `💳 Auto-billing scheduled: "${AUTO_BILLING.cron}" (${AUTO_BILLING.timezone})` +
      `${AUTO_BILLING.dryRun ? ' — DRY RUN, no charges will be made' : ''}`
  );

  return schedulerTask;
};

const stopBillingScheduler = () => {
  if (schedulerTask) {
    schedulerTask.stop();
    schedulerTask = null;
  }
};

module.exports = {
  runBillingCycle,
  startBillingScheduler,
  stopBillingScheduler,
  logSummary,
  // exported for unit tests / reuse
  computePeriodWindow,
  ensurePeriod,
  issueInvoice,
  recordPaidPeriod
};
