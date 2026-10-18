'use strict';

/* ======================================================================
   Mail Hub
   Reads the three accounts' exports through the Mail Hub API script and
   keeps done / seen marks in mailhub_state.json in the same Drive folder.
   ====================================================================== */

const ACCOUNTS = {
  college:   { name: 'College',  letter: 'C' },
  personal:  { name: 'Main',     letter: 'M' },
  personal2: { name: 'Personal', letter: 'P' },
};
const ACCOUNT_ORDER = ['college', 'personal', 'personal2'];
const KEEP_DAYS = 16;            // local cache keeps this many days of mail
const STALE_MINUTES = 45;        // an export older than this gets flagged
const AUTO_SYNC_MINUTES = 3;     // sync when the app is reopened after this long
const KEYS = { conn: 'mh.conn', cache: 'mh.cache.v1', pending: 'mh.pending.v1', taskPending: 'mh.taskpending.v1' };

const S = {
  conn: null,            // { u: web app URL, k: device key }
  demo: false,
  mails: new Map(),      // id -> mail
  files: {},             // fileId -> { name, account, day, modified, generatedAt }
  state: { done: {}, seen: {} },
  pending: [],           // ops not yet acknowledged by the script
  lastSync: null,
  syncing: false,
  error: null,           // { kind, text }
  filter: 'all',
  query: '',
  selected: null,
  showDone: new Set(),   // dayKeys with done mail revealed
  openAuto: new Set(),   // dayKeys with automated mail expanded
  undo: null,
  view: 'mail',          // mail | tasks
  tasks: {},             // id -> task, shared with Pocket Ledger through mailhub_tasks.json
  taskPending: [],       // task ops not yet acknowledged by the script
  tasksUpdatedAt: null,
  showDoneTasks: false,
  editing: null,         // { id } or { mail } for the task dialog
};

const $ = (id) => document.getElementById(id);
const coarse = matchMedia('(pointer: coarse)');
const narrow = matchMedia('(max-width: 899px)');

/* ---------- Small DOM helper (never uses innerHTML) ---------- */
function h(tag, props, ...kids) {
  const node = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'style') node.style.cssText = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else node.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
}
const SVG_NS = 'http://www.w3.org/2000/svg';
function icon(paths, cls = 'i') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '1.6');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    svg.append(p);
  }
  return svg;
}
const ICON_CLIP = ['M13.5 9.5 9 14a3 3 0 0 1-4.2-4.2l5.3-5.3a2 2 0 0 1 2.8 2.8L7.6 12.6a1 1 0 0 1-1.4-1.4l4.6-4.6'];
const ICON_CHEV = ['M5 8l5 5 5-5'];
const ICON_CHECK = ['M4.5 10.5l3.5 3.5 7.5-8'];
const ICON_TASK = ['M3.5 4.5h3v3h-3z', 'M9.5 6h7', 'M3.5 12.5h3v3h-3z', 'M9.5 14h7'];

function accInfo(acc) { return ACCOUNTS[acc] || { name: acc, letter: (acc || '?')[0].toUpperCase() }; }
function tabEl(acc) {
  const info = accInfo(acc);
  return h('span', { class: 'tab', 'data-acc': acc, title: info.name, 'aria-hidden': 'true' }, info.letter);
}

/* ---------- Storage ---------- */
function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { return false; }
}
function saveCache() {
  if (S.demo) return;
  save(KEYS.cache, {
    mails: [...S.mails.values()], files: S.files, state: S.state, lastSync: S.lastSync,
    tasks: S.tasks, tasksUpdatedAt: S.tasksUpdatedAt,
  });
}
function savePending() {
  if (S.demo) return;
  save(KEYS.pending, S.pending);
  save(KEYS.taskPending, S.taskPending);
}

function restoreCache() {
  const c = load(KEYS.cache, null);
  if (c) {
    S.mails = new Map((c.mails || []).map((m) => [m.id, m]));
    S.files = c.files || {};
    S.state = c.state || { done: {}, seen: {} };
    S.lastSync = c.lastSync || null;
    S.tasks = c.tasks || {};
    S.tasksUpdatedAt = c.tasksUpdatedAt || null;
  }
  S.pending = load(KEYS.pending, []);
  for (const op of S.pending) applyOp(op);
  S.taskPending = load(KEYS.taskPending, []);
  for (const op of S.taskPending) applyTaskOp(op);
}

/* ---------- Connection ---------- */
function decodeConnection(raw) {
  let code = String(raw || '').trim();
  const at = code.indexOf('#connect=');
  if (at >= 0) code = code.slice(at + 9);
  code = code.replace(/\s+/g, '');
  if (!code) return null;
  try {
    const b64 = code.replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const obj = JSON.parse(json);
    if (typeof obj.u !== 'string' || typeof obj.k !== 'string') return null;
    const url = new URL(obj.u);
    if (url.protocol !== 'https:' || url.hostname !== 'script.google.com') return null;
    return { u: url.href, k: obj.k };
  } catch { return null; }
}

/* ---------- Mail model ---------- */
const AUTO_SENDER = /(^|[._+-])(no-?reply|do-?not-?reply|notifications?|notify|alerts?|mailer|mailer-daemon|bounces?|updates?|news|newsletters?|digest|marketing|promo|offers?|info|hello|team|support|accounts?|security|billing|receipts?)([._+-]|$)/i;

function parseFrom(from) {
  const s = String(from || '').trim();
  const m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || m[2].trim(), email: m[2].trim().toLowerCase() };
  return { name: s, email: s.toLowerCase() };
}
function localDayKey(d) {
  const y = d.getFullYear(), mo = String(d.getMonth() + 1).padStart(2, '0'), da = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}
function isAutomated(email, body, starred) {
  if (starred) return false;
  const local = email.split('@')[0] || '';
  return AUTO_SENDER.test(local) || /\bunsubscribe\b/i.test(body || '');
}
function normalize(m, file) {
  const account = file.account;
  const from = parseFrom(m.from);
  const date = new Date(m.date || Date.now());
  const body = String(m.body || '');
  return {
    id: `${account}_${m.id}`,
    account,
    threadId: m.threadId || '',
    date: date.toISOString(),
    dayKey: localDayKey(date),
    fromName: from.name, fromEmail: from.email,
    fromMe: !!m.fromMe,
    to: m.to || '', cc: m.cc || '',
    subject: (m.subject || '').trim() || '(no subject)',
    body,
    preview: body.replace(/\s+/g, ' ').trim().slice(0, 220),
    unread: !!m.unread, starred: !!m.starred, important: !!m.important,
    attachments: Array.isArray(m.attachments) ? m.attachments : [],
    files: Array.isArray(m.files) ? m.files.filter((f) => f && typeof f.name === 'string').map((f) => ({
      name: f.name, size: Number(f.size) || 0, skipped: f.skipped || '',
      driveId: typeof f.driveId === 'string' && /^[\w-]{10,}$/.test(f.driveId) ? f.driveId : '',
    })) : [],
    link: typeof m.link === 'string' && m.link.startsWith('https://mail.google.com/') ? m.link : '',
    auto: isAutomated(from.email, body, m.starred),
  };
}
const isDone = (m) => !!S.state.done[m.id];
const isNew = (m) => m.unread && !S.state.seen[m.id] && !isDone(m);

function applyFiles(files) {
  const present = {};
  for (const f of files) {
    present[f.id] = {
      name: f.name, account: f.account, day: f.day, modified: f.modified,
      generatedAt: f.generatedAt || (S.files[f.id] && S.files[f.id].generatedAt) || '',
    };
    if (Array.isArray(f.messages)) {
      for (const raw of f.messages) {
        const m = normalize(raw, f);
        S.mails.set(m.id, m);
      }
    }
  }
  S.files = present;
  pruneMails();
}
function pruneMails() {
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  for (const [id, m] of S.mails) if (Date.parse(m.date) < cutoff) S.mails.delete(id);
}

/* ---------- Marks ---------- */
function applyOp(op) {
  const bag = S.state[op.field] || (S.state[op.field] = {});
  if (op.value) bag[op.id] = op.at; else delete bag[op.id];
}
function setFlag(ids, field, value) {
  const at = new Date().toISOString();
  for (const id of ids) {
    const op = { id, field, value, at };
    applyOp(op);
    S.pending = S.pending.filter((p) => !(p.id === id && p.field === field));
    S.pending.push(op);
  }
  savePending();
  saveCache();
  scheduleFlush();
}
let flushTimer = 0;
function scheduleFlush() {
  if (S.demo) return;
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => sync({ quiet: true }), 900);
}

/* ---------- Tasks ----------
   Same rules as the script's applyTaskOp_, so a change shows at once and
   still merges correctly with changes made in Pocket Ledger. */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
function applyTaskOp(op) {
  const t = S.tasks[op.id];
  const f = op.fields || {};
  if (op.type === 'add') {
    if (t) return;
    S.tasks[op.id] = { id: op.id, title: 'Untitled task', due: null, done: false, doneAt: null,
      createdAt: op.at, updatedAt: op.at, source: op.source || '', ...f, ...(f.done ? { doneAt: op.at } : {}) };
  } else if (op.type === 'update') {
    if (!t || (t.updatedAt && op.at < t.updatedAt)) return;
    Object.assign(t, f, { updatedAt: op.at });
    if ('done' in f) t.doneAt = f.done ? op.at : null;
  } else if (op.type === 'delete') {
    delete S.tasks[op.id];
  }
}
function taskOp(type, id, fields) {
  const op = { opId: uid(), at: new Date().toISOString(), type, id, source: 'mailhub', fields: fields || {} };
  applyTaskOp(op);
  S.taskPending.push(op);
  savePending();
  saveCache();
  scheduleFlush();
  return op;
}
function taskForMail(mailId) {
  return Object.values(S.tasks).find((t) => t.mailId === mailId) || null;
}
function openTaskCount() {
  return Object.values(S.tasks).filter((t) => !t.done).length;
}

/* ---------- Network ---------- */
class ApiError extends Error {
  constructor(kind, text) { super(text); this.kind = kind; }
}
async function api(payload) {
  let res;
  try {
    res = await fetch(S.conn.u, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...payload, key: S.conn.k }),
      cache: 'no-store',
      redirect: 'follow',
    });
  } catch {
    throw new ApiError('network', navigator.onLine
      ? 'Couldn’t reach the Mail Hub script. Check that its deployment gives access to Anyone.'
      : 'You’re offline. Showing the mail saved on this device.');
  }
  if (!res.ok) throw new ApiError('http', `The script answered with HTTP ${res.status}.`);
  let data;
  try { data = await res.json(); }
  catch { throw new ApiError('format', 'The script didn’t answer with mail data. Check that you deployed it as a web app.'); }
  if (!data.ok) {
    if (data.error === 'bad_key') throw new ApiError('key', 'The script rejected this device’s key. Run makeConnectLink and connect again.');
    throw new ApiError('server', data.message ? `The script failed: ${data.message}` : 'The script failed.');
  }
  return data;
}

async function sync({ quiet = false } = {}) {
  if (S.demo || !S.conn) return;
  if (S.syncing) { S.again = true; return; }
  S.syncing = true;
  renderSync();
  const ops = S.pending.slice();
  const taskOps = S.taskPending.slice();
  const have = {};
  for (const [id, f] of Object.entries(S.files)) have[id] = f.modified;
  try {
    const data = await api({ action: 'sync', have, ops, taskOps });
    S.pending = S.pending.filter((p) => !ops.includes(p));
    S.taskPending = S.taskPending.filter((p) => !taskOps.includes(p));
    if (data.tasks) {
      S.tasks = data.tasks.tasks || {};
      S.tasksUpdatedAt = data.tasks.updatedAt || null;
      for (const op of S.taskPending) applyTaskOp(op);
    }
    applyFiles(data.files || []);
    S.state = data.state || { done: {}, seen: {} };
    S.state.done = S.state.done || {};
    S.state.seen = S.state.seen || {};
    for (const op of S.pending) applyOp(op);
    S.lastSync = data.now || new Date().toISOString();
    S.error = null;
    savePending();
    saveCache();
  } catch (e) {
    S.error = { kind: e.kind || 'network', text: e.message };
    if (!quiet && e.kind !== 'network') console.warn(e);
  } finally {
    S.syncing = false;
    render();
    if (S.again) { S.again = false; sync({ quiet: true }); }
  }
}

/* ---------- Time formatting ---------- */
const fmtTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const fmtDay = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });
const fmtShortDay = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const fmtFull = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

function dayLabel(key) {
  const today = localDayKey(new Date());
  const y = new Date(); y.setDate(y.getDate() - 1);
  if (key === today) return 'Today';
  if (key === localDayKey(y)) return 'Yesterday';
  const [yy, mm, dd] = key.split('-').map(Number);
  return fmtDay.format(new Date(yy, mm - 1, dd));
}
function relTime(iso) {
  if (!iso) return 'never';
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const sameDay = localDayKey(d) === localDayKey(new Date());
  return sameDay ? fmtTime.format(d) : `${fmtShortDay.format(d)}, ${fmtTime.format(d)}`;
}

/* ---------- Selection of what to show ---------- */
function matchesQuery(m, q) {
  if (!q) return true;
  const hay = `${m.fromName} ${m.fromEmail} ${m.subject} ${m.body}`.toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}
function visibleMails() {
  const q = S.query.trim().toLowerCase();
  return [...S.mails.values()]
    .filter((m) => !m.fromMe)
    .filter((m) => S.filter === 'all' || m.account === S.filter)
    .filter((m) => matchesQuery(m, q))
    .sort((a, b) => b.date.localeCompare(a.date));
}
function openCount(acc) {
  let n = 0;
  for (const m of S.mails.values()) {
    if (m.fromMe || isDone(m)) continue;
    if (acc === 'all' || m.account === acc) n++;
  }
  return n;
}

/* Order of rows as the keyboard and "next" see them */
let rowOrder = [];

/* ---------- Rendering ---------- */
function render() {
  const connected = S.demo || !!S.conn;
  $('setup').hidden = connected;
  $('app').hidden = !connected;
  if (!connected) return;
  renderAccounts();
  renderSync();
  renderBanner();
  renderList();
  renderReader();
}

function renderAccounts() {
  const box = $('accounts');
  const accs = [...ACCOUNT_ORDER];
  for (const m of S.mails.values()) if (!accs.includes(m.account)) accs.push(m.account);
  const btn = (acc, label, lead) => h('button', {
    type: 'button', class: 'acc-btn', 'aria-pressed': String(S.view === 'mail' && S.filter === acc),
    onclick: () => setFilter(acc),
  }, lead, h('span', { class: 'lbl' }, label, h('span', { class: 'n' }, String(openCount(acc)))));
  const allGlyph = h('span', { class: 'all-glyph', 'aria-hidden': 'true' },
    ACCOUNT_ORDER.map((a) => h('span', { 'data-acc': a })));
  box.replaceChildren(
    btn('all', 'All', allGlyph),
    ...accs.map((a) => btn(a, accInfo(a).name, tabEl(a))),
    tasksButton('in-nav'),
  );
  $('tasks-slot').replaceChildren(tasksButton('in-head'));
}

function tasksButton(where) {
  return h('button', {
    type: 'button', class: `acc-btn is-tasks ${where}`, 'aria-pressed': String(S.view === 'tasks'),
    onclick: () => setView(S.view === 'tasks' ? 'mail' : 'tasks'),
  }, h('span', { class: 'task-glyph', 'aria-hidden': 'true' }, icon(ICON_TASK)),
    h('span', { class: 'lbl' }, 'Tasks', h('span', { class: 'n' }, String(openTaskCount()))));
}
function setView(view) {
  S.view = view;
  render();
  $('list-scroll').scrollTop = 0;
}
function setFilter(acc) {
  S.view = 'mail';
  S.filter = acc;
  if (S.selected && acc !== 'all' && S.mails.get(S.selected)?.account !== acc) S.selected = null;
  render();
  $('list-scroll').scrollTop = 0;
}

function renderSync() {
  const b = $('sync-btn');
  let label, state = 'idle';
  if (S.demo) label = 'Sample mail';
  else if (S.syncing) { label = 'Syncing'; state = 'busy'; }
  else if (S.error && S.error.kind === 'network' && !navigator.onLine) { label = 'Offline'; state = 'error'; }
  else if (S.error) { label = 'Sync failed'; state = 'error'; }
  else label = S.lastSync ? `Synced ${relTime(S.lastSync)}` : 'Not synced';
  $('sync-label').textContent = label;
  b.dataset.state = state;
}

function renderBanner() {
  const el = $('banner');
  if (S.demo) {
    el.hidden = false; el.dataset.kind = 'info';
    el.replaceChildren('Sample mail. Nothing here is real or saved.',
      h('button', { type: 'button', class: 'link-btn', onclick: leaveDemo }, 'Leave'));
    return;
  }
  if (S.error && S.error.kind !== 'network') {
    el.hidden = false; el.dataset.kind = 'error';
    el.replaceChildren(S.error.text);
    return;
  }
  if (S.error && !navigator.onLine) {
    el.hidden = false; el.dataset.kind = 'info';
    el.replaceChildren(`You’re offline. Showing mail saved on this device${S.lastSync ? ' at ' + relTime(S.lastSync) : ''}.`);
    return;
  }
  el.hidden = true;
}

function renderList() {
  const list = $('list');
  rowOrder = [];
  teardownSwipes();
  $('search').closest('.search').hidden = S.view === 'tasks';
  if (S.view === 'tasks') { list.replaceChildren(...taskViewNodes()); return; }
  const mails = visibleMails();
  if (!mails.length) {
    list.replaceChildren(emptyList());
    return;
  }
  const byDay = new Map();
  for (const m of mails) {
    if (!byDay.has(m.dayKey)) byDay.set(m.dayKey, []);
    byDay.get(m.dayKey).push(m);
  }
  const searching = !!S.query.trim();
  const sections = [];
  for (const [day, all] of byDay) sections.push(daySection(day, all, searching));
  list.replaceChildren(...sections);
  if (coarse.matches) setupSwipes(list);
}

function emptyList() {
  if (S.query.trim()) {
    return h('div', { class: 'list-empty' },
      h('h2', { text: 'No mail matches' }),
      h('p', { text: `Nothing from the last ${KEEP_DAYS} days has “${S.query.trim()}” in the sender, subject or text.` }));
  }
  if (!S.mails.size) {
    return h('div', { class: 'list-empty' },
      h('h2', { text: S.syncing ? 'Getting your mail' : 'No mail yet' }),
      h('p', { text: S.syncing
        ? 'The first sync reads every export in the Mail Hub folder, so it takes a few seconds.'
        : 'Nothing has synced to this device yet. Tap the sync button above to try again.' }));
  }
  return h('div', { class: 'list-empty' },
    h('h2', { text: `Nothing from ${accInfo(S.filter).name}` }),
    h('p', { text: `No mail from this account in the last ${KEEP_DAYS} days.` }));
}

function daySection(day, all, searching) {
  const open = all.filter((m) => !isDone(m));
  const done = all.filter(isDone);
  const showDone = searching || S.showDone.has(day);

  // Strip: oldest first, one tick per mail.
  const ticks = all.slice().reverse().map((m) =>
    h('span', { class: `tick${isDone(m) ? ' is-done' : ''}`, 'data-acc': m.account }));

  const title = h('h2', { class: 'day-title' }, dayLabel(day),
    h('span', { class: 'left' }, open.length ? `${open.length} open` : 'Cleared'));
  const toggle = done.length && !searching
    ? h('button', {
        type: 'button', class: 'day-toggle', 'aria-expanded': String(showDone),
        onclick: () => { S.showDone.has(day) ? S.showDone.delete(day) : S.showDone.add(day); renderList(); },
      }, showDone ? 'Hide done' : `Show ${done.length} done`)
    : h('span');
  const head = h('header', { class: 'day-head' }, title, toggle,
    h('div', { class: 'strip', role: 'img', 'aria-label': `${all.length} mails, ${done.length} done` }, ticks));

  const section = h('section', { class: 'day', 'aria-label': dayLabel(day) }, head);

  if (searching) {
    section.append(rowsList(all));
    return section;
  }

  const people = open.filter((m) => !m.auto);
  const auto = open.filter((m) => m.auto);
  if (people.length) section.append(rowsList(people));
  if (auto.length) section.append(autoFold(day, auto));
  if (showDone && done.length) section.append(rowsList(done));
  return section;
}

function rowsList(mails) {
  return h('ul', { class: 'rows' }, mails.map(rowEl));
}

function rowEl(m) {
  rowOrder.push(m.id);
  const done = isDone(m);
  const cls = ['row', isNew(m) && 'is-new', done && 'is-done'].filter(Boolean).join(' ');
  const main = h('button', {
    type: 'button', class: 'row-main', 'data-id': m.id,
    'aria-current': String(S.selected === m.id),
    onclick: () => openMail(m.id),
  },
    tabEl(m.account),
    h('span', { class: 'who' }, m.fromName),
    h('time', { class: 'when', datetime: m.date }, fmtTime.format(new Date(m.date))),
    h('span', { class: 'subj' }, m.attachments.length ? icon(ICON_CLIP, 'clip') : null, m.subject),
    m.preview ? h('span', { class: 'snip' }, m.preview) : null,
  );
  return h('li', { class: cls, 'data-id': m.id, 'data-done': String(done) }, h('div', { class: 'track' }, main));
}

function autoFold(day, auto) {
  const expanded = S.openAuto.has(day);
  const senders = [];
  for (const m of auto) {
    const n = shortSender(m);
    if (!senders.includes(n)) senders.push(n);
  }
  const named = senders.slice(0, 3);
  const rest = senders.length - named.length;
  const who = rest > 0 ? `${named.join(', ')} and ${rest} more` : listJoin(named);
  const accs = ACCOUNT_ORDER.filter((a) => auto.some((m) => m.account === a));
  const stack = h('span', { class: 'auto-stack', 'aria-hidden': 'true' },
    accs.map((a) => h('span', { 'data-acc': a })));

  const toggle = h('button', {
    type: 'button', class: 'auto-toggle', 'aria-expanded': String(expanded),
    onclick: () => { expanded ? S.openAuto.delete(day) : S.openAuto.add(day); renderList(); },
  }, stack,
    h('span', { class: 'auto-text' }, h('b', null, `${auto.length} automated`), ` from ${who}`),
    icon(ICON_CHEV, 'auto-chev'));

  const wrap = h('div', { class: 'auto' }, toggle);
  if (expanded) {
    wrap.append(h('div', { class: 'auto-body' },
      rowsList(auto),
      h('div', { class: 'auto-foot' },
        h('button', {
          type: 'button', class: 'btn btn-quiet',
          onclick: () => markDone(auto.map((m) => m.id), `${auto.length} automated mails marked done.`),
        }, `Mark these ${auto.length} done`))));
  }
  return wrap;
}
function shortSender(m) {
  let n = m.fromName || m.fromEmail;
  n = n.replace(/\s*(via|from)\s.*$/i, '').replace(/\s+(team|notifications?|alerts?)$/i, '').trim();
  return n.length > 22 ? n.slice(0, 21) + '…' : n;
}
function listJoin(a) {
  if (a.length <= 1) return a.join('');
  return `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
}

/* ---------- Task list ---------- */
function dueInfo(due) {
  if (!due) return { group: 'later', label: '' };
  const today = localDayKey(new Date());
  const tm = new Date(); tm.setDate(tm.getDate() + 1);
  const [y, m, d] = due.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  if (due < today) return { group: 'late', label: `Was due ${fmtShortDay.format(date)}`, late: true };
  if (due === today) return { group: 'today', label: 'Due today' };
  if (due === localDayKey(tm)) return { group: 'soon', label: 'Due tomorrow' };
  return { group: 'soon', label: `Due ${fmtDay.format(date)}` };
}
function taskViewNodes() {
  const title = h('input', { type: 'text', id: 'task-quick', placeholder: 'Add a task', 'aria-label': 'New task', maxlength: '200', enterkeyhint: 'done' });
  const due = h('input', { type: 'date', 'aria-label': 'Due date' });
  const add = () => {
    const text = title.value.trim();
    if (!text) { title.focus(); return; }
    taskOp('add', uid(), { title: text, due: due.value || null });
    render();
    document.getElementById('task-quick')?.focus();
  };
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); add(); } });
  const form = h('div', { class: 'task-add' }, title, due, h('button', { type: 'button', class: 'btn btn-primary', onclick: add }, 'Add'));

  const all = Object.values(S.tasks);
  const open = all.filter((t) => !t.done);
  const done = all.filter((t) => t.done).sort((a, b) => String(b.doneAt).localeCompare(String(a.doneAt)));
  const byGroup = { late: [], today: [], soon: [], later: [] };
  for (const t of open) byGroup[dueInfo(t.due).group].push(t);
  for (const g of Object.values(byGroup)) {
    g.sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999') || String(a.createdAt).localeCompare(String(b.createdAt)));
  }
  const groups = [['late', 'Overdue'], ['today', 'Today'], ['soon', 'Coming up'], ['later', 'No date']]
    .filter(([k]) => byGroup[k].length)
    .map(([k, label]) => h('section', { class: `task-group${k === 'late' ? ' is-late' : ''}`, 'aria-label': label },
      h('h2', null, label, h('span', { class: 'left' }, String(byGroup[k].length))),
      h('ul', { class: 'rows' }, byGroup[k].map(taskRow))));

  const nodes = [form];
  if (!all.length) {
    nodes.push(h('div', { class: 'list-empty' },
      h('h2', { text: 'No tasks yet' }),
      h('p', { text: 'Add one here, from any mail with Add task, or from the Tasks panel in Pocket Ledger. All three share one list.' })));
    return nodes;
  }
  if (!open.length) nodes.push(h('div', { class: 'list-empty' }, h('h2', { text: 'Nothing left to do' })));
  nodes.push(...groups);
  if (done.length) {
    nodes.push(h('button', {
      type: 'button', class: 'day-toggle task-done-toggle', 'aria-expanded': String(S.showDoneTasks),
      onclick: () => { S.showDoneTasks = !S.showDoneTasks; renderList(); },
    }, S.showDoneTasks ? 'Hide finished tasks' : `Show ${done.length} finished`));
    if (S.showDoneTasks) nodes.push(h('section', { class: 'task-group' }, h('ul', { class: 'rows' }, done.map(taskRow))));
  }
  return nodes;
}
function taskRow(t) {
  const info = dueInfo(t.due);
  const mail = t.mailId && S.mails.get(t.mailId);
  const from = t.mailId
    ? (mail
        ? h('button', { type: 'button', class: 'from', onclick: () => { S.view = 'mail'; openMail(mail.id); render(); } },
            tabEl(mail.account), h('span', null, mail.subject))
        : h('span', { class: 'from' }, t.account ? tabEl(t.account) : null, h('span', null, t.mailSubject || 'From a mail')))
    : t.source === 'pocket-ledger' ? h('span', null, 'From Pocket Ledger') : null;
  return h('li', { class: `task${t.done ? ' is-done' : ''}` },
    h('button', {
      type: 'button', class: 'check', role: 'checkbox', 'aria-checked': String(!!t.done),
      'aria-label': `${t.done ? 'Reopen' : 'Finish'}: ${t.title}`,
      onclick: () => {
        const wasDone = !!t.done;
        taskOp('update', t.id, { done: !wasDone });
        render();
        if (!wasDone) showToast('Task finished.', () => { taskOp('update', t.id, { done: false }); render(); });
      },
    }, t.done ? icon(ICON_CHECK) : null),
    h('div', { class: 'task-body' },
      h('button', { type: 'button', class: 'task-title', onclick: () => openTaskDialog({ id: t.id }) }, t.title),
      (info.label || from) ? h('div', { class: 'task-meta' },
        info.label && !t.done ? h('span', { class: info.late ? 'late' : '' }, info.label) : null, from) : null));
}

function openTaskDialog(target) {
  S.editing = target;
  const d = $('task-dialog');
  const t = target.id ? S.tasks[target.id] : null;
  const mail = target.mail || null;
  $('task-dialog-title').textContent = t ? 'Edit task' : 'New task';
  $('task-title').value = t ? t.title : (mail ? mail.subject : '');
  $('task-due').value = t ? (t.due || '') : '';
  $('task-save').textContent = t ? 'Save' : 'Add task';
  $('task-delete-row').hidden = !t;
  const from = $('task-dialog-from');
  from.hidden = !mail;
  if (mail) from.textContent = `Linked to the mail from ${mail.fromName}.`;
  if (!d.open) d.showModal();
  $('task-title').focus();
  $('task-title').select();
}
function saveTaskDialog() {
  const target = S.editing;
  const title = $('task-title').value.trim();
  if (!target || !title) { $('task-title').focus(); return; }
  const due = $('task-due').value || null;
  if (target.id) {
    taskOp('update', target.id, { title, due });
  } else {
    const m = target.mail;
    taskOp('add', uid(), m
      ? { title, due, mailId: m.id, mailSubject: m.subject, account: m.account, ...(m.link ? { mailLink: m.link } : {}) }
      : { title, due });
    showToast('Task added.');
  }
  $('task-dialog').close();
  render();
}

/* ---------- Reader ---------- */
function renderReader() {
  const m = S.selected && S.mails.get(S.selected);
  $('mail').hidden = !m;
  $('reader-empty').hidden = !!m;
  if (!m) {
    if (!narrow.matches) $('reader-empty').replaceChildren(...overview().filter(Boolean));
    return;
  }
  $('mail-subject').textContent = m.subject;
  $('mail-from').replaceChildren(tabEl(m.account),
    h('span', { class: 'name' }, m.fromName),
    m.fromEmail !== m.fromName.toLowerCase() ? h('span', { class: 'addr' }, m.fromEmail) : null);
  $('mail-when').textContent = fmtFull.format(new Date(m.date));
  $('mail-to').textContent = `In your ${accInfo(m.account).name} inbox${m.cc ? `. Cc ${m.cc}` : ''}`;
  const files = $('mail-files');
  files.hidden = !m.attachments.length;
  files.replaceChildren(...attachmentNodes(m));
  $('mail-body').replaceChildren(...bodyNodes(m.body));
  const done = isDone(m);
  $('done-btn').textContent = done ? 'Move back to open' : 'Mark done';
  const linked = taskForMail(m.id);
  $('task-from-mail').textContent = linked ? (linked.done ? 'Task finished' : 'Task added') : 'Add task';
  const g = $('gmail-link');
  if (m.link) { g.href = m.link; g.hidden = false; } else { g.removeAttribute('href'); g.hidden = true; }
}

/* The overview fills the reader when nothing is open: the day's strip at full
   size (each tick opens its mail) and where the open mail sits by account. */
function overview() {
  const mails = visibleMails().filter((m) => !m.fromMe);
  if (!mails.length) {
    return [h('h2', { class: 'ov-title' }, 'No mail'),
      h('p', { class: 'ov-sub' }, S.mails.size ? 'Nothing matches this view.' : 'Nothing has synced yet.')];
  }
  const today = localDayKey(new Date());
  const day = mails.some((m) => m.dayKey === today) ? today : mails[0].dayKey;
  const dayMails = mails.filter((m) => m.dayKey === day).reverse();
  const open = dayMails.filter((m) => !isDone(m));
  const people = open.filter((m) => !m.auto).length;

  const parts = [];
  if (people) parts.push(`${people} from people`);
  if (open.length - people) parts.push(`${open.length - people} automated`);
  const sub = !open.length ? `All ${dayMails.length} done.`
    : `${open.length === dayMails.length ? open.length : `${open.length} of ${dayMails.length}`} open: ${listJoin(parts)}.`;

  const strip = h('div', { class: 'strip strip-lg', role: 'group', 'aria-label': `Mail from ${dayLabel(day).toLowerCase()}, oldest first` },
    dayMails.map((m) => h('button', {
      type: 'button', tabindex: '-1', class: `tick${isDone(m) ? ' is-done' : ''}`, 'data-acc': m.account,
      title: `${fmtTime.format(new Date(m.date))}  ${m.fromName}: ${m.subject}`,
      'aria-label': `${fmtTime.format(new Date(m.date))}, ${m.fromName}: ${m.subject}`,
      onclick: () => openMail(m.id),
    })));

  const accs = ACCOUNT_ORDER.filter((a) => S.filter === 'all' || a === S.filter);
  const rows = accs.map((a) => {
    const mine = [...S.mails.values()].filter((m) => m.account === a && !m.fromMe && !isDone(m))
      .sort((x, y) => y.date.localeCompare(x.date));
    const latest = mine[0];
    return h('li', null, h('button', {
      type: 'button', class: 'ov-acc', onclick: () => latest ? openMail(latest.id) : setFilter(a),
    }, tabEl(a), h('span', { class: 'nm' }, accInfo(a).name),
      h('span', null, mine.length ? `${mine.length} open` : 'Clear'),
      h('span', { class: 'latest' }, latest ? `Latest: ${latest.fromName}, ${relTime(latest.date)}` : '')));
  });

  const hint = coarse.matches && !matchMedia('(any-pointer: fine)').matches ? null
    : h('p', { class: 'ov-hint' }, 'Press ', h('kbd', null, 'j'), ' to start, ', h('kbd', null, 'e'), ' to mark done, ',
        h('kbd', null, 'u'), ' to undo, ', h('kbd', null, '/'), ' to search.');

  return [h('h2', { class: 'ov-title' }, dayLabel(day)), h('p', { class: 'ov-sub' }, sub), strip,
    h('h3', { class: 'ov-h' }, `Still open from the last ${KEEP_DAYS} days`),
    h('ul', { class: 'ov-accs' }, rows), hint];
}

const SKIP_NOTE = { too_large: 'too large to copy', next_run: 'copying soon', small_image: 'small image', error: 'couldn’t copy' };
function fmtSize(n) {
  if (!n) return '';
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}
function attachmentNodes(m) {
  const byName = new Map((m.files || []).map((f) => [f.name, f]));
  return m.attachments.map((name) => {
    const f = byName.get(name);
    if (f && f.driveId) {
      return h('li', null, h('a', {
        class: 'file-link', href: `https://drive.google.com/file/d/${f.driveId}/view`,
        target: '_blank', rel: 'noopener noreferrer', title: `Open ${name} in Google Drive`,
      }, icon(ICON_CLIP), h('span', null, name), f.size ? h('small', null, fmtSize(f.size)) : null));
    }
    const note = f && f.skipped ? SKIP_NOTE[f.skipped] : '';
    return h('li', { class: 'is-missing' }, icon(ICON_CLIP), h('span', null, name), note ? h('small', null, note) : null);
  });
}

const URL_RE = /\bhttps?:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?]/g;
function linkify(text) {
  const out = [];
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const href = match[0];
    out.push(h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, href));
    last = match.index + href.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
function bodyNodes(body) {
  const text = String(body || '').replace(/\r\n/g, '\n').trim();
  if (!text) return [h('p', { class: 'muted' }, 'This mail has no text. Open it in Gmail to see its content.')];
  return text.split(/\n{2,}/).map((para) => {
    const truncated = para.endsWith('...[truncated]');
    const clean = truncated ? para.slice(0, -'...[truncated]'.length).trimEnd() + '…' : para;
    const p = h('p', null, ...linkify(clean));
    if (truncated) p.append(h('span', { class: 'muted' }, ' The rest is in Gmail.'));
    return p;
  });
}

/* ---------- Actions ---------- */
function openMail(id, { focusReader = true } = {}) {
  const m = S.mails.get(id);
  if (!m) return;
  const wasNarrowReading = document.body.classList.contains('is-reading');
  S.selected = id;
  if (!S.state.seen[id] && m.unread) setFlag([id], 'seen', true);
  if (narrow.matches) {
    document.body.classList.add('is-reading');
    if (!wasNarrowReading) history.pushState({ reader: true }, '');
  }
  renderList();
  renderReader();
  $('mail-scroll').scrollTop = 0;
  if (focusReader && narrow.matches) $('reader').focus({ preventScroll: true });
  const row = document.querySelector(`.row-main[data-id="${CSS.escape(id)}"]`);
  if (row && !narrow.matches) row.scrollIntoView({ block: 'nearest' });
}
function closeReader() {
  if (!document.body.classList.contains('is-reading')) return;
  document.body.classList.remove('is-reading');
  const row = S.selected && document.querySelector(`.row-main[data-id="${CSS.escape(S.selected)}"]`);
  if (row) row.focus({ preventScroll: false });
}
function nextOpenAfter(id) {
  const i = rowOrder.indexOf(id);
  for (let j = i + 1; j < rowOrder.length; j++) if (!isDone(S.mails.get(rowOrder[j]))) return rowOrder[j];
  for (let j = i - 1; j >= 0; j--) if (!isDone(S.mails.get(rowOrder[j]))) return rowOrder[j];
  return null;
}
function markDone(ids, message) {
  const fresh = ids.filter((id) => !S.state.done[id]);
  if (!fresh.length) return;
  const next = S.selected && fresh.includes(S.selected) ? nextOpenAfter(S.selected) : S.selected;
  setFlag(fresh, 'done', true);
  if (S.selected && fresh.includes(S.selected)) {
    if (narrow.matches) { S.selected = null; history.back(); }
    else S.selected = next;
  }
  showToast(message || (fresh.length === 1 ? 'Marked done.' : `${fresh.length} marked done.`), () => {
    setFlag(fresh, 'done', false);
    render();
  });
  render();
}
function toggleDoneSelected() {
  const m = S.selected && S.mails.get(S.selected);
  if (!m) return;
  if (isDone(m)) { setFlag([m.id], 'done', false); render(); showToast('Moved back to open.'); }
  else markDone([m.id]);
}

let toastTimer = 0;
function showToast(text, undo) {
  const t = $('toast');
  $('toast-text').textContent = text;
  S.undo = undo || null;
  $('toast-btn').hidden = !undo;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; S.undo = null; }, 6000);
}

/* ---------- Swipe to mark done (touch screens) ---------- */
const swipeHandles = new WeakMap();
const viewport = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const item = e.target;
    if (e.isIntersecting) {
      const handle = swipeHandles.get(item) || setupSwipe(item);
      if (handle) handle.io.observe(handle.content);
    } else {
      const handle = swipeHandles.get(item);
      if (handle) handle.io.unobserve(handle.content);
    }
  }
});
const liveSwipes = new Set();
function teardownSwipes() {
  for (const handle of liveSwipes) handle.io.disconnect();
  liveSwipes.clear();
  viewport.disconnect();
}
function setupSwipes(list) {
  for (const li of list.querySelectorAll('.row[data-done="false"]')) viewport.observe(li);
}
function setupSwipe(item) {
  const track = item.querySelector('.track');
  const content = item.querySelector('.row-main');
  if (!track || !content) return null;
  item.classList.add('is-swipe');
  track.scrollLeft = track.clientWidth;  // rest on the row itself
  requestAnimationFrame(() => { track.scrollLeft = track.clientWidth; });
  // Only a real touch may commit; layout changes alone never mark mail done.
  let touched = false;
  track.addEventListener('pointerdown', () => { touched = true; }, { passive: true });
  track.addEventListener('touchstart', () => { touched = true; }, { passive: true });
  const io = new IntersectionObserver((entries) => {
    const entry = entries[entries.length - 1];
    const ratio = entry.intersectionRatio;
    // Rows replaced by a re-render report 0 with no root; that is not a swipe.
    if (!touched || !item.isConnected || !entry.rootBounds || entry.rootBounds.width === 0) return;
    if (ratio < 0.25 && !item.dataset.committed) {
      item.dataset.committed = '1';
      io.disconnect();
      viewport.unobserve(item);
      dismissRow(item, content, entry).then(() => markDone([item.dataset.id]));
      return;
    }
    item.classList.toggle('is-armed', ratio < 0.7);
  }, { root: track, threshold: [0.25, 0.7] });
  const handle = { io, content };
  swipeHandles.set(item, handle);
  liveSwipes.add(handle);
  return handle;
}
async function dismissRow(item, content, entry) {
  const rect = entry.boundingClientRect;
  const x = rect.x - entry.rootBounds.x;
  const to = x > 0 ? rect.width - x : -(rect.width + x);
  const opts = { duration: 220, easing: 'ease-out', fill: 'forwards' };
  item.animate([{ height: `${rect.height}px` }, { height: '0px' }], opts);
  content.animate([{ translate: `${to}px` }], opts);
  await Promise.allSettled(item.getAnimations({ subtree: true }).map((a) => a.finished));
}

/* ---------- Sync sheet ---------- */
function openSyncSheet() {
  const d = $('sync-dialog');
  $('sync-summary').textContent = S.demo
    ? 'You’re looking at sample mail. Nothing syncs.'
    : S.syncing ? 'Syncing now.'
    : S.error ? S.error.text
    : `Last synced ${relTime(S.lastSync)}.${S.pending.length ? ` ${S.pending.length} change${S.pending.length === 1 ? '' : 's'} waiting to upload.` : ''}`;
  const latest = {};
  for (const f of Object.values(S.files)) {
    if (!latest[f.account] || f.modified > latest[f.account]) latest[f.account] = f.modified;
  }
  const stale = [];
  const rows = ACCOUNT_ORDER.map((acc) => {
    const t = latest[acc];
    const old = !t || (Date.now() - Date.parse(t)) > STALE_MINUTES * 60000;
    if (old && !S.demo) stale.push(accInfo(acc).name);
    return h('tr', { class: old && !S.demo ? 'is-stale' : '' },
      h('th', { scope: 'row' }, tabEl(acc), accInfo(acc).name),
      h('td', null, t ? relTime(t) : 'No file'));
  });
  $('fresh-body').replaceChildren(...rows);
  const note = $('fresh-note');
  note.hidden = !stale.length;
  note.textContent = stale.length
    ? `${listJoin(stale)} ${stale.length === 1 ? 'hasn’t' : 'haven’t'} exported in over ${STALE_MINUTES} minutes. Open that account’s Mail Hub project on script.google.com and check Triggers and Executions.`
    : '';
  $('sync-now').hidden = S.demo;
  $('disconnect').textContent = S.demo ? 'Leave sample mail' : 'Disconnect this device';
  if (!d.open) d.showModal();
}

/* ---------- Setup and demo ---------- */
function connectWith(raw) {
  const conn = decodeConnection(raw);
  if (!conn) return false;
  S.conn = conn;
  save(KEYS.conn, conn);
  S.demo = false;
  render();
  sync();
  return true;
}
function startDemo() {
  S.demo = true;
  S.mails = new Map(sampleMail().map((m) => [m.id, m]));
  S.files = sampleFiles();
  S.state = { done: {}, seen: {} };
  S.lastSync = new Date().toISOString();
  S.tasks = sampleTasks();
  render();
}
function leaveDemo() {
  $('sync-dialog').close();
  S.demo = false;
  S.mails = new Map(); S.files = {}; S.state = { done: {}, seen: {} }; S.selected = null;
  S.tasks = {}; S.view = 'mail';
  restoreCache();
  history.replaceState(null, '', location.pathname);
  render();
}
function disconnect() {
  if (S.demo) { leaveDemo(); return; }
  if (!confirm('Disconnect this device? Saved mail on this device is removed. Your Drive folder and marks are not touched.')) return;
  for (const k of Object.values(KEYS)) localStorage.removeItem(k);
  S.conn = null; S.mails = new Map(); S.files = {}; S.state = { done: {}, seen: {} };
  S.pending = []; S.lastSync = null; S.selected = null; S.error = null;
  S.tasks = {}; S.taskPending = []; S.tasksUpdatedAt = null; S.view = 'mail';
  $('sync-dialog').close();
  render();
}

function sampleTasks() {
  const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return localDayKey(d); };
  const at = new Date().toISOString();
  const list = [
    { id: 'st1', title: 'Register for the Northwind online test', due: day(1), mailId: 'college_s0', mailSubject: 'Shortlist for Northwind Systems online test', account: 'college', source: 'mailhub' },
    { id: 'st2', title: 'Swap Q17 in the prelims set', due: day(0), mailId: 'college_s9', account: 'college', source: 'mailhub' },
    { id: 'st3', title: 'Pay mess bill', due: day(-1), source: 'pocket-ledger' },
    { id: 'st4', title: 'Return the two library books', due: day(4), source: 'pocket-ledger' },
    { id: 'st5', title: 'Read the PS evaluation section before Saturday', due: null, source: 'mailhub' },
    { id: 'st6', title: 'Book Diwali train tickets', due: day(-2), done: true, doneAt: at, source: 'pocket-ledger' },
  ];
  return Object.fromEntries(list.map((t) => [t.id, { done: false, doneAt: null, createdAt: at, updatedAt: at, ...t }]));
}

/* ---------- Sample mail (invented) ---------- */
function sampleFiles() {
  const now = Date.now();
  return {
    a: { name: 'sample_college.json', account: 'college', modified: new Date(now - 6 * 60000).toISOString() },
    b: { name: 'sample_personal.json', account: 'personal', modified: new Date(now - 9 * 60000).toISOString() },
    c: { name: 'sample_personal2.json', account: 'personal2', modified: new Date(now - 11 * 60000).toISOString() },
  };
}
function sampleMail() {
  const at = (daysAgo, hh, mm) => { const d = new Date(); d.setDate(d.getDate() - daysAgo); d.setHours(hh, mm, 0, 0); return d.toISOString(); };
  const raw = [
    ['college', 0, 9, 12, 'Training & Placement Cell <tnp@college.example>', 'Shortlist for Northwind Systems online test', 'Dear students,\n\nThe shortlist for the Northwind Systems online test is attached. The test opens on Thursday at 6:00 PM and closes at 7:30 PM. Use a laptop with a webcam; phones are not allowed.\n\nRegister on the portal by Wednesday noon: https://portal.example/northwind\n\nTraining & Placement Cell', true, ['Northwind_shortlist.pdf']],
    ['personal', 0, 8, 41, 'Ritika Sharma <ritika.s@example.com>', 'Re: Inter IIT team, slot for Saturday call', 'Saturday 4 PM works for me. Can you share the problem statement PDF before that? I want to read the evaluation section first.\n\nAlso, should we ask Kabir? He did the ASR pipeline last year.', true],
    ['college', 0, 7, 55, 'Dean Academic Affairs <dean.acad@college.example>', 'Mid-semester grade moderation for EE4L007', 'Students of EE4L007 may view moderated mid-semester marks on the academic portal from today. Requests for re-evaluation close on Friday.', false],
    ['personal', 0, 7, 3, 'GitHub <noreply@github.example>', '[Abhimanyu5100/drone-sensor-routing] Run failed: tests on main', 'The workflow run "tests" failed on main. 1 job failed: pytest (3.12).\n\nView the run: https://github.example/runs/1234', true],
    ['personal2', 0, 6, 30, 'Google <no-reply@accounts.google.example>', 'Security alert', 'Mail Hub was granted access to your Google Account. If you did not grant access, check this activity and secure your account.', true],
    ['personal', 0, 6, 2, 'Unstop <noreply@unstop.example>', '3 new hackathons match your profile', 'Hackathons closing this week. Unsubscribe from these emails at any time.', false],
    ['college', 0, 5, 48, 'Library <library-notify@college.example>', 'Due date reminder: 2 books', 'Digital Control Systems (Ogata) and Electric Machinery (Fitzgerald) are due on 22 Oct.', false],
    ['personal2', 0, 5, 10, 'LinkedIn <notifications-noreply@linkedin.example>', 'You appeared in 14 searches this week', 'See who is looking. Unsubscribe.', false],
    ['personal', 1, 22, 17, 'Aarav Mehta <aarav.m@example.com>', 'Notes from today’s DBMS revision', 'Pushed the normalization notes to the shared folder. Covered 1NF to BCNF with the two examples from the 2024 paper. Indexing tomorrow?', false],
    ['college', 1, 18, 5, 'Quizsoc Core <quizsoc@college.example>', 'Prelims set for Saturday: final review', 'Abhimanyu, the 30-question prelims set is final except Q17 (two people found the answer online). Can you swap it tonight?', false],
    ['personal', 1, 15, 32, 'HackerRank <no-reply@hackerrank.example>', 'Your test invitation from Contoso Labs', 'You have been invited to take the Contoso Labs Software Engineer test. Valid for 7 days.', true, ['instructions.pdf']],
    ['personal2', 1, 11, 9, 'Mom <mom.family@example.com>', 'Diwali tickets', 'Did you book the train for the 7th? Papa says tatkal opens at 10.', false],
    ['personal', 1, 9, 0, 'Medium Daily Digest <noreply@medium.example>', 'Transformers, explained without the math', 'Stories for you. Unsubscribe.', false],
    ['college', 2, 16, 40, 'EE Department Office <ee.office@college.example>', 'Lab rescheduling: Power Quality', 'The Electric Power Quality lab moves from Tuesday to Wednesday 2 PM this week only.', false],
    ['personal', 2, 13, 25, 'Swiggy <noreply@swiggy.example>', 'Your order is on the way', 'Your order will reach in 25 minutes.', false],
  ];
  return raw.map(([account, d, hh, mm, from, subject, body, unread, attachments], i) =>
    normalize({ id: `s${i}`, threadId: `t${i}`, date: at(d, hh, mm), from, subject, body, unread, attachments: attachments || [], link: '' },
      { account }));
}

/* ---------- Events ---------- */
function bind() {
  $('connect-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const ok = connectWith($('connect-input').value);
    const err = $('connect-error');
    err.hidden = ok;
    if (!ok) err.textContent = 'That isn’t a Mail Hub connection link or code. Copy the whole line that makeConnectLink logged.';
  });
  $('try-demo').addEventListener('click', startDemo);
  $('sync-btn').addEventListener('click', openSyncSheet);
  $('sync-now').addEventListener('click', () => { sync(); $('sync-dialog').close(); });
  $('sync-close').addEventListener('click', () => $('sync-dialog').close());
  $('disconnect').addEventListener('click', disconnect);
  $('done-btn').addEventListener('click', toggleDoneSelected);
  $('task-from-mail').addEventListener('click', () => {
    const m = S.selected && S.mails.get(S.selected);
    if (!m) return;
    const linked = taskForMail(m.id);
    openTaskDialog(linked ? { id: linked.id } : { mail: m });
  });
  $('task-save').addEventListener('click', saveTaskDialog);
  $('task-title').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); saveTaskDialog(); } });
  $('task-cancel').addEventListener('click', () => $('task-dialog').close());
  $('task-delete').addEventListener('click', () => {
    const id = S.editing && S.editing.id;
    const t = id && S.tasks[id];
    if (!t) return;
    const copy = { ...t };
    taskOp('delete', id);
    $('task-dialog').close();
    render();
    showToast('Task deleted.', () => {
      const back = { title: copy.title, due: copy.due, done: copy.done };
      for (const k of ['mailId', 'mailSubject', 'account', 'mailLink']) if (copy[k]) back[k] = copy[k];
      taskOp('add', uid(), back);
      render();
    });
  });
  $('back-btn').addEventListener('click', () => history.back());
  $('toast-btn').addEventListener('click', () => {
    const fn = S.undo; S.undo = null; $('toast').hidden = true;
    if (fn) fn();
  });

  let searchTimer = 0;
  $('search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { S.query = e.target.value; renderList(); }, 120);
  });

  window.addEventListener('popstate', () => {
    if (document.body.classList.contains('is-reading')) closeReader();
  });
  narrow.addEventListener('change', () => {
    if (!narrow.matches) document.body.classList.remove('is-reading');
    render();
  });
  window.addEventListener('online', () => sync({ quiet: true }));
  window.addEventListener('offline', () => { S.error = { kind: 'network', text: 'offline' }; renderSync(); renderBanner(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!S.lastSync || Date.now() - Date.parse(S.lastSync) > AUTO_SYNC_MINUTES * 60000) sync({ quiet: true });
    else renderSync();
  });
  setInterval(() => { if (document.visibilityState === 'visible') renderSync(); }, 30000);

  document.addEventListener('keydown', onKey);
}

function onKey(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if ($('sync-dialog').open || $('task-dialog').open) return;
  const typing = e.target.closest('input, textarea, [contenteditable]');
  if (typing) {
    if (e.key === 'Escape') { e.target.value = ''; S.query = ''; e.target.blur(); renderList(); }
    return;
  }
  const move = (dir) => {
    if (!rowOrder.length) return;
    const i = rowOrder.indexOf(S.selected);
    const j = i < 0 ? 0 : Math.min(rowOrder.length - 1, Math.max(0, i + dir));
    openMail(rowOrder[j], { focusReader: false });
  };
  switch (e.key) {
    case 'j': case 'ArrowDown': if (e.key === 'ArrowDown' && narrow.matches) return; e.preventDefault(); move(1); break;
    case 'k': case 'ArrowUp': if (e.key === 'ArrowUp' && narrow.matches) return; e.preventDefault(); move(-1); break;
    case 'e': if (S.selected) { e.preventDefault(); toggleDoneSelected(); } break;
    case 't': if (S.selected) { e.preventDefault(); $('task-from-mail').click(); } break;
    case 'g': e.preventDefault(); setView(S.view === 'tasks' ? 'mail' : 'tasks'); break;
    case 'u': if (S.undo) { e.preventDefault(); $('toast-btn').click(); } break;
    case '/': e.preventDefault(); $('search').focus(); break;
    case 'r': e.preventDefault(); sync(); break;
    case 'Escape':
      if (narrow.matches && document.body.classList.contains('is-reading')) history.back();
      else if (S.selected) { S.selected = null; render(); }
      break;
  }
}

/* ---------- Start ---------- */
function start() {
  bind();
  const params = new URLSearchParams(location.search);
  if (location.hash.startsWith('#connect=')) {
    const code = location.hash;
    history.replaceState(null, '', location.pathname + location.search);
    if (connectWith(code)) return;
    $('connect-error').hidden = false;
    $('connect-error').textContent = 'That connection link is incomplete. Copy the whole line that makeConnectLink logged.';
  }
  S.conn = load(KEYS.conn, null);
  if (params.has('demo') && !S.conn) { startDemo(); return; }
  restoreCache();
  render();
  if (S.conn) sync();
}

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
start();
