'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/shared/cases');
const { caseTasks } = require('../src/shared/schedule');

const ctx = (by = 'Kim Office', at = '2027-01-15T10:00:00Z') => ({ by, now: new Date(at) });
const recipient = { kind: 'contact', id: 'p1', memberId: '1234', name: 'Ann Miller' };

function request() {
  return C.newCase({ recipient, summary: 'Help with rent', requestedOn: '2027-01-10', requestedBy: 'Pastor John', method: 'check', amount: '' }, ctx(), 'c1');
}

function approvedCase() {
  return C.approve(request(), { method: 'check', amount: '$300', approvedFrom: '2027-01-15', approvedThrough: '2027-12-31', decidedOn: '2027-01-15' }, ctx());
}

test('a new request needs who it is for and what it is for', () => {
  const c = request();
  assert.equal(c.status, 'requested');
  assert.equal(c.amount, null);
  assert.match(c.history[0].text, /Pastor John/);
  assert.throws(() => C.newCase({ recipient, summary: ' ', requestedOn: '2027-01-10' }, ctx(), 'x'), /what the request is for/);
  assert.throws(() => C.newCase({ recipient: null, summary: 'x', requestedOn: '2027-01-10' }, ctx(), 'x'), /member or church/);
  // Typed in while MemberManager's list can't be reached.
  assert.equal(C.newCase({ recipient: { kind: 'none', name: 'Grace Church' }, summary: 'x', requestedOn: '2027-01-10' }, ctx(), 'x').recipient.id, null);
});

test('approving sets the terms and dates; it needs an amount', () => {
  const c = approvedCase();
  assert.equal(c.status, 'approved');
  assert.equal(c.amount, 300);
  assert.equal(c.decidedBy, 'Kim Office');
  assert.match(c.history.at(-1).text, /\$300\.00 a quarter by check, 1\/15\/2027 through 12\/31\/2027/);
  assert.throws(() => C.approve(request(), { method: 'check', amount: '', approvedFrom: '2027-01-15', approvedThrough: '2027-12-31', decidedOn: '2027-01-15' }, ctx()), /amount/);
  assert.throws(() => C.approve(request(), { method: 'check', amount: '1', approvedFrom: '2027-02-01', approvedThrough: '2027-01-01', decidedOn: '2027-01-15' }, ctx()), /end after it starts/);
  assert.throws(() => C.approve(c, { method: 'check', amount: '1', approvedFrom: '2027-01-15', approvedThrough: '2027-12-31', decidedOn: '2027-01-15' }, ctx()), /can't be approved/);
});

test('marking a quarter paid records who, when and the check number', () => {
  const c = C.markPaid(approvedCase(), 'pay:2027-Q1', { on: '2027-01-16', note: '#1042' }, ctx('Lee'));
  assert.deepEqual(
    { by: c.done['pay:2027-Q1'].by, note: c.done['pay:2027-Q1'].note, amount: c.done['pay:2027-Q1'].amount },
    { by: 'Lee', note: '#1042', amount: 300 },
  );
  assert.throws(() => C.markPaid(c, 'pay:2027-Q1', { on: '2027-01-16' }, ctx()), /already marked done by Lee/);
  assert.throws(() => C.markPaid(c, 'review:2027-12-31', { on: '2027-01-16' }, ctx()), /Review/);
  assert.throws(() => C.markPaid(c, 'pay:2031-Q1', { on: '2027-01-16' }, ctx()), /no longer on this case/);
});

test('renewing at review moves the end a year on, with new terms', () => {
  const c = C.review(approvedCase(), 'review:2027-12-31', { outcome: 'renew', approvedThrough: '2028-12-31', amount: '350', method: 'writeoff', on: '2027-12-03' }, ctx());
  assert.equal(c.approvedThrough, '2028-12-31');
  assert.equal(c.amount, 350);
  assert.equal(c.method, 'writeoff');
  const open = caseTasks(c).filter((t) => !t.done);
  assert.ok(open.find((t) => t.id === 'pay:2028-Q1' && t.label === 'Write off the Q1 2028 invoice'));
  assert.ok(open.find((t) => t.id === 'review:2028-12-31'));
  assert.throws(() => C.undo(c, 'review:2027-12-31', ctx()), /can't be undone/);
  assert.throws(() => C.review(approvedCase(), 'review:2027-12-31', { outcome: 'renew', approvedThrough: '2027-06-30', on: '2027-12-03' }, ctx()), /past 12\/31\/2027/);
});

test('ending at review leaves the rest of the year to run', () => {
  const c = C.review(approvedCase(), 'review:2027-12-31', { outcome: 'end', on: '2027-12-03' }, ctx());
  assert.equal(c.status, 'approved');
  assert.equal(c.approvedThrough, '2027-12-31');
  assert.equal(caseTasks(c).filter((t) => !t.done).length, 4);
  C.undo(c, 'review:2027-12-31', ctx());
  assert.equal(c.done['review:2027-12-31'], undefined);
  assert.throws(() => C.review(approvedCase(), 'review:2027-12-31', { on: '2027-12-03' }, ctx()), /renew the case or let it end/);
});

test('closing drops what was not done', () => {
  const c = C.markPaid(approvedCase(), 'pay:2027-Q1', { on: '2027-01-16' }, ctx());
  const { dropped } = C.close(c, { closedOn: '2027-03-01', note: 'Moved away' }, ctx());
  assert.equal(dropped, 4);
  assert.equal(c.status, 'closed');
  assert.deepEqual(caseTasks(c).map((t) => t.id), ['pay:2027-Q1']);
  assert.throws(() => C.edit(c, { summary: 'x' }, ctx()), /closed case/);
});

test('editing logs what changed, but not a name MemberManager changed', () => {
  const c = approvedCase();
  const before = c.history.length;
  C.edit(c, { recipient: { ...recipient, name: 'Ann Miller-Yoder' } }, ctx());
  assert.equal(c.history.length, before);
  assert.equal(c.recipient.name, 'Ann Miller-Yoder');
  C.edit(c, { amount: '400', approvedThrough: '2027-09-30' }, ctx());
  assert.match(c.history.at(-1).text, /Changed amount, end date/);
  assert.throws(() => C.edit(c, { amount: '' }, ctx()), /amount/);
});

test('declining', () => {
  const c = C.decline(request(), { decidedOn: '2027-01-12', note: 'Covered by the church' }, ctx());
  assert.equal(c.status, 'declined');
  assert.match(c.history.at(-1).text, /Covered by the church/);
});

test('documents are added and removed, each logged', () => {
  const c = approvedCase();
  C.addDocuments(c, [{ id: 'd1', file: 'letter.pdf', name: 'letter.pdf', size: 2048 }, { id: 'd2', file: 'bill (2).pdf', name: 'bill.pdf', size: 10 }], ctx('Lee'));
  assert.deepEqual(c.documents.map((d) => [d.id, d.file, d.addedBy]), [['d1', 'letter.pdf', 'Lee'], ['d2', 'bill (2).pdf', 'Lee']]);
  assert.match(c.history.at(-1).text, /Added 2 documents: letter\.pdf, bill\.pdf/);
  assert.equal(C.removeDocument(c, 'd1', ctx()).file, 'letter.pdf');
  assert.deepEqual(c.documents.map((d) => d.id), ['d2']);
  assert.match(c.history.at(-1).text, /Removed letter\.pdf/);
  assert.throws(() => C.removeDocument(c, 'd1', ctx()), /no longer on this case/);
});

test('a case saved before documents existed can still have them added', () => {
  const c = approvedCase();
  delete c.documents;
  C.addDocuments(c, [{ id: 'd1', file: 'a.pdf', name: 'a.pdf', size: 1 }], ctx());
  assert.equal(c.documents.length, 1);
});
