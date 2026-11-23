'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/shared/schedule');

const approved = (over = {}) => ({
  id: 'c1',
  status: 'approved',
  method: 'check',
  amount: 300,
  approvedFrom: '2027-01-15',
  approvedThrough: '2027-12-31',
  recipient: { kind: 'contact', id: 'p1', memberId: '1234', name: 'Ann Miller' },
  done: {},
  updatedAt: '2027-01-15T10:00:00.000Z',
  ...over,
});

test('dates', () => {
  assert.equal(S.isDate('2027-02-29'), false);
  assert.equal(S.isDate('2028-02-29'), true);
  assert.equal(S.addYears('2028-02-29', 1), '2029-02-28');
  assert.equal(S.addDays('2027-12-31', -30), '2027-12-01');
  assert.equal(S.formatDate('2027-01-05'), '1/5/2027');
  assert.equal(S.formatMoney(1250), '$1,250.00');
});

test('an approval runs to the end of the year, or of the next from October on', () => {
  assert.equal(S.defaultThrough('2027-03-10'), '2027-12-31');
  assert.equal(S.defaultThrough('2027-09-30'), '2027-12-31');
  assert.equal(S.defaultThrough('2027-10-01'), '2028-12-31');
  assert.equal(S.defaultThrough('2027-12-10'), '2028-12-31');
});

test('an approved case has a payment each calendar quarter and a review a month before it ends', () => {
  const tasks = S.caseTasks(approved());
  assert.deepEqual(tasks.map((t) => [t.id, t.due]), [
    ['pay:2027-Q1', '2027-01-15'],
    ['pay:2027-Q2', '2027-04-01'],
    ['pay:2027-Q3', '2027-07-01'],
    ['pay:2027-Q4', '2027-10-01'],
    ['review:2027-12-31', '2027-12-01'],
  ]);
  assert.equal(tasks[0].label, 'Send the Q1 2027 check');
  assert.equal(tasks[4].label, 'Review for 2028');
  assert.equal(S.caseTasks(approved({ method: 'writeoff' }))[1].label, 'Write off the Q2 2027 invoice');
});

test('a request not yet approved, or declined, has no tasks', () => {
  assert.deepEqual(S.caseTasks(approved({ status: 'requested' })), []);
  assert.deepEqual(S.caseTasks(approved({ status: 'declined' })), []);
});

test('a closed case keeps only what was done', () => {
  const c = approved({ status: 'closed', done: { 'pay:2027-Q1': { on: '2027-01-20', by: 'Kim' } } });
  assert.deepEqual(S.caseTasks(c).map((t) => t.id), ['pay:2027-Q1']);
});

test("last year's review stays on the case as done after renewing", () => {
  const c = approved({
    approvedThrough: '2028-12-31',
    done: { 'review:2027-12-31': { on: '2027-12-02', due: '2027-12-01', label: 'Review for 2028', outcome: 'renew', through: '2028-12-31' } },
  });
  const tasks = S.caseTasks(c);
  assert.ok(tasks.find((t) => t.id === 'review:2027-12-31' && t.done));
  assert.ok(tasks.find((t) => t.id === 'review:2028-12-31' && !t.done));
  assert.equal(tasks.filter((t) => t.kind === 'payment').length, 8);
});

test('where a case stands', () => {
  assert.equal(S.caseState(approved(), '2027-06-01'), 'active');
  const ending = approved({ done: { 'review:2027-12-31': { outcome: 'end' } } });
  assert.equal(S.caseState(ending, '2027-12-31'), 'active');
  assert.equal(S.caseState(ending, '2028-01-01'), 'ended');
  // Past its end but never reviewed: still active, and the review keeps being reminded.
  assert.equal(S.caseState(approved(), '2028-02-01'), 'active');
});

test('the reminders file lists every open task, including those not due yet, and not done ones', () => {
  const c = approved({ done: { 'pay:2027-Q1': { on: '2027-01-20' } } });
  const r = S.buildReminders([c, approved({ id: 'c2', status: 'requested' })], {
    sendTo: 'office@example.org',
    nameOf: (x) => `${x.recipient.name} (Member ${x.recipient.memberId})`,
    basis: '2027-01-20T00:00:00.000Z',
    now: new Date('2027-01-20T12:00:00Z'),
  });
  assert.equal(r.sendTo, 'office@example.org');
  assert.deepEqual(r.tasks.map((t) => t.due), ['2027-04-01', '2027-07-01', '2027-10-01', '2027-12-01']);
  assert.deepEqual(r.tasks[0], {
    due: '2027-04-01',
    dueText: '4/1/2027',
    task: 'Send the Q2 2027 check',
    for: 'Ann Miller (Member 1234)',
    amount: '$300.00',
    line: '4/1/2027 · Send the Q2 2027 check · Ann Miller (Member 1234) · $300.00',
  });
  assert.equal(r.tasks[3].amount, '');
});

test('reminders are compared without when they were written', () => {
  const a = { version: 1, generatedAt: 'x', basis: '1', sendTo: 'a', tasks: [] };
  assert.ok(S.sameReminders(a, { ...a, generatedAt: 'y', basis: '2' }));
  assert.ok(!S.sameReminders(a, { ...a, sendTo: 'b' }));
  assert.ok(!S.sameReminders(null, a));
});

test('the basis is the newest change to any case or the settings', () => {
  assert.equal(S.remindersBasis([{ updatedAt: '2027-01-02' }, { updatedAt: '2027-03-01' }], { updatedAt: '2027-02-01' }), '2027-03-01');
  assert.equal(S.remindersBasis([], {}), null);
});
