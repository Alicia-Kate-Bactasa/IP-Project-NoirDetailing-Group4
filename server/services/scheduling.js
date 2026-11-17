/**
 * Scheduling helpers for Noir Detailing.
 *
 * Centralises the two things that are easy to get wrong in this domain:
 *  - slot reservation keys (so the database can enforce "one booking per bay/slot"),
 *  - calendar math in the studio's timezone (Asia/Manila) instead of UTC.
 */

const TIMEZONE = process.env.BUSINESS_TIMEZONE || 'Asia/Manila';

/** Booking states that do NOT occupy a bay any more. */
const RELEASED_STATUSES = ['Cancelled', 'No_Show'];

/** Every status the API accepts for a booking. */
const BOOKING_STATUSES = [
  'Pending',
  'Pending_Verification',
  'Confirmed',
  'Completed',
  'Cancelled',
  'No_Show',
  'Paid',
  'Scheduled'
];

/** True when a booking with this status still holds its bay/slot. */
const isBlockingStatus = (status) => !RELEASED_STATUSES.includes(status);

/** Trimmed, upper-cased, single-spaced time slot ("10:00 am" -> "10:00 AM"). */
const normalizeTimeSlot = (slot) => String(slot ?? '').trim().replace(/\s+/g, ' ').toUpperCase();

/** "YYYY-MM-DD" for the calendar date a stored @db.Date value represents. */
const dateOnlyKey = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
};

/** Midnight (UTC) of the given date, used for @db.Date comparisons. */
const startOfDate = (value) => {
  const key = dateOnlyKey(value);
  return key ? new Date(`${key}T00:00:00.000Z`) : null;
};

/**
 * Reservation key stored in bookings.slot_lock.
 * Unique index on the column is what actually prevents double-booking under
 * concurrency; the app-level checks only provide nicer error messages.
 */
const buildSlotLock = ({ scheduled_date, time_slot, bay_number }) => {
  const day = dateOnlyKey(scheduled_date);
  const slot = normalizeTimeSlot(time_slot);
  const bay = Number.parseInt(bay_number, 10) || 1;
  if (!day || !slot) return null;
  return `${day}|${slot}|${bay}`;
};

/** Current calendar date in the studio timezone, as a UTC-midnight Date. */
const todayInTimezone = (timeZone = TIMEZONE, now = new Date()) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now);
  return new Date(`${parts}T00:00:00.000Z`);
};

/**
 * Adds whole months without the JS Date overflow bug (Jan 31 + 1 month must be
 * Feb 28/29, not Mar 3), clamping to the last day of the target month.
 */
const addMonthsClamped = (value, months) => {
  const date = startOfDate(value);
  if (!date) return null;

  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();

  const target = new Date(Date.UTC(year, month + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();

  return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(day, lastDay)));
};

/** Adds days to a date-only value. */
const addDaysClamped = (value, days) => {
  const date = startOfDate(value);
  if (!date) return null;
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
};

/** Whole days between two date-only values (b - a). */
const daysBetween = (a, b) => {
  const from = startOfDate(a);
  const to = startOfDate(b);
  if (!from || !to) return 0;
  return Math.round((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
};

module.exports = {
  TIMEZONE,
  BOOKING_STATUSES,
  RELEASED_STATUSES,
  isBlockingStatus,
  normalizeTimeSlot,
  dateOnlyKey,
  startOfDate,
  buildSlotLock,
  todayInTimezone,
  addMonthsClamped,
  addDaysClamped,
  daysBetween
};
