// Built-in webmail: mailbox login, folders, reading, composing, replies,
// deleting and local delivery between hosted mailboxes. This is the webmail
// that always works; Roundcube is offered as an alternative when installed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { all, get, run, nowIso, verifyPassword, setting } from '../db.mjs';
import { config, VERSION } from '../config.mjs';
import { html as h, raw, formatDate, formatBytes, timeAgo, e, isEmail } from '../util.mjs';
import { icon } from '../ui/icons.mjs';
import { pctClass } from '../ui/components.mjs';
import { sendMail, mtaStatus } from '../mta.mjs';
import { systemProvider } from '../providers/index.mjs';
import { syncMaildirs } from '../maildir.mjs';
import { checkDisk } from '../quota.mjs';
import { hashSessionToken } from '../auth.mjs';

const COOKIE = 'OA_WEBMAIL';
const FOLDERS = ['INBOX', 'Drafts', 'Sent', 'Trash'];
const TTL_HOURS = 8;

function mailSession(token) {
  if (!token) return null;
  const hash = hashSessionToken(token);
  let row = get('SELECT * FROM webmail_sessions WHERE token = ?', hash);
  if (!row) {
    // One-time migration for sessions created before token hashing.
    row = get('SELECT * FROM webmail_sessions WHERE token = ?', token);
    if (row) {
      run('UPDATE webmail_sessions SET token = ? WHERE token = ?', hash, token);
      row = { ...row, token: hash };
    }
  }
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    run('DELETE FROM webmail_sessions WHERE token = ?', hash);
    return null;
  }
  const account = get('SELECT * FROM email_accounts WHERE local_part || char(64) || domain = ?', row.mailbox);
  if (!account || account.suspended) return null;
  return { session: row, account, mailbox: row.mailbox };
}

function createSession(mailbox) {
  const token = crypto.randomBytes(28).toString('hex');
  const expires = new Date(Date.now() + TTL_HOURS * 3600 * 1000).toISOString();
  run('INSERT INTO webmail_sessions(token, mailbox, created_at, expires_at) VALUES(?,?,?,?)', hashSessionToken(token), mailbox, nowIso(), expires);
  return token;
}

function cookieFor(token, secure = false) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${TTL_HOURS * 3600}${secure ? '; Secure' : ''}`;
}

function attachmentDir() {
  const dir = path.join(config.dataDir, 'webmail', 'attachments');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

const sendWindow = new Map();
const loginWindow = new Map();
function rateLimit(map, key, max, windowMs) {
  const now = Date.now();
  const hits = (map.get(key) || []).filter((t) => now - t < windowMs);
  if (hits.length >= max) { map.set(key, hits); return false; }
  hits.push(now);
  map.set(key, hits);
  return true;
}

function recentFailures(map, key, windowMs) {
  const now = Date.now();
  return (map.get(key) || []).filter((t) => now - t < windowMs);
}

function recordFailure(map, key) {
  const hits = recentFailures(map, key, 15 * 60 * 1000);
  hits.push(Date.now());
  map.set(key, hits);
}

function safeAttachment(token) {
  const base = path.basename(String(token));
  const file = path.join(attachmentDir(), base);
  return file.startsWith(attachmentDir()) && fs.existsSync(file) ? file : null;
}

const nextUid = (mailbox, folder) => (get('SELECT MAX(uid) m FROM mail_messages WHERE mailbox = ? AND folder = ?', mailbox, folder)?.m || 0) + 1;

function deliver(mailbox, { from, subject, body, folder = 'INBOX', cc = '', seen = 0 }) {
  const r = run(`INSERT INTO mail_messages(mailbox, uid, folder, from_addr, to_addr, cc, subject, body, seen, size_kb, created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`, mailbox, nextUid(mailbox, folder), folder, from, mailbox, cc,
    subject || '(no subject)', body || '', seen, Math.max(1, Math.round((body || '').length / 1024)), nowIso());
  return r.lastInsertRowid;
}

function layout({ title, mailbox = '', body, counts = {}, active = 'INBOX', query = '', message = null }) {
  const folderCount = (f) => (counts[f] || 0);
  return h`<!DOCTYPE html>
<html lang="en" data-skin="evolution">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} · Webmail</title>
  <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/assets/app.css?v=${VERSION}">
</head>
<body class="webmail-body">
  <header class="wm-top">
    <a class="wm-brand" href="/webmail">
      ${raw('<svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#0a6daa"/><path d="M8 11h16v10H8z" fill="none" stroke="#fff" stroke-width="2"/><path d="m8 11 8 6 8-6" fill="none" stroke="#fff" stroke-width="2"/></svg>')}
      <span><strong>Webmail</strong><em>${mailbox || 'OpenAdmin'}</em></span>
    </a>
    <div class="wm-actions">
      ${mailbox ? h`<a class="btn btn-primary btn-sm" href="/webmail?compose=1">${icon('edit', { size: 15 })} Compose</a>
        <a class="btn btn-ghost btn-sm" href="/webmail/logout">${icon('logout', { size: 15 })} Sign out</a>` : ''}
      <a class="btn btn-ghost btn-sm" href="/user/email">${icon('arrowRight', { size: 15 })} Panel</a>
    </div>
  </header>
  ${body}
  <script>
  (function () {
    const input = document.querySelector('[data-wm-attach]');
    const list = document.querySelector('[data-wm-attach-list]');
    const form = document.querySelector('.wm-read form');
    if (!input || !list || !form) return;
    const csrf = form.querySelector('input[name="_csrf"]')?.value || '';
    input.addEventListener('change', async () => {
      for (const file of input.files) {
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        const res = await fetch('/webmail/attach', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ _csrf: csrf, name: file.name, data }),
        });
        const json = await res.json().catch(() => ({}));
        if (!json.ok) { list.textContent = json.error || 'Upload failed'; continue; }
        const hidden = document.createElement('input');
        hidden.type = 'hidden'; hidden.name = 'attachment[]'; hidden.value = json.token;
        form.appendChild(hidden);
        const item = document.createElement('span');
        item.className = 'wm-attach-item';
        item.textContent = file.name;
        list.appendChild(item);
      }
      input.value = '';
    });
  })();
  </script>
</body>
</html>`;
}

function loginPage({ error = '', email = '' }) {
  const mailboxes = all('SELECT local_part, domain FROM email_accounts WHERE suspended = 0 ORDER BY domain, local_part').slice(0, 40);
  const body = h`<div class="wm-login">
    <div class="wm-login-card">
      <h1>Sign in to webmail</h1>
      <p class="small muted">Use the mailbox address and password from your hosting panel.</p>
      ${error ? h`<div class="alert alert-danger">${icon('alert', { size: 18 })}<div>${error}</div></div>` : ''}
      <form method="post" action="/webmail/login" class="oa-form">
        <div class="field"><label class="field-label">E-mail address</label><input name="email" type="email" value="${email}" required autofocus placeholder="you@example.com"></div>
        <div class="field"><label class="field-label">Password</label><input name="password" type="password" required></div>
        <div class="form-actions"><button class="btn btn-primary btn-block" type="submit">Sign in</button></div>
      </form>
      <details class="wm-demo"><summary>Hosted mailboxes (demo)</summary>
        <p class="small muted">${mailboxes.map((m) => `${m.local_part}@${m.domain}`).join(' · ') || 'No mailboxes yet'}</p>
      </details>
    </div>
  </div>`;
  return layout({ title: 'Sign in', body });
}

function folderCounts(mailbox) {
  const rows = all('SELECT folder, COUNT(*) n, SUM(CASE WHEN seen = 0 THEN 1 ELSE 0 END) unread FROM mail_messages WHERE mailbox = ? GROUP BY folder', mailbox);
  const out = {};
  for (const r of rows) out[r.folder] = r.n;
  out._unread = rows.reduce((a, r) => a + (r.unread || 0), 0);
  return out;
}

function sidebar(mailbox, counts, active) {
  return h`<aside class="wm-side">
    ${FOLDERS.map((f) => h`<a class="wm-folder ${f === active ? 'active' : ''}" href="/webmail?folder=${encodeURIComponent(f)}">
      ${icon(f === 'INBOX' ? 'mail' : f === 'Sent' ? 'upload' : f === 'Drafts' ? 'file' : 'trash', { size: 17 })}
      <span>${f === 'INBOX' ? 'Inbox' : f}</span>
      <em>${counts[f] || 0}</em>
    </a>`)}
    <div class="wm-side-foot">
      <div class="small muted">Storage</div>
      <div class="progress"><span class="${pctClass(Math.min(100, Math.round((get('SELECT COALESCE(SUM(size_kb),0) s FROM mail_messages WHERE mailbox = ?', mailbox).s || 0) / Math.max(get('SELECT quota_mb FROM email_accounts WHERE local_part || char(64) || domain = ?', mailbox)?.quota_mb || 1024, 1) * 100 / 1024)))}"></span></div>
      <div class="small muted u-s24">${formatBytes((get('SELECT COALESCE(SUM(size_kb),0) s FROM mail_messages WHERE mailbox = ?', mailbox).s || 0) / 1024)} used</div>
    </div>
  </aside>`;
}

function listPane(mailbox, folder, rows, selectedId, q, page = 1, total = 0) {
  return h`<section class="wm-list">
    <div class="wm-list-head">
      <form method="get" action="/webmail" class="wm-search">
        <input type="hidden" name="folder" value="${folder}">
        ${icon('search', { size: 15 })}
        <input name="q" value="${q || ''}" placeholder="Search ${folder === 'INBOX' ? 'inbox' : folder.toLowerCase()}">
      </form>
      <span class="small muted">${rows.length} of ${total} message(s)</span>
    </div>
    <div class="wm-rows">
      ${rows.length ? rows.map((m) => h`<a class="wm-row ${m.id === selectedId ? 'selected' : ''} ${m.seen ? '' : 'unread'}" href="/webmail?folder=${encodeURIComponent(folder)}&id=${m.id}">
        <span class="wm-from">${folder === 'Sent' ? 'To: ' + m.to_addr : m.from_addr}</span>
        <span class="wm-subj">${m.subject}</span>
        <span class="wm-date">${timeAgo(m.created_at)}</span>
      </a>`) : h`<div class="empty"><p>This folder is empty.</p></div>`}
    </div>
    <div class="wm-pager">
      <span class="small muted">${total > 20 ? `Page ${page} of ${Math.ceil(total / 20)}` : ''}</span>
      <span>
        ${page > 1 ? h`<a class="btn btn-ghost btn-sm" href="/webmail?folder=${encodeURIComponent(folder)}&page=${page - 1}${q ? '&q=' + encodeURIComponent(q) : ''}">Previous</a>` : ''}
        ${page * 20 < total ? h`<a class="btn btn-ghost btn-sm" href="/webmail?folder=${encodeURIComponent(folder)}&page=${page + 1}${q ? '&q=' + encodeURIComponent(q) : ''}">Next</a>` : ''}
      </span>
    </div>
  </section>`;
}

function messagePane(m, mailbox, folder, { reply = false } = {}) {
  if (!m) {
    return h`<section class="wm-read wm-empty"><div class="empty">${icon('mail', { size: 28 })}<h3>No message selected</h3><p>Choose a message from the list or compose a new one.</p><a class="btn btn-primary btn-sm" href="/webmail?compose=1">Compose</a></div></section>`;
  }
  const body = h`<section class="wm-read">
    <header class="wm-read-head">
      <h2>${m.subject}</h2>
      <div class="wm-meta">
        <span><strong>From</strong> ${m.from_addr}</span>
        <span><strong>To</strong> ${m.to_addr}</span>
        <span><strong>Date</strong> ${formatDate(m.created_at, { time: true })}</span>
        ${m.cc ? h`<span><strong>Cc</strong> ${m.cc}</span>` : ''}
      </div>
      <div class="wm-tools">
        <a class="btn btn-secondary btn-sm" href="/webmail?folder=${encodeURIComponent(folder)}&reply=${m.id}">${icon('arrowRight', { size: 14 })} Reply</a>
        <form method="post" action="/webmail/${m.id}/flag" class="inline"><input type="hidden" name="_csrf" value="${csrfFor(mailbox)}">
          <button class="btn btn-ghost btn-sm" type="submit">${icon('star', { size: 14 })} ${m.flagged ? 'Unflag' : 'Flag'}</button></form>
        <form method="post" action="/webmail/${m.id}/delete" class="inline"><input type="hidden" name="_csrf" value="${csrfFor(mailbox)}">
          <button class="btn btn-ghost btn-sm" type="submit">${icon('trash', { size: 14 })} Delete</button></form>
      </div>
    </header>
    <pre class="wm-text">${m.body}</pre>
    ${(() => { const files = all('SELECT * FROM mail_attachments WHERE message_id = ?', m.id); return files.length ? h`<div class="wm-attach">
      ${files.map((f) => h`<a class="wm-attach-item" href="/webmail/attachment/${f.id}">${icon('file', { size: 15 })}<span>${f.filename}</span><em>${formatBytes(f.size_kb / 1024)}</em></a>`)}
    </div>` : ''; })()}
    ${reply ? composePane(mailbox, { to: m.from_addr, subject: m.subject.startsWith('Re:') ? m.subject : 'Re: ' + m.subject, quote: `\n\n--- Original message ---\n${m.body}` }) : ''}
  </section>`;
  return body;
}

function csrfFor(mailbox) {
  // Webmail has its own session; the token is derived from it deterministically.
  const s = get('SELECT token FROM webmail_sessions WHERE mailbox = ? ORDER BY created_at DESC LIMIT 1', mailbox);
  return crypto.createHash('sha256').update(`webmail:${s?.token || ''}`).digest('hex').slice(0, 32);
}

function composePane(mailbox, { to = '', subject = '', quote = '', error = '', draftId = '', sendLabel = 'Send message' } = {}) {
  return h`<section class="wm-read">
    <header class="wm-read-head"><h2>New message</h2></header>
    ${error ? h`<div class="alert alert-danger">${error}</div>` : ''}
    <form method="post" action="/webmail/send" class="oa-form">
      <input type="hidden" name="_csrf" value="${csrfFor(mailbox)}">
      ${draftId ? h`<input type="hidden" name="draft_id" value="${draftId}">` : ''}
      <div class="field"><label class="field-label">To</label><input name="to" type="text" value="${to}" placeholder="one@example.com, two@example.com"></div>
      <div class="field"><label class="field-label">Subject</label><input name="subject" value="${subject}" required></div>
      <div class="field"><label class="field-label">Message</label><textarea name="body" rows="12">${quote}</textarea></div>
      <div class="field">
        <label class="field-label">Attachments</label>
        <input type="file" multiple data-wm-attach>
        <div class="wm-attach-list" data-wm-attach-list></div>
        <p class="field-help">Files upload immediately; they are attached when the message is sent.</p>
      </div>
      <div class="form-actions">
        <button class="btn btn-primary" type="submit">${icon('upload', { size: 16 })} ${sendLabel}</button>
        <button class="btn btn-secondary" type="submit" formaction="/webmail/draft">Save draft</button>
        <a class="btn btn-ghost" href="/webmail">Discard</a></div>
    </form>
  </section>`;
}

export function register(router) {
  router.get('/webmail', (ctx) => {
    const found = mailSession(ctx.cookies[COOKIE]);
    if (!found) return { status: 200, html: loginPage({ email: ctx.query.email || '' }) };
    const { mailbox } = found;
    const counts = folderCounts(mailbox);
    const folder = FOLDERS.includes(String(ctx.query.folder)) ? String(ctx.query.folder) : 'INBOX';
    const q = String(ctx.query.q || '').trim();
    const page = Math.max(1, Number(ctx.query.page) || 1);
    const where = q ? 'AND (subject LIKE ? OR from_addr LIKE ? OR body LIKE ?)' : '';
    const args = q ? [mailbox, folder, `%${q}%`, `%${q}%`, `%${q}%`] : [mailbox, folder];
    const total = get(`SELECT COUNT(*) n FROM mail_messages WHERE mailbox = ? AND folder = ? ${where}`, ...args).n;
    const rows = all(`SELECT * FROM mail_messages WHERE mailbox = ? AND folder = ? ${where} ORDER BY created_at DESC, id DESC LIMIT 20 OFFSET ?`,
      ...args, (page - 1) * 20);
    let selected = ctx.query.id ? get('SELECT * FROM mail_messages WHERE id = ? AND mailbox = ?', Number(ctx.query.id), mailbox) : null;
    if (!selected && !ctx.query.compose && rows.length && !q && folder !== 'Drafts') selected = rows[0];
    if (selected && selected.folder !== 'Trash' && !selected.seen) run('UPDATE mail_messages SET seen = 1 WHERE id = ?', selected.id);
    const replyTarget = ctx.query.reply ? get('SELECT * FROM mail_messages WHERE id = ? AND mailbox = ?', Number(ctx.query.reply), mailbox) : null;
    const draftMode = ctx.query.compose || (selected && selected.folder === 'Drafts');
    const pane = draftMode
      ? composePane(mailbox, selected && selected.folder === 'Drafts'
        ? { to: selected.to_addr, subject: selected.subject, quote: selected.body, draftId: selected.id, sendLabel: 'Send draft' }
        : {})
      : replyTarget
        ? messagePane({ ...replyTarget, seen: 1 }, mailbox, folder, { reply: true })
        : messagePane(selected, mailbox, folder);
    const body = h`<div class="wm-shell">
      ${sidebar(mailbox, counts, folder)}
      ${listPane(mailbox, folder, rows, selected?.id, q, page, total)}
      ${pane}
    </div>`;
    return { status: 200, html: layout({ title: folder === 'INBOX' ? 'Inbox' : folder, mailbox, body, counts, active: folder, query: q }) };
  });

  router.post('/webmail/attach', (ctx) => {
    const found = mailSession(ctx.cookies[COOKIE]);
    if (!found) return { status: 401, json: { ok: false, error: 'Webmail login required' } };
    if (String(ctx.body._csrf || '') !== csrfFor(found.mailbox)) return { status: 403, json: { ok: false, error: 'Invalid token' } };
    const name = path.basename(String(ctx.body.name || 'attachment.bin')).replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 120);
    const data = Buffer.from(String(ctx.body.data || ''), 'base64');
    if (!data.length) return { status: 400, json: { ok: false, error: 'Empty file' } };
    if (data.length > 20 * 1024 * 1024) return { status: 413, json: { ok: false, error: 'Attachment exceeds 20 MB' } };
    const account = get('SELECT * FROM email_accounts WHERE local_part || char(64) || domain = ?', found.mailbox);
    const owner = account ? get('SELECT * FROM users WHERE id = (SELECT user_id FROM domains WHERE id = ?)', account.domain_id) : null;
    const disk = owner ? checkDisk(owner, data.length / 1024 / 1024) : { ok: true };
    if (!disk.ok) return { status: 413, json: { ok: false, error: `Disk quota exceeded (${disk.used.toFixed(1)} / ${disk.limit} MB)` } };
    const token = `${crypto.randomBytes(8).toString('hex')}-${name}`;
    fs.writeFileSync(path.join(attachmentDir(), token), data, { mode: 0o600 });
    return { json: { ok: true, token, name, size: data.length } };
  });

  router.get('/webmail/attachment/:id', (ctx) => {
    const found = mailSession(ctx.cookies[COOKIE]);
    if (!found) return ctx.redirect('/webmail');
    const row = get(`SELECT a.* FROM mail_attachments a JOIN mail_messages m ON m.id = a.message_id
                     WHERE a.id = ? AND m.mailbox = ?`, Number(ctx.params.id), found.mailbox);
    if (!row || !fs.existsSync(row.path)) return ctx.redirect('/webmail?flash=Attachment%20not%20found&type=error');
    const data = fs.readFileSync(row.path);
    ctx.res.writeHead(200, {
      'Content-Type': row.mime || 'application/octet-stream',
      'Content-Length': data.length,
      'Content-Disposition': `attachment; filename="${row.filename.replace(/"/g, '')}"`,
    });
    ctx.res.end(data);
    return { handled: true };
  });

  router.post('/webmail/login', (ctx) => {
    if (recentFailures(loginWindow, ctx.ip, 15 * 60 * 1000).length >= 10) {
      return { status: 429, html: loginPage({ error: 'Too many failed attempts. Try again in 15 minutes.', email: String(ctx.body.email || '') }) };
    }
    const email = String(ctx.body.email || '').trim().toLowerCase();
    const account = get('SELECT * FROM email_accounts WHERE local_part || char(64) || domain = ?', email);
    if (!account || !verifyPassword(String(ctx.body.password || ''), account.password)) {
      recordFailure(loginWindow, ctx.ip);
      return { status: 401, html: loginPage({ error: 'Invalid mailbox or password.', email }) };
    }
    if (account.suspended) return { status: 403, html: loginPage({ error: 'This mailbox is suspended.', email }) };
    const token = createSession(email);
    ctx.res.setHeader('Set-Cookie', cookieFor(token, ctx.secure));
    return ctx.redirect('/webmail');
  });

  router.get('/webmail/logout', (ctx) => {
    const token = ctx.cookies[COOKIE];
    if (token) run('DELETE FROM webmail_sessions WHERE token = ?', hashSessionToken(token));
    ctx.res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
    return ctx.redirect('/webmail');
  });

  router.post('/webmail/draft', (ctx) => {
    const found = mailSession(ctx.cookies[COOKIE]);
    if (!found) return ctx.redirect('/webmail');
    const mailbox = found.mailbox;
    if (String(ctx.body._csrf || '') !== csrfFor(mailbox)) return ctx.redirect('/webmail?compose=1');
    const to = String(ctx.body.to || '').trim();
    const subject = String(ctx.body.subject || '').trim() || '(no subject)';
    const text = String(ctx.body.body || '');
    const id = Number(ctx.body.draft_id) || 0;
    const existing = id ? get('SELECT * FROM mail_messages WHERE id = ? AND mailbox = ?', id, mailbox) : null;
    if (existing) {
      run('UPDATE mail_messages SET to_addr = ?, subject = ?, body = ?, created_at = ? WHERE id = ?', to, subject, text, nowIso(), id);
      return ctx.redirect(`/webmail?folder=Drafts&id=${id}`);
    }
    run(`INSERT INTO mail_messages(mailbox, uid, folder, from_addr, to_addr, subject, body, seen, size_kb, created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`, mailbox, nextUid(mailbox, 'Drafts'), 'Drafts', mailbox, to, subject, text, 1,
      Math.max(1, Math.round(text.length / 1024)), nowIso());
    return ctx.redirect('/webmail?folder=Drafts&flash=' + encodeURIComponent('Draft saved'));
  });

  router.post('/webmail/send', (ctx) => {
    const found = mailSession(ctx.cookies[COOKIE]);
    if (!found) return ctx.redirect('/webmail');
    const mailbox = found.mailbox;
    if (String(ctx.body._csrf || '') !== csrfFor(mailbox)) return ctx.redirect('/webmail?compose=1');
    if (!rateLimit(sendWindow, mailbox, 30, 60 * 60 * 1000)) {
      return { status: 429, html: layout({ mailbox, body: composePane(mailbox, { to: ctx.body.to, subject: ctx.body.subject, quote: ctx.body.body, error: 'Too many messages sent. Try again later.' }), counts: folderCounts(mailbox) }) };
    }
    const to = String(ctx.body.to || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const subject = String(ctx.body.subject || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 200) || '(no subject)';
    const text = String(ctx.body.body || '');
    const invalid = to.filter((a) => !isEmail(a));
    if (!to.length || invalid.length) {
      const message = !to.length ? 'Add at least one recipient.' : `Invalid address: ${invalid.join(', ')}`;
      return { status: 400, html: layout({ mailbox, body: composePane(mailbox, { to: ctx.body.to, subject, quote: text, error: message }), counts: folderCounts(mailbox) }) };
    }
    if (to.length > 20) return { status: 400, html: layout({ mailbox, body: composePane(mailbox, { to: ctx.body.to, subject, quote: text, error: 'At most 20 recipients per message.' }), counts: folderCounts(mailbox) }) };

    const tokens = [].concat(ctx.body['attachment'] || ctx.body.attachments || []).filter(Boolean);
    const files = tokens.map((token) => safeAttachment(token)).filter(Boolean).map((file) => ({
      filename: path.basename(file).replace(/^[a-f0-9]+-/, ''),
      path: file,
      mime: 'application/octet-stream',
      size: fs.statSync(file).size,
    }));
    const totalMb = (Buffer.byteLength(text) + files.reduce((n, f) => n + f.size, 0)) / 1024 / 1024;
    const external = [];
    const rejected = [];
    const deliveredViaMta = [];
    const messageIds = [];
    for (const addr of to) {
      const account = get('SELECT * FROM email_accounts WHERE local_part || char(64) || domain = ? AND suspended = 0', addr);
      if (account) {
        if (account.quota_mb > 0 && account.used_mb + totalMb > account.quota_mb) {
          rejected.push(`${addr} (mailbox quota)`);
          continue;
        }
        // With a local MTA, submit through it so Dovecot/Maildir and the panel
        // store converge; without one, deliver into the panel store directly.
        const viaMta = mtaStatus().available && systemProvider().id === 'linux' ? sendMail({ from: mailbox, to: addr, subject, body: text, attachments: files }) : { ok: false };
        if (viaMta.ok) {
          deliveredViaMta.push(addr);
        } else {
          messageIds.push(deliver(addr, { from: mailbox, subject, body: text }));
        }
        run('UPDATE email_accounts SET used_mb = used_mb + ? WHERE id = ?', Math.max(0.01, totalMb), account.id);
      } else {
        external.push(addr);
        const delivered = sendMail({ from: mailbox, to: addr, subject, body: text, attachments: files });
        run('INSERT INTO mail_queue(sender, recipient, subject, body, attachments, size_kb, status, error, attempts, sent_at, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
          mailbox, addr, subject, text, JSON.stringify(files.map((f) => ({ filename: f.filename, path: f.path, mime: f.mime }))),
          Math.max(1, Math.round(totalMb * 1024)),
          delivered.ok ? 'sent' : 'failed', delivered.ok ? null : delivered.output, 1,
          delivered.ok ? nowIso() : null, nowIso());
      }
    }
    if (ctx.body.draft_id) run('DELETE FROM mail_messages WHERE id = ? AND mailbox = ?', Number(ctx.body.draft_id), mailbox);
    messageIds.push(deliver(mailbox, { from: mailbox, subject, body: `To: ${to.join(', ')}\n\n${text}`, folder: 'Sent', seen: 1 }));
    for (const file of files) {
      for (const id of messageIds) {
        run('INSERT INTO mail_attachments(message_id, filename, mime, size_kb, path, created_at) VALUES(?,?,?,?,?,?)',
          id, file.filename, file.mime, Math.round(file.size / 1024), file.path, nowIso());
      }
    }
    run('UPDATE email_accounts SET used_mb = used_mb + ? WHERE local_part || char(64) || domain = ?', Math.max(0.01, totalMb), mailbox);
    if (deliveredViaMta.length) { try { syncMaildirs(); } catch { /* next run */ } }
    const note = external.length ? `&queued=${encodeURIComponent(external.join(','))}` : '';
    const rejectNote = rejected.length ? `&rejected=${encodeURIComponent(rejected.join(','))}` : '';
    return ctx.redirect(`/webmail?folder=Sent&sent=1${note}${rejectNote}`);
  });

  router.post('/webmail/:id/delete', (ctx) => {
    const found = mailSession(ctx.cookies[COOKIE]);
    if (!found) return ctx.redirect('/webmail');
    const m = get('SELECT * FROM mail_messages WHERE id = ? AND mailbox = ?', Number(ctx.params.id), found.mailbox);
    if (m) {
      if (m.folder === 'Trash') run('DELETE FROM mail_messages WHERE id = ?', m.id);
      else run("UPDATE mail_messages SET folder = 'Trash' WHERE id = ?", m.id);
    }
    return ctx.redirect(`/webmail?folder=${encodeURIComponent(m?.folder === 'Trash' ? 'Trash' : 'INBOX')}`);
  });

  router.post('/webmail/:id/flag', (ctx) => {
    const found = mailSession(ctx.cookies[COOKIE]);
    if (!found) return ctx.redirect('/webmail');
    const m = get('SELECT * FROM mail_messages WHERE id = ? AND mailbox = ?', Number(ctx.params.id), found.mailbox);
    if (m) run('UPDATE mail_messages SET flagged = ? WHERE id = ?', m.flagged ? 0 : 1, m.id);
    return ctx.redirect(`/webmail?folder=${encodeURIComponent(m?.folder || 'INBOX')}&id=${ctx.params.id}`);
  });

  // Lightweight mailbox API used by tests and integrations.
  router.get('/api/v1/webmail/messages', (ctx) => {
    const found = mailSession(ctx.cookies[COOKIE]);
    if (!found) return { status: 401, json: { ok: false, error: 'Webmail login required' } };
    const folder = FOLDERS.includes(String(ctx.query.folder)) ? String(ctx.query.folder) : 'INBOX';
    const rows = all('SELECT id, folder, from_addr, to_addr, subject, seen, created_at FROM mail_messages WHERE mailbox = ? AND folder = ? ORDER BY created_at DESC', found.mailbox, folder);
    return { json: { ok: true, mailbox: found.mailbox, folder, messages: rows } };
  });
}

void setting; void e;
