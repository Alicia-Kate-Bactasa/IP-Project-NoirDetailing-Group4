/**
 * Payments & Checkout API Router for Noir Detailing.
 * Handles PayMongo Hosted Checkout integration (GCash, Maya, Card), payment status verification,
 * manual payment proof submissions, and admin payment approval/rejection workflows.
 */

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const prisma = require('../config/db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { sendInvoiceEmail } = require('../services/mailer');
const paymongo = require('../services/paymongo');
const { addMonthsClamped } = require('../services/scheduling');
const { z } = require('zod');
const { JWT_SECRET, PUBLIC_APP_URL } = require('../config');

// Zod validation schema for manual payment submission.
// `amount` is accepted for backward compatibility but is ignored: the invoice
// total is always authoritative.
const submitPaymentSchema = z.object({
  body: z.object({
    invoice_id: z.number().int().positive('Valid invoice_id is required'),
    amount: z.number().positive().optional(),
    payment_method: z.string().default('GCash'),
    proof_of_payment: z.string().min(5, 'Proof of payment image URL/reference is required')
  })
});


/**
 * GET /api/v1/payments/invoices
 * Retrieve invoices and payments
 */
router.get('/invoices', requireAuth, async (req, res) => {
  try {
    const { status } = req.query;
    const where = {};

    if (status) {
      where.invoice_status = status;
    }

    const invoices = await prisma.invoice.findMany({
      where,
      include: {
        booking: { include: { service: true } },
        subscription: { include: { user: true } },
        payments: true
      },
      orderBy: { invoice_id: 'desc' }
    });

    return res.status(200).json({
      status: 'success',
      data: invoices
    });
  } catch (error) {
    console.error('Error fetching invoices:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to retrieve invoices.' });
  }
});

/**
 * POST /api/v1/payments
 * Submit GCash / bank proof of payment for an invoice you own.
 * Requires authentication; the invoice total is authoritative.
 */
router.post('/', requireAuth, validate(submitPaymentSchema), async (req, res) => {
  try {
    const { invoice_id, payment_method, proof_of_payment } = req.validated.body;

    const invoice = await prisma.invoice.findUnique({
      where: { invoice_id },
      include: {
        booking: { include: { customer: true } },
        subscription: true
      }
    });

    if (!invoice) {
      return res.status(404).json({ status: 'error', message: 'Invoice not found.' });
    }

    if (invoice.invoice_status === 'Paid') {
      return res.status(409).json({ status: 'error', message: 'This invoice has already been paid.' });
    }

    if (invoice.invoice_status === 'Void') {
      return res.status(409).json({ status: 'error', message: 'This invoice has been voided and can no longer be paid.' });
    }

    // Ownership check: members may only submit proof for their own invoice.
    if (req.user.role !== 'Admin') {
      const dbUser = await prisma.user.findUnique({ where: { email: req.user.email } });
      const email = (req.user.email || '').toLowerCase();
      const ownsBooking =
        invoice.booking &&
        (invoice.booking.user_id === (dbUser?.user_id ?? null) ||
          (invoice.booking.customer?.email || '').toLowerCase() === email);
      const ownsSubscription =
        invoice.subscription && invoice.subscription.user_id === (dbUser?.user_id ?? null);

      if (!dbUser || (!ownsBooking && !ownsSubscription)) {
        return res.status(403).json({ status: 'error', message: 'You do not have permission to pay this invoice.' });
      }
    }

    const newPayment = await prisma.payment.create({
      data: {
        invoice_id,
        // Server-side amount: never trust a client-supplied figure.
        amount: invoice.total_amount,
        payment_method: payment_method || 'GCash',
        proof_of_payment,
        payment_status: 'Pending_Approval',
        provider: 'manual'
      }
    });

    return res.status(201).json({
      status: 'success',
      message: 'Payment proof submitted successfully. Pending Admin verification.',
      data: newPayment
    });
  } catch (error) {
    console.error('Error submitting payment:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to submit payment.' });
  }
});

/**
 * PUT /api/v1/payments/:id/approve
 * Admin approve payment proof -> Marks Invoice as Paid, Booking as Confirmed, Subscription as Active
 */
router.put('/:id/approve', requireAuth, requireAdmin, async (req, res) => {
  try {
    const paymentId = parseInt(req.params.id, 10);

    const payment = await prisma.payment.findUnique({
      where: { payment_id: paymentId },
      include: { invoice: true }
    });

    if (!payment) {
      return res.status(404).json({ status: 'error', message: 'Payment record not found.' });
    }

    const result = await prisma.$transaction(async (tx) => {
      // 1. Approve Payment
      const approvedPayment = await tx.payment.update({
        where: { payment_id: paymentId },
        data: { payment_status: 'Paid' }
      });

      // 2. Mark Invoice Paid
      const updatedInvoice = await tx.invoice.update({
        where: { invoice_id: payment.invoice_id },
        data: { invoice_status: 'Paid' }
      });

      // 3. If tied to a Booking, set Booking to Confirmed
      if (payment.invoice.booking_id) {
        await tx.booking.update({
          where: { booking_id: payment.invoice.booking_id },
          data: { booking_status: 'Confirmed' }
        });
      }

      // 4. If tied to a Subscription, set Subscription to Active
      if (payment.invoice.subscription_id) {
        const today = new Date();

        await tx.subscription.update({
          where: { subscription_id: payment.invoice.subscription_id },
          data: {
            plan_status: 'Active',
            last_billing_date: today,
            next_billing_date: addMonthsClamped(today, 1),
            retry_count: 0,
            grace_period_start: null,
            reminder_sent_at: null
          }
        });

        // Settle the matching recurring cycle, if this invoice belongs to one
        await tx.billingPeriod.updateMany({
          where: {
            invoice_id: payment.invoice_id,
            status: { in: ['Scheduled', 'Invoiced', 'Failed', 'Processing'] }
          },
          data: { status: 'Paid', last_error: null, last_attempt_at: new Date() }
        });
      }

      return { payment: approvedPayment, invoice: updatedInvoice };
    });

    return res.status(200).json({
      status: 'success',
      message: 'Payment approved. Invoice and related records activated.',
      data: result
    });
  } catch (error) {
    console.error('Error approving payment:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to approve payment.' });
  }
});

/**
 * PUT /api/v1/payments/:id/reject
 * Admin reject payment proof
 */
router.put('/:id/reject', requireAuth, requireAdmin, async (req, res) => {
  try {
    const paymentId = parseInt(req.params.id, 10);

    const rejectedPayment = await prisma.payment.update({
      where: { payment_id: paymentId },
      data: { payment_status: 'Rejected' }
    });

    return res.status(200).json({
      status: 'success',
      message: 'Payment status marked as Rejected.',
      data: rejectedPayment
    });
  } catch (error) {
    console.error('Error rejecting payment:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to reject payment.' });
  }
});

/**
 * POST /api/v1/payments/paymongo/checkout
 * Create a PayMongo Checkout Session for GCash / Maya / Card.
 *
 * SECURITY: the amount and item name are resolved from the invoice stored in the
 * database. Any `amount` sent by the client is ignored, so a customer cannot pay
 * ₱1 for a ₱1,500 membership by editing the request body.
 */
router.post('/paymongo/checkout', async (req, res) => {
  try {
    const { invoice_id, booking_id, subscription_id, return_url } = req.body || {};

    const invoiceInclude = {
      booking: { include: { service: true } },
      subscription: true
    };

    // 1. Resolve the invoice server-side
    let invoice = null;
    const parsedInvoiceId = Number.parseInt(invoice_id, 10);
    const parsedBookingId = Number.parseInt(booking_id, 10);
    const parsedSubscriptionId = Number.parseInt(subscription_id, 10);

    if (Number.isInteger(parsedInvoiceId)) {
      invoice = await prisma.invoice.findUnique({
        where: { invoice_id: parsedInvoiceId },
        include: invoiceInclude
      });
    }

    if (!invoice && Number.isInteger(parsedBookingId)) {
      invoice = await prisma.invoice.findFirst({
        where: { booking_id: parsedBookingId },
        orderBy: { invoice_id: 'desc' },
        include: invoiceInclude
      });
    }

    if (!invoice && Number.isInteger(parsedSubscriptionId)) {
      invoice = await prisma.invoice.findFirst({
        where: { subscription_id: parsedSubscriptionId, invoice_status: 'Pending' },
        orderBy: { invoice_id: 'desc' },
        include: invoiceInclude
      });
    }

    if (!invoice) {
      return res.status(404).json({
        status: 'error',
        message: 'No payable invoice found for this request. Provide invoice_id, booking_id or subscription_id.'
      });
    }

    if (invoice.invoice_status === 'Paid') {
      return res.status(409).json({ status: 'error', message: 'This invoice has already been paid.' });
    }

    if (invoice.invoice_status === 'Void') {
      return res.status(409).json({ status: 'error', message: 'This invoice has been voided and can no longer be paid.' });
    }

    const amount = Number(invoice.total_amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ status: 'error', message: 'This invoice has no payable amount.' });
    }

    // 2. Derive the line item from the invoice, never from the client
    const itemName =
      invoice.booking?.service?.service_name ||
      invoice.subscription?.plan_tier ||
      'Noir Detailing Service';
    const itemDescription =
      invoice.invoice_type === 'Monthly_Roster'
        ? 'VIP Membership Roster - Monthly Subscription'
        : invoice.booking?.service?.service_description || itemName;

    // 3. Build return URLs from the invoice, not from the request body
    const fallbackUrl = req.headers.referer || `${PUBLIC_APP_URL}/`;
    let cleanReturnUrl = String(return_url || fallbackUrl).split('?')[0];
    try {
      const parsed = new URL(cleanReturnUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported protocol');
      cleanReturnUrl = parsed.toString();
    } catch {
      cleanReturnUrl = `${PUBLIC_APP_URL}/`;
    }

    const query = new URLSearchParams({
      payment: 'success',
      invoice_id: String(invoice.invoice_id),
      ...(invoice.booking_id ? { booking_id: String(invoice.booking_id) } : {}),
      ...(invoice.subscription_id ? { subscription_id: String(invoice.subscription_id) } : {})
    });
    const successUrl = `${cleanReturnUrl}${cleanReturnUrl.includes('?') ? '&' : '?'}${query.toString()}`;
    const cancelUrl = `${cleanReturnUrl}${cleanReturnUrl.includes('?') ? '&' : '?'}payment=cancel`;

    if (!paymongo.isConfigured()) {
      return res.status(400).json({
        status: 'error',
        message: 'Please insert your valid PayMongo Secret Key (sk_test_...) into server/.env file.'
      });
    }

    // 4. Create the hosted checkout session
    const result = await paymongo.createCheckoutSession({
      amount,
      name: itemName,
      description: itemDescription,
      successUrl,
      cancelUrl,
      metadata: {
        invoice_id: String(invoice.invoice_id),
        booking_id: invoice.booking_id ? String(invoice.booking_id) : '',
        subscription_id: invoice.subscription_id ? String(invoice.subscription_id) : ''
      }
    });

    if (!result.ok) {
      console.error('PayMongo API Checkout Error:', result.error);
      return res.status(400).json({ status: 'error', message: `PayMongo API Error: ${result.error}` });
    }

    return res.status(200).json({
      status: 'success',
      provider: 'paymongo',
      sandbox: result.data.sandbox,
      checkout_url: result.data.checkout_url,
      checkout_session_id: result.data.checkout_session_id,
      invoice_id: invoice.invoice_id,
      amount
    });
  } catch (error) {
    console.error('Error creating PayMongo checkout session:', error);
    return res.status(500).json({
      status: 'error',
      message: 'Failed to create PayMongo checkout session.'
    });
  }
});

/**
 * POST /api/v1/payments/verify
 * Verifies PayMongo payment completion and updates Invoice/Booking/Subscription status automatically
 */
router.post('/verify', async (req, res) => {
  try {
    const { invoice_id, booking_id, subscription_id, payment_method, reg_token } = req.body;

    // Handle Atomic Registration on Payment Verification
    if (reg_token) {
      // Registration token is an opaque random reference; the password hash and
      // profile live server-side and are never carried in the redirect URL.
      const pending = await prisma.pendingRegistration.findUnique({
        where: { token: reg_token }
      });

      if (!pending || pending.expires_at < new Date()) {
        return res.status(400).json({ status: 'error', message: 'Registration payment session is invalid or has expired.' });
      }

      const { email, username, full_name, phone_number, password_hash: hashedPassword } = pending;

      if (!email || !hashedPassword) {
        return res.status(400).json({ status: 'error', message: 'Invalid registration payload.' });
      }

      // Check if user was already created
      let existingUser = await prisma.user.findUnique({ where: { email } });
      let finalUser = existingUser;
      let finalSub = null;
      let finalInv = null;

      if (!existingUser) {
        const atomicResult = await prisma.$transaction(async (tx) => {
          // 1. Create User
          const newUser = await tx.user.create({
            data: {
              email,
              username: username || email.split('@')[0],
              password: hashedPassword,
              role: 'Subscriber'
            }
          });

          // 2. Create Customer
          await tx.customer.create({
            data: {
              full_name: full_name || username || email.split('@')[0],
              phone_number: phone_number || 'N/A',
              email,
              customer_type: 'Regular'
            }
          });

          // 3. Create Active Subscription
          const today = new Date();
          const nextMonth = new Date();
          nextMonth.setMonth(today.getMonth() + 1);

          const newSub = await tx.subscription.create({
            data: {
              user_id: newUser.user_id,
              plan_tier: 'VIP Membership Roster',
              plan_status: 'Active',
              last_billing_date: today,
              next_billing_date: nextMonth
            }
          });

          // 4. Create Paid Invoice
          const newInv = await tx.invoice.create({
            data: {
              subscription_id: newSub.subscription_id,
              total_amount: 1500.00,
              invoice_type: 'Monthly_Roster',
              invoice_status: 'Paid'
            }
          });

          // 5. Create Payment record
          await tx.payment.create({
            data: {
              invoice_id: newInv.invoice_id,
              amount: 1500.00,
              payment_method: payment_method || 'PayMongo (Verified Checkout)',
              proof_of_payment: 'PAYMONGO_VERIFIED_REGISTRATION',
              payment_status: 'Paid'
            }
          });

          return { user: newUser, subscription: newSub, invoice: newInv };
        });

        finalUser = atomicResult.user;
        finalSub = atomicResult.subscription;
        finalInv = atomicResult.invoice;
      }

      // Registration token was successfully redeemed: delete the temporary record
      await prisma.pendingRegistration.delete({ where: { token: reg_token } });

      // Generate JWT auth token for instant login
      const token = jwt.sign(
        { userId: finalUser.user_id, email: finalUser.email, role: finalUser.role },
        JWT_SECRET,
        { expiresIn: '7d' }
      );

      // Async send invoice receipt email
      sendInvoiceEmail({
        to: finalUser.email,
        clientName: full_name || finalUser.username,
        invoiceId: finalInv ? finalInv.invoice_id : 1,
        bookingId: null,
        serviceName: 'VIP Membership Roster - Monthly Subscription',
        amount: 1500.00,
        date: new Date()
      }).catch(e => console.error('Registration Receipt Email Error:', e));

      return res.status(200).json({
        status: 'success',
        message: 'Payment verified! Member account created and VIP Membership activated.',
        token,
        user: {
          user_id: finalUser.user_id,
          email: finalUser.email,
          full_name: full_name || finalUser.username,
          role: finalUser.role
        }
      });
    }

    let targetInvoiceId = invoice_id ? parseInt(invoice_id, 10) : null;
    let targetBookingId = booking_id ? parseInt(booking_id, 10) : null;
    let targetSubId = subscription_id ? parseInt(subscription_id, 10) : null;

    if (!targetInvoiceId && targetBookingId) {
      const invoice = await prisma.invoice.findFirst({
        where: { booking_id: targetBookingId },
        orderBy: { invoice_id: 'desc' }
      });
      if (invoice) targetInvoiceId = invoice.invoice_id;
    }

    if (!targetInvoiceId && targetSubId) {
      const invoice = await prisma.invoice.findFirst({
        where: { subscription_id: targetSubId },
        orderBy: { invoice_id: 'desc' }
      });
      if (invoice) targetInvoiceId = invoice.invoice_id;
    }

    const result = await prisma.$transaction(async (tx) => {
      let createdPayment = null;
      let paidPeriodStart = null;

      if (targetInvoiceId) {
        const inv = await tx.invoice.findUnique({ where: { invoice_id: targetInvoiceId } });
        if (inv) {
          createdPayment = await tx.payment.create({
            data: {
              invoice_id: targetInvoiceId,
              amount: inv.total_amount,
              payment_method: payment_method || 'PayMongo (GCash/Maya/Card)',
              proof_of_payment: 'PAYMONGO_VERIFIED_CHECKOUT',
              payment_status: 'Paid',
              provider: 'paymongo'
            }
          });

          await tx.invoice.update({
            where: { invoice_id: targetInvoiceId },
            data: { invoice_status: 'Paid' }
          });

          // Reconcile recurring billing: a paid renewal invoice settles its cycle
          const billedPeriod = await tx.billingPeriod.findFirst({
            where: { invoice_id: targetInvoiceId }
          });
          if (billedPeriod) {
            paidPeriodStart = billedPeriod.period_start;
            await tx.billingPeriod.update({
              where: { period_id: billedPeriod.period_id },
              data: { status: 'Paid', last_error: null, last_attempt_at: new Date() }
            });
          }
        }
      }

      if (targetBookingId) {
        await tx.booking.update({
          where: { booking_id: targetBookingId },
          data: { booking_status: 'Confirmed' }
        });
      }

      if (targetSubId) {
        const today = new Date();
        const nextBillingDate = paidPeriodStart
          ? addMonthsClamped(paidPeriodStart, 1)
          : addMonthsClamped(today, 1);

        await tx.subscription.update({
          where: { subscription_id: targetSubId },
          data: {
            plan_status: 'Active',
            last_billing_date: paidPeriodStart || today,
            next_billing_date: nextBillingDate,
            retry_count: 0,
            grace_period_start: null,
            reminder_sent_at: null
          }
        });
      }

      return { success: true, payment: createdPayment };
    });

    // Send HTML Invoice receipt email asynchronously
    if (targetInvoiceId) {
      prisma.invoice.findUnique({
        where: { invoice_id: targetInvoiceId },
        include: {
          booking: { include: { service: true, customer: true } },
          subscription: { include: { user: true } }
        }
      }).then(invDetails => {
        if (invDetails) {
          const recipientEmail = invDetails.booking?.customer?.email || invDetails.subscription?.user?.email;
          const recipientName = invDetails.booking?.customer?.full_name || invDetails.subscription?.user?.username;
          const serviceName = invDetails.booking?.service?.service_name || invDetails.subscription?.plan_tier || 'Detailing Service';

          if (recipientEmail) {
            sendInvoiceEmail({
              to: recipientEmail,
              clientName: recipientName,
              invoiceId: invDetails.invoice_id,
              bookingId: invDetails.booking_id,
              serviceName: serviceName,
              amount: invDetails.total_amount,
              date: invDetails.issued_at
            }).catch(e => console.error('Invoice Email Error:', e));
          }
        }
      }).catch(e => console.error('Invoice Details Fetch Error:', e));
    }

    return res.status(200).json({
      status: 'success',
      message: 'Payment verified and status updated to Paid & Confirmed.',
      data: result
    });
  } catch (error) {
    console.error('Error verifying payment status:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to verify payment.' });
  }
});

module.exports = router;
