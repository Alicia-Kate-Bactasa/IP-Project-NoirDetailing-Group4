/**
 * Minimal PayMongo REST client used by the backend only.
 *
 * Wraps the three calls this app needs:
 *  - hosted checkout sessions (GCash / Maya / card / QR),
 *  - Payment Intents + saved-card attach for recurring autopay,
 *  - a health check so the billing job can degrade gracefully when no key is set.
 */

const { PAYMONGO_SECRET_KEY } = require('../config');

const API_BASE = 'https://api.paymongo.com/v1';

/** True when a usable (non-placeholder) secret key is configured. */
const isConfigured = () =>
  Boolean(PAYMONGO_SECRET_KEY) &&
  /^sk_(test|live)_/.test(PAYMONGO_SECRET_KEY) &&
  !PAYMONGO_SECRET_KEY.includes('your_paymongo_secret_key');

const authHeader = () => `Basic ${Buffer.from(`${PAYMONGO_SECRET_KEY}:`).toString('base64')}`;

/**
 * Calls the PayMongo API and normalises errors into a predictable shape.
 * @returns {Promise<{ok: boolean, status: number, data: any, error?: string}>}
 */
const request = async (path, { method = 'GET', body, idempotencyKey } = {}) => {
  if (!isConfigured()) {
    return { ok: false, status: 0, data: null, error: 'PayMongo secret key is not configured.' };
  }

  const headers = {
    'Content-Type': 'application/json',
    Authorization: authHeader()
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  try {
    const response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await response.json().catch(() => null);

    if (!response.ok) {
      const detail =
        data?.errors?.[0]?.detail ||
        data?.errors?.[0]?.code ||
        `PayMongo request failed with status ${response.status}.`;
      return { ok: false, status: response.status, data, error: detail };
    }

    return { ok: true, status: response.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: null, error: err.message || 'PayMongo network error.' };
  }
};

/**
 * Creates a hosted checkout session.
 * @param {object} params
 * @param {number} params.amount       Amount in PHP (converted to centavos here).
 * @param {string} params.name         Line-item name.
 * @param {string} params.description  Line-item description.
 * @param {string} params.successUrl
 * @param {string} params.cancelUrl
 * @param {object} [params.metadata]   Echoed back on the payment intent.
 */
const createCheckoutSession = async ({ amount, name, description, successUrl, cancelUrl, metadata }) => {
  const attributes = {
    send_email_receipt: true,
    show_description: true,
    show_line_items: true,
    payment_method_types: ['gcash', 'paymaya', 'card', 'dob', 'grab_pay'],
    line_items: [
      {
        currency: 'PHP',
        amount: Math.round(Number(amount) * 100),
        description,
        name,
        quantity: 1
      }
    ],
    success_url: successUrl,
    cancel_url: cancelUrl
  };
  if (metadata) attributes.metadata = metadata;

  const result = await request('/checkout_sessions', {
    method: 'POST',
    body: { data: { attributes } }
  });

  if (!result.ok) return result;

  const attributes2 = result.data?.data?.attributes;
  if (!attributes2?.checkout_url) {
    return { ok: false, status: 0, data: result.data, error: 'PayMongo did not return a checkout URL.' };
  }

  return {
    ok: true,
    status: 200,
    data: {
      checkout_url: attributes2.checkout_url,
      checkout_session_id: result.data.data.id,
      sandbox: PAYMONGO_SECRET_KEY.startsWith('sk_test_')
    }
  };
};

/**
 * Charges a saved card (PaymentMethod `pm_...`) without customer interaction.
 *
 * Returns `status: 'succeeded' | 'awaiting_next_action' | 'processing'`.
 * `awaiting_next_action` means 3-D Secure is required, so the caller must fall
 * back to sending the member a hosted-checkout link instead of retrying blindly.
 */
const chargeSavedCard = async ({
  amount,
  paymentMethodId,
  description,
  statementDescriptor = 'NOIR DETAILING',
  metadata,
  returnUrl,
  idempotencyKey
}) => {
  const intent = await request('/payment_intents', {
    method: 'POST',
    idempotencyKey,
    body: {
      data: {
        attributes: {
          amount: Math.round(Number(amount) * 100),
          currency: 'PHP',
          payment_method_allowed: ['card'],
          capture_type: 'automatic',
          description,
          statement_descriptor: statementDescriptor,
          ...(metadata ? { metadata } : {})
        }
      }
    }
  });

  if (!intent.ok) return { ok: false, error: intent.error, status: 0 };

  const intentId = intent.data?.data?.id;
  const clientKey = intent.data?.data?.attributes?.client_key;

  const attached = await request(`/payment_intents/${intentId}/attach`, {
    method: 'POST',
    body: {
      data: {
        attributes: {
          payment_method: paymentMethodId,
          client_key: clientKey,
          ...(returnUrl ? { return_url: returnUrl } : {})
        }
      }
    }
  });

  if (!attached.ok) {
    return { ok: false, error: attached.error, status: 0, paymentIntentId: intentId };
  }

  const attributes = attached.data?.data?.attributes || {};
  return {
    ok: true,
    status: attributes.status,
    paymentIntentId: attached.data?.data?.id || intentId,
    nextActionUrl: attributes.next_action?.redirect?.url || null,
    raw: attached.data?.data
  };
};

module.exports = {
  API_BASE,
  isConfigured,
  request,
  createCheckoutSession,
  chargeSavedCard
};
