/**
 * Mail Hub API
 *
 * Paste this into ONE new Apps Script project in the account that owns the
 * Mail Hub folder (abhibaramanyu@gmail.com). The three exporter scripts stay
 * as they are.
 *
 * It does two things for the Mail Hub app:
 *   1. Returns the exported mail files from the Mail Hub folder.
 *   2. Keeps your done / seen marks in mailhub_state.json in the same folder,
 *      so every device sees the same marks and Claude can read them.
 *   3. Keeps the shared task list in mailhub_tasks.json. Mail Hub sends task
 *      changes with each sync; Pocket Ledger drops them into the folder as
 *      small mailhub-taskops_*.json files, which this script merges and then
 *      moves to the trash.
 *
 * Setup:
 *   1. Deploy > New deployment > type Web app.
 *      Execute as: Me.  Who has access: Anyone.  Deploy, then authorize.
 *   2. Copy the Web app URL (ends in /exec) into CONFIG.WEBAPP_URL below. Save.
 *   3. Pick makeConnectLink in the function menu and click Run.
 *      Open the link it logs on each device you want to use.
 *   4. Pick setupTaskTrigger and click Run once, so tasks added in Pocket
 *      Ledger are merged every 10 minutes even when Mail Hub isn't open.
 *
 * Every request must carry the device key that makeConnectLink creates.
 * To lock out all devices, run rotateKey, then makeConnectLink again.
 */

const CONFIG = {
  FOLDER_ID: '12UEqfv72GyZh4vf75MHub5bUySXlv8PX',
  STATE_FILE: 'mailhub_state.json',
  TASKS_FILE: 'mailhub_tasks.json',
  TASK_OPS_PREFIX: 'mailhub-taskops_',
  TASK_DONE_KEEP_DAYS: 60, // finished tasks older than this are dropped
  WEBAPP_URL: 'PASTE_WEB_APP_URL_HERE',
  APP_URL: 'https://abhimanyu5100.github.io/mail-hub-app/',
  DAYS: 14,          // how many days of export files to serve
  STATE_KEEP_DAYS: 75 // marks older than this are dropped from the state file
};

const KEY_PROP = 'MAILHUB_KEY';
const FILE_RE = /^(\d{4}-\d{2}-\d{2})_([a-z0-9_-]+)\.json$/i;

/* ---------- Web app entry points ---------- */

function doGet() {
  return json_({ ok: true, app: 'mail-hub-api', note: 'Use POST.' });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e && e.postData && e.postData.contents || '{}');
  } catch (err) {
    return json_({ ok: false, error: 'bad_request', message: 'Body is not JSON.' });
  }
  if (!keyMatches_(req.key)) {
    return json_({ ok: false, error: 'bad_key', message: 'This device key is not valid.' });
  }
  try {
    if (req.action === 'sync') return json_(sync_(req));
    return json_({ ok: false, error: 'unknown_action', message: String(req.action) });
  } catch (err) {
    return json_({ ok: false, error: 'server', message: String(err && err.message || err) });
  }
}

/* ---------- Actions ---------- */

/**
 * req.have: { fileId: modifiedISO } for files the device already has.
 * req.ops:  [{ id, field: 'done'|'seen', value: true|false, at: ISO }]
 * req.taskOps: task changes from this device (see applyTaskOp_).
 * Returns every current export file; `messages` is filled only for files the
 * device doesn't have or that changed since.
 */
function sync_(req) {
  const folder = DriveApp.getFolderById(CONFIG.FOLDER_ID);
  const state = Array.isArray(req.ops) && req.ops.length
    ? applyOps_(folder, req.ops)
    : readState_(folder).data;

  const have = req.have && typeof req.have === 'object' ? req.have : {};
  const cutoff = new Date(Date.now() - CONFIG.DAYS * 86400000);
  const cutoffDay = Utilities.formatDate(cutoff, 'Asia/Kolkata', 'yyyy-MM-dd');

  const files = [];
  const opFiles = [];
  const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (f.isTrashed()) continue;
    if (f.getName().indexOf(CONFIG.TASK_OPS_PREFIX) === 0) { opFiles.push(f); continue; }
    const m = FILE_RE.exec(f.getName());
    if (!m || m[1] < cutoffDay) continue;

    const entry = {
      id: f.getId(),
      name: f.getName(),
      day: m[1],
      account: m[2],
      modified: f.getLastUpdated().toISOString(),
      messages: null
    };
    if (have[entry.id] !== entry.modified) {
      try {
        const data = JSON.parse(f.getBlob().getDataAsString('UTF-8'));
        entry.account = data.account || entry.account;
        entry.email = data.email || '';
        entry.generatedAt = data.generatedAt || '';
        entry.messages = Array.isArray(data.messages) ? data.messages : [];
      } catch (err) {
        entry.error = 'Could not read this file: ' + err.message;
      }
    }
    files.push(entry);
  }

  const tasks = applyTaskOps_(folder, opFiles, Array.isArray(req.taskOps) ? req.taskOps : []);
  return { ok: true, now: new Date().toISOString(), files: files, state: state, tasks: tasks };
}

/* ---------- Tasks ---------- */

function emptyTasks_() {
  return { version: 1, updatedAt: null, tasks: {}, applied: [] };
}

function readTasks_(folder) {
  const it = folder.getFilesByName(CONFIG.TASKS_FILE);
  while (it.hasNext()) {
    const f = it.next();
    if (f.isTrashed()) continue;
    try {
      const data = JSON.parse(f.getBlob().getDataAsString('UTF-8'));
      data.tasks = data.tasks || {};
      data.applied = Array.isArray(data.applied) ? data.applied : [];
      return { file: f, data: data };
    } catch (err) {
      return { file: f, data: emptyTasks_() };
    }
  }
  return { file: null, data: emptyTasks_() };
}

/** Merges task changes from op files and from Mail Hub, then trashes the op files. */
function applyTaskOps_(folder, opFiles, extraOps) {
  if (!opFiles.length && !extraOps.length) return readTasks_(folder).data;

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const current = readTasks_(folder);
    const store = current.data;
    const ops = extraOps.slice();
    opFiles.forEach(function (f) {
      try {
        const d = JSON.parse(f.getBlob().getDataAsString('UTF-8'));
        (Array.isArray(d.ops) ? d.ops : []).forEach(function (op) { ops.push(op); });
      } catch (err) { /* unreadable op files are dropped */ }
    });
    ops.sort(function (a, b) { return String(a && a.at).localeCompare(String(b && b.at)); });

    const seen = {};
    store.applied.forEach(function (id) { seen[id] = true; });
    ops.forEach(function (op) {
      if (!op || typeof op.opId !== 'string' || seen[op.opId]) return;
      applyTaskOp_(store, op);
      seen[op.opId] = true;
      store.applied.push(op.opId);
    });
    store.applied = store.applied.slice(-500);

    const oldest = new Date(Date.now() - CONFIG.TASK_DONE_KEEP_DAYS * 86400000).toISOString();
    Object.keys(store.tasks).forEach(function (id) {
      const t = store.tasks[id];
      if (t.done && t.doneAt && t.doneAt < oldest) delete store.tasks[id];
    });

    store.version = 1;
    store.updatedAt = new Date().toISOString();
    const text = JSON.stringify(store);
    if (current.file) current.file.setContent(text);
    else folder.createFile(CONFIG.TASKS_FILE, text, 'application/json');
    opFiles.forEach(function (f) { f.setTrashed(true); });
    return store;
  } finally {
    lock.releaseLock();
  }
}

/**
 * op: { opId, at: ISO, type: 'add'|'update'|'delete', id, source, fields }
 * Later changes win: an update older than the task's last change is ignored.
 */
function applyTaskOp_(store, op) {
  const id = String(op.id || '').slice(0, 80);
  if (!id) return;
  const at = String(op.at || new Date().toISOString());
  const t = store.tasks[id];
  if (op.type === 'add') {
    if (t) return;
    const task = { id: id, title: 'Untitled task', due: null, done: false, doneAt: null,
                   createdAt: at, updatedAt: at, source: String(op.source || '').slice(0, 30) };
    cleanTaskFields_(task, op.fields || {}, at);
    store.tasks[id] = task;
  } else if (op.type === 'update') {
    if (!t || (t.updatedAt && at < t.updatedAt)) return;
    cleanTaskFields_(t, op.fields || {}, at);
    t.updatedAt = at;
  } else if (op.type === 'delete') {
    delete store.tasks[id];
  }
}

function cleanTaskFields_(task, f, at) {
  if (typeof f.title === 'string' && f.title.trim()) task.title = f.title.trim().slice(0, 200);
  if ('due' in f) task.due = /^\d{4}-\d{2}-\d{2}$/.test(f.due) ? f.due : null;
  if ('done' in f) { task.done = !!f.done; task.doneAt = f.done ? at : null; }
  if (typeof f.note === 'string') task.note = f.note.slice(0, 1000);
  if (typeof f.mailId === 'string') task.mailId = f.mailId.slice(0, 120);
  if (typeof f.mailSubject === 'string') task.mailSubject = f.mailSubject.slice(0, 200);
  if (typeof f.account === 'string') task.account = f.account.slice(0, 30);
  if (typeof f.mailLink === 'string' && f.mailLink.indexOf('https://mail.google.com/') === 0) {
    task.mailLink = f.mailLink.slice(0, 500);
  }
}

/** Trigger target: merges Pocket Ledger's task changes without Mail Hub open. */
function ingestTaskOps() {
  const folder = DriveApp.getFolderById(CONFIG.FOLDER_ID);
  const opFiles = [];
  const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (!f.isTrashed() && f.getName().indexOf(CONFIG.TASK_OPS_PREFIX) === 0) opFiles.push(f);
  }
  if (opFiles.length) applyTaskOps_(folder, opFiles, []);
}

/** Run once from the editor. Replaces any existing ingestTaskOps trigger. */
function setupTaskTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'ingestTaskOps') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('ingestTaskOps').timeBased().everyMinutes(10).create();
  ingestTaskOps();
  Logger.log('Task merge runs every 10 minutes.');
}

/* ---------- State file ---------- */

function emptyState_() {
  return { version: 1, updatedAt: null, done: {}, seen: {} };
}

function readState_(folder) {
  const it = folder.getFilesByName(CONFIG.STATE_FILE);
  while (it.hasNext()) {
    const f = it.next();
    if (f.isTrashed()) continue;
    try {
      const data = JSON.parse(f.getBlob().getDataAsString('UTF-8'));
      data.done = data.done || {};
      data.seen = data.seen || {};
      return { file: f, data: data };
    } catch (err) {
      // A broken state file is replaced on the next write.
      return { file: f, data: emptyState_() };
    }
  }
  return { file: null, data: emptyState_() };
}

function applyOps_(folder, ops) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const current = readState_(folder);
    const state = current.data;

    ops.forEach(function (op) {
      if (!op || typeof op.id !== 'string') return;
      if (op.field !== 'done' && op.field !== 'seen') return;
      if (op.value) state[op.field][op.id] = op.at || new Date().toISOString();
      else delete state[op.field][op.id];
    });

    const oldest = new Date(Date.now() - CONFIG.STATE_KEEP_DAYS * 86400000).toISOString();
    ['done', 'seen'].forEach(function (field) {
      Object.keys(state[field]).forEach(function (id) {
        if (state[field][id] < oldest) delete state[field][id];
      });
    });

    state.version = 1;
    state.updatedAt = new Date().toISOString();
    const text = JSON.stringify(state);
    if (current.file) current.file.setContent(text);
    else folder.createFile(CONFIG.STATE_FILE, text, 'application/json');
    return state;
  } finally {
    lock.releaseLock();
  }
}

/* ---------- Device key ---------- */

function keyMatches_(given) {
  const key = PropertiesService.getScriptProperties().getProperty(KEY_PROP);
  if (!key || typeof given !== 'string' || given.length !== key.length) return false;
  let diff = 0;
  for (let i = 0; i < key.length; i++) diff |= key.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

function getOrCreateKey_() {
  const props = PropertiesService.getScriptProperties();
  let key = props.getProperty(KEY_PROP);
  if (!key) {
    key = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    props.setProperty(KEY_PROP, key);
  }
  return key;
}

/** Run from the editor. Logs the link that connects a device to this script. */
function makeConnectLink() {
  if (CONFIG.WEBAPP_URL.indexOf('PASTE_') === 0) {
    throw new Error('Deploy as a web app first, then paste its URL into CONFIG.WEBAPP_URL.');
  }
  const code = Utilities.base64EncodeWebSafe(
    JSON.stringify({ u: CONFIG.WEBAPP_URL, k: getOrCreateKey_() })
  ).replace(/=+$/, '');
  Logger.log('Open this on each device:\n' + CONFIG.APP_URL + '#connect=' + code);
  Logger.log('Or paste just this code into the app:\n' + code);
}

/** Run from the editor to disconnect every device. Then run makeConnectLink. */
function rotateKey() {
  PropertiesService.getScriptProperties().deleteProperty(KEY_PROP);
  getOrCreateKey_();
  Logger.log('New key created. Every device must reconnect with a new link.');
}

/** Run from the editor to check the folder and state file can be read. */
function selfTest() {
  const res = sync_({ have: {}, ops: [] });
  const counts = {};
  res.files.forEach(function (f) {
    counts[f.account] = (counts[f.account] || 0) + (f.messages ? f.messages.length : 0);
  });
  Logger.log(res.files.length + ' files. Messages per account: ' + JSON.stringify(counts));
  Logger.log('Marks: ' + Object.keys(res.state.done).length + ' done, ' +
             Object.keys(res.state.seen).length + ' seen.');
  Logger.log('Tasks: ' + Object.keys(res.tasks.tasks).length + '.');
}

/* ---------- Helpers ---------- */

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
