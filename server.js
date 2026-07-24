/**
 * Pharma Contact Extractor — standalone web app.
 *
 * Sign in with Google (Gmail read-only), scan the mailbox for
 * pharma-related conversations, extract contacts (email, name, company
 * domain, direction, first/last seen, message count, last subject) and
 * download them as CSV.
 *
 * Required environment variables (see .env.example):
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET  — OAuth client (Web application)
 *   APP_URL        — public base URL, e.g. https://your-app.onrender.com
 *   SESSION_SECRET — any long random string
 *   PORT           — set automatically by Render
 */
require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const { google } = require('googleapis');

const PORT = process.env.PORT || 3000;
const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const IS_PROD = process.env.NODE_ENV === 'production';

// ------------------------------------------------------------------
//  Defaults (the UI lets the user edit keywords / own domains per scan)
// ------------------------------------------------------------------
const DEFAULT_KEYWORDS = [
  'pharma', 'pharmaceutical', 'pharmaceuticals', 'medicine', 'medicines',
  'drug', 'drugs', 'vaccine', 'vaccines', 'oncology', 'hospital',
  'formulation', 'formulations', 'medical', 'surgical', 'injection',
  'tablet', 'tablets', 'capsule', 'capsules', 'tender', '"cold chain"',
  'manufacturer', 'distributor'
];

const EXCLUDE_PATTERNS = [
  'noreply', 'no-reply', 'no_reply', 'donotreply', 'do-not-reply',
  'mailer-daemon', 'postmaster', 'bounce', 'unsubscribe',
  'notifications@', 'newsletter@', 'alerts@'
];

const FREEMAIL_DOMAINS = [
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'ymail.com',
  'hotmail.com', 'outlook.com', 'live.com', 'aol.com', 'rediffmail.com',
  'icloud.com', 'protonmail.com', 'proton.me', 'zoho.com', 'zohomail.in',
  'mail.com'
];

const LIST_PAGE_SIZE = 500;   // message ids per Gmail list call
const FETCH_CONCURRENCY = 20; // parallel metadata fetches (stays under quota)

// ------------------------------------------------------------------
//  App setup
// ------------------------------------------------------------------
const app = express();
app.set('trust proxy', 1); // Render terminates TLS in front of us
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PROD,
    maxAge: 7 * 24 * 3600 * 1000
  }
}));

// One scan job per browser session, kept in memory.
// (Render's free tier has no persistent disk — download the CSV when done.)
const jobs = new Map();

function makeOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    APP_URL + '/oauth2callback'
  );
}

// ------------------------------------------------------------------
//  OAuth flow
// ------------------------------------------------------------------
app.get('/auth/google', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.redirect('/?error=not_configured');
  }
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  const url = makeOAuthClient().generateAuthUrl({
    access_type: 'offline',       // refresh token → scans longer than 1h keep working
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/userinfo.email'
    ],
    state
  });
  res.redirect(url);
});

app.get('/oauth2callback', async (req, res) => {
  try {
    if (req.query.error) return res.redirect('/?error=' + encodeURIComponent(req.query.error));
    if (!req.query.state || req.query.state !== req.session.oauthState) {
      return res.status(400).send('Invalid OAuth state. Please go back and try signing in again.');
    }
    delete req.session.oauthState;

    const client = makeOAuthClient();
    const { tokens } = await client.getToken(String(req.query.code));
    client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const me = await oauth2.userinfo.get();

    req.session.tokens = tokens;
    req.session.email = (me.data.email || '').toLowerCase();
    res.redirect('/');
  } catch (err) {
    console.error('OAuth callback failed:', err.message);
    res.redirect('/?error=signin_failed');
  }
});

app.post('/api/logout', (req, res) => {
  const job = jobs.get(req.session.id);
  if (job) job.cancelled = true;
  jobs.delete(req.session.id);
  req.session.destroy(() => res.json({ ok: true }));
});

// ------------------------------------------------------------------
//  API
// ------------------------------------------------------------------
app.get('/api/me', (req, res) => {
  res.json({
    email: req.session.email || null,
    defaults: { keywords: DEFAULT_KEYWORDS, ownDomains: [] }
  });
});

app.post('/api/scan', (req, res) => {
  if (!req.session.tokens) return res.status(401).json({ error: 'Not signed in.' });
  const existing = jobs.get(req.session.id);
  if (existing && existing.state === 'running') {
    return res.status(409).json({ error: 'A scan is already running.' });
  }

  const body = req.body || {};
  const keywords = sanitizeKeywords(body.keywords);
  if (!keywords.length) return res.status(400).json({ error: 'Add at least one keyword.' });

  const opts = {
    keywords,
    includeSpamTrash: body.includeSpamTrash !== false,
    ownDomains: sanitizeDomains(body.ownDomains),
    ownEmail: req.session.email || '',
    maxMessages: Number(body.maxMessages) > 0 ? Number(body.maxMessages) : 0
  };

  const job = {
    state: 'running',
    startedAt: Date.now(),
    finishedAt: 0,
    scanned: 0,
    estimate: 0,
    error: '',
    cancelled: false,
    contacts: new Map(),
    opts
  };
  jobs.set(req.session.id, job);

  const client = makeOAuthClient();
  client.setCredentials(req.session.tokens);

  runScan(job, client).catch(err => {
    job.state = 'error';
    job.error = friendlyError(err);
    job.finishedAt = Date.now();
    console.error('Scan failed:', err.message);
  });

  res.json({ ok: true });
});

app.post('/api/stop', (req, res) => {
  const job = jobs.get(req.session.id);
  if (job && job.state === 'running') job.cancelled = true;
  res.json({ ok: true });
});

app.get('/api/progress', (req, res) => {
  const job = jobs.get(req.session.id);
  if (!job) return res.json({ state: 'idle' });
  res.json({
    state: job.state,
    scanned: job.scanned,
    estimate: job.estimate,
    contacts: job.contacts.size,
    error: job.error,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt
  });
});

app.get('/api/contacts', (req, res) => {
  const job = jobs.get(req.session.id);
  if (!job) return res.json({ rows: [] });
  const limit = Math.min(Number(req.query.limit) || 200, 2000);
  res.json({ rows: sortedContacts(job).slice(0, limit).map(contactJson) });
});

app.get('/api/export.csv', (req, res) => {
  const job = jobs.get(req.session.id);
  if (!job || job.contacts.size === 0) {
    return res.status(404).send('No contacts yet — run a scan first.');
  }
  const header = ['Email', 'Name', 'Company (domain)', 'Direction',
    'First seen', 'Last seen', 'Messages', 'Last subject'];
  const lines = [header.join(',')];
  sortedContacts(job).forEach(c => {
    lines.push([
      c.email, c.name, c.domain, directionText(c),
      isoDate(c.first), isoDate(c.last), String(c.count), c.subject
    ].map(csvEscape).join(','));
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="pharma-contacts.csv"');
  res.send('﻿' + lines.join('\r\n')); // BOM so Excel opens it as UTF-8
});

app.get('/healthz', (req, res) => res.send('ok'));

// ------------------------------------------------------------------
//  Scan engine (Gmail API)
// ------------------------------------------------------------------
async function runScan(job, auth) {
  const gmail = google.gmail({ version: 'v1', auth });
  const q = '{' + job.opts.keywords.join(' ') + '}';
  let pageToken;

  do {
    if (job.cancelled) break;
    const list = await withRetry(() => gmail.users.messages.list({
      userId: 'me',
      q,
      includeSpamTrash: job.opts.includeSpamTrash,
      maxResults: LIST_PAGE_SIZE,
      pageToken
    }));
    if (list.data.resultSizeEstimate) job.estimate = list.data.resultSizeEstimate;
    const messages = list.data.messages || [];

    for (let i = 0; i < messages.length && !job.cancelled; i += FETCH_CONCURRENCY) {
      const chunk = messages.slice(i, i + FETCH_CONCURRENCY);
      const metas = await Promise.all(chunk.map(m =>
        withRetry(() => gmail.users.messages.get({
          userId: 'me',
          id: m.id,
          format: 'metadata',
          metadataHeaders: ['From', 'To', 'Cc', 'Bcc', 'Subject']
        })).catch(() => null) // skip unreadable messages, keep going
      ));
      metas.forEach(r => { if (r) mergeMessage(job, r.data); });
      job.scanned += chunk.length;
      if (job.opts.maxMessages && job.scanned >= job.opts.maxMessages) { job.cancelled = true; }
    }
    pageToken = list.data.nextPageToken;
  } while (pageToken && !job.cancelled);

  job.state = job.cancelled && job.opts.maxMessages && job.scanned >= job.opts.maxMessages
    ? 'done'
    : (job.cancelled ? 'stopped' : 'done');
  job.finishedAt = Date.now();
}

function mergeMessage(job, msg) {
  const headers = {};
  ((msg.payload && msg.payload.headers) || []).forEach(h => {
    headers[h.name.toLowerCase()] = h.value || '';
  });
  const date = new Date(Number(msg.internalDate) || Date.now());
  const subject = headers['subject'] || '';
  const senders = extractAddresses(headers['from'] || '');
  const recipients = extractAddresses(
    [headers['to'], headers['cc'], headers['bcc']].filter(Boolean).join(',')
  );

  const sentByUs = senders.some(p => isOwn(p.email, job.opts));

  // merge every address in this message once, with combined flags
  const perMessage = new Map();
  senders.forEach(p => {
    const e = perMessage.get(p.email) || { name: '', received: false, sent: false };
    if (p.name.length > e.name.length) e.name = p.name;
    if (!sentByUs) e.received = true; // they wrote a mail that landed in this inbox
    perMessage.set(p.email, e);
  });
  recipients.forEach(p => {
    const e = perMessage.get(p.email) || { name: '', received: false, sent: false };
    if (p.name.length > e.name.length) e.name = p.name;
    if (sentByUs) e.sent = true;      // the account owner wrote to them
    perMessage.set(p.email, e);
  });

  perMessage.forEach((info, email) => addContact(job, email, info, date, subject));
}

function addContact(job, email, info, date, subject) {
  if (!email || isOwn(email, job.opts) || isExcluded(email)) return;
  let c = job.contacts.get(email);
  if (!c) {
    c = {
      email, name: '', domain: companyDomain(email),
      sent: false, received: false,
      first: null, last: null, count: 0, subject: ''
    };
    job.contacts.set(email, c);
  }
  c.count++;
  const name = cleanName(info.name);
  if (name && name.length > c.name.length) c.name = name;
  if (info.sent) c.sent = true;
  if (info.received) c.received = true;
  if (!c.first || date < c.first) c.first = date;
  if (!c.last || date >= c.last) {
    c.last = date;
    if (subject) c.subject = subject.substring(0, 160);
  }
}

// ------------------------------------------------------------------
//  Parsing & filters (same logic as the Apps Script version)
// ------------------------------------------------------------------
function extractAddresses(headerString) {
  const results = [];
  if (!headerString) return results;
  const re = /(?:"([^"]*)"\s*|([^<>,;"]*?)\s*)?<([A-Za-z0-9._%+\-']+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})>|([A-Za-z0-9._%+\-']+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})/g;
  let m;
  while ((m = re.exec(headerString)) !== null) {
    const email = (m[3] || m[4] || '').toLowerCase();
    if (!email) continue;
    results.push({ email, name: (m[1] || m[2] || '').trim() });
  }
  return results;
}

function cleanName(name) {
  if (!name) return '';
  const n = name
    .replace(/^[\s"']+|[\s"']+$/g, '')
    .replace(/\\"/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
  return n.indexOf('@') !== -1 ? '' : n;
}

function isOwn(email, opts) {
  if (opts.ownEmail && email === opts.ownEmail) return true;
  const at = email.lastIndexOf('@');
  if (at === -1) return false;
  const domain = email.substring(at + 1);
  return opts.ownDomains.some(d => domain === d || domain.endsWith('.' + d));
}

function isExcluded(email) {
  return EXCLUDE_PATTERNS.some(p => email.includes(p));
}

function companyDomain(email) {
  const at = email.lastIndexOf('@');
  if (at === -1) return '';
  const domain = email.substring(at + 1);
  return FREEMAIL_DOMAINS.includes(domain) ? '' : domain;
}

function directionText(c) {
  if (c.sent && c.received) return 'Both';
  if (c.sent) return 'Sent to';
  if (c.received) return 'Received from';
  return 'On shared thread';
}

// ------------------------------------------------------------------
//  Helpers
// ------------------------------------------------------------------
function sanitizeKeywords(input) {
  if (!Array.isArray(input)) return DEFAULT_KEYWORDS;
  return input
    .map(k => String(k).trim())
    .filter(k => k && k.length <= 60 && !/[{}]/.test(k))
    .slice(0, 60);
}

function sanitizeDomains(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map(d => String(d).trim().toLowerCase().replace(/^@/, ''))
    .filter(d => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d))
    .slice(0, 20);
}

function sortedContacts(job) {
  return Array.from(job.contacts.values())
    .sort((a, b) => (b.count - a.count) || (a.email < b.email ? -1 : 1));
}

function contactJson(c) {
  return {
    email: c.email, name: c.name, domain: c.domain,
    direction: directionText(c),
    first: isoDate(c.first), last: isoDate(c.last),
    count: c.count, subject: c.subject
  };
}

function isoDate(d) {
  return d instanceof Date && !isNaN(d) ? d.toISOString().slice(0, 10) : '';
}

function csvEscape(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

async function withRetry(fn, tries = 5) {
  let delay = 1000;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err && (err.code || (err.response && err.response.status));
      const reason = String(
        (err && err.errors && err.errors[0] && err.errors[0].reason) || ''
      );
      const retriable =
        status === 429 || status >= 500 ||
        (status === 403 && /ratelimit|userratelimit|quota/i.test(reason));
      if (!retriable || attempt >= tries) throw err;
      await new Promise(r => setTimeout(r, delay + Math.random() * 500));
      delay = Math.min(delay * 2, 30000);
    }
  }
}

function friendlyError(err) {
  const status = err && (err.code || (err.response && err.response.status));
  const msg = (err && err.message) || '';
  const reason = String(
    (err && err.errors && err.errors[0] && err.errors[0].reason) || ''
  );
  if (reason === 'accessNotConfigured' || /has not been used in project|api.*disabled/i.test(msg)) {
    return 'The Gmail API is switched OFF in your Google Cloud project. Go to ' +
      'console.cloud.google.com → APIs & Services → Library → search "Gmail API" → Enable, ' +
      'wait 2 minutes, then click Start scan again.';
  }
  if (status === 401) return 'Google sign-in expired — please disconnect and sign in again.';
  if (status === 403) return 'Gmail said no (permission or quota issue). Wait a bit and try again.';
  return 'Scan failed: ' + (msg || 'unknown error');
}

app.listen(PORT, () => {
  console.log(`Pharma Contact Extractor running on ${APP_URL} (port ${PORT})`);
});
