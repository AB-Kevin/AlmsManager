'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Menu, nativeTheme, net } = require('electron');
const { readIdentity, watchIdentity } = require('ab-common/abapps');
const { appFolder } = require('ab-common/appfolder');
const { watchMemberList } = require('ab-common/members');
const { writeJson } = require('ab-common/jsonfile');
const store = require('./store');
const directoryOf = require('./members');
const cases = require('../shared/cases');
const schedule = require('../shared/schedule');
// Releases are published by .github/workflows/release.yml, each with the
// latest.yml electron-builder writes beside the installer. AB Apps reads the
// same file to install and update this app.
const { RELEASES_PAGE, checkForUpdate, downloadInstaller } = require('ab-common/releases').selfUpdates({
  repo: 'AB-Kevin/AlmsManager',
  installerName: (version) => `AlmsManager-Setup-${version}.exe`, // package.json build.nsis.artifactName
});

const APP_ID = 'org.anabaptistbrotherhood.almsmanager';
const DOCS_URL = 'https://github.com/AB-Kevin/AlmsManager/blob/main/docs/power-automate.md';
const APP_ICON = path.join(__dirname, '..', '..', 'build', 'icon.png');
// The window's color before the page paints: --surface-page in styles.css.
const WINDOW_BACKGROUND = { light: '#FFFFFF', dark: '#1E1C1D' };
const POLL_MS = 5000;

const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) app.quit();

let win = null;
let identity = null; // who is signed in to AB Apps, or null
let dir = null; // AlmsManager's folder in the AB Apps folder, or null
let directory = null; // MemberManager's list (members.js), or null
let stopMemberWatch = () => {};
let signature = '';
let reminders = { writtenAt: null, skipped: null, error: null };
let latestRelease = null;
let installing = null;

const updatesDir = () => path.join(app.getPath('temp'), 'AlmsManager updates');

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
const stateChanged = () => send('state-changed');

// Folder and member list ---------------------------------------------------

/** Works out where the data is for whoever is signed in, and starts following MemberManager's list. */
function open() {
  stopMemberWatch();
  stopMemberWatch = () => {};
  dir = null;
  directory = null;
  if (!identity || !fs.existsSync(identity.dataDir)) return;
  dir = appFolder(identity, store.FOLDER);
  fs.mkdirSync(store.casesDir(dir), { recursive: true });
  loadMembers();
  if (directory) stopMemberWatch = watchMemberList(directory.folder, () => loadMembers() && refresh());
  signature = store.casesSignature(dir);
  syncReminders();
}

function loadMembers() {
  const next = directoryOf.loadDirectory(identity);
  // A list OneDrive is still syncing reads as null; keep the last one.
  if (next || !directory) directory = next;
  return Boolean(next);
}

/** Picks up changes made on other computers. */
function poll() {
  if (!dir) return;
  const next = store.casesSignature(dir);
  if (next === signature) return;
  signature = next;
  refresh();
}

function refresh() {
  syncReminders();
  stateChanged();
}

// Reminders file -----------------------------------------------------------

/**
 * Rewrites reminders.json when what it should say has changed. Any computer
 * may write it, since it's always rebuilt from the cases, but not while a
 * case file can't be read (its reminders would vanish), nor from a copy of
 * the cases older than the one the file was built from.
 */
function syncReminders() {
  if (!dir) return;
  try {
    const { cases: all, unreadable } = store.readCases(dir);
    if (unreadable.length) {
      reminders = { ...reminders, skipped: `${unreadable.length} case file${unreadable.length === 1 ? '' : 's'} couldn't be read yet` };
      return;
    }
    const settings = store.readSettings(dir);
    const basis = schedule.remindersBasis(all, settings);
    const existing = store.readReminders(dir);
    if (existing?.basis && basis && existing.basis > basis) {
      reminders = { ...reminders, skipped: 'another computer has newer changes; waiting for OneDrive' };
      return;
    }
    const next = schedule.buildReminders(all, {
      sendTo: settings.reminderEmail,
      nameOf: (c) => directoryOf.recipientLine(directory, c.recipient),
      basis,
    });
    const unchanged = schedule.sameReminders(existing, next);
    if (!unchanged) writeJson(store.remindersPath(dir), next);
    reminders = { writtenAt: unchanged ? existing.generatedAt : next.generatedAt, skipped: null, error: null };
  } catch (err) {
    reminders = { ...reminders, error: err.message };
  }
}

// What the window shows ----------------------------------------------------

function snapshot() {
  const today = schedule.localToday();
  const base = {
    version: app.getVersion(),
    today,
    signedIn: Boolean(identity),
    name: identity?.name ?? null,
    isManager: identity?.class === 'manager',
    update: latestRelease ? { version: latestRelease.version, newer: latestRelease.newer, hasInstaller: Boolean(latestRelease.installer) } : null,
  };
  if (!identity) return base;
  if (!dir) return { ...base, folderMissing: identity.dataDir };
  const { cases: all, unreadable, conflicts } = store.readCases(dir);
  let settings;
  let settingsError = null;
  try {
    settings = store.readSettings(dir);
  } catch (err) {
    settings = { reminderEmail: '' };
    settingsError = err.message;
  }
  const shown = all.map((c) => ({
    ...c,
    who: directoryOf.describeRecipient(directory, c.recipient),
    state: schedule.caseState(c, today),
    tasks: schedule.caseTasks(c),
  }));
  return {
    ...base,
    folder: dir,
    members: directory ? { available: true, count: directory.entries.length } : { available: false },
    cases: shown,
    unreadable,
    conflicts: conflicts.map((id) => shown.find((c) => c.id === id)?.who.name ?? id),
    settings,
    settingsError,
    reminders: { ...reminders, path: store.remindersPath(dir) },
  };
}

// Updates -----------------------------------------------------------------

async function installUpdate() {
  const release = latestRelease;
  if (!release?.newer || !release.installer) throw new Error('Check for updates first.');
  if (!app.isPackaged) throw new Error('Updates are installed from the installed app, not from a development copy.');
  let lastPercent = -1;
  const installer = await downloadInstaller(release.installer, updatesDir(), net.fetch, (received, total) => {
    const percent = Math.floor((received / total) * 100);
    if (percent !== lastPercent) send('update-progress', { percent: (lastPercent = percent) });
  });
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    title: 'Install update?',
    message: `Install AlmsManager ${release.version} now?`,
    detail: 'AlmsManager closes while the update installs. Everything is already saved.',
    buttons: ['Install now', 'Later'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (response !== 0) return { installing: false };
  // --updated: the installer waits for this app to close and keeps the shortcuts as they are.
  await new Promise((resolve, reject) => {
    const child = spawn(installer, ['--updated'], { detached: true, stdio: 'ignore' });
    child.once('spawn', resolve);
    child.once('error', (err) => reject(new Error(`The installer couldn't be started: ${err.message}`)));
    child.unref();
  });
  app.quit();
  return { installing: true };
}

async function checkUpdates() {
  latestRelease = await checkForUpdate(app.getVersion(), net.fetch);
  const { version, newer, publishedAt, installer } = latestRelease;
  return { version, newer, publishedAt, hasInstaller: Boolean(installer) };
}

// IPC ---------------------------------------------------------------------

/** Registers an IPC handler that returns { ok, value } or { ok: false, error }. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

function ctx() {
  if (!identity) throw new Error('Sign in to AB Apps first.');
  if (!dir) throw new Error('The AB Apps folder can\'t be reached. If OneDrive is still setting up, wait for it to finish.');
  return { by: identity.name, now: new Date() };
}

/** Changes one case, read afresh from its file, then rebuilds the reminders. */
function change(id, fn) {
  const context = ctx();
  const result = store.updateCase(dir, id, (c) => fn(c, context));
  refresh();
  return result?.dropped ?? null;
}

function registerIpc() {
  handle('state:get', () => snapshot());
  handle('members:search', (query) => directoryOf.search(directory, query));

  handle('case:create', (input) => {
    const c = cases.newCase(input, ctx(), crypto.randomUUID());
    store.writeCase(dir, c);
    refresh();
    return c.id;
  });
  handle('case:approve', (id, input) => change(id, (c, x) => cases.approve(c, input, x)));
  handle('case:decline', (id, input) => change(id, (c, x) => cases.decline(c, input, x)));
  handle('case:edit', (id, input) => change(id, (c, x) => cases.edit(c, input, x)));
  handle('case:close', (id, input) => change(id, (c, x) => cases.close(c, input, x)));
  handle('task:paid', (id, taskId, input) => change(id, (c, x) => cases.markPaid(c, taskId, input, x)));
  handle('task:review', (id, taskId, input) => change(id, (c, x) => cases.review(c, taskId, input, x)));
  handle('task:undo', (id, taskId) => change(id, (c, x) => cases.undo(c, taskId, x)));

  handle('settings:save', (input) => {
    const context = ctx();
    if (identity.class !== 'manager') throw new Error('Only a manager can change who the reminders go to.');
    store.writeSettings(dir, input, context);
    refresh();
  });

  handle('folder:open', async () => {
    const error = await shell.openPath(dir ?? '');
    if (error) throw new Error(error);
  });
  handle('reminders:copy-path', () => clipboard.writeText(store.remindersPath(dir)));
  handle('docs:open', () => shell.openExternal(DOCS_URL));

  handle('update:check', () => checkUpdates());
  handle('update:install', () => {
    installing ??= installUpdate().finally(() => {
      installing = null;
    });
    return installing;
  });
  handle('update:page', () => shell.openExternal(latestRelease?.pageUrl ?? RELEASES_PAGE));
}

// Window ------------------------------------------------------------------

const windowBackground = () => WINDOW_BACKGROUND[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'];

function createWindow() {
  win = new BrowserWindow({
    width: 1240,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: 'AlmsManager',
    backgroundColor: windowBackground(),
    icon: APP_ICON,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('closed', () => {
    win = null;
  });
}

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(() => {
  if (!isPrimaryInstance) return;
  app.setAppUserModelId(APP_ID);
  Menu.setApplicationMenu(null);
  nativeTheme.on('updated', () => win?.setBackgroundColor(windowBackground()));
  try {
    fs.rmSync(updatesDir(), { recursive: true, force: true });
  } catch {
    // The installer that just ran may still be closing; it is removed next time.
  }

  identity = readIdentity(app.getPath('appData'));
  try {
    open();
  } catch (err) {
    console.error('open', err);
  }
  // Signing in or out of AB Apps, or moving to another AB Apps folder.
  watchIdentity(app.getPath('appData'), (next) => {
    identity = next;
    try {
      open();
    } catch (err) {
      console.error('open', err);
    }
    stateChanged();
  });
  setInterval(poll, POLL_MS);
  // A new day can bring tasks due, and the reminders file needs no change for it.
  let day = schedule.localToday();
  setInterval(() => {
    if (schedule.localToday() !== day) {
      day = schedule.localToday();
      stateChanged();
    }
  }, 60 * 1000);

  registerIpc();
  createWindow();
  checkUpdates().then(stateChanged, () => {});
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => stopMemberWatch());
