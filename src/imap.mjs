// Minimal IMAP4rev1 server over the panel mail store. It supports the commands
// Roundcube and common clients need for login, folder listing, reading,
// flagging, appending and expunging. It is not a full RFC implementation.
import net from 'node:net';
import { all, get, run, nowIso, verifyPassword } from './db.mjs';
import { config } from './config.mjs';

const FOLDERS = ['INBOX', 'Drafts', 'Sent', 'Trash'];

function headerBlock(m) {
  return [
    `Date: ${new Date(m.created_at).toUTCString()}`,
    `From: ${m.from_addr}`,
    `To: ${m.to_addr}`,
    m.cc ? `Cc: ${m.cc}` : null,
    `Subject: ${m.subject}`,
    `Message-ID: <${m.id}.${m.uid}@openadmin.local>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
  ].filter(Boolean).join('\r\n') + '\r\n\r\n';
}

function fullMessage(m) {
  return headerBlock(m) + String(m.body || '').replace(/\n/g, '\r\n');
}

function flagsOf(m, deleted) {
  const flags = [];
  if (m.seen) flags.push('\\Seen');
  if (m.flagged) flags.push('\\Flagged');
  if (m.folder === 'Drafts') flags.push('\\Draft');
  if (deleted?.has(m.id)) flags.push('\\Deleted');
  return `(${flags.join(' ')})`;
}

function internalDate(iso) {
  const d = new Date(iso);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}-${months[d.getUTCMonth()]}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

function tokenize(line) {
  const tokens = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === ' ') { i++; continue; }
    if (ch === '"') {
      let out = '';
      i++;
      while (i < line.length) {
        if (line[i] === '\\') { out += line[i + 1]; i += 2; continue; }
        if (line[i] === '"') { i++; break; }
        out += line[i++];
      }
      tokens.push(out);
      continue;
    }
    let out = '';
    while (i < line.length && line[i] !== ' ') out += line[i++];
    tokens.push(out);
  }
  return tokens;
}

function parseSet(set, list) {
  const ids = list.map((m) => m.uid);
  const out = new Set();
  for (const part of String(set).split(',')) {
    if (part.includes(':')) {
      const [a, b] = part.split(':');
      const start = a === '*' ? (ids.at(-1) || 0) : Number(a);
      const end = b === '*' ? (ids.at(-1) || 0) : Number(b);
      for (let i = Math.min(start, end); i <= Math.max(start, end); i++) out.add(i);
    } else if (part === '*') {
      if (ids.length) out.add(ids.at(-1));
    } else {
      out.add(Number(part));
    }
  }
  return out;
}

export function createImapServer() {
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let pending = null;
    const session = { user: null, mailbox: null, folder: null, messages: [], deleted: new Set(), failures: 0 };

    const write = (s) => { try { socket.write(s.endsWith('\r\n') ? s : s + '\r\n'); } catch { /* closed */ } };

    write('* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] OpenAdmin IMAP ready');

    const loadFolder = (folder) => {
      session.folder = folder;
      session.deleted = new Set();
      session.messages = all('SELECT * FROM mail_messages WHERE mailbox = ? AND folder = ? ORDER BY uid',
        session.mailbox, folder);
    };

    const handle = (line, literalData = null) => {
      const tokens = tokenize(line);
      const tag = tokens[0];
      const cmd = (tokens[1] || '').toUpperCase();
      const rest = line.slice((tag + ' ' + (tokens[1] || '')).length).trim();
      const reply = (text, extra = '') => write(`${tag} ${text}${extra ? ' ' + extra : ''}`);

      if (cmd === 'CAPABILITY') {
        write('* CAPABILITY IMAP4rev1 AUTH=PLAIN');
        return reply('OK', 'CAPABILITY completed');
      }
      if (cmd === 'NOOP') return reply('OK', 'NOOP completed');
      if (cmd === 'LOGOUT') {
        write('* BYE OpenAdmin IMAP closing');
        reply('OK', 'LOGOUT completed');
        socket.end();
        return;
      }
      if (cmd === 'ID') {
        write('* ID NIL');
        return reply('OK', 'ID completed');
      }
      if (cmd === 'LOGIN') {
        const user = tokens[2] || '';
        const pass = tokens[3] || '';
        const account = get('SELECT * FROM email_accounts WHERE local_part || char(64) || domain = ?', user.toString().toLowerCase());
        if (!account || account.suspended || !verifyPassword(pass, account.password)) {
          session.failures++;
          if (session.failures >= 3) {
            reply('NO', '[AUTHENTICATIONFAILED] Too many failures');
            write('* BYE Too many failed logins');
            socket.end();
            return;
          }
          return reply('NO', '[AUTHENTICATIONFAILED] Invalid credentials');
        }
        session.user = account;
        session.mailbox = `${account.local_part}@${account.domain}`;
        return reply('OK', 'LOGIN completed');
      }
      if (!session.user) return reply('BAD', 'Authenticate first');
      if (cmd === 'LIST' || cmd === 'LSUB') {
        for (const f of FOLDERS) write(`* ${cmd} () "/" "${f}"`);
        return reply('OK', `${cmd} completed`);
      }
      if (cmd === 'STATUS') {
        const folder = (tokens[2] || 'INBOX').replace(/"/g, '');
        const rows = all('SELECT * FROM mail_messages WHERE mailbox = ? AND folder = ?', session.mailbox, folder);
        const unseen = rows.filter((r) => !r.seen).length;
        write(`* STATUS "${folder}" (MESSAGES ${rows.length} UNSEEN ${unseen} UIDNEXT ${(rows.at(-1)?.uid || 0) + 1} UIDVALIDITY 1)`);
        return reply('OK', 'STATUS completed');
      }
      if (cmd === 'SELECT' || cmd === 'EXAMINE') {
        const folder = (tokens[2] || 'INBOX').replace(/"/g, '');
        loadFolder(folder);
        write(`* ${session.messages.length} EXISTS`);
        write(`* 0 RECENT`);
        write('* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)');
        write('* OK [PERMANENTFLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft \\*)] Flags permitted');
        write(`* OK [UIDVALIDITY 1] UIDs valid`);
        write(`* OK [UIDNEXT ${(session.messages.at(-1)?.uid || 0) + 1}] Predicted next UID`);
        return reply('OK', `[${cmd === 'EXAMINE' ? 'READ-ONLY' : 'READ-WRITE'}] ${cmd} completed`);
      }
      if (cmd === 'CLOSE' || cmd === 'UNSELECT') {
        if (cmd === 'CLOSE' && session.folder) {
          for (const m of session.messages) if (session.deleted.has(m.id)) run('DELETE FROM mail_messages WHERE id = ?', m.id);
        }
        session.folder = null;
        session.messages = [];
        return reply('OK', `${cmd} completed`);
      }
      if (cmd === 'APPEND') {
        const folder = (tokens[2] || 'INBOX').replace(/"/g, '');
        if (literalData) {
          const raw = literalData.toString('utf8');
          const headerEnd = raw.indexOf('\r\n\r\n');
          const headers = headerEnd === -1 ? raw : raw.slice(0, headerEnd);
          const body = headerEnd === -1 ? '' : raw.slice(headerEnd + 4);
          const fresh = get('SELECT * FROM email_accounts WHERE local_part || char(64) || domain = ?', session.mailbox);
          const sizeMb = raw.length / 1024 / 1024;
          if (fresh && fresh.quota_mb > 0 && fresh.used_mb + sizeMb > fresh.quota_mb) {
            return reply('NO', '[OVERQUOTA] Mailbox quota exceeded');
          }
          const subject = /^Subject:\s*(.*)$/mi.exec(headers)?.[1] || '(no subject)';
          const from = /^From:\s*(.*)$/mi.exec(headers)?.[1] || session.mailbox;
          const to = /^To:\s*(.*)$/mi.exec(headers)?.[1] || session.mailbox;
          const uid = (get('SELECT MAX(uid) m FROM mail_messages WHERE mailbox = ? AND folder = ?', session.mailbox, folder)?.m || 0) + 1;
          run(`INSERT INTO mail_messages(mailbox, uid, folder, from_addr, to_addr, subject, body, seen, size_kb, created_at)
               VALUES(?,?,?,?,?,?,?,?,?,?)`, session.mailbox, uid, folder, from, to, subject, body, 1,
            Math.max(1, Math.round(raw.length / 1024)), nowIso());
          if (fresh) run('UPDATE email_accounts SET used_mb = used_mb + ? WHERE id = ?', Math.max(0.01, sizeMb), fresh.id);
          return reply('OK', 'APPEND completed');
        }
        return reply('BAD', 'APPEND requires a literal');
      }
      if (cmd === 'FETCH' || ((cmd === 'UID') && (tokens[2] || '').toUpperCase() === 'FETCH')) {
        const uidMode = cmd === 'UID';
        const set = uidMode ? tokens[3] : tokens[2];
        const itemText = line.slice(line.toUpperCase().indexOf('FETCH') + 5).trim();
        const wanted = parseSet(set, session.messages);
        session.messages.forEach((m, idx) => {
          const key = uidMode ? m.uid : idx + 1;
          if (!wanted.has(key)) return;
          const parts = [];
          if (/UID/i.test(itemText)) parts.push(`UID ${m.uid}`);
          if (/FLAGS/i.test(itemText)) parts.push(`FLAGS ${flagsOf(m, session.deleted)}`);
          if (/INTERNALDATE/i.test(itemText)) parts.push(`INTERNALDATE "${internalDate(m.created_at)}"`);
          if (/RFC822\.SIZE/i.test(itemText)) parts.push(`RFC822.SIZE ${Buffer.byteLength(fullMessage(m))}`);
          if (/BODYSTRUCTURE/i.test(itemText)) {
            const size = Buffer.byteLength(String(m.body || ''));
            parts.push(`BODYSTRUCTURE ("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" ${size} ${String(m.body || '').split('\n').length} NIL NIL NIL NIL)`);
          }
          const headerFields = /BODY(?:\.PEEK)?\[HEADER\.FIELDS\s*\(([^)]*)\)\]/i.exec(itemText);
          if (headerFields) {
            const names = headerFields[1].split(/\s+/).filter(Boolean).map((s) => s.toUpperCase());
            const headers = headerBlock(m).split('\r\n').filter((l) => {
              const idx2 = l.indexOf(':');
              return idx2 > 0 && names.includes(l.slice(0, idx2).toUpperCase());
            }).join('\r\n') + '\r\n\r\n';
            parts.push(`BODY[HEADER.FIELDS (${headerFields[1]})] {${Buffer.byteLength(headers)}}\r\n${headers}`);
          } else if (/BODY(?:\.PEEK)?\[TEXT\]/i.test(itemText)) {
            const text = String(m.body || '').replace(/\n/g, '\r\n');
            parts.push(`BODY[TEXT] {${Buffer.byteLength(text)}}\r\n${text}`);
          } else if (/BODY(?:\.PEEK)?\[\]/i.test(itemText)) {
            const full = fullMessage(m);
            parts.push(`BODY[] {${Buffer.byteLength(full)}}\r\n${full}`);
          }
          write(`* ${idx + 1} FETCH (${parts.join(' ')})`);
        });
        return reply('OK', 'FETCH completed');
      }
      if (cmd === 'STORE' || (cmd === 'UID' && (tokens[2] || '').toUpperCase() === 'STORE')) {
        const uidMode = cmd === 'UID';
        const set = uidMode ? tokens[3] : tokens[2];
        const op = (uidMode ? tokens[4] : tokens[3]) || '';
        const flagText = line.slice(line.lastIndexOf('(') + 1, line.lastIndexOf(')')).toLowerCase();
        const wanted = parseSet(set, session.messages);
        session.messages.forEach((m, idx) => {
          if (!wanted.has(uidMode ? m.uid : idx + 1)) return;
          for (const flag of flagText.split(/\s+/)) {
            if (flag === '\\seen') run('UPDATE mail_messages SET seen = ? WHERE id = ?', op.startsWith('+') ? 1 : 0, m.id);
            if (flag === '\\flagged') run('UPDATE mail_messages SET flagged = ? WHERE id = ?', op.startsWith('+') ? 1 : 0, m.id);
            if (flag === '\\deleted') {
              if (op.startsWith('+')) session.deleted.add(m.id); else session.deleted.delete(m.id);
            }
          }
          write(`* ${idx + 1} FETCH (UID ${m.uid} FLAGS ${flagsOf(m, session.deleted)})`);
        });
        return reply('OK', 'STORE completed');
      }
      if (cmd === 'EXPUNGE') {
        let removed = 0;
        session.messages = session.messages.filter((m, idx) => {
          if (!session.deleted.has(m.id)) return true;
          run('DELETE FROM mail_messages WHERE id = ?', m.id);
          removed++;
          write(`* ${idx + 1 - (removed - 1)} EXPUNGE`);
          return false;
        });
        return reply('OK', 'EXPUNGE completed');
      }
      if (cmd === 'SEARCH' || (cmd === 'UID' && (tokens[2] || '').toUpperCase() === 'SEARCH')) {
        const uidMode = cmd === 'UID';
        const criteria = line.toUpperCase();
        const hits = [];
        session.messages.forEach((m, idx) => {
          if (criteria.includes('UNSEEN') && m.seen) return;
          if (criteria.includes('SEEN') && !criteria.includes('UNSEEN') && !m.seen) return;
          hits.push(uidMode ? m.uid : idx + 1);
        });
        write(`* SEARCH ${hits.join(' ')}`);
        return reply('OK', 'SEARCH completed');
      }
      return reply('BAD', `Unsupported command ${cmd}`);
    };

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        if (pending) {
          if (buffer.length < pending.size) return;
          const data = buffer.subarray(0, pending.size);
          buffer = buffer.subarray(pending.size);
          const line = pending.line;
          pending = null;
          handle(line, data);
          continue;
        }
        const idx = buffer.indexOf('\r\n');
        if (idx === -1) return;
        const line = buffer.subarray(0, idx).toString('utf8');
        buffer = buffer.subarray(idx + 2);
        const literalMatch = /\{(\d+)\}$/.exec(line);
        if (literalMatch) {
          pending = { line, size: Number(literalMatch[1]) };
          socket.write('+ Ready for literal data\r\n');
          continue;
        }
        handle(line);
      }
    });
    socket.on('error', () => { /* client disconnected */ });
  });
  return server;
}

let running = null;

export function startImap({ port = Number(config.imapPort || 1143), host = '127.0.0.1' } = {}) {
  if (running) return running;
  running = createImapServer();
  running.listen(port, host, () => {
    console.log(`  IMAP server listening on ${host}:${running.address().port}`);
  });
  running.on('error', (e) => console.warn('[openadmin] IMAP:', e.message));
  if (typeof running.unref === 'function') running.unref();
  return running;
}

export function stopImap() {
  if (running) { running.close(); running = null; }
}
