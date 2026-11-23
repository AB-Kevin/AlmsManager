'use strict';

// AlmsManager keeps everything in its subfolder of the AB Apps folder:
//
//   AlmsManager\cases\<id>.json  one file per case (see shared/cases.js)
//   AlmsManager\files\<id>\      copies of the documents added to that case
//   AlmsManager\settings.json    who the reminders go to; managers change it
//   AlmsManager\reminders.json   what Power Automate reads to send the daily
//                                reminder (see docs/power-automate.md)
//
// OneDrive can't merge two computers' changes to one file, so each case has
// its own: two people only collide if they change the same case within the
// minute or so OneDrive takes to sync. Every change reads the case's file
// afresh just before writing it, never an older copy held in memory. When
// two do collide, OneDrive keeps both, naming one "<id>-<COMPUTER>.json";
// those are reported (`conflicts`) so someone can look, and never read as
// cases.

const fs = require('fs');
const path = require('path');
const { readJson, writeJson } = require('ab-common/jsonfile');

const FOLDER = 'AlmsManager';
const CASE_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/i;
const CONFLICT_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-.+\.json$/i;

const casesDir = (dir) => path.join(dir, 'cases');
const casePath = (dir, id) => path.join(casesDir(dir), `${id}.json`);
const settingsPath = (dir) => path.join(dir, 'settings.json');
const remindersPath = (dir) => path.join(dir, 'reminders.json');

function listCaseFolder(dir) {
  try {
    return fs.readdirSync(casesDir(dir));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Every case: { cases, unreadable, conflicts }. A file OneDrive is still
 * syncing, or a damaged one, is left out and named in `unreadable`; while
 * any is, the reminders file isn't rewritten, so that case's reminders
 * aren't lost. `conflicts` are the ids of cases OneDrive kept two copies of.
 */
function readCases(dir) {
  const cases = [];
  const unreadable = [];
  const conflicts = new Set();
  for (const name of listCaseFolder(dir)) {
    const conflict = CONFLICT_FILE.exec(name);
    if (conflict) {
      conflicts.add(conflict[1].toLowerCase());
      continue;
    }
    const match = CASE_FILE.exec(name);
    if (!match) continue;
    try {
      const c = readJson(path.join(casesDir(dir), name), null);
      if (c?.version === 1 && c.id?.toLowerCase() === match[1].toLowerCase()) cases.push(c);
      else unreadable.push(name);
    } catch {
      unreadable.push(name);
    }
  }
  return { cases, unreadable, conflicts: [...conflicts] };
}

/** One case, read afresh. Throws if it's gone or can't be read. */
function readCase(dir, id) {
  if (!CASE_FILE.test(`${id}.json`)) throw new Error('That case can\'t be found.');
  const c = readJson(casePath(dir, id), null);
  if (!c) throw new Error('That case can\'t be found. If it was added on another computer, wait for OneDrive to sync it.');
  return c;
}

function writeCase(dir, c) {
  writeJson(casePath(dir, c.id), c);
}

/** Reads a case, lets `change` change it, and writes it back. Returns what `change` returns. */
function updateCase(dir, id, change) {
  const c = readCase(dir, id);
  const result = change(c);
  writeCase(dir, c);
  return result;
}

/** When each case file was last changed, as one string, to notice changes from other computers. */
function casesSignature(dir) {
  const files = [
    ...listCaseFolder(dir).sort().map((name) => path.join(casesDir(dir), name)),
    settingsPath(dir),
    remindersPath(dir),
  ];
  return files
    .map((file) => {
      try {
        const stat = fs.statSync(file);
        return `${path.basename(file)}:${stat.mtimeMs}:${stat.size}`;
      } catch {
        return `${path.basename(file)}:-`;
      }
    })
    .join('|');
}

const DEFAULT_SETTINGS = { version: 1, reminderEmail: '', updatedAt: null, updatedBy: null };

function readSettings(dir) {
  const settings = readJson(settingsPath(dir), DEFAULT_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...settings };
}

/** One or more email addresses, separated by semicolons or commas; returned joined by semicolons, as Outlook takes them. */
function cleanEmails(value) {
  const list = String(value ?? '').split(/[;,]/).map((s) => s.trim()).filter(Boolean);
  for (const address of list) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new Error(`${address} isn't an email address.`);
  }
  return list.join('; ');
}

function writeSettings(dir, input, { by, now }) {
  const settings = { ...readSettings(dir), reminderEmail: cleanEmails(input.reminderEmail), updatedAt: now.toISOString(), updatedBy: by };
  writeJson(settingsPath(dir), settings);
  return settings;
}

// Documents ---------------------------------------------------------------
//
// A document is copied into the case's folder rather than linked where it
// was, so it opens on every computer that syncs the AB Apps folder, and stays
// when the original is moved or deleted. Each copy is written once and never
// changed, so two computers never write the same file.

const CASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function filesDir(dir, caseId) {
  if (!CASE_ID.test(caseId)) throw new Error('That case can\'t be found.');
  return path.join(dir, 'files', caseId);
}

/** A name Windows and OneDrive accept: no reserved characters, no trailing dots or spaces, not too long. */
function safeFileName(name) {
  let clean = String(name ?? '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim();
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(clean)) clean = `_${clean}`;
  // documentPath refuses names starting with a dot, so ".pdf" becomes "document.pdf".
  if (clean.startsWith('.')) clean = `document${clean}`;
  const ext = path.extname(clean).slice(0, 20);
  const stem = clean.slice(0, clean.length - path.extname(clean).length).slice(0, 120);
  return stem ? `${stem}${ext}` : `document${ext}`;
}

/**
 * Copies a file into the case's folder, under its own name, or "name (2).pdf"
 * when that's taken. Returns { file, name, size }: the copy's name and the
 * original's.
 */
function copyDocument(dir, caseId, source) {
  const folder = filesDir(dir, caseId);
  let stat;
  try {
    stat = fs.statSync(source);
  } catch {
    throw new Error(`${path.basename(source)} can't be found.`);
  }
  if (!stat.isFile()) throw new Error(`${path.basename(source)} is a folder, not a file.`);
  fs.mkdirSync(folder, { recursive: true });
  const base = safeFileName(path.basename(source));
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  for (let n = 1; ; n++) {
    const file = n === 1 ? base : `${stem} (${n})${ext}`;
    try {
      fs.copyFileSync(source, path.join(folder, file), fs.constants.COPYFILE_EXCL);
      return { file, name: path.basename(source), size: stat.size };
    } catch (err) {
      if (err.code !== 'EEXIST' || n > 999) throw new Error(`${path.basename(source)} couldn't be copied: ${err.message}`);
    }
  }
}

/** Where a case's document is. `file` is only ever a name in the case's folder. */
function documentPath(dir, caseId, file) {
  if (typeof file !== 'string' || !file || path.basename(file) !== file || file.startsWith('.')) throw new Error('That document can\'t be found.');
  return path.join(filesDir(dir, caseId), file);
}

/** Deletes a document's copy; OneDrive keeps it in its recycle bin for a while. */
function deleteDocument(dir, caseId, file) {
  try {
    fs.rmSync(documentPath(dir, caseId, file), { force: true });
  } catch {
    // Already gone, or locked open on this computer: harmless either way.
  }
}

function readReminders(dir) {
  try {
    return readJson(remindersPath(dir), null);
  } catch {
    return null;
  }
}

module.exports = {
  FOLDER,
  casesDir,
  casePath,
  settingsPath,
  remindersPath,
  readCases,
  readCase,
  writeCase,
  updateCase,
  casesSignature,
  readSettings,
  writeSettings,
  cleanEmails,
  safeFileName,
  copyDocument,
  documentPath,
  deleteDocument,
  readReminders,
};
