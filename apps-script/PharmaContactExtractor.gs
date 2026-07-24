/**
 * ============================================================
 *  PHARMA CONTACT EXTRACTOR — v2  (automatic batch processing)
 * ============================================================
 *
 * WHAT IT DOES
 *   Scans the whole Gmail account (inbox, sent, archive, spam, trash)
 *   for pharma-related conversations and builds a contact list in the
 *   "Pharma Contacts" sheet with: email, name, company domain,
 *   direction (sent/received), first & last seen dates, message count
 *   and the most recent subject line.
 *
 * WHAT'S NEW vs v1
 *   - Fully automatic: click "Start" ONCE and it keeps running on
 *     Google's servers until the entire mailbox is processed — even if
 *     this computer is switched off. No more re-running manually.
 *   - Collects names, company domains, direction, dates and counts,
 *     not just bare email addresses.
 *   - Live "Extractor Status" tab, Pause / Resume / Reset menu,
 *     and an email notification when the full scan finishes.
 *   - "Rescan recent" mode + automatic weekly refresh so new mail
 *     keeps flowing into the list after the first full scan.
 *   - Keeps any addresses already collected by the old v1 script
 *     (the old sheet is preserved as a backup tab).
 *   - Rows never move once written: you can safely add your own
 *     columns (Notes, Priority, …) to the right of "Last subject".
 *
 * HOW TO INSTALL
 *   1. Open the Google Sheet  →  Extensions  →  Apps Script.
 *   2. Delete the old code, paste this entire file, press Save.
 *   3. Reload the spreadsheet tab in the browser.
 *   4. A "Pharma Extractor" menu appears — click "Start / Resume".
 *   5. Approve the permissions (click "Advanced" → "Go to … (unsafe)"
 *      if Google shows an unverified-app warning — that is normal for
 *      personal scripts).
 *   6. IMPORTANT: after approving, click "Start / Resume" ONCE MORE —
 *      Google does not re-run the click that triggered the approval.
 *      You know it is running when the small toast appears and the
 *      "Extractor Status" tab shows RUNNING.
 *
 * NOTE ON GOOGLE'S DAILY LIMITS
 *   Free Gmail accounts allow ~90 minutes of background script time
 *   per day. Big mailboxes therefore take a few days — the extractor
 *   pauses itself when the daily limit is hit and resumes
 *   automatically. Google may email you a "Summary of failures" on
 *   those days; that is expected and harmless.
 */

// ------------------------------------------------------------------
//  CONFIGURATION — edit these lists to tune what gets collected
// ------------------------------------------------------------------
var CONFIG = {
  CONTACT_SHEET: 'Pharma Contacts',
  STATUS_SHEET: 'Extractor Status',

  // An email counts as "pharma-related" if it contains ANY of these.
  KEYWORDS: [
    'pharma', 'pharmaceutical', 'pharmaceuticals', 'medicine',
    'medicines', 'drug', 'drugs', 'vaccine', 'vaccines', 'oncology',
    'hospital', 'formulation', 'formulations', 'medical', 'surgical',
    'injection', 'tablet', 'tablets', 'capsule', 'capsules', 'tender',
    '"cold chain"', 'manufacturer', 'distributor'
  ],

  // Also search spam and trash (in:anywhere). Set false to skip them.
  INCLUDE_SPAM_TRASH: true,

  // Your own company domains — these addresses are never collected.
  OWN_DOMAINS: ['3scorporation.com'],

  // Addresses containing any of these are skipped (automated senders).
  EXCLUDE_PATTERNS: [
    'noreply', 'no-reply', 'no_reply', 'donotreply', 'do-not-reply',
    'mailer-daemon', 'postmaster', 'bounce', 'unsubscribe',
    'notifications@', 'newsletter@', 'alerts@'
  ],

  // Personal-mail domains: the "Company (domain)" column stays blank.
  FREEMAIL_DOMAINS: [
    'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in',
    'ymail.com', 'hotmail.com', 'outlook.com', 'live.com', 'aol.com',
    'rediffmail.com', 'icloud.com', 'protonmail.com', 'proton.me',
    'zoho.com', 'zohomail.in', 'mail.com'
  ],

  WINDOW_DAYS: 30,             // mailbox is scanned in 30-day slices
  THREADS_PER_SEARCH: 100,     // threads fetched per Gmail search call
  TIME_BUDGET_MS: 4 * 60 * 1000,   // stay well under the 6-min limit
  FIRST_RUN_BUDGET_MS: 40 * 1000,  // short first slice for quick feedback
  CONTINUE_DELAY_MS: 60 * 1000,    // gap between automatic runs
  RESCAN_DAYS: 60,             // "Rescan recent" covers this many days
  AUTO_REFRESH_DAYS: 7,        // auto-rescan every N days when done (0 = off)
  SEND_COMPLETION_EMAIL: true
};

var HEADERS = [
  'Email', 'Name', 'Company (domain)', 'Direction',
  'First seen', 'Last seen', 'Messages', 'Last subject'
];

// Never search earlier than 1 Jan 2000 — guards against spam with
// forged ancient dates driving the scan into invalid negative queries.
var FLOOR_SEC = 946684800;

var WATCHDOG_GRACE_MS = 45 * 60 * 1000; // must exceed the 30-min error backoff

var STATUS_MARKER = 'PHARMA CONTACT EXTRACTOR';

// ------------------------------------------------------------------
//  MENU
// ------------------------------------------------------------------
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Pharma Extractor')
    .addItem('Start / Resume extraction', 'startExtraction')
    .addItem('Pause', 'pauseExtraction')
    .addItem('Show status', 'showStatus')
    .addSeparator()
    .addItem('Rescan recent mail (last ' + CONFIG.RESCAN_DAYS + ' days)', 'rescanRecent')
    .addSeparator()
    .addItem('Reset (start over)', 'resetExtraction')
    .addToUi();
}

function startExtraction() {
  var props = PropertiesService.getScriptProperties();
  var state = props.getProperty('STATE');
  if (state === 'DONE') {
    safeAlert_('The full mailbox scan already finished.\n\nUse "Rescan recent mail" to pick up new emails, or "Reset" to start again from scratch.');
    return;
  }
  if (!props.getProperty('CURSOR_END')) { // brand-new full scan
    props.setProperties({
      MODE: 'FULL',
      COUNT_FLOOR: '0',
      LAST_SCAN_STARTED: String(nowSec_()),
      STARTED_AT: String(Date.now())
    });
  }
  if (!props.getProperty('MODE')) props.setProperty('MODE', 'FULL');
  props.setProperty('STATE', 'RUNNING');
  ensureWatchdog_();
  safeToast_('Extraction started. It now runs by itself in the background — watch the "' + CONFIG.STATUS_SHEET + '" tab. You can close this sheet.');
  runExtraction_(CONFIG.FIRST_RUN_BUDGET_MS);
}

function pauseExtraction() {
  var props = PropertiesService.getScriptProperties();
  var state = props.getProperty('STATE');
  if (state !== 'RUNNING') {
    safeAlert_(state === 'DONE'
      ? 'Nothing is running — the scan already finished.\n\n"Pause" is only needed while a scan is in progress, so nothing was changed.'
      : 'Nothing is running right now.');
    return;
  }
  props.setProperty('STATE', 'PAUSED');
  deleteTriggersFor_('processBatch');
  deleteTriggersFor_('watchdogTick');
  safeToast_('Paused. Use "Start / Resume extraction" to continue where it left off.');
}

function rescanRecent() {
  var props = PropertiesService.getScriptProperties();
  var state = props.getProperty('STATE');
  if (state === 'RUNNING') {
    safeAlert_('The extractor is already running. Pause it first, or wait for it to finish.');
    return;
  }
  if (state !== 'DONE') {
    safeAlert_('Finish the full mailbox scan first ("Start / Resume extraction").\n\nRescan is meant for picking up NEW mail after the full scan is complete.');
    return;
  }
  beginRefresh_();
  ensureWatchdog_();
  safeToast_('Rescanning the last ' + CONFIG.RESCAN_DAYS + ' days of mail…');
  runExtraction_(CONFIG.FIRST_RUN_BUDGET_MS);
}

function resetExtraction() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.alert(
    'Reset extractor',
    'This clears all progress, so the next Start begins from scratch.\n\nContinue?',
    ui.ButtonSet.YES_NO
  );
  if (resp !== ui.Button.YES) return;
  var resp2 = ui.alert(
    'Also delete the contacts collected so far in "' + CONFIG.CONTACT_SHEET + '"?',
    ui.ButtonSet.YES_NO
  );
  var clearRows = resp2 === ui.Button.YES;

  var props = PropertiesService.getScriptProperties();
  // Stop any in-flight batch first, then wait for it to finish before
  // wiping, so it cannot re-save the progress we are erasing.
  props.setProperty('STATE', 'PAUSED');
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(300000)) {
    safeAlert_('A background batch is still finishing. The extractor has been paused — please run Reset again in a minute.');
    return;
  }
  try {
    deleteTriggersFor_('processBatch');
    deleteTriggersFor_('startWeeklyRefresh');
    deleteTriggersFor_('watchdogTick');
    props.deleteAllProperties();
    if (clearRows) {
      var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.CONTACT_SHEET);
      if (sheet) {
        var last = sheet.getLastRow();
        if (last > 1) sheet.getRange(2, 1, last - 1, HEADERS.length).clearContent();
      }
    }
  } finally {
    lock.releaseLock();
  }
  safeToast_('Reset complete.');
}

function showStatus() {
  var props = PropertiesService.getScriptProperties();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONFIG.CONTACT_SHEET);
  var contacts = sheet && sheet.getLastRow() > 1 ? sheet.getLastRow() - 1 : 0;
  var state = props.getProperty('STATE') || 'Not started';
  var msg =
    'State: ' + state + '\n' +
    'Contacts collected: ' + contacts + '\n' +
    'Email threads scanned: ' + (props.getProperty('THREADS_DONE') || 0) + '\n' +
    'Now scanning around: ' + cursorLabel_(props) + '\n' +
    'Last error: ' + (props.getProperty('LAST_ERROR') || 'none');
  safeAlert_(msg);
}

// ------------------------------------------------------------------
//  TRIGGER ENTRY POINTS (run automatically on Google's servers)
// ------------------------------------------------------------------
function processBatch() {
  runExtraction_(CONFIG.TIME_BUDGET_MS);
}

function startWeeklyRefresh() {
  var props = PropertiesService.getScriptProperties();
  deleteTriggersFor_('startWeeklyRefresh');
  if (props.getProperty('STATE') === 'RUNNING') {
    // busy — make sure the watchdog can heal a wedged chain, retry tomorrow
    ensureWatchdog_();
    ScriptApp.newTrigger('startWeeklyRefresh').timeBased()
      .at(new Date(Date.now() + 24 * 3600 * 1000)).create();
    return;
  }
  beginRefresh_();
  ensureWatchdog_();
  runExtraction_(CONFIG.TIME_BUDGET_MS);
}

// Self-healing: if the continuation chain dies (daily quota hit, crash
// before rescheduling, etc.) this recurring trigger restarts it.
// Liveness is judged by heartbeat TIME, never by trigger presence —
// fired one-off triggers linger in the trigger list and would fool a
// presence check exactly when the daily quota kills an execution.
function watchdogTick() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('STATE') !== 'RUNNING') return;
  var nextRunAt = Number(props.getProperty('NEXT_RUN_AT') || 0);
  var lastRunAt = Number(props.getProperty('LAST_RUN_AT') || 0);
  if (Date.now() > Math.max(nextRunAt, lastRunAt) + WATCHDOG_GRACE_MS) {
    scheduleContinue_(60 * 1000); // also clears any spent triggers
  }
}

// ------------------------------------------------------------------
//  CORE ENGINE
// ------------------------------------------------------------------
function runExtraction_(budgetMs) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return; // another run is already active

  try {
    deleteTriggersFor_('processBatch'); // remove the just-fired trigger
    var props = PropertiesService.getScriptProperties();
    if (props.getProperty('STATE') !== 'RUNNING') return;
    props.setProperty('LAST_RUN_AT', String(Date.now())); // heartbeat

    var deadline = Date.now() + budgetMs;
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ensureContactSheet_(ss);
    var book = loadContacts_(sheet);
    var own = buildOwnIdentity_();

    var mode = props.getProperty('MODE') || 'FULL';
    var cursorEnd = Number(props.getProperty('CURSOR_END') || 0); // window end, epoch seconds
    var span = Number(props.getProperty('SPAN_DAYS') || CONFIG.WINDOW_DAYS);
    var offset = Number(props.getProperty('OFFSET') || 0);
    var openEnd = props.getProperty('OPEN_END') === '1'; // first window has no upper date bound
    var refreshUntil = Number(props.getProperty('REFRESH_UNTIL') || 0);
    var countFloor = Number(props.getProperty('COUNT_FLOOR') || 0);
    var threadsDone = Number(props.getProperty('THREADS_DONE') || 0);

    if (!cursorEnd) { // very first run
      cursorEnd = nowSec_() + 86400;
      offset = 0;
      openEnd = true;
      span = CONFIG.WINDOW_DAYS;
    } else if (offset > 0 && span > 1) {
      // Previous execution stopped mid-window. Gmail's result order can
      // shift between executions, so a stale offset could silently skip
      // threads. Restart the window from the top with a smaller span —
      // re-scanning is harmless (merging is idempotent), skipping isn't.
      span = Math.max(1, Math.floor(span / 2));
      offset = 0;
    }

    var done = false;
    var errorMsg = '';

    try {
      while (Date.now() < deadline) {
        if (props.getProperty('STATE') !== 'RUNNING') break; // paused/reset

        var windowStart = cursorEnd - span * 86400;
        var finalWindow = windowStart <= FLOOR_SEC;
        var effStart = finalWindow ? 0 : windowStart;
        var query = buildQuery_(effStart, openEnd ? 0 : cursorEnd);
        var threads = GmailApp.search(query, offset, CONFIG.THREADS_PER_SEARCH);

        if (threads.length > 0) {
          processThreads_(threads, book, own, {
            floor: countFloor,
            winStart: effStart,
            winEnd: openEnd ? 0 : cursorEnd
          });
          offset += threads.length;
          threadsDone += threads.length;
        } else {
          // this window is exhausted — finish, or move to the next one
          if (mode === 'REFRESH' && windowStart <= refreshUntil) { done = true; break; }
          if (mode === 'FULL' && (finalWindow || !hasOlderMail_(windowStart))) { done = true; break; }
          cursorEnd = windowStart;
          span = CONFIG.WINDOW_DAYS;
          offset = 0;
          openEnd = false;
        }
      }
    } catch (e) {
      errorMsg = String((e && e.message) || e);
    }

    // If a Reset wiped the state while we were working, discard
    // everything — persisting now would resurrect the erased progress.
    var stateNow = props.getProperty('STATE');
    if (stateNow === null) return;

    // Persist progress. Contact merging is idempotent, so re-scanning a
    // batch after a crash is harmless.
    saveContacts_(sheet, book);
    props.setProperties({
      CURSOR_END: String(cursorEnd),
      SPAN_DAYS: String(span),
      OFFSET: String(offset),
      OPEN_END: openEnd ? '1' : '0',
      THREADS_DONE: String(threadsDone),
      LAST_ERROR: errorMsg
    });

    var contactCount = Object.keys(book.map).length;

    if (done) {
      props.setProperty('STATE', 'DONE');
      deleteTriggersFor_('watchdogTick');
      updateStatus_(ss, props, contactCount);
      onComplete_(ss, mode, threadsDone, contactCount);
    } else if (stateNow === 'RUNNING') {
      // on error, back off for 30 min (e.g. daily Gmail quota reached)
      scheduleContinue_(errorMsg ? 30 * 60 * 1000 : CONFIG.CONTINUE_DELAY_MS);
      updateStatus_(ss, props, contactCount);
    } else {
      updateStatus_(ss, props, contactCount); // paused — no reschedule
    }
  } catch (outer) {
    // unexpected failure before/after the main loop — keep the chain alive
    try {
      var p = PropertiesService.getScriptProperties();
      p.setProperty('LAST_ERROR', String((outer && outer.message) || outer));
      if (p.getProperty('STATE') === 'RUNNING') scheduleContinue_(30 * 60 * 1000);
    } catch (ignore) {}
  } finally {
    lock.releaseLock();
  }
}

function buildQuery_(startSec, endSec) {
  var q = (CONFIG.INCLUDE_SPAM_TRASH ? 'in:anywhere ' : '') +
    '{' + CONFIG.KEYWORDS.join(' ') + '}';
  if (startSec) q += ' after:' + (startSec - 1);
  if (endSec) q += ' before:' + endSec;
  return q;
}

function hasOlderMail_(beforeSec) {
  var q = (CONFIG.INCLUDE_SPAM_TRASH ? 'in:anywhere ' : '') +
    '{' + CONFIG.KEYWORDS.join(' ') + '}' +
    ' before:' + beforeSec;
  return GmailApp.search(q, 0, 1).length > 0;
}

function processThreads_(threads, book, own, counting) {
  var messagesByThread = GmailApp.getMessagesForThreads(threads);
  messagesByThread.forEach(function (messages) {
    messages.forEach(function (msg) {
      var date, subject, senders, recipients;
      try {
        date = msg.getDate();
        subject = msg.getSubject() || '';
        senders = extractAddresses_(msg.getFrom());
        recipients = extractAddresses_(
          [msg.getTo(), msg.getCc(), msg.getBcc()].join(',')
        );
      } catch (e) {
        return; // skip unreadable message, keep going
      }

      // Count a message only when it belongs to the current scan window
      // and is newer than the counting floor — this keeps "Messages"
      // honest across window overlaps and weekly rescans.
      var msgSec = Math.floor(date.getTime() / 1000);
      var inWindow = (!counting.winStart || msgSec >= counting.winStart) &&
                     (!counting.winEnd || msgSec < counting.winEnd);
      var shouldCount = inWindow && msgSec > counting.floor;

      var sentByUs = senders.some(function (p) { return isOwn_(p.email, own); });

      // merge every address in this message once, with combined flags
      var perMessage = {};
      senders.forEach(function (p) {
        var e = perMessage[p.email] || (perMessage[p.email] = { name: '', received: false, sent: false });
        if (p.name.length > e.name.length) e.name = p.name;
        if (!sentByUs) e.received = true;   // they wrote a mail that landed in our box
      });
      recipients.forEach(function (p) {
        var e = perMessage[p.email] || (perMessage[p.email] = { name: '', received: false, sent: false });
        if (p.name.length > e.name.length) e.name = p.name;
        if (sentByUs) e.sent = true;        // we wrote to them
      });

      Object.keys(perMessage).forEach(function (email) {
        addContact_(book.map, email, perMessage[email], date, subject, own, shouldCount);
      });
    });
  });
}

function addContact_(map, email, info, date, subject, own, shouldCount) {
  if (!email || isOwn_(email, own) || isExcluded_(email)) return;
  var c = map[email];
  if (!c) {
    c = map[email] = {
      email: email, name: '', domain: companyDomain_(email),
      sent: false, received: false,
      first: null, last: null, count: 0, subject: '', row: 0
    };
  }
  if (shouldCount || c.count === 0) c.count++;
  var name = cleanName_(info.name);
  if (name && name.length > c.name.length) c.name = name;
  if (info.sent) c.sent = true;
  if (info.received) c.received = true;
  if (!c.first || date < c.first) c.first = date;
  if (!c.last || date >= c.last) {
    c.last = date;
    if (subject) c.subject = subject.substring(0, 120);
  }
}

// ------------------------------------------------------------------
//  ADDRESS PARSING & FILTERS
// ------------------------------------------------------------------
function extractAddresses_(headerString) {
  var results = [];
  if (!headerString) return results;
  var re = /(?:"([^"]*)"\s*|([^<>,;"]*?)\s*)?<([A-Za-z0-9._%+\-']+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})>|([A-Za-z0-9._%+\-']+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})/g;
  var m;
  while ((m = re.exec(headerString)) !== null) {
    var email = (m[3] || m[4] || '').toLowerCase();
    if (!email) continue;
    results.push({ email: email, name: (m[1] || m[2] || '').trim() });
  }
  return results;
}

function cleanName_(name) {
  if (!name) return '';
  var n = name
    .replace(/^[\s"']+|[\s"']+$/g, '')
    .replace(/\\"/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
  if (n.indexOf('@') !== -1) return ''; // it's just the email repeated
  return n;
}

function buildOwnIdentity_() {
  var me = '';
  try { me = String(Session.getEffectiveUser().getEmail() || '').toLowerCase(); } catch (e) {}
  return {
    email: me,
    domains: CONFIG.OWN_DOMAINS.map(function (d) { return d.toLowerCase(); })
  };
}

function isOwn_(email, own) {
  if (own.email && email === own.email) return true;
  var at = email.lastIndexOf('@');
  if (at === -1) return false;
  var domain = email.substring(at + 1);
  return own.domains.some(function (d) {
    return domain === d || endsWith_(domain, '.' + d);
  });
}

function isExcluded_(email) {
  for (var i = 0; i < CONFIG.EXCLUDE_PATTERNS.length; i++) {
    if (email.indexOf(CONFIG.EXCLUDE_PATTERNS[i]) !== -1) return true;
  }
  return false;
}

function companyDomain_(email) {
  var at = email.lastIndexOf('@');
  if (at === -1) return '';
  var domain = email.substring(at + 1);
  return CONFIG.FREEMAIL_DOMAINS.indexOf(domain) !== -1 ? '' : domain;
}

function endsWith_(str, suffix) {
  return str.length >= suffix.length &&
    str.substring(str.length - suffix.length) === suffix;
}

// ------------------------------------------------------------------
//  SHEET I/O
// ------------------------------------------------------------------
function ensureContactSheet_(ss) {
  var sheet = ss.getSheetByName(CONFIG.CONTACT_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.CONTACT_SHEET);
    writeHeaders_(sheet);
    return sheet;
  }
  var a1 = String(sheet.getRange(1, 1).getValue());
  if (a1 === 'Email') return sheet; // already ours (v2)

  if (a1 === 'Email Address') {
    // v1 sheet: keep it untouched as a backup, import its emails
    var last = sheet.getLastRow();
    var oldEmails = last > 1 ? sheet.getRange(2, 1, last - 1, 1).getValues() : [];
    renameAside_(ss, sheet, CONFIG.CONTACT_SHEET + ' (v1 backup)');
    var fresh = ss.insertSheet(CONFIG.CONTACT_SHEET);
    writeHeaders_(fresh);
    var rows = [];
    oldEmails.forEach(function (r) {
      var e = String(r[0] || '').trim().toLowerCase();
      if (e && e.indexOf('@') !== -1) {
        rows.push([e, '', companyDomain_(e), '', '', '', 0, '']);
      }
    });
    if (rows.length) {
      ensureRows_(fresh, rows.length + 1);
      fresh.getRange(2, 1, rows.length, HEADERS.length).setValues(rows);
    }
    return fresh;
  }

  if (sheet.getLastRow() === 0) { // empty sheet with our name — adopt it
    writeHeaders_(sheet);
    return sheet;
  }

  // An unrelated sheet occupies our name — move it aside untouched.
  var newName = renameAside_(ss, sheet, CONFIG.CONTACT_SHEET + ' (old)');
  var fresh2 = ss.insertSheet(CONFIG.CONTACT_SHEET);
  writeHeaders_(fresh2);
  try {
    PropertiesService.getScriptProperties().setProperty('LAST_ERROR',
      'A sheet named "' + CONFIG.CONTACT_SHEET + '" already existed with other data — it was renamed to "' + newName + '" and left untouched.');
  } catch (e) {}
  return fresh2;
}

function renameAside_(ss, sheet, base) {
  var name = base;
  var i = 2;
  while (ss.getSheetByName(name)) { name = base + ' ' + i; i++; }
  sheet.setName(name);
  return name;
}

function writeHeaders_(sheet) {
  sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
  sheet.setFrozenRows(1);
  try {
    sheet.setColumnWidth(1, 230); // Email
    sheet.setColumnWidth(2, 170); // Name
    sheet.setColumnWidth(3, 150); // Company
    sheet.setColumnWidth(4, 120); // Direction
    sheet.setColumnWidth(5, 110); // First seen
    sheet.setColumnWidth(6, 110); // Last seen
    sheet.setColumnWidth(7, 90);  // Messages
    sheet.setColumnWidth(8, 330); // Subject
    sheet.getRange(2, 5, sheet.getMaxRows() - 1, 2).setNumberFormat('dd mmm yyyy');
    if (!sheet.getFilter()) {
      // full-width filter so user-added columns travel along when sorting
      sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns()).createFilter();
    }
  } catch (e) {} // cosmetics only — never block the run
}

// Reads the contact sheet into { map: {email -> contact}, origRows: [...] }.
// Each contact remembers its sheet row so saves are position-stable.
function loadContacts_(sheet) {
  var book = { map: {}, origRows: [] };
  var last = sheet.getLastRow();
  if (last < 2) return book;
  book.origRows = sheet.getRange(2, 1, last - 1, HEADERS.length).getValues();
  book.origRows.forEach(function (row, i) {
    var email = String(row[0] || '').trim().toLowerCase();
    if (!email || email.indexOf('@') === -1) return;
    var dir = String(row[3] || '');
    var c = {
      email: email,
      name: String(row[1] || ''),
      domain: String(row[2] || '') || companyDomain_(email),
      sent: dir === 'Sent to' || dir === 'Both',
      received: dir === 'Received from' || dir === 'Both',
      first: row[4] instanceof Date ? row[4] : null,
      last: row[5] instanceof Date ? row[5] : null,
      count: Number(row[6]) || 0,
      subject: String(row[7] || ''),
      row: i + 2
    };
    // if the same email somehow appears twice, keep the fuller row
    var existing = book.map[email];
    if (!existing || c.count >= existing.count) book.map[email] = c;
  });
  return book;
}

// Writes contacts back WITHOUT clearing first and WITHOUT re-sorting:
// existing contacts overwrite their own rows in place, new contacts are
// appended at the bottom. Rows never move, so columns the user adds
// beyond "Last subject" (Notes etc.) stay attached to their contact,
// and a crash mid-write can never wipe the sheet.
function saveContacts_(sheet, book) {
  var out = book.origRows.map(function (r) { return r.slice(); });
  var fresh = [];
  Object.keys(book.map).forEach(function (k) {
    var c = book.map[k];
    if (c.row) out[c.row - 2] = contactRow_(c);
    else fresh.push(c);
  });
  fresh.sort(function (a, b) {
    return (b.count - a.count) || (a.email < b.email ? -1 : 1);
  });
  ensureRows_(sheet, out.length + fresh.length + 1);
  if (out.length) {
    sheet.getRange(2, 1, out.length, HEADERS.length).setValues(out);
  }
  if (fresh.length) {
    sheet.getRange(out.length + 2, 1, fresh.length, HEADERS.length)
      .setValues(fresh.map(contactRow_));
  }
  SpreadsheetApp.flush(); // commit the data before the cursor advances
}

// Bulk setValues cannot write past the sheet's grid — grow it first.
function ensureRows_(sheet, needed) {
  var max = sheet.getMaxRows();
  if (needed > max) sheet.insertRowsAfter(max, needed - max);
}

function contactRow_(c) {
  return [
    c.email, c.name, c.domain, directionText_(c),
    c.first || '', c.last || '', c.count, c.subject
  ];
}

function directionText_(c) {
  if (c.sent && c.received) return 'Both';
  if (c.sent) return 'Sent to';
  if (c.received) return 'Received from';
  return 'On shared thread';
}

// ------------------------------------------------------------------
//  STATUS TAB
// ------------------------------------------------------------------
function ensureStatusSheet_(ss) {
  var sheet = ss.getSheetByName(CONFIG.STATUS_SHEET);
  if (sheet && String(sheet.getRange('A1').getValue()) === STATUS_MARKER) return sheet;
  if (sheet && sheet.getLastRow() > 0) {
    renameAside_(ss, sheet, CONFIG.STATUS_SHEET + ' (old)'); // unrelated sheet — keep it safe
    sheet = null;
  }
  if (!sheet) sheet = ss.insertSheet(CONFIG.STATUS_SHEET);
  sheet.getRange('A1').setValue(STATUS_MARKER).setFontWeight('bold').setFontSize(13);
  sheet.getRange('A3:A10').setValues([
    ['State'], ['Mode'], ['Contacts collected'], ['Email threads scanned'],
    ['Now scanning around'], ['Last run'], ['Next automatic run'], ['Last error']
  ]).setFontWeight('bold');
  sheet.getRange('A12').setValue(
    'The extractor runs by itself on Google\'s servers — you can close ' +
    'this sheet and switch off the computer. It scans the mailbox in ' +
    'slices from newest to oldest and updates "' + CONFIG.CONTACT_SHEET +
    '" after every run. You will get an email when the full scan finishes.'
  );
  sheet.getRange('A13').setValue(
    'Big mailboxes take a few days: Google allows ~90 min of background ' +
    'script time per day. On those days Google may email you a "Summary ' +
    'of failures" — that is normal; the extractor resumes by itself.'
  );
  sheet.getRange('A14').setValue(
    'Tip: you can add your own columns (Notes, Priority, …) to the right ' +
    'of "Last subject" in the contacts sheet — rows never move, so your ' +
    'notes stay attached to the right contact. When sorting manually, ' +
    'use the filter arrows in the header row.'
  );
  sheet.setColumnWidth(1, 190);
  sheet.setColumnWidth(2, 420);
  return sheet;
}

function updateStatus_(ss, props, contactCount) {
  try {
    var sheet = ensureStatusSheet_(ss);
    var tz = Session.getScriptTimeZone();
    var state = props.getProperty('STATE') || 'IDLE';
    var stateLabel =
      state === 'RUNNING' ? 'RUNNING (automatic)' :
      state === 'DONE' ? 'FINISHED' : state;
    var mode = props.getProperty('MODE') === 'REFRESH'
      ? 'Rescan of recent mail (last ' + CONFIG.RESCAN_DAYS + ' days)'
      : 'Full mailbox scan';
    var nextRunAt = Number(props.getProperty('NEXT_RUN_AT') || 0);
    var nextRun = (state === 'RUNNING' && nextRunAt > Date.now())
      ? Utilities.formatDate(new Date(nextRunAt), tz, 'dd MMM yyyy HH:mm')
      : '—';
    sheet.getRange('B3:B10').setValues([
      [stateLabel],
      [mode],
      [contactCount],
      [Number(props.getProperty('THREADS_DONE') || 0)],
      [state === 'DONE' ? '—' : cursorLabel_(props)],
      [Utilities.formatDate(new Date(), tz, 'dd MMM yyyy HH:mm')],
      [nextRun],
      [props.getProperty('LAST_ERROR') || 'none']
    ]);
  } catch (e) {} // status display must never break the extraction
}

function cursorLabel_(props) {
  var cursorEnd = Number(props.getProperty('CURSOR_END') || 0);
  if (!cursorEnd) return 'not started yet';
  var tz = Session.getScriptTimeZone();
  return Utilities.formatDate(new Date(cursorEnd * 1000), tz, 'dd MMM yyyy');
}

// ------------------------------------------------------------------
//  COMPLETION, TRIGGERS & HELPERS
// ------------------------------------------------------------------
function onComplete_(ss, mode, threadsDone, contactCount) {
  deleteTriggersFor_('processBatch');

  if (CONFIG.AUTO_REFRESH_DAYS > 0) {
    deleteTriggersFor_('startWeeklyRefresh');
    ScriptApp.newTrigger('startWeeklyRefresh').timeBased()
      .at(new Date(Date.now() + CONFIG.AUTO_REFRESH_DAYS * 24 * 3600 * 1000))
      .create();
  }

  var what = mode === 'REFRESH'
    ? 'Rescan of the last ' + CONFIG.RESCAN_DAYS + ' days is complete.'
    : 'Full mailbox scan is complete.';
  var refreshNote = CONFIG.AUTO_REFRESH_DAYS > 0
    ? 'New mail will be picked up automatically every ' + CONFIG.AUTO_REFRESH_DAYS + ' days.'
    : 'Use "Rescan recent mail" from the menu to pick up new mail later.';

  if (CONFIG.SEND_COMPLETION_EMAIL) {
    try {
      var me = Session.getEffectiveUser().getEmail();
      if (me) {
        MailApp.sendEmail(
          me,
          'Pharma Contact Extractor — finished (' + contactCount + ' contacts)',
          what + '\n\n' +
          'Contacts collected: ' + contactCount + '\n' +
          'Email threads scanned: ' + threadsDone + '\n\n' +
          refreshNote + '\n\n' +
          'Open the sheet: ' + ss.getUrl()
        );
      }
    } catch (e) {}
  }
  safeToast_(what + ' ' + contactCount + ' contacts collected.');
}

function beginRefresh_() {
  var props = PropertiesService.getScriptProperties();
  // Count only messages newer than the last completed scan, so weekly
  // rescans never inflate the "Messages" numbers.
  var floor = Number(props.getProperty('LAST_SCAN_STARTED') || 0) ||
    (nowSec_() - CONFIG.RESCAN_DAYS * 86400);
  props.setProperties({
    STATE: 'RUNNING',
    MODE: 'REFRESH',
    CURSOR_END: String(nowSec_() + 86400),
    SPAN_DAYS: String(CONFIG.WINDOW_DAYS),
    OFFSET: '0',
    OPEN_END: '1',
    REFRESH_UNTIL: String(nowSec_() - CONFIG.RESCAN_DAYS * 86400),
    COUNT_FLOOR: String(floor),
    LAST_SCAN_STARTED: String(nowSec_()),
    LAST_ERROR: ''
  });
}

// Single scheduling point: clears spent/stale triggers first (fired
// one-off triggers are NOT auto-removed) and stamps the heartbeat the
// watchdog relies on.
function scheduleContinue_(delayMs) {
  deleteTriggersFor_('processBatch');
  PropertiesService.getScriptProperties()
    .setProperty('NEXT_RUN_AT', String(Date.now() + delayMs));
  ScriptApp.newTrigger('processBatch').timeBased().after(delayMs).create();
}

function ensureWatchdog_() {
  var exists = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'watchdogTick';
  });
  if (!exists) {
    ScriptApp.newTrigger('watchdogTick').timeBased().everyHours(6).create();
  }
}

function deleteTriggersFor_(handlerName) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === handlerName) ScriptApp.deleteTrigger(t);
  });
}

function nowSec_() {
  return Math.floor(Date.now() / 1000);
}

function safeToast_(msg) {
  try { SpreadsheetApp.getActiveSpreadsheet().toast(msg, 'Pharma Extractor', 10); } catch (e) {}
}

function safeAlert_(msg) {
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { safeToast_(msg); }
}
