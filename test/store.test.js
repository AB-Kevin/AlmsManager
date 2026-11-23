'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../src/main/store');

const ID = '0dbc309a-4814-4490-a9ca-0691c9092199';
const ID2 = '1dbc309a-4814-4490-a9ca-0691c9092199';

function folder() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'almsmanager-'));
}

test('cases are read one file each; conflict copies and unreadable files are reported, not read', () => {
  const dir = folder();
  store.writeCase(dir, { version: 1, id: ID, summary: 'a' });
  fs.writeFileSync(path.join(store.casesDir(dir), `${ID}-OFFICE-PC.json`), '{}');
  fs.writeFileSync(path.join(store.casesDir(dir), `${ID2}.json`), '{ half a file');
  fs.writeFileSync(path.join(store.casesDir(dir), 'notes.txt'), 'x');
  const { cases, unreadable, conflicts } = store.readCases(dir);
  assert.deepEqual(cases.map((c) => c.id), [ID]);
  assert.deepEqual(unreadable, [`${ID2}.json`]);
  assert.deepEqual(conflicts, [ID]);
});

test('a missing folder has no cases', () => {
  assert.deepEqual(store.readCases(path.join(folder(), 'nope')), { cases: [], unreadable: [], conflicts: [] });
});

test('updateCase reads the file afresh and writes the change', () => {
  const dir = folder();
  store.writeCase(dir, { version: 1, id: ID, summary: 'a' });
  store.updateCase(dir, ID, (c) => {
    c.summary = 'b';
  });
  assert.equal(store.readCase(dir, ID).summary, 'b');
  assert.throws(() => store.readCase(dir, ID2), /can't be found/);
  assert.throws(() => store.readCase(dir, '../settings'), /can't be found/);
});

test('the signature changes when a case does', () => {
  const dir = folder();
  const before = store.casesSignature(dir);
  store.writeCase(dir, { version: 1, id: ID });
  assert.notEqual(store.casesSignature(dir), before);
});

test('reminder addresses', () => {
  assert.equal(store.cleanEmails(' a@example.org, b@example.org ;'), 'a@example.org; b@example.org');
  assert.equal(store.cleanEmails(''), '');
  assert.throws(() => store.cleanEmails('nobody'), /isn't an email address/);
  const dir = folder();
  store.writeSettings(dir, { reminderEmail: 'a@example.org' }, { by: 'Kim', now: new Date('2027-01-01T00:00:00Z') });
  assert.deepEqual(store.readSettings(dir), { version: 1, reminderEmail: 'a@example.org', updatedAt: '2027-01-01T00:00:00.000Z', updatedBy: 'Kim' });
});

test('documents are copied into the case folder, never over another', () => {
  const dir = folder();
  const src = path.join(folder(), 'Rent letter.pdf');
  fs.writeFileSync(src, 'pdf');
  const first = store.copyDocument(dir, ID, src);
  const second = store.copyDocument(dir, ID, src);
  assert.deepEqual([first.file, second.file], ['Rent letter.pdf', 'Rent letter (2).pdf']);
  assert.equal(first.size, 3);
  assert.equal(fs.readFileSync(store.documentPath(dir, ID, second.file), 'utf8'), 'pdf');
  store.deleteDocument(dir, ID, first.file);
  assert.ok(!fs.existsSync(store.documentPath(dir, ID, first.file)));
  assert.throws(() => store.copyDocument(dir, ID, path.join(dir, 'missing.pdf')), /can't be found/);
  assert.throws(() => store.copyDocument(dir, ID, dir), /folder, not a file/);
});

test('a document path never leaves the case folder', () => {
  const dir = folder();
  assert.throws(() => store.documentPath(dir, ID, '..\settings.json'), /can't be found/);
  assert.throws(() => store.documentPath(dir, ID, '../x'), /can't be found/);
  assert.throws(() => store.documentPath(dir, 'not-a-case', 'a.pdf'), /can't be found/);
});

test('file names are made safe for Windows and OneDrive', () => {
  assert.equal(store.safeFileName('a:b?c.pdf'), 'a_b_c.pdf');
  assert.equal(store.safeFileName('notes. '), 'notes');
  assert.equal(store.safeFileName('CON.txt'), '_CON.txt');
  assert.equal(store.safeFileName('.pdf'), 'document.pdf');
});
