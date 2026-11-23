'use strict';

// AlmsManager keeps everything in its subfolder of the AB Apps folder:
//
//   AlmsManager\cases\<id>.json  one file per case (see shared/cases.js)
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
  readReminders,
};
