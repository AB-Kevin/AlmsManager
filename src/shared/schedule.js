// Loaded by the main process with require(), and by the window as a plain
// script, where it's window.Schedule.
(function (root) {
'use strict';

// The tasks an approved case makes, and the reminders file Power Automate
// reads. Dates are 'YYYY-MM-DD' strings throughout, compared as text.
//
// An approved case runs from `approvedFrom` through `approvedThrough`
// (December 31 by default, so each year's approval is "for the year"):
//
// - one payment for each calendar quarter the approval touches, due on the
//   quarter's first day (or on `approvedFrom`, for the quarter it starts in):
//   a check to send, or an invoice to write off, as the case's `method` says;
// - one review, due REVIEW_LEAD_DAYS before `approvedThrough` (December 1 for
//   a December 31 end), to renew the case for another year or let it end.
//
// A task is done once the case's `done` has an entry for its id. Renewing
// moves `approvedThrough` a year on, which adds the next year's payments and
// review.

const REVIEW_LEAD_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const pad = (n) => String(n).padStart(2, '0');

/** Whether `s` is a real date as 'YYYY-MM-DD'. */
function isDate(s) {
  if (typeof s !== 'string' || !DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const toUtc = (s) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
const fromUtc = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (s, n) => fromUtc(toUtc(s) + n * DAY_MS);

/** The same day `n` years on; February 29 becomes February 28. */
function addYears(s, n) {
  const year = Number(s.slice(0, 4)) + n;
  const month = Number(s.slice(5, 7));
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${pad(month)}-${pad(Math.min(Number(s.slice(8, 10)), last))}`;
}

/** Today on this computer's calendar. */
const localToday = (now = new Date()) => `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

const quarterOf = (s) => ({ year: Number(s.slice(0, 4)), q: Math.floor((Number(s.slice(5, 7)) - 1) / 3) + 1 });
const quarterStart = ({ year, q }) => `${year}-${pad((q - 1) * 3 + 1)}-01`;
const nextQuarter = ({ year, q }) => (q === 4 ? { year: year + 1, q: 1 } : { year, q: q + 1 });

/**
 * Where an approval starting on `from` runs to unless someone says otherwise:
 * the end of that year, or, from October on, the end of the next one, so a
 * late approval isn't up for review within weeks.
 */
function defaultThrough(from) {
  const end = `${from.slice(0, 4)}-12-31`;
  return Number(from.slice(5, 7)) >= 10 ? addYears(end, 1) : end;
}

/** Shows a date as people write it here: 1/5/2027. */
function formatDate(s) {
  return isDate(s) ? `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}/${s.slice(0, 4)}` : '';
}

function formatMoney(amount) {
  return typeof amount === 'number' ? amount.toLocaleString('en-US', { style: 'currency', currency: 'USD' }) : '';
}

const reviewId = (through) => `review:${through}`;

function paymentLabel(method, period) {
  return method === 'writeoff' ? `Write off the ${period} invoice` : `Send the ${period} check`;
}

const reviewLabel = (through) => `Review for ${addDays(through, 1).slice(0, 4)}`;

/**
 * Every task of a case, earliest first: { id, kind ('payment' or 'review'),
 * due, label, period, done }, where `done` is the case's record of it or null.
 * A case that was never approved has none. A closed case keeps only the
 * tasks that were done; the rest were dropped when it closed. Tasks done
 * under earlier approval dates (last year's review, say) are kept as done.
 */
function caseTasks(c) {
  const done = c.done || {};
  const tasks = [];
  const approved = ['approved', 'closed'].includes(c.status)
    && isDate(c.approvedFrom) && isDate(c.approvedThrough) && c.approvedThrough >= c.approvedFrom;
  if (approved) {
    for (let q = quarterOf(c.approvedFrom); quarterStart(q) <= c.approvedThrough; q = nextQuarter(q)) {
      const start = quarterStart(q);
      const period = `Q${q.q} ${q.year}`;
      tasks.push({ id: `pay:${q.year}-Q${q.q}`, kind: 'payment', due: start < c.approvedFrom ? c.approvedFrom : start, period, label: paymentLabel(c.method, period) });
    }
    const reviewDue = addDays(c.approvedThrough, -REVIEW_LEAD_DAYS);
    tasks.push({
      id: reviewId(c.approvedThrough),
      kind: 'review',
      due: reviewDue < c.approvedFrom ? c.approvedFrom : reviewDue,
      period: c.approvedThrough.slice(0, 4),
      label: reviewLabel(c.approvedThrough),
    });
  }
  const ids = new Set(tasks.map((t) => t.id));
  for (const [id, record] of Object.entries(done)) {
    if (ids.has(id)) continue;
    tasks.push({ id, kind: id.startsWith('review:') ? 'review' : 'payment', due: record.due || record.on, period: record.period || '', label: record.label || id });
  }
  return tasks
    .map((t) => ({ ...t, done: done[t.id] || null }))
    .filter((t) => c.status !== 'closed' || t.done)
    .sort((a, b) => a.due.localeCompare(b.due) || a.id.localeCompare(b.id));
}

/**
 * Where a case stands, for showing it: 'requested', 'declined', 'active',
 * 'ended' (its last review let it end and the approval has run out) or
 * 'closed' (closed early).
 */
function caseState(c, today) {
  if (c.status !== 'approved') return c.status;
  if (today > c.approvedThrough && c.done?.[reviewId(c.approvedThrough)]?.outcome === 'end') return 'ended';
  return 'active';
}

/** Tasks still to do, across all cases, earliest first, each with its `case`. */
function openTasks(cases) {
  return cases
    .filter((c) => c.status === 'approved')
    .flatMap((c) => caseTasks(c).filter((t) => !t.done).map((t) => ({ ...t, case: c })))
    .sort((a, b) => a.due.localeCompare(b.due) || a.label.localeCompare(b.label));
}

/**
 * The newest change the reminders are built from: the latest `updatedAt` of
 * any case or the settings. A computer whose copy is older than the file's
 * (OneDrive hasn't brought it everything yet) leaves the file alone.
 */
function remindersBasis(cases, settings) {
  return [settings?.updatedAt, ...cases.map((c) => c.updatedAt)].filter(Boolean).sort().pop() || null;
}

/**
 * The file Power Automate reads (see docs/power-automate.md): who to email,
 * and every task still to do, with its due date, including those not due
 * yet, so the flow knows when each comes due without anyone opening the app.
 * The flow emails the tasks whose `due` is today or earlier. `nameOf(c)` is
 * the case's recipient as shown. Done tasks aren't listed: marking one done
 * takes it off the next day's email.
 */
function buildReminders(cases, { sendTo, nameOf, basis, now = new Date() }) {
  return {
    version: 1,
    app: 'AlmsManager',
    generatedAt: now.toISOString(),
    basis,
    sendTo: sendTo || '',
    tasks: openTasks(cases).map((t) => {
      const amount = t.kind === 'payment' ? formatMoney(t.case.amount) : '';
      const who = nameOf(t.case);
      return {
        due: t.due,
        dueText: formatDate(t.due),
        task: t.label,
        for: who,
        amount,
        line: [formatDate(t.due), t.label, who, amount].filter(Boolean).join(' · '),
      };
    }),
  };
}

/** Whether two reminder files say the same thing, apart from when they were written. */
function sameReminders(a, b) {
  const strip = (r) => JSON.stringify({ ...r, generatedAt: null, basis: null });
  return Boolean(a && b) && strip(a) === strip(b);
}

const api = {
  REVIEW_LEAD_DAYS,
  isDate,
  addDays,
  addYears,
  localToday,
  defaultThrough,
  formatDate,
  formatMoney,
  reviewId,
  caseTasks,
  caseState,
  openTasks,
  remindersBasis,
  buildReminders,
  sameReminders,
};

if (typeof module === 'object' && module.exports) module.exports = api;
else root.Schedule = api;
})(typeof self !== 'undefined' ? self : globalThis);
