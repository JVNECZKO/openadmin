// Mail Operations Center: queue, delivery events, address diagnostics,
// filters, routing, remote SMTP and deliverability settings.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { config } from './config.mjs';
import { all, get, run, nowIso, setting, audit } from './db.mjs';
import { getJson, setJson } from './json.mjs';
import { which, sh, isRoot, readManaged, writeManaged, backupFile, serviceReload } from './sys.mjs';
import { encryptSecret, decryptSecret } from './secrets.mjs';

export function eximBin() {
  return which('exim4') || which('exim') || '';
}

export function queueList() {
  if (config.provider === 'linux' && eximBin()) {
    const r = sh(eximBin(), ['-bp'], { timeout: 20000 });
    if (r.ok) {
      const rows = [];
      for (const line of r.stdout.split('\n')) {
        const m = /^\s*(\S+)\s+(\S+)\s+(\S{6,})\s+(.*)$/.exec(line);
        if (!m) continue;
        const rest = m[4];
        const sender = /<([^>]+)>/.exec(rest)?.[1] || '';
        const marker = /(\*\*|==|=>|->)\s*([^:]+)(?::\s*(.*))?/.exec(rest);
        rows.push({
          id: m[3], age: m[1], size: m[2], sender,
          recipient: marker?.[2]?.trim() || '',
          status: marker?.[1] === '**' ? 'failed' : marker?.[1] === '==' ? 'deferred' : marker?.[1] === '=>' ? 'delivered' : 'queued',
          reason: marker?.[3]?.trim() || '',
        });
      }
      if (rows.length) return { ok: true, simulated: false, rows };
    }
  }
  const rows = all('SELECT * FROM mail_queue ORDER BY id DESC LIMIT 100').map((r) => ({
    id: String(r.id), age: r.created_at, size: '—', sender: r.sender || '', recipient: r.recipient || '',
    status: r.status || 'queued', reason: r.error || '', db: true,
  }));
  return { ok: true, simulated: config.provider !== 'linux', rows };
}

export function queueAction(id, action) {
  if (action === 'retry' && config.provider === 'linux' && eximBin()) {
    const r = sh(eximBin(), ['-M', id], { timeout: 30000 });
    return { ok: r.ok, output: r.stdout || r.stderr || (r.ok ? 'Message retried' : 'Retry failed') };
  }
  if (action === 'delete' && config.provider === 'linux' && eximBin()) {
    const r = sh(eximBin(), ['-Mrm', id], { timeout: 30000 });
    return { ok: r.ok, output: r.stdout || r.stderr || (r.ok ? 'Message removed' : 'Remove failed') };
  }
  const row = get('SELECT * FROM mail_queue WHERE id = ?', Number(id));
  if (!row) return { ok: false, error: 'Not found' };
  if (action === 'delete') run('DELETE FROM mail_queue WHERE id = ?', row.id);
  else run("UPDATE mail_queue SET status = 'queued', attempts = attempts + 1 WHERE id = ?", row.id);
  return { ok: true, simulated: true, output: `Queue ${action} simulated` };
}

function logPath() {
  for (const p of ['/var/log/exim4/mainlog', '/var/log/exim/mainlog', '/var/log/mail.log']) if (fs.existsSync(p)) return p;
  return '';
}

export function syncMailEvents({ maxLines = 2000 } = {}) {
  const file = config.provider === 'linux' ? logPath() : '';
  if (!file) return { ok: true, inserted: 0, output: 'Brak logu Exima (sandbox lub inny MTA)' };
  let text = '';
  try {
    const stat = fs.statSync(file);
    const size = Math.min(stat.size, 4 * 1024 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, Math.max(0, stat.size - size));
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch (e) { return { ok: false, error: e.message, inserted: 0 }; }
  const lines = text.split('\n').filter(Boolean).slice(-maxLines);
  let inserted = 0;
  for (const line of lines) {
    const m = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+(\S+)\s+(<=|=>|\*\*|==|->)\s+(\S+)(?:\s+(.*))?$/.exec(line);
    if (!m) continue;
    if (get('SELECT id FROM mail_events WHERE raw = ? LIMIT 1', line)) continue;
    const marker = m[3];
    const status = marker === '<=' ? 'received' : marker === '=>' ? 'delivered' : marker === '**' ? 'failed' : marker === '==' ? 'deferred' : 'relayed';
    const address = m[4].replace(/[<>]/g, '');
    const domain = address.includes('@') ? address.split('@').pop() : '';
    run('INSERT INTO mail_events(message_id, domain, sender, recipient, status, reason, raw, created_at) VALUES(?,?,?,?,?,?,?,?)',
      m[2], domain, marker === '<=' ? address : '', marker === '<=' ? '' : address, status, (m[5] || '').slice(0, 400), line, m[1].replace(' ', 'T') + 'Z');
    inserted++;
  }
  return { ok: true, inserted, output: `${inserted} new event(s)` };
}

function digAt(name, type, server) {
  const args = ['+short', '+time=2', '+tries=1', type, name, ...(server ? [`@${server}`] : [])];
  const r = spawnSync('dig', args, { encoding: 'utf8', timeout: 5000 });
  return r.status === 0 ? r.stdout.trim().split('\n').filter(Boolean) : [];
}

function dig(name, type) {
  const local = config.provider === 'linux' ? digAt(name, type, '127.0.0.1') : [];
  return local.length ? local : digAt(name, type, null);
}

function port(host, p, timeout = 2500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port: p });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeout, () => done(false));
    socket.on('connect', () => done(true));
    socket.on('error', () => done(false));
  });
}

export async function diagnose(address) {
  const email = String(address || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'Nieprawidłowy adres e-mail' };
  const [local, domain] = email.split('@');
  const checks = [];
  const add = (id, label, ok, detail, hint = '') => checks.push({ id, label, ok, detail, hint });
  const d = get('SELECT * FROM domains WHERE name = ?', domain);
  add('domain', 'Domena w panelu', !!d, d ? `dokument root: ${d.docroot}` : 'Domena nie jest obsługiwana przez ten panel', d ? '' : 'Dodaj domenę w panelu, jeśli ma tu działać poczta.');
  const mx = dig(domain, 'MX');
  add('mx', 'Rekord MX', mx.length > 0, mx.join(' ') || 'Brak MX', mx.length ? '' : 'Dodaj MX: 10 mail.' + domain);
  const spf = dig(domain, 'TXT').find((v) => /v=spf1/i.test(v)) || '';
  add('spf', 'SPF', !!spf, spf || 'Brak rekordu SPF', spf ? '' : 'Dodaj TXT: v=spf1 a mx ~all');
  const dkim = dig(`default._domainkey.${domain}`, 'TXT');
  add('dkim', 'DKIM', dkim.length > 0, dkim[0]?.slice(0, 120) || 'Brak klucza default._domainkey', dkim.length ? '' : 'Wygeneruj DKIM w panelu (Poczta → DKIM).');
  const dmarc = dig(`_dmarc.${domain}`, 'TXT');
  add('dmarc', 'DMARC', dmarc.length > 0, dmarc[0]?.slice(0, 120) || 'Brak rekordu _dmarc', dmarc.length ? '' : 'Dodaj TXT _dmarc: v=DMARC1; p=quarantine');
  const mailbox = get('SELECT * FROM email_accounts WHERE domain = ? AND local_part = ?', domain, local);
  add('mailbox', 'Skrzynka w panelu', !!mailbox, mailbox ? `quota ${mailbox.quota_mb || '∞'} MB` : 'Nie znaleziono skrzynki', mailbox ? '' : 'Utwórz skrzynkę w Poczta → Dodaj pocztę.');
  if (config.provider === 'linux') {
    const host = d ? setting('server_ip', '127.0.0.1') : domain;
    const [imap, smtp, submission] = await Promise.all([port(host, 993), port(host, 25), port(host, 587)]);
    add('imap', 'IMAP 993', imap, imap ? 'port otwarty' : 'brak połączenia', imap ? '' : 'Sprawdź Dovecot i firewall.');
    add('smtp', 'SMTP 25', smtp, smtp ? 'port otwarty' : 'brak połączenia', smtp ? '' : 'Sprawdź Exim i firewall.');
    add('submission', 'SMTP 587', submission, submission ? 'port otwarty' : 'brak połączenia', submission ? '' : 'Sprawdź Exim (submission) i firewall.');
  } else {
    add('network', 'Porty 993/25/587', true, 'Pominięto w trybie sandbox', 'Sprawdź na serwerze produkcyjnym.');
  }
  return { ok: true, email, checks, score: Math.round((checks.filter((c) => c.ok).length / checks.length) * 100) };
}

export function mailSettings() {
  return getJson('mail_ops_settings', {
    rbl: ['zen.spamhaus.org', 'bl.spamcop.net'],
    greylisting: false,
    greylist_delay: 300,
    sender_blacklist: [],
    country_filter: false,
  });
}

export function saveMailSettings(body, actor = 'admin') {
  const cur = mailSettings();
  const rbl = String(body.rbl || '')
    .split(/[\s,]+/).map((x) => x.trim()).filter((x) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(x));
  const cfg = {
    ...cur,
    rbl: rbl.length ? rbl : cur.rbl,
    greylisting: !!body.greylisting,
    greylist_delay: Math.min(3600, Math.max(60, Number(body.greylist_delay || 300))),
    sender_blacklist: String(body.sender_blacklist || '').split(/[\s,]+/).map((x) => x.trim()).filter(Boolean),
    country_filter: !!body.country_filter,
  };
  setJson('mail_ops_settings', cfg);
  applyEximSettings();
  audit(actor, 'admin', 'mail.settings.save', `rbl=${cfg.rbl.length}`, '');
  return { ok: true, cfg };
}

export function applyEximSettings() {
  if (config.provider !== 'linux') return { ok: true, simulated: true, output: 'Exim settings written to sandbox' };
  if (!isRoot()) return { ok: false, error: 'Root privileges required' };
  if (!eximBin()) return { ok: false, error: 'Exim is not installed' };
  const cfg = mailSettings();
  const base = '/etc/exim4';
  const macro = path.join(base, 'conf.d', 'main', '99_openadmin_macros');
  const acl = path.join(base, 'openadmin_rcpt.acl');
  const dataAcl = path.join(base, 'openadmin_data.acl');
  const blocked = all('SELECT domain FROM blacklist_domains').map((r) => r.domain);
  const lines = [];
  if (cfg.rbl.length) lines.push(`CHECK_RCPT_IP_DNSBLS = ${cfg.rbl.join(' : ')}`);
  lines.push(`CHECK_RCPT_LOCAL_ACL_FILE = ${acl}`);
  lines.push(`CHECK_DATA_LOCAL_ACL_FILE = ${dataAcl}`);
  fs.mkdirSync(path.dirname(macro), { recursive: true });
  backupFile(macro);
  fs.writeFileSync(macro, `# Managed by OpenAdmin\n${lines.join('\n')}\n`, { mode: 0o644 });
  const senders = [...blocked, ...cfg.sender_blacklist].join(' : ');
  fs.writeFileSync(acl, `# Managed by OpenAdmin\n${senders ? `deny message = Sender domain blocked by OpenAdmin\n     senders = ${senders}\n` : ''}`, { mode: 0o644 });
  fs.writeFileSync(dataAcl, '# Managed by OpenAdmin\n', { mode: 0o644 });
  const validate = sh(eximBin(), ['-bV'], { timeout: 15000 });
  if (!validate.ok) return { ok: false, error: `Exim validation failed: ${validate.stderr || validate.error}` };
  const upd = sh('update-exim4.conf', [], { timeout: 30000 });
  const parsed = sh(eximBin(), ['-bP'], { timeout: 30000 });
  if (!upd.ok || !parsed.ok) return { ok: false, error: `Exim config: ${upd.stderr || parsed.stderr || parsed.error}` };
  const reload = sh('systemctl', ['reload', 'exim4']);
  return { ok: reload.ok, output: [upd.stdout, reload.stdout].filter(Boolean).join(' ') || 'Exim configuration applied', error: !reload.ok ? reload.stderr : '' };
}

export function listFilters() {
  return all('SELECT * FROM mail_filters ORDER BY created_at DESC');
}

export function addFilter(body, actor = 'admin') {
  const kind = ['sender_domain', 'country', 'rbl'].includes(body.kind) ? body.kind : 'sender_domain';
  const value = String(body.value || '').trim();
  if (!value) return { ok: false, error: 'Wartość jest wymagana' };
  run('INSERT INTO mail_filters(domain, kind, value, action, enabled, created_at) VALUES(?,?,?,?,?,?)',
    ctxDomain(body.domain), kind, value, String(body.action || 'reject'), 1, nowIso());
  applyEximSettings();
  audit(actor, 'admin', 'mail.filter.add', `${kind}:${value}`, '');
  return { ok: true };
}

function ctxDomain(value) {
  return String(value || '').trim() || null;
}

export function removeFilter(id, actor = 'admin') {
  run('DELETE FROM mail_filters WHERE id = ?', Number(id));
  applyEximSettings();
  audit(actor, 'admin', 'mail.filter.remove', String(id), '');
  return { ok: true };
}

export function listRoutes() {
  return all('SELECT * FROM mail_routing ORDER BY domain');
}

export function saveRoute(body, actor = 'admin') {
  const domain = String(body.domain || '').trim();
  if (!domain) return { ok: false, error: 'Domena jest wymagana' };
  const router = ['local', 'remote', 'split'].includes(body.router) ? body.router : 'local';
  const target = String(body.target || '').trim();
  if (router !== 'local' && !target) return { ok: false, error: 'Podaj host dla routingu zdalnego' };
  run(`INSERT INTO mail_routing(domain, router, target, split, enabled, updated_at) VALUES(?,?,?,?,?,?)
       ON CONFLICT(domain) DO UPDATE SET router=excluded.router, target=excluded.target, split=excluded.split, enabled=excluded.enabled, updated_at=excluded.updated_at`,
    domain, router, target || null, router === 'split' ? 1 : 0, 1, nowIso());
  applyRouting();
  audit(actor, 'admin', 'mail.route.save', `${domain}:${router}`, '');
  return { ok: true };
}

export function applyRouting() {
  if (config.provider !== 'linux') return { ok: true, simulated: true };
  const rows = all("SELECT * FROM mail_routing WHERE enabled = 1 AND router IN ('remote','split')");
  const file = '/etc/exim4/conf.d/router/99_openadmin_routing';
  const lines = ['# Managed by OpenAdmin'];
  for (const r of rows) {
    const [host, port] = String(r.target || '').split(':');
    lines.push(`openadmin_route_${r.domain.replace(/[^a-z0-9]/gi, '_')}:`);
    lines.push('  driver = manualroute');
    lines.push(`  domains = ${r.domain}`);
    lines.push(`  route_list = * ${host}${port ? `::${port}` : ''}`);
    lines.push('  transport = openadmin_remote_smtp');
    lines.push('  no_more');
    lines.push('');
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  backupFile(file);
  fs.writeFileSync(file, lines.join('\n'), { mode: 0o644 });
  sh('update-exim4.conf');
  const val = sh(eximBin(), ['-bP'], { timeout: 30000 });
  if (!val.ok) return { ok: false, error: val.stderr || val.error };
  const rel = sh('systemctl', ['reload', 'exim4']);
  return { ok: rel.ok, output: rel.stdout || 'Routing applied' };
}

export function listRemoteSmtp() {
  return all('SELECT * FROM remote_smtp ORDER BY created_at DESC');
}

export async function saveRemoteSmtp(body, actor = 'admin') {
  const host = String(body.host || '').trim();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) return { ok: false, error: 'Nieprawidłowy host SMTP' };
  const port = Math.min(65535, Math.max(1, Number(body.port || 587)));
  if (!body.id) {
    run('INSERT INTO remote_smtp(name, host, port, username, password_enc, tls, enabled, created_at) VALUES(?,?,?,?,?,?,?,?)',
      String(body.name || host), host, port, String(body.username || ''), body.password ? encryptSecret(String(body.password)) : null, body.tls ? 1 : 0, 0, nowIso());
  } else {
    if (body.password) run('UPDATE remote_smtp SET name=?, host=?, port=?, username=?, password_enc=?, tls=? WHERE id=?', String(body.name || host), host, port, String(body.username || ''), encryptSecret(String(body.password)), body.tls ? 1 : 0, Number(body.id));
    else run('UPDATE remote_smtp SET name=?, host=?, port=?, username=?, tls=? WHERE id=?', String(body.name || host), host, port, String(body.username || ''), body.tls ? 1 : 0, Number(body.id));
  }
  audit(actor, 'admin', 'mail.remote_smtp.save', host, '');
  const tested = await testRemoteSmtp({ host, port });
  return { ok: true, tested };
}

export function testRemoteSmtp({ host, port }) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port: Number(port) });
    const done = (ok, detail) => { s.destroy(); resolve({ ok, detail }); };
    s.setTimeout(5000, () => done(false, 'timeout'));
    s.on('connect', () => done(true, 'TCP connection established'));
    s.on('error', (e) => done(false, e.message));
  });
}

export async function activateRemoteSmtp(id, actor = 'admin') {
  const row = get('SELECT * FROM remote_smtp WHERE id = ?', Number(id));
  if (!row) return { ok: false, error: 'Not found' };
  const test = await testRemoteSmtp(row);
  if (!test.ok) return { ok: false, error: `Test połączenia nie powiódł się: ${test.detail}` };
  run('UPDATE remote_smtp SET enabled = CASE WHEN id = ? THEN 1 ELSE 0 END', row.id);
  if (config.provider !== 'linux') return { ok: true, simulated: true, output: 'Remote SMTP selected in sandbox' };
  if (!isRoot()) return { ok: false, error: 'Root privileges required' };
  if (!eximBin()) return { ok: false, error: 'Exim is not installed' };
  const conf = '/etc/exim4/update-exim4.conf.conf';
  if (!fs.existsSync(conf)) return { ok: false, error: 'Brak /etc/exim4/update-exim4.conf.conf' };
  backupFile(conf);
  let text = fs.readFileSync(conf, 'utf8');
  text = /^dc_smarthost=.*$/m.test(text) ? text.replace(/^dc_smarthost=.*$/m, `dc_smarthost='[${row.host}]:${row.port}'`) : text + `\ndc_smarthost='[${row.host}]:${row.port}'\n`;
  fs.writeFileSync(conf, text, { mode: 0o644 });
  if (row.username && row.password_enc) {
    const passFile = '/etc/exim4/passwd.client';
    const pass = decryptSecret(row.password_enc);
    const lines = fs.existsSync(passFile) ? fs.readFileSync(passFile, 'utf8').split('\n').filter((l) => l && !l.startsWith(`${row.host}:`)) : [];
    lines.push(`${row.host}:${row.username}:${pass}`);
    fs.writeFileSync(passFile, lines.join('\n') + '\n', { mode: 0o640 });
    sh('chown', ['root:Debian-exim', passFile]);
  }
  const upd = sh('update-exim4.conf');
  const rel = sh('systemctl', ['reload', 'exim4']);
  audit(actor, 'admin', 'mail.remote_smtp.activate', row.host, '');
  return { ok: upd.ok && rel.ok, output: [upd.stdout, rel.stdout].filter(Boolean).join(' ') || 'Remote SMTP activated', error: !upd.ok ? upd.stderr : (!rel.ok ? rel.stderr : '') };
}

export function greylistingSupport() {
  const rspamd = !!which('rspamc');
  const postgrey = !!which('postgrey');
  return { supported: rspamd || postgrey, rspamd, postgrey };
}

export function listEvents({ domain = '', status = '', limit = 100 } = {}) {
  const where = [];
  const params = [];
  if (domain) { where.push('domain = ?'); params.push(domain); }
  if (status) { where.push('status = ?'); params.push(status); }
  return all(`SELECT * FROM mail_events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`, ...params, Number(limit));
}

export function eventStats() {
  return all("SELECT status, COUNT(*) n FROM mail_events WHERE created_at > ? GROUP BY status", new Date(Date.now() - 86400000).toISOString());
}

export function blacklist() {
  return all('SELECT * FROM blacklist_domains ORDER BY domain');
}

export function addBlacklist(domain, actor = 'admin') {
  const d = String(domain || '').trim().toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return { ok: false, error: 'Nieprawidłowa domena' };
  run('INSERT OR IGNORE INTO blacklist_domains(domain, reason, created_at) VALUES(?,?,?)', d, 'panel', nowIso());
  applyEximSettings();
  audit(actor, 'admin', 'mail.blacklist.add', d, '');
  return { ok: true };
}

export function removeBlacklist(id) {
  run('DELETE FROM blacklist_domains WHERE id = ?', Number(id));
  applyEximSettings();
  return { ok: true };
}

export function mailOverview() {
  const q = queueList();
  const stats = Object.fromEntries(eventStats().map((r) => [r.status, r.n]));
  return {
    queue: q.rows.length,
    deferred: q.rows.filter((r) => r.status === 'deferred').length,
    failed: stats.failed || 0,
    delivered: stats.delivered || 0,
    events: Object.values(stats).reduce((a, b) => a + b, 0),
    simulated: q.simulated,
    exim: !!eximBin(),
  };
}
