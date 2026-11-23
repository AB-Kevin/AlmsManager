'use strict';

// What can happen to a case. A case is one alms request, from when it comes
// in, through its approval and the quarterly payments and yearly reviews that
// follow, to when it ends:
//
//   requested --approve--> approved --close--> closed
//             \-decline--> declined
//
// Each action takes the case as just read from its file, checks the input,
// changes the case, and adds a line to its history; the caller saves it.
// `ctx` is { by: who is acting (their AB Apps name), now: a Date }.

const { isDate, addDays, formatDate, formatMoney, reviewId, caseTasks } = require('./schedule');

const METHODS = ['check', 'writeoff'];
const KINDS = ['contact', 'org', 'none'];
const METHOD_NAMES = { check: 'by check', writeoff: 'by writing off the invoice' };

const text = (value, max = 2000) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

function amountOf(value, { required = false } = {}) {
  if (value === '' || value === null || value === undefined) {
    if (required) throw new Error('Enter the amount for each quarter.');
    return null;
  }
  const n = Number(String(value).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0) throw new Error('The amount has to be a number, such as 250 or 250.00.');
  return Math.round(n * 100) / 100;
}

function dateOf(value, label) {
  if (!isDate(value)) throw new Error(`${label} has to be a date.`);
  return value;
}

function methodOf(value) {
  if (!METHODS.includes(value)) throw new Error('Choose whether it is paid by check or by writing off an invoice.');
  return value;
}

/**
 * Who a case is for: a member (`contact`) or church (`org`) on MemberManager's
 * list, kept by id with their name as it was, or `none`, a name typed in when
 * MemberManager's list can't be reached.
 */
function recipientOf(r) {
  const name = text(r?.name, 200);
  if (!r || !KINDS.includes(r.kind) || !name || (r.kind !== 'none' && !text(r.id))) {
    throw new Error('Choose the member or church this case is for.');
  }
  return { kind: r.kind, id: r.kind === 'none' ? null : text(r.id, 100), memberId: text(r.memberId, 50), name };
}

function note(c, ctx, line) {
  c.history.push({ at: ctx.now.toISOString(), by: ctx.by, text: line });
  c.updatedAt = ctx.now.toISOString();
}

const describeTerms = (c) => `${formatMoney(c.amount)} a quarter ${METHOD_NAMES[c.method]}`;

/** A new case for a request that has just come in. */
function newCase(input, ctx, id) {
  const at = ctx.now.toISOString();
  const c = {
    version: 1,
    id,
    recipient: recipientOf(input.recipient),
    summary: text(input.summary, 500),
    method: methodOf(input.method || 'check'),
    amount: amountOf(input.amount),
    notes: text(input.notes),
    requestedOn: dateOf(input.requestedOn, 'Received on'),
    requestedBy: text(input.requestedBy, 200),
    status: 'requested',
    decidedOn: null,
    decidedBy: null,
    approvedFrom: null,
    approvedThrough: null,
    closedOn: null,
    done: {},
    documents: [],
    history: [],
    createdAt: at,
    updatedAt: at,
  };
  if (!c.summary) throw new Error('Say what the request is for.');
  note(c, ctx, `Request received${c.requestedBy ? ` from ${c.requestedBy}` : ''}.`);
  return c;
}

function requireStatus(c, status, action) {
  if (c.status !== status) throw new Error(`This case is ${c.status}, so it can't be ${action}.`);
}

/** Approves a request: the amount, how it's paid, and the dates it runs. */
function approve(c, input, ctx) {
  requireStatus(c, 'requested', 'approved');
  const from = dateOf(input.approvedFrom, 'Starts on');
  const through = dateOf(input.approvedThrough, 'Runs through');
  if (through < from) throw new Error('The approval has to end after it starts.');
  c.method = methodOf(input.method);
  c.amount = amountOf(input.amount, { required: true });
  c.approvedFrom = from;
  c.approvedThrough = through;
  c.decidedOn = dateOf(input.decidedOn, 'Approved on');
  c.decidedBy = ctx.by;
  c.status = 'approved';
  note(c, ctx, `Approved: ${describeTerms(c)}, ${formatDate(from)} through ${formatDate(through)}.${text(input.note) ? ` ${text(input.note)}` : ''}`);
  return c;
}

function decline(c, input, ctx) {
  requireStatus(c, 'requested', 'declined');
  c.decidedOn = dateOf(input.decidedOn, 'Declined on');
  c.decidedBy = ctx.by;
  c.status = 'declined';
  note(c, ctx, `Declined.${text(input.note) ? ` ${text(input.note)}` : ''}`);
  return c;
}

/** Closes an approved case early. Tasks not yet done are dropped. */
function close(c, input, ctx) {
  requireStatus(c, 'approved', 'closed');
  c.closedOn = dateOf(input.closedOn, 'Closed on');
  const dropped = caseTasks(c).filter((t) => !t.done).length;
  c.status = 'closed';
  note(c, ctx, `Closed.${text(input.note) ? ` ${text(input.note)}` : ''}`);
  return { case: c, dropped };
}

const EDITABLE = ['recipient', 'summary', 'method', 'amount', 'notes', 'requestedOn', 'requestedBy', 'approvedFrom', 'approvedThrough'];
const LABELS = {
  recipient: 'who it is for', summary: 'what it is for', method: 'how it is paid', amount: 'amount', notes: 'notes',
  requestedOn: 'date received', requestedBy: 'requested by', approvedFrom: 'start date', approvedThrough: 'end date',
};

/** Changes a case's details. The approval dates only change on an approved case. */
function edit(c, input, ctx) {
  if (c.status === 'closed') throw new Error("A closed case can't be changed.");
  const next = {
    recipient: recipientOf(input.recipient ?? c.recipient),
    summary: text(input.summary ?? c.summary, 500),
    method: methodOf(input.method ?? c.method),
    amount: amountOf(input.amount ?? c.amount, { required: c.status === 'approved' }),
    notes: text(input.notes ?? c.notes),
    requestedOn: dateOf(input.requestedOn ?? c.requestedOn, 'Received on'),
    requestedBy: text(input.requestedBy ?? c.requestedBy, 200),
    approvedFrom: c.approvedFrom,
    approvedThrough: c.approvedThrough,
  };
  if (!next.summary) throw new Error('Say what the request is for.');
  if (c.status === 'approved') {
    next.approvedFrom = dateOf(input.approvedFrom ?? c.approvedFrom, 'Starts on');
    next.approvedThrough = dateOf(input.approvedThrough ?? c.approvedThrough, 'Runs through');
    if (next.approvedThrough < next.approvedFrom) throw new Error('The approval has to end after it starts.');
  }
  // The same member or church under a name changed in MemberManager isn't a
  // change of who the case is for; the kept name is just brought up to date.
  const same = (key) => (key === 'recipient'
    ? next.recipient.kind === c.recipient.kind && next.recipient.id === c.recipient.id && (next.recipient.kind !== 'none' || next.recipient.name === c.recipient.name)
    : JSON.stringify(next[key]) === JSON.stringify(c[key]));
  const changed = EDITABLE.filter((key) => !same(key));
  if (!changed.length) {
    c.recipient = next.recipient;
    return c;
  }
  Object.assign(c, next);
  note(c, ctx, `Changed ${changed.map((key) => LABELS[key]).join(', ')}.`);
  return c;
}

function findTask(c, taskId) {
  const task = caseTasks(c).find((t) => t.id === taskId);
  if (!task) throw new Error('That task is no longer on this case. Its dates may have changed.');
  return task;
}

function doneRecord(task, input, ctx) {
  return {
    on: dateOf(input.on, 'Done on'),
    at: ctx.now.toISOString(),
    by: ctx.by,
    note: text(input.note, 500),
    due: task.due,
    period: task.period,
    label: task.label,
  };
}

/** Marks a quarter's check sent or invoice written off. */
function markPaid(c, taskId, input, ctx) {
  requireStatus(c, 'approved', 'paid');
  const task = findTask(c, taskId);
  if (task.kind !== 'payment') throw new Error('Use Review for a review.');
  if (task.done) throw new Error(`${task.label} was already marked done by ${task.done.by}.`);
  c.done[taskId] = { ...doneRecord(task, input, ctx), amount: c.amount, method: c.method };
  const what = c.method === 'writeoff' ? 'invoice written off' : 'check sent';
  note(c, ctx, `${task.period} ${what}: ${formatMoney(c.amount)}${c.done[taskId].note ? ` (${c.done[taskId].note})` : ''}.`);
  return c;
}

/**
 * The yearly review: renews the case through a new end date, with new terms
 * if they changed, or lets it end when the current approval runs out.
 */
function review(c, taskId, input, ctx) {
  requireStatus(c, 'approved', 'reviewed');
  if (taskId !== reviewId(c.approvedThrough)) throw new Error('That review is no longer on this case. Its dates may have changed.');
  const task = findTask(c, taskId);
  if (task.done) throw new Error(`This review was already done by ${task.done.by}.`);
  const record = doneRecord(task, input, ctx);
  if (input.outcome === 'renew') {
    const through = dateOf(input.approvedThrough, 'Renewed through');
    if (through <= c.approvedThrough) throw new Error(`Renew it past ${formatDate(c.approvedThrough)}, when it ends now.`);
    c.method = methodOf(input.method ?? c.method);
    c.amount = amountOf(input.amount ?? c.amount, { required: true });
    c.done[taskId] = { ...record, outcome: 'renew', through };
    const from = addDays(c.approvedThrough, 1);
    c.approvedThrough = through;
    note(c, ctx, `Reviewed and renewed: ${describeTerms(c)}, ${formatDate(from)} through ${formatDate(through)}.${record.note ? ` ${record.note}` : ''}`);
  } else if (input.outcome === 'end') {
    c.done[taskId] = { ...record, outcome: 'end' };
    note(c, ctx, `Reviewed: not renewed, ends ${formatDate(c.approvedThrough)}.${record.note ? ` ${record.note}` : ''}`);
  } else {
    throw new Error('Choose whether to renew the case or let it end.');
  }
  return c;
}

/**
 * Takes back a task marked done by mistake. A renewal can't be taken back
 * this way, since it moved the case's dates; change them with Edit instead.
 */
function undo(c, taskId, ctx) {
  requireStatus(c, 'approved', 'changed');
  const record = c.done[taskId];
  if (!record) throw new Error('That task isn\'t marked done.');
  if (record.outcome === 'renew') throw new Error('A renewal can\'t be undone. Use Edit to change the dates the case runs.');
  delete c.done[taskId];
  note(c, ctx, `${record.label}: marked not done.`);
  return c;
}

/**
 * Records documents already copied into the case's folder (store.js
 * copyDocument): `files` are { id, file, name, size }, where `file` is the
 * copy's name in the folder and `name` the original's. Any case can have
 * documents added, closed ones too, to keep its paperwork together.
 */
function addDocuments(c, files, ctx) {
  if (!files.length) return c;
  c.documents ??= [];
  const at = ctx.now.toISOString();
  for (const f of files) {
    c.documents.push({ id: f.id, name: text(f.name, 255) || f.file, file: f.file, size: f.size ?? null, addedAt: at, addedBy: ctx.by });
  }
  note(c, ctx, files.length === 1 ? `Added ${files[0].name}.` : `Added ${files.length} documents: ${files.map((f) => f.name).join(', ')}.`);
  return c;
}

/** Takes a document off the case. Returns it, so its copy can be deleted. */
function removeDocument(c, docId, ctx) {
  const doc = (c.documents || []).find((d) => d.id === docId);
  if (!doc) throw new Error('That document is no longer on this case.');
  c.documents = c.documents.filter((d) => d.id !== docId);
  note(c, ctx, `Removed ${doc.name}.`);
  return doc;
}

module.exports = { METHODS, recipientOf, newCase, approve, decline, close, edit, markPaid, review, undo, addDocuments, removeDocument };
