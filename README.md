# Noir Detailing

Noir Detailing is a full-stack auto detailing reservation and VIP membership subscription web application built with Express.js backend and Vue.js 3 frontend, powered by Prisma ORM and Neon PostgreSQL database integration.

---
> Live Website: https://noir-detailing.dcism.org 
## Tech Stack

### Frontend
![Vue.js 3](https://img.shields.io/badge/Vue.js_3-35495E?style=for-the-badge&logo=vuedotjs&logoColor=4FC08D)
![Vite](https://img.shields.io/badge/Vite-646CFF?style=for-the-badge&logo=vite&logoColor=white)
![Vue Router](https://img.shields.io/badge/Vue_Router-4FC08D?style=for-the-badge&logo=vuedotjs&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-38B2AC?style=for-the-badge&logo=tailwind-css&logoColor=white)
![PostCSS](https://img.shields.io/badge/PostCSS-DD3A0A?style=for-the-badge&logo=postcss&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)
![HTML5](https://img.shields.io/badge/HTML5-E34F26?style=for-the-badge&logo=html5&logoColor=white)
![CSS3](https://img.shields.io/badge/CSS3-1572B6?style=for-the-badge&logo=css3&logoColor=white)

### Backend & Database
![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![Express.js](https://img.shields.io/badge/Express.js-000000?style=for-the-badge&logo=express&logoColor=white)
![MySQL](https://img.shields.io/badge/MySQL-4479A1?style=for-the-badge&logo=mysql&logoColor=white)
![Prisma ORM](https://img.shields.io/badge/Prisma_ORM-2D3748?style=for-the-badge&logo=prisma&logoColor=white)
![Nodemailer](https://img.shields.io/badge/Nodemailer-0298C3?style=for-the-badge&logo=gmail&logoColor=white)
![PayMongo API](https://img.shields.io/badge/PayMongo_API-0052FF?style=for-the-badge&logo=contactlesspayment&logoColor=white)

---

## System Overview

Noir Detailing offers structured auto detailing scheduling and membership management with distinct workflows:

- **Guest Booking Wizard**: Allows walk-in and guest customers to browse active detailing packages, select service durations, check studio bay availability in real time, and proceed through online checkout.
- **VIP Subscriber Hub**: Enables active subscribers to book complimentary detailing sessions with 0 PHP per-session transaction invoices, manage billing cycles, reschedule, or cancel appointments.
- **Admin Management Control**: Provides studio administrators with live service package CRUD (activation/deactivation, duration setting, pricing updates), walk-in booking management, payment tracking with linked booking IDs, and recharts analytics for customer feedback.
- **Transaction Invoicing & HTML Email Service**: Sends structured HTML email confirmations for bookings, payments, cancellations, reschedules, and password resets with exact booking ID and invoice reference cards.

---

## Repository Structure

```text
noirDetailing/
├── client/                      # Frontend Web Application (Vue.js 3, Vite, Tailwind CSS)
│   ├── src/
│   │   ├── components/          # Reusable UI components (ServiceSelector, Modals)
│   │   ├── views/               # Page views (HomeView, DashboardView, AdminView, etc.)
│   │   ├── router/              # Vue Router navigation mapping
│   │   └── style.css            # Custom CSS styling and animations
│   ├── package.json
│   └── vite.config.js
│
├── server/                      # Express.js REST API Backend
│   ├── server.js                # Server entry point
│   ├── middleware/              # Auth verification and input validation
│   ├── routes/                  # API routes (/auth, /services, /bookings, /subscriptions, /payments, /feedback)
│   ├── services/                # Mailer service and external integrations
│   ├── prisma/                  # Prisma ORM schema definition
│   ├── package.json
│   └── .env.example             # Environment variable configuration template
│
└── README.md
```

---

## API Documentation

The REST API is described by an OpenAPI 3.0 contract at [`server/openapi.yaml`](server/openapi.yaml) — 49 operations across the Auth, Services, Bookings, Payments, Subscriptions, Admin (incl. billing), Feedback and Health groups.

Once the backend is running:

| Resource | URL |
|---|---|
| Interactive Swagger UI | http://localhost:5001/api-docs |
| Raw OpenAPI JSON (codegen / Postman) | http://localhost:5001/api-docs/openapi.json |

To call protected endpoints from Swagger UI, log in via `POST /auth/login`, copy the returned `token`, click **Authorize**, and paste it as the Bearer value. Documentation can be disabled with `ENABLE_API_DOCS=false` in `server/.env`.

---

## Recurring VIP Billing (Option C)

VIP memberships renew automatically through a daily **node-cron** job (default
`0 8 * * *`, `Asia/Manila`). Two paths are supported:

| Member has… | What happens on the renewal date |
|---|---|
| A saved card (`pm_...` from PayMongo.js) | The card is charged silently. If it fails or needs 3-D Secure, the member is emailed and falls back to invoicing. |
| GCash / Maya / no saved card | An invoice is created (or reused) and emailed. GCash and Maya **cannot be charged unattended**, so these members must pay the invoice themselves. |

### Safety model

- **`AUTO_BILLING_DRY_RUN=true` by default.** The job logs what it *would* do and
  writes/charges nothing. Set it to `false` only after reviewing a dry run.
- **Idempotent by design.** Each cycle has one `BillingPeriod` row, enforced by a
  unique `(subscription_id, period_start)` constraint plus an optimistic claim on
  `last_attempt_at`; card charges also send a stable PayMongo `Idempotency-Key`.
  Running the job twice cannot double-charge a member.
- **Server-side pricing.** The amount comes from `SUBSCRIPTION_MONTHLY_FEE`
  (default ₱1,500), never from the client.

### Status / dunning flow

```
Active ──payment ok──────────────► Active (next_billing_date +1 month)
   │
   ├──charge/invoice fails──► Payment_Pending (grace_period_start set)
   │                              │ payment ok ─► Active
   │                              └ grace + retries exhausted ─► Expired
   │
   ├──cancel requested──────► Cancellation_Pending
   │                              └ period ends ─► Expired (no charge)
   │
   └──auto-renew off────────► Expired at next_billing_date
```

- Grace window: `AUTO_BILLING_GRACE_DAYS` (default 5). Card retries follow
  `AUTO_BILLING_RETRY_DAYS` (default `0,3,7`) but stop at the grace boundary; the
  last offset also bounds the auto-invoice dunning window.
- A renewal reminder email goes out `AUTO_BILLING_REMINDER_DAYS` (default 3) before
  the renewal date.
- Cancelling keeps every VIP perk until `next_billing_date`; members can reactivate
  for free while the paid period is still running.

### Configuration (`server/.env`)

| Variable | Default | Purpose |
|---|---|---|
| `AUTO_BILLING_ENABLED` | `true` | Start the cron scheduler with the server. |
| `AUTO_BILLING_DRY_RUN` | `true` | Log-only mode — no charges or writes. |
| `AUTO_BILLING_CRON` | `0 8 * * *` | Sweep schedule (studio timezone). |
| `BUSINESS_TIMEZONE` | `Asia/Manila` | Timezone for billing dates and cron. |
| `SUBSCRIPTION_MONTHLY_FEE` | `1500` | Monthly fee in PHP. |
| `AUTO_BILLING_GRACE_DAYS` | `5` | Access kept after a failed renewal. |
| `AUTO_BILLING_RETRY_DAYS` | `0,3,7` | Retry offsets for failed charges / dunning window. |
| `AUTO_BILLING_REMINDER_DAYS` | `3` | Days before renewal to email a reminder (`0` = off). |
| `PUBLIC_APP_URL` | `http://localhost:5173` | Base for billing email links. |

### Manual control

- `POST /api/v1/admin/billing/run` — run the sweep on demand. Accepts
  `{ "dry_run": true, "subscription_id": 12 }`.
- `GET /api/v1/admin/billing/periods?status=Failed&take=50` — inspect the ledger.
- Member endpoints: `PUT /subscriptions/auto-renew`,
  `PUT|DELETE /subscriptions/payment-method`, `GET /subscriptions/billing-history`.

> **Not implemented:** the PayMongo webhook receiver + signature verification.
> Payment confirmation currently relies on the checkout redirect
> (`POST /payments/verify`), which should be hardened before going live.

---

## Getting Started

### 1. Backend Setup

```bash
cd server

# Install backend dependencies
npm install

# Copy environment variable template
cp .env.example .env

# Generate Prisma Client
npx prisma generate

# Create / update the PostgreSQL schema (project has no migration history)
npx prisma db push

# Start Express REST API server
npm run dev
```

The REST API server will run on http://localhost:5001/api/v1.

### 2. Frontend Setup

```bash
cd client

# Install frontend dependencies
npm install

# Start Vite development server
npm run dev
```

The frontend application will run on http://localhost:5173.

### 3. Production Build

To build the production frontend bundle:

```bash
cd client
npm run build
```
