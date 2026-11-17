/**
 * VIP Subscriptions API Router for Noir Detailing.
 * Handles VIP membership roster monitoring, member status checks (/me),
 * subscription renewals, cancellations, reactivations, autopay controls and
 * admin status updates.
 */

const express = require('express');
const router = express.Router();
const prisma = require('../config/db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const config = require('../config');
const { addMonthsClamped, addDaysClamped, dateOnlyKey, startOfDate } = require('../services/scheduling');

const MONTHLY_FEE = config.AUTO_BILLING.monthlyFee;

/** Latest subscription for an account (the app treats one plan per member). */
const findLatestSubscription = (userId) =>
  prisma.subscription.findFirst({
    where: { user_id: userId },
    orderBy: { subscription_id: 'desc' }
  });

/** Reuses an open renewal invoice instead of stacking duplicates. */
const findOrCreateRenewalInvoice = async (subscriptionId, amount = MONTHLY_FEE) => {
  const existing = await prisma.invoice.findFirst({
    where: {
      subscription_id: subscriptionId,
      invoice_status: 'Pending',
      invoice_type: 'Monthly_Roster'
    },
    orderBy: { invoice_id: 'desc' }
  });
  if (existing) return { invoice: existing, created: false };

  const invoice = await prisma.invoice.create({
    data: {
      subscription_id: subscriptionId,
      total_amount: amount,
      invoice_type: 'Monthly_Roster',
      invoice_status: 'Pending'
    }
  });
  return { invoice, created: true };
};

/** Formats a date-only value for user-facing messages. */
const displayDate = (value) => {
  const key = dateOnlyKey(value);
  return key || 'the end of the current period';
};

/**
 * GET /api/v1/subscriptions
 * Retrieves all subscriber accounts for admin monitoring.
 */
router.get('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    const where = {};
    if (status) {
      where.plan_status = status;
    }

    const subscriptions = await prisma.subscription.findMany({
      where,
      include: {
        user: { select: { user_id: true, email: true, username: true, role: true } },
        invoices: { include: { payments: true } }
      },
      orderBy: { subscription_id: 'desc' }
    });

    return res.status(200).json({
      status: 'success',
      data: subscriptions
    });
  } catch (error) {
    console.error('Error fetching subscriptions:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to retrieve subscriptions.' });
  }
});

/**
 * GET /api/v1/subscriptions/me
 * Get current subscriber status, autopay controls and recent billing history.
 */
router.get('/me', requireAuth, async (req, res) => {
  try {
    const email = (req.user.email || '').trim().toLowerCase();

    let user = null;
    if (email && email.length > 3) {
      user = await prisma.user.findUnique({ where: { email } }).catch(() => null);
    }

    let subscription = null;
    if (user) {
      subscription = await prisma.subscription.findFirst({
        where: { user_id: user.user_id },
        include: {
          invoices: { include: { payments: true } },
          billing_periods: {
            orderBy: { period_start: 'desc' },
            take: 6,
            include: { invoice: true }
          }
        },
        orderBy: { subscription_id: 'desc' }
      }).catch(() => null);
    }

    return res.status(200).json({
      status: 'success',
      data: {
        user: user || { email: email || null, username: 'VIP Member' },
        subscription,
        // Never expose the PayMongo payment method token itself
        payment_method: subscription?.payment_method_id
          ? {
              saved: true,
              brand: subscription.payment_method_brand,
              last4: subscription.payment_method_last4
            }
          : { saved: false },
        auto_renew: subscription?.auto_renew ?? null
      }
    });
  } catch (error) {
    console.error('Error fetching subscription profile:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Failed to retrieve subscription profile.'
    });
  }
});

/**
 * POST /api/v1/subscriptions/renew
 * Start a membership renewal. Never suspends an active plan (the member keeps
 * VIP perks while the invoice is open); activation happens on payment.
 */
router.post('/renew', requireAuth, async (req, res) => {
  try {
    const { plan_tier } = req.body || {};
    const tierName = plan_tier || 'Unlimited Basic Wash';

    const dbUser = await prisma.user.findUnique({
      where: { email: req.user.email }
    });

    if (!dbUser) {
      return res.status(404).json({ status: 'error', message: 'User not found.' });
    }

    let sub = await findLatestSubscription(dbUser.user_id);

    if (!sub) {
      // First-time purchase: nothing to protect, so park the plan until payment.
      sub = await prisma.subscription.create({
        data: {
          user_id: dbUser.user_id,
          plan_tier: tierName,
          plan_status: 'Payment_Pending',
          auto_renew: true
        }
      });
    } else if (!sub.next_billing_date && sub.plan_status !== 'Payment_Pending') {
      // Defensive: keep the billing cycle well-defined for legacy active rows.
      // A never-paid (Payment_Pending) plan gets its cycle only after payment.
      sub = await prisma.subscription.update({
        where: { subscription_id: sub.subscription_id },
        data: {
          plan_tier: tierName,
          next_billing_date: addMonthsClamped(new Date(), 1)
        }
      });
    } else if (plan_tier && plan_tier !== sub.plan_tier) {
      sub = await prisma.subscription.update({
        where: { subscription_id: sub.subscription_id },
        data: { plan_tier: tierName }
      });
    }

    // A renewal request must never downgrade a paying member.
    // Active / Cancellation_Pending / Payment_Pending keep their state until the
    // payment is actually verified (then /payments/verify flips them to Active).
    const { invoice } = await findOrCreateRenewalInvoice(sub.subscription_id);

    return res.status(200).json({
      status: 'success',
      message:
        sub.plan_status === 'Active'
          ? 'Renewal invoice ready. Your VIP perks stay active until it is paid.'
          : 'Subscription renewal request generated. Please upload payment proof or pay online for activation.',
      data: { subscription: sub, invoice }
    });
  } catch (error) {
    console.error('Error renewing subscription:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to generate renewal.' });
  }
});

/**
 * POST /api/v1/subscriptions/cancel
 * Schedule cancellation at the end of the paid period. Access is NOT revoked
 * immediately: the plan becomes Cancellation_Pending and auto-renew is turned
 * off, so the member keeps every perk until next_billing_date.
 */
router.post('/cancel', requireAuth, async (req, res) => {
  try {
    const requesterEmail = (req.user.email || '').trim().toLowerCase();
    const isAdmin = req.user.role === 'Admin';
    const requestedEmail = isAdmin && req.body?.email
      ? String(req.body.email).trim().toLowerCase()
      : requesterEmail;

    const user = await prisma.user.findUnique({ where: { email: requestedEmail } });
    if (!user) {
      return res.status(404).json({ status: 'error', message: 'User not found.' });
    }

    if (!isAdmin && user.email.toLowerCase() !== requesterEmail) {
      return res.status(403).json({ status: 'error', message: 'You may only cancel your own subscription.' });
    }

    const sub = await findLatestSubscription(user.user_id);

    if (!sub) {
      return res.status(404).json({ status: 'error', message: 'No subscription found for this account.' });
    }

    if (sub.plan_status === 'Cancellation_Pending') {
      return res.status(200).json({
        status: 'success',
        message: `Cancellation already scheduled. VIP access remains active until ${displayDate(sub.next_billing_date)}.`,
        data: sub
      });
    }

    if (sub.plan_status === 'Expired') {
      return res.status(200).json({
        status: 'success',
        message: 'This membership is already expired.',
        data: sub
      });
    }

    const accessUntil = sub.next_billing_date || addMonthsClamped(new Date(), 1);

    const cancelled = await prisma.subscription.update({
      where: { subscription_id: sub.subscription_id },
      data: {
        plan_status: 'Cancellation_Pending',
        canceled_at: new Date(),
        auto_renew: false
      }
    });

    if (requestedEmail.includes('@')) {
      const { sendSubscriptionCancelledEmail } = require('../services/mailer');
      sendSubscriptionCancelledEmail({
        to: requestedEmail,
        clientName: user?.username || 'VIP Member',
        subscriptionId: cancelled.subscription_id,
        accessUntil: dateOnlyKey(accessUntil)
      }).catch(e => console.error('Subscription Cancelled Email Error:', e));
    }

    return res.status(200).json({
      status: 'success',
      message: `Cancellation scheduled. Your VIP perks stay active until ${dateOnlyKey(accessUntil)}.`,
      data: cancelled
    });
  } catch (error) {
    console.error('Error cancelling subscription:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Failed to cancel subscription.'
    });
  }
});

/**
 * POST /api/v1/subscriptions/reactivate
 * Members can reverse a pending cancellation for free while their period is
 * still paid. Expired / payment-pending plans require a renewal payment, so the
 * response carries a payable invoice; admins may still override manually.
 */
router.post('/reactivate', requireAuth, async (req, res) => {
  try {
    const requesterEmail = (req.user.email || '').trim().toLowerCase();
    const isAdmin = req.user.role === 'Admin';
    const requestedEmail = isAdmin && req.body?.email
      ? String(req.body.email).trim().toLowerCase()
      : requesterEmail;

    const user = await prisma.user.findUnique({ where: { email: requestedEmail } });
    if (!user) {
      return res.status(404).json({ status: 'error', message: 'User not found.' });
    }

    if (!isAdmin && user.email.toLowerCase() !== requesterEmail) {
      return res.status(403).json({ status: 'error', message: 'You may only reactivate your own subscription.' });
    }

    const sub = await findLatestSubscription(user.user_id);
    if (!sub) {
      return res.status(404).json({ status: 'error', message: 'No subscription found. Start a new membership to continue.' });
    }

    const today = new Date();
    const todayKey = startOfDate(today);
    const periodEnd = sub.next_billing_date ? startOfDate(sub.next_billing_date) : null;
    const periodEnded = !periodEnd || periodEnd < todayKey;
    // Keeping the existing period end is what makes "cancel then reactivate"
    // free: the member already paid for the time remaining.
    const nextBillingDate = sub.next_billing_date || addMonthsClamped(today, 1);

    const { sendSubscriptionReactivatedEmail } = require('../services/mailer');

    // --- Admin override: activate immediately -------------------------------
    if (isAdmin) {
      const reactivated = await prisma.subscription.update({
        where: { subscription_id: sub.subscription_id },
        data: {
          plan_status: 'Active',
          auto_renew: true,
          canceled_at: null,
          last_billing_date: sub.last_billing_date || today,
          next_billing_date: nextBillingDate,
          retry_count: 0,
          grace_period_start: null
        }
      });

      if (requestedEmail.includes('@')) {
        sendSubscriptionReactivatedEmail({
          to: requestedEmail,
          clientName: user?.username || 'VIP Member',
          subscriptionId: reactivated.subscription_id,
          nextBillingDate: dateOnlyKey(reactivated.next_billing_date)
        }).catch(e => console.error('Subscription Reactivated Email Error:', e));
      }

      return res.status(200).json({
        status: 'success',
        message: 'Subscription plan reactivated successfully. VIP perks are now active.',
        data: reactivated
      });
    }

    // --- Member, still inside the paid period: free reversal ----------------
    if (
      (sub.plan_status === 'Active' || sub.plan_status === 'Cancellation_Pending') &&
      !periodEnded
    ) {
      const reactivated = await prisma.subscription.update({
        where: { subscription_id: sub.subscription_id },
        data: {
          plan_status: 'Active',
          auto_renew: true,
          canceled_at: null,
          grace_period_start: null,
          retry_count: 0,
          next_billing_date: nextBillingDate
        }
      });

      if (requestedEmail.includes('@')) {
        sendSubscriptionReactivatedEmail({
          to: requestedEmail,
          clientName: user?.username || 'VIP Member',
          subscriptionId: reactivated.subscription_id,
          nextBillingDate: dateOnlyKey(reactivated.next_billing_date)
        }).catch(e => console.error('Subscription Reactivated Email Error:', e));
      }

      return res.status(200).json({
        status: 'success',
        message: 'Welcome back! Auto-renew is on and your VIP perks remain active.',
        checkout_required: false,
        data: reactivated
      });
    }

    // --- Expired / payment pending: payment required ------------------------
    const { invoice, created } = await findOrCreateRenewalInvoice(sub.subscription_id);

    return res.status(200).json({
      status: 'success',
      message: 'Please settle the renewal invoice to reactivate your VIP membership.',
      checkout_required: true,
      data: { subscription: sub, invoice, invoice_created: created }
    });
  } catch (error) {
    console.error('Error reactivating subscription:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Failed to reactivate subscription.'
    });
  }
});

/**
 * PUT /api/v1/subscriptions/auto-renew
 * Toggle auto-renewal. Re-enabling it also reverses a pending cancellation.
 */
router.put('/auto-renew', requireAuth, async (req, res) => {
  try {
    const { auto_renew } = req.body || {};
    if (typeof auto_renew !== 'boolean') {
      return res.status(400).json({ status: 'error', message: 'auto_renew must be a boolean.' });
    }

    const user = await prisma.user.findUnique({ where: { email: req.user.email } });
    if (!user) {
      return res.status(404).json({ status: 'error', message: 'User not found.' });
    }

    const sub = await findLatestSubscription(user.user_id);
    if (!sub) {
      return res.status(404).json({ status: 'error', message: 'No subscription found.' });
    }

    const data = { auto_renew };

    // Turning autopay back on revives a plan that was set to cancel
    if (auto_renew && sub.plan_status === 'Cancellation_Pending') {
      data.plan_status = 'Active';
      data.canceled_at = null;
      // Preserve the paid period end; only invent one when the row has none.
      data.next_billing_date = sub.next_billing_date || addMonthsClamped(new Date(), 1);
    }

    const updated = await prisma.subscription.update({
      where: { subscription_id: sub.subscription_id },
      data
    });

    return res.status(200).json({
      status: 'success',
      message: auto_renew
        ? 'Auto-renew is on. We will bill your saved card or email an invoice each cycle.'
        : 'Auto-renew is off. Your plan will expire at the end of the current billing period.',
      data: updated
    });
  } catch (error) {
    console.error('Error updating auto-renew:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to update auto-renew.' });
  }
});

/**
 * PUT /api/v1/subscriptions/payment-method
 * Stores a PayMongo PaymentMethod id (`pm_...`) created client-side for card
 * autopay. GCash / Maya cannot be charged unattended and stay on auto-invoice.
 */
router.put('/payment-method', requireAuth, async (req, res) => {
  try {
    const { payment_method_id, brand, last4 } = req.body || {};

    if (!payment_method_id || !/^pm_[A-Za-z0-9]+$/.test(String(payment_method_id))) {
      return res.status(400).json({
        status: 'error',
        message: 'A valid PayMongo payment_method_id (pm_...) is required.'
      });
    }

    const user = await prisma.user.findUnique({ where: { email: req.user.email } });
    if (!user) {
      return res.status(404).json({ status: 'error', message: 'User not found.' });
    }

    const sub = await findLatestSubscription(user.user_id);
    if (!sub) {
      return res.status(404).json({ status: 'error', message: 'No subscription found.' });
    }

    const updated = await prisma.subscription.update({
      where: { subscription_id: sub.subscription_id },
      data: {
        payment_method_id: String(payment_method_id),
        payment_method_brand: brand ? String(brand).slice(0, 20) : null,
        payment_method_last4: last4 ? String(last4).slice(-4) : null
      }
    });

    return res.status(200).json({
      status: 'success',
      message: 'Card saved for automatic renewal.',
      data: {
        saved: true,
        brand: updated.payment_method_brand,
        last4: updated.payment_method_last4
      }
    });
  } catch (error) {
    console.error('Error saving payment method:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to save payment method.' });
  }
});

/**
 * DELETE /api/v1/subscriptions/payment-method
 * Removes the saved card. The member falls back to auto-invoicing.
 */
router.delete('/payment-method', requireAuth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { email: req.user.email } });
    if (!user) {
      return res.status(404).json({ status: 'error', message: 'User not found.' });
    }

    const sub = await findLatestSubscription(user.user_id);
    if (!sub) {
      return res.status(404).json({ status: 'error', message: 'No subscription found.' });
    }

    await prisma.subscription.update({
      where: { subscription_id: sub.subscription_id },
      data: { payment_method_id: null, payment_method_brand: null, payment_method_last4: null }
    });

    return res.status(200).json({
      status: 'success',
      message: 'Saved card removed. Renewals will be invoiced instead of auto-charged.',
      data: { saved: false }
    });
  } catch (error) {
    console.error('Error removing payment method:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to remove payment method.' });
  }
});

/**
 * GET /api/v1/subscriptions/billing-history
 * Recent recurring billing cycles for the authenticated member.
 */
router.get('/billing-history', requireAuth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { email: req.user.email } });
    if (!user) {
      return res.status(404).json({ status: 'error', message: 'User not found.' });
    }

    const sub = await findLatestSubscription(user.user_id);
    if (!sub) {
      return res.status(200).json({ status: 'success', data: [] });
    }

    const periods = await prisma.billingPeriod.findMany({
      where: { subscription_id: sub.subscription_id },
      include: { invoice: { include: { payments: true } } },
      orderBy: { period_start: 'desc' },
      take: 24
    });

    return res.status(200).json({ status: 'success', data: periods });
  } catch (error) {
    console.error('Error fetching billing history:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to retrieve billing history.' });
  }
});

/**
 * PUT /api/v1/subscriptions/:id/status
 * Admin update subscriber status (e.g. Active, Expired)
 */
router.put('/:id/status', requireAuth, requireAdmin, async (req, res) => {
  try {
    const subId = parseInt(req.params.id, 10);
    const { plan_status } = req.body;

    if (!plan_status) {
      return res.status(400).json({ status: 'error', message: 'plan_status is required.' });
    }

    const updated = await prisma.subscription.update({
      where: { subscription_id: subId },
      data: { plan_status }
    });

    return res.status(200).json({
      status: 'success',
      message: 'Subscription status updated successfully.',
      data: updated
    });
  } catch (error) {
    console.error('Error updating subscription status:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to update subscription status.' });
  }
});

module.exports = router;
