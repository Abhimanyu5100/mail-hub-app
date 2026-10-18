/**
 * Mail Hub exporter
 * Paste this into script.google.com in EACH of your 3 Google accounts.
 * Per account, change only ACCOUNT_LABEL.
 *
 * Every RUN_EVERY_MINUTES it rewrites today's  YYYY-MM-DD_<label>.json  in the
 * Mail Hub folder with the last ~26 hours of mail from that account.
 *
 * Attachments: each new attachment is copied once into
 *   Mail Hub/attachments/<label>/
 * so Claude and the Mail Hub app can open it. Files over MAX_ATTACHMENT_MB,
 * inline images and small logo-sized images are skipped. Copies older than
 * ATTACH_KEEP_DAYS go to the Drive trash.
 */

const CONFIG = {
  ACCOUNT_LABEL: 'personal',               // unique per account: 'personal', 'personal2', 'college'
  FOLDER_ID: '12UEqfv72GyZh4vf75MHub5bUySXlv8PX',
  TIMEZONE: 'Asia/Kolkata',
  RUN_EVERY_MINUTES: 15,                   // allowed: 5, 10, 15 or 30
  LOOKBACK_HOURS: 26,                      // 24h + 2h overlap so nothing slips between runs
  MAX_MESSAGES: 300,                       // safety cap per run
  MAX_BODY_CHARS: 2500,                    // body is trimmed after this
  KEEP_DAYS: 14,                           // older export files from this account go to Drive trash

  SAVE_ATTACHMENTS: true,
  MAX_ATTACHMENT_MB: 10,                   // bigger files are listed but not copied
  MIN_IMAGE_KB: 20,                        // smaller images are usually logos and signatures
  MAX_NEW_ATTACHMENTS_PER_RUN: 40,         // keeps one run short; the rest are copied next run
  ATTACH_KEEP_DAYS: 14
};

/** Main job. The trigger calls it; run it once by hand to test. */
function runDaily() {
  const now = new Date();
  const since = new Date(now.getTime() - CONFIG.LOOKBACK_HOURS * 3600 * 1000);
  const me = Session.getActiveUser().getEmail();
  const query = 'after:' + Math.floor(since.getTime() / 1000) + ' -in:spam -in:trash -in:chats';
  const saver = CONFIG.SAVE_ATTACHMENTS ? attachmentSaver_() : null;

  const messages = [];
  let truncated = false;
  let start = 0;

  outer:
  while (true) {
    const threads = GmailApp.search(query, start, 100);
    if (threads.length === 0) break;

    for (const thread of threads) {
      const labels = thread.getLabels().map(function (l) { return l.getName(); });
      const inInbox = thread.isInInbox();
      const important = thread.isImportant();

      for (const msg of thread.getMessages()) {
        if (msg.getDate() < since || msg.isDraft() || msg.isInTrash()) continue;
        if (messages.length >= CONFIG.MAX_MESSAGES) { truncated = true; break outer; }
        messages.push(toRecord_(msg, thread, labels, inInbox, important, me, saver));
      }
    }

    if (threads.length < 100) break;
    start += 100;
  }

  messages.sort(function (a, b) { return b.date.localeCompare(a.date); });

  const dateKey = Utilities.formatDate(now, CONFIG.TIMEZONE, 'yyyy-MM-dd');
  const payload = {
    account: CONFIG.ACCOUNT_LABEL,
    email: me,
    generatedAt: now.toISOString(),
    windowStart: since.toISOString(),
    windowEnd: now.toISOString(),
    count: messages.length,
    truncated: truncated,
    messages: messages
  };

  const fileName = dateKey + '_' + CONFIG.ACCOUNT_LABEL + '.json';
  writeFile_(fileName, JSON.stringify(payload, null, 1));
  cleanupOld_();
  if (saver) saver.cleanup();

  console.log('Wrote ' + fileName + ' with ' + messages.length + ' messages' +
              (truncated ? ' (hit MAX_MESSAGES cap)' : '') +
              (saver ? '; copied ' + saver.copied() + ' new attachments' : ''));
}

/** Run ONCE per account to schedule runDaily every RUN_EVERY_MINUTES.
 *  Replaces any earlier runDaily trigger, so it's safe to re-run. */
function setupTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'runDaily'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });

  ScriptApp.newTrigger('runDaily')
    .timeBased()
    .everyMinutes(CONFIG.RUN_EVERY_MINUTES)
    .create();

  console.log('Trigger set: runDaily every ' + CONFIG.RUN_EVERY_MINUTES + ' minutes');
}

/* ---------------- attachments ---------------- */

/** Copies attachments into Mail Hub/attachments/<label>/, each one only once. */
function attachmentSaver_() {
  const root = DriveApp.getFolderById(CONFIG.FOLDER_ID);
  const folder = childFolder_(childFolder_(root, 'attachments'), CONFIG.ACCOUNT_LABEL);

  // Index what is already there by name, so reruns every 15 minutes don't copy again.
  const existing = {};
  const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (!f.isTrashed()) existing[f.getName()] = f.getId();
  }

  let copied = 0;
  const maxBytes = CONFIG.MAX_ATTACHMENT_MB * 1024 * 1024;

  return {
    /** Returns [{ name, size, type, driveId?, skipped? }] for one message. */
    save: function (msg, atts) {
      return atts.map(function (a, i) {
        const name = a.getName() || ('attachment-' + (i + 1));
        const size = a.getSize();
        const type = a.getContentType() || '';
        const rec = { name: name, size: size, type: type };

        if (size > maxBytes) { rec.skipped = 'too_large'; return rec; }
        if (type.indexOf('image/') === 0 && size < CONFIG.MIN_IMAGE_KB * 1024) { rec.skipped = 'small_image'; return rec; }

        const fileName = msg.getId() + '_' + (i + 1) + '_' + safeName_(name);
        if (existing[fileName]) { rec.driveId = existing[fileName]; return rec; }
        if (copied >= CONFIG.MAX_NEW_ATTACHMENTS_PER_RUN) { rec.skipped = 'next_run'; return rec; }

        try {
          const file = folder.createFile(a.copyBlob().setName(fileName));
          file.setDescription('From: ' + msg.getFrom() + '\nSubject: ' + (msg.getSubject() || ''));
          existing[fileName] = file.getId();
          rec.driveId = file.getId();
          copied++;
        } catch (e) {
          rec.skipped = 'error';
          console.warn('Could not copy ' + name + ': ' + e.message);
        }
        return rec;
      });
    },
    copied: function () { return copied; },
    cleanup: function () {
      const cutoff = new Date(Date.now() - CONFIG.ATTACH_KEEP_DAYS * 86400000);
      const files = folder.getFiles();
      while (files.hasNext()) {
        const f = files.next();
        if (!f.isTrashed() && f.getDateCreated() < cutoff) {
          try { f.setTrashed(true); } catch (e) { console.warn('Could not trash ' + f.getName()); }
        }
      }
    }
  };
}

function childFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  while (it.hasNext()) {
    const f = it.next();
    if (!f.isTrashed()) return f;
  }
  return parent.createFolder(name);
}

function safeName_(name) {
  return String(name).replace(/[\\/:*?"<>|#%]+/g, '_').slice(0, 120);
}

/* ---------------- helpers ---------------- */

function toRecord_(msg, thread, labels, inInbox, important, me, saver) {
  const from = msg.getFrom();
  let attachments = [];
  let files = [];
  try {
    const atts = msg.getAttachments({ includeInlineImages: false });
    attachments = atts.map(function (a) { return a.getName(); });
    if (saver && atts.length) files = saver.save(msg, atts);
  } catch (e) { /* ignore attachment read errors */ }

  return {
    id: msg.getId(),
    threadId: thread.getId(),
    date: msg.getDate().toISOString(),
    dateLocal: Utilities.formatDate(msg.getDate(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm'),
    from: from,
    fromMe: !!me && from.toLowerCase().indexOf(me.toLowerCase()) !== -1,
    to: msg.getTo(),
    cc: msg.getCc(),
    subject: msg.getSubject() || '(no subject)',
    unread: msg.isUnread(),
    starred: msg.isStarred(),
    important: important,
    inInbox: inInbox,
    labels: labels,
    attachments: attachments,
    files: files,
    body: cleanBody_(msg.getPlainBody()),
    link: 'https://mail.google.com/mail/?authuser=' + encodeURIComponent(me) + '#all/' + msg.getId()
  };
}

function cleanBody_(text) {
  if (!text) return '';
  const out = [];
  const lines = text.replace(/\r/g, '').split('\n');

  for (const line of lines) {
    const t = line.trim();
    if (t.indexOf('>') === 0) continue;          // quoted reply lines
    if (/^On .+wrote:$/.test(t)) break;          // start of the quoted older thread
    out.push(t);
  }

  let body = out.join('\n')
    .replace(/https?:\/\/\S{60,}/g, '[long link]') // tracking URLs just waste space
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (body.length > CONFIG.MAX_BODY_CHARS) {
    body = body.slice(0, CONFIG.MAX_BODY_CHARS) + ' ...[truncated]';
  }
  return body;
}

function writeFile_(name, content) {
  const folder = DriveApp.getFolderById(CONFIG.FOLDER_ID);
  const existing = folder.getFilesByName(name);
  if (existing.hasNext()) {
    existing.next().setContent(content);         // reruns on the same day overwrite
  } else {
    folder.createFile(name, content, 'application/json');
  }
}

function cleanupOld_() {
  const folder = DriveApp.getFolderById(CONFIG.FOLDER_ID);
  const cutoff = new Date(Date.now() - CONFIG.KEEP_DAYS * 86400000);
  const suffix = '_' + CONFIG.ACCOUNT_LABEL + '.json';
  const files = folder.getFiles();

  while (files.hasNext()) {
    const f = files.next();
    if (f.getName().slice(-suffix.length) === suffix && f.getDateCreated() < cutoff) {
      try { f.setTrashed(true); } catch (e) { console.warn('Could not trash ' + f.getName()); }
    }
  }
}
