// Import mail delivered by the MTA into the panel mail store so the built-in
// webmail and IMAP service see the same messages as external clients.
import fs from 'node:fs';
import path from 'node:path';
import { all, get, run, nowIso } from './db.mjs';
import { mailAccounts } from './mail.mjs';
import { mailHome } from './paths.mjs';

function parseHeaders(raw) {
  const split = raw.search(/\r?\n\r?\n/);
  const head = split === -1 ? raw : raw.slice(0, split);
  const body = split === -1 ? '' : raw.slice(split).replace(/^\r?\n\r?\n/, '');
  const unfolded = head.replace(/\r?\n[ \t]+/g, ' ');
  const headers = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
  }
  return { headers, body };
}

function stripHtml(html) {
  return String(html).replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
}

function decodeBody(headers, body) {
  const ct = String(headers['content-type'] || '');
  if (/^multipart\//i.test(ct)) {
    const boundary = /boundary="?([^";]+)"?/i.exec(ct)?.[1];
    if (boundary) {
      const parts = body.split(`--${boundary}`).slice(1, -1);
      let html = '';
      for (const part of parts) {
        const parsed = parseHeaders(part.replace(/^\r?\n/, ''));
        const type = String(parsed.headers['content-type'] || 'text/plain');
        if (/^text\/plain/i.test(type)) return decodeBody(parsed.headers, parsed.body);
        if (/^text\/html/i.test(type)) html = decodeBody(parsed.headers, parsed.body);
      }
      if (html) return stripHtml(html);
    }
  }
  if (/^text\/html/i.test(ct)) return stripHtml(body);
  const enc = String(headers['content-transfer-encoding'] || '').toLowerCase();
  if (enc === 'base64') {
    try { return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8'); } catch { return body; }
  }
  if (enc === 'quoted-printable') {
    return body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
  }
  return body;
}

function folderFor(sub) {
  if (!sub) return 'INBOX';
  const name = sub.replace(/^\./, '');
  const map = { Sent: 'Sent', Drafts: 'Drafts', Trash: 'Trash', Junk: 'Junk', Spam: 'Junk' };
  return map[name] || name.charAt(0).toUpperCase() + name.slice(1);
}

function maildirDirs(base) {
  const out = [{ dir: base, folder: 'INBOX' }];
  let entries = [];
  try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { return out; }
  for (const ent of entries) {
    if (ent.isDirectory() && ent.name.startsWith('.')) {
      out.push({ dir: path.join(base, ent.name), folder: folderFor(ent.name) });
    }
  }
  return out;
}

/** Import new Maildir files. Returns counts; safe to run repeatedly. */
export function syncMaildirs(limit = 500) {
  let imported = 0;
  let skipped = 0;
  for (const account of mailAccounts()) {
    const base = mailHome(account.username, account.domain, account.local_part);
    for (const { dir, folder } of maildirDirs(base)) {
      for (const sub of ['new', 'cur']) {
        const full = path.join(dir, sub);
        let files = [];
        try { files = fs.readdirSync(full).filter((f) => !f.startsWith('.')); } catch { continue; }
        for (const file of files) {
          if (imported >= limit) return { ok: true, imported, skipped, limited: true };
          const filePath = path.join(full, file);
          if (get('SELECT path FROM maildir_imports WHERE path = ?', filePath)) { skipped++; continue; }
          let raw;
          try { raw = fs.readFileSync(filePath, 'utf8'); } catch { continue; }
          const { headers, body } = parseHeaders(raw);
          const seen = sub === 'cur' && /:2,.*S/.test(file) ? 1 : 0;
          const uid = (get('SELECT MAX(uid) m FROM mail_messages WHERE mailbox = ? AND folder = ?', account.local_part + '@' + account.domain, folder)?.m || 0) + 1;
          const text = decodeBody(headers, body);
          const r = run(`INSERT INTO mail_messages(mailbox, uid, folder, from_addr, to_addr, cc, subject, body, seen, size_kb, created_at)
                         VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
            `${account.local_part}@${account.domain}`, uid, folder,
            headers.from || 'unknown@localhost', headers.to || `${account.local_part}@${account.domain}`,
            headers.cc || '', headers.subject || '(no subject)', text, seen,
            Math.max(1, Math.round(raw.length / 1024)), headers.date ? new Date(headers.date).toISOString() : nowIso());
          run('INSERT INTO maildir_imports(path, mailbox, message_id, imported_at) VALUES(?,?,?,?)',
            filePath, `${account.local_part}@${account.domain}`, r.lastInsertRowid, nowIso());
          imported++;
        }
      }
    }
  }
  return { ok: true, imported, skipped, limited: false };
}

export function maildirMeta() {
  return {
    imported: get('SELECT COUNT(*) n FROM maildir_imports')[0]?.n || 0,
    last: get('SELECT imported_at FROM maildir_imports ORDER BY imported_at DESC LIMIT 1')?.imported_at || '',
  };
}
