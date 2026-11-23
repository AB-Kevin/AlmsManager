'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

/** Calls the main process and unwraps { ok, value, error }. */
async function call(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

contextBridge.exposeInMainWorld('api', {
  getState: () => call('state:get'),
  searchMembers: (query) => call('members:search', query),
  createCase: (input) => call('case:create', input),
  approve: (id, input) => call('case:approve', id, input),
  decline: (id, input) => call('case:decline', id, input),
  edit: (id, input) => call('case:edit', id, input),
  close: (id, input) => call('case:close', id, input),
  markPaid: (id, taskId, input) => call('task:paid', id, taskId, input),
  review: (id, taskId, input) => call('task:review', id, taskId, input),
  undo: (id, taskId) => call('task:undo', id, taskId),
  chooseDocuments: (id) => call('doc:add', id, null),
  dropDocuments: (id, files) => call('doc:add', id, Array.from(files, (file) => webUtils.getPathForFile(file))),
  openDocument: (id, docId) => call('doc:open', id, docId),
  removeDocument: (id, docId) => call('doc:remove', id, docId),
  saveSettings: (input) => call('settings:save', input),
  openFolder: () => call('folder:open'),
  copyRemindersPath: () => call('reminders:copy-path'),
  openDocs: () => call('docs:open'),
  checkForUpdate: () => call('update:check'),
  installUpdate: () => call('update:install'),
  openReleasePage: () => call('update:page'),
  onStateChanged: (callback) => ipcRenderer.on('state-changed', () => callback()),
  onUpdateProgress: (callback) => ipcRenderer.on('update-progress', (_event, progress) => callback(progress)),
});
