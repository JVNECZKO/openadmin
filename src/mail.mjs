// Mail stack provisioning: Maildirs, Dovecot passwd-file, Exim virtual domains
// and aliases, plus deployment on Linux. Account passwords are stored as
// SHA512-CRYPT hashes suitable for Dovecot at creation time.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { config } from './config.mjs';
import { all, get, run, nowIso, setting } from './db.mjs';
import { systemProvider } from './providers/index.mjs';
import { userHome, mailHome, virtualMailRoot } from './paths.mjs';

export function dovecotHash(password) {
  const r = spawnSync('openssl', ['passwd', '-6', String(password)], { encoding: 'utf8', timeout: 15000 });
  if (r.status !== 0) throw new Error('openssl is required to hash mailbox passwords');
  return r.stdout.trim();
}

export function mailRoot() {
  const dir = path.join(config.dataDir, 'mail');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function homeOf(username) {
  return userHome(username);
}

function uidOf(username) {
  const r = spawnSync('id', ['-u', username], { encoding: 'utf8' });
  const g = spawnSync('id', ['-g', username], { encoding: 'utf8' });
  return { uid: r.status === 0 ? Number(r.stdout.trim()) : 1000, gid: g.status === 0 ? Number(g.stdout.trim()) : 1000 };
}

function ensureVmail() {
  if (systemProvider().id !== 'linux') return { uid: 1000, gid: 1000 };
  const check = spawnSync('id', ['-u', 'vmail'], { encoding: 'utf8' });
  if (check.status !== 0) {
    spawnSync('groupadd', ['-g', '5000', 'vmail'], { encoding: 'utf8' });
    spawnSync('useradd', ['-r', '-u', '5000', '-g', 'vmail', '-d', '/var/mail/virtual', '-s', '/usr/sbin/nologin', 'vmail'], { encoding: 'utf8' });
  }
  const uid = spawnSync('id', ['-u', 'vmail'], { encoding: 'utf8' });
  const gid = spawnSync('id', ['-g', 'vmail'], { encoding: 'utf8' });
  const root = virtualMailRoot();
  fs.mkdirSync(root, { recursive: true });
  try { fs.chownSync(root, Number(uid.stdout.trim()), Number(gid.stdout.trim())); } catch { /* ignore */ }
  return { uid: Number(uid.stdout.trim()) || 5000, gid: Number(gid.stdout.trim()) || 5000 };
}

function mailIdentity(username) {
  if (systemProvider().id === 'linux') return ensureVmail();
  return uidOf(username);
}

export function ensureMaildir(username, domain, local) {
  const dir = mailHome(username, domain, local);
  for (const sub of ['cur', 'new', 'tmp']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  const { uid, gid } = mailIdentity(username);
  try {
    for (const d of [path.dirname(path.dirname(dir)), path.dirname(dir), dir,
      path.join(dir, 'cur'), path.join(dir, 'new'), path.join(dir, 'tmp')]) {
      fs.chownSync(d, uid, gid);
    }
  } catch { /* sandbox or non-root */ }
  return dir;
}

export function mailAccounts() {
  return all(`SELECT e.*, d.name AS domain_name, d.user_id, u.username
              FROM email_accounts e JOIN domains d ON d.id = e.domain_id JOIN users u ON u.id = d.user_id
              ORDER BY e.domain, e.local_part`);
}

/**
 * One tenant-scoped predicate used by counts and lists. Dashboard, health,
 * mailbox lists and API handlers must all pass the same scope here so a
 * counter can never disagree with the list it summarises.
 */
export function mailboxScope({ userId = null, domain = null } = {}) {
  const where = [];
  const params = [];
  if (domain) {
    where.push('e.domain = ?');
    params.push(String(domain));
  }
  if (userId) {
    where.push('d.user_id = ?');
    params.push(Number(userId));
  }
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

/** COUNT(*) uses the same JOIN/filters as mailboxList(); `get()` is an object. */
export function mailboxCount(options = {}) {
  const scope = mailboxScope(options);
  const row = get(`SELECT COUNT(*) AS n FROM email_accounts e
                   JOIN domains d ON d.id = e.domain_id ${scope.clause}`, ...scope.params);
  return Number(row?.n) || 0;
}

export function mailboxList(options = {}) {
  const scope = mailboxScope(options);
  return all(`SELECT e.*, d.name AS domain_name, d.user_id, u.username
              FROM email_accounts e JOIN domains d ON d.id = e.domain_id
              JOIN users u ON u.id = d.user_id
              ${scope.clause}
              ORDER BY e.domain, e.local_part`, ...scope.params);
}

/**
 * The single mailbox summary used by dashboard/health/list/API callers.
 * `total` is the length of the same scoped list, never a fabricated `0`.
 */
export function mailSummary(options = {}) {
  const rows = mailboxList(options);
  return {
    total: rows.length,
    accounts: rows.length,
    active: rows.filter((row) => !row.suspended).length,
    suspended: rows.filter((row) => row.suspended).length,
    scope: {
      userId: options.userId ? Number(options.userId) : null,
      domain: options.domain ? String(options.domain) : null,
    },
    source: 'email_accounts JOIN domains',
    timestamp: nowIso(),
  };
}

/** Rebuild every mail configuration file from the database. */
export function syncMail() {
  const dir = mailRoot();
  const accounts = mailAccounts();
  const passwd = [];
  const domains = new Set();
  let skipped = 0;
  for (const a of accounts) {
    ensureMaildir(a.username, a.domain, a.local_part);
    domains.add(a.domain);
    if (!a.mail_hash) { skipped++; continue; }
    const { uid, gid } = mailIdentity(a.username);
    passwd.push(`${a.local_part}@${a.domain}:${a.mail_hash}:${uid}:${gid}::${mailHome(a.username, a.domain, a.local_part)}::`);
  }
  fs.writeFileSync(path.join(dir, 'passwd'), passwd.join('\n') + (passwd.length ? '\n' : ''), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'domains'), [...domains].join('\n') + '\n', { mode: 0o644 });
  const aliases = all('SELECT source, domain, dest FROM email_forwarders').map((r) => {
    const src = String(r.source).includes('@') ? r.source : `${r.source}@${r.domain}`;
    return `${src}: ${r.dest}`;
  });
  fs.writeFileSync(path.join(dir, 'aliases'), aliases.join('\n') + (aliases.length ? '\n' : ''), { mode: 0o644 });
  const autoreplies = all(`SELECT email, subject, body FROM autoresponders WHERE enabled = 1`).map((r) => `${r.email}\t${r.subject}\t${String(r.body).replace(/\n/g, ' ')}`);
  fs.writeFileSync(path.join(dir, 'autoreplies'), autoreplies.join('\n') + (autoreplies.length ? '\n' : ''), { mode: 0o644 });
  const catches = all('SELECT domain, dest FROM catchall WHERE dest IS NOT NULL').map((r) => `${r.domain}: ${r.dest}`);
  fs.writeFileSync(path.join(dir, 'catchall'), catches.join('\n') + (catches.length ? '\n' : ''), { mode: 0o644 });
  const owners = all('SELECT e.domain, u.username FROM email_accounts e JOIN domains d ON d.id = e.domain_id JOIN users u ON u.id = d.user_id GROUP BY e.domain, u.username');
  fs.writeFileSync(path.join(dir, 'domain-owners'), owners.map((r) => `${r.domain}: ${r.username}`).join('\n') + (owners.length ? '\n' : ''), { mode: 0o644 });
  run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    'mail_last_sync', new Date().toISOString());
  run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    'mail_skipped_accounts', String(skipped));
  return { ok: true, accounts: accounts.length, passwd: passwd.length, skipped, domains: domains.size, dir };
}

const DOVECOT_CONF = `# Generated by OpenAdmin — Dovecot virtual mail
passdb {
  driver = passwd-file
  args = scheme=SHA512-CRYPT username_format=%u /etc/dovecot/openadmin.passwd
}
userdb {
  driver = passwd-file
  args = username_format=%u /etc/dovecot/openadmin.passwd
}
mail_location = maildir:~/
mail_privileged_group = mail
protocols = imap lmtp
service lmtp {
  inet_listener lmtp {
    address = 127.0.0.1
    port = 24
  }
}
namespace inbox {
  inbox = yes
}
`;

function eximMain() {
  return `# Generated by OpenAdmin — virtual mail domains
domainlist openadmin_domains = /etc/exim4/openadmin/domains
daemon_smtp_ports = 25 : 587
tls_advertise_hosts = *
tls_certificate = /etc/ssl/certs/ssl-cert-snakeoil.pem
tls_privatekey = /etc/ssl/private/ssl-cert-snakeoil.key
DKIM_DOMAIN = \${sender_address_domain}
DKIM_SELECTOR = default
DKIM_PRIVATE_KEY = /etc/opendkim/keys/\${sender_address_domain}.private
`;
}

function eximRouter() {
  return `# Generated by OpenAdmin — aliases
openadmin_aliases:
  driver = redirect
  domains = +openadmin_domains
  data = \${lookup{\${local_part}@\${domain}}lsearch{/etc/exim4/openadmin/aliases}}
  allow_fail
  allow_defer

openadmin_catchall:
  driver = redirect
  domains = +openadmin_domains
  data = \${lookup{*@\${domain}}lsearch{/etc/exim4/openadmin/catchall}}
  allow_fail
  allow_defer

`;
}

function eximLocalRouter() {
  return `# Generated by OpenAdmin — generic virtual delivery
openadmin_local:
  driver = accept
  domains = +openadmin_domains
  transport = openadmin_lmtp
  no_more
`;
}

function eximRemoteRouter() {
  return `# Generated by OpenAdmin — outbound with DKIM
openadmin_remote:
  driver = dnslookup
  domains = ! +local_domains
  transport = openadmin_remote_smtp
  ignore_target_hosts = 0.0.0.0 : 127.0.0.0/8 : 169.254.0.0/16
  no_more
`;
}

function eximTransport() {
  return `# Generated by OpenAdmin — Dovecot LMTP delivery
openadmin_lmtp:
  driver = smtp
  protocol = lmtp
  hosts = 127.0.0.1
  port = 24
  allow_localhost = true

openadmin_remote_smtp:
  driver = smtp
`;
}

export function deployMail() {
  const result = syncMail();
  const provider = systemProvider();
  if (provider.id !== 'linux') {
    return { ok: true, simulated: true, output: `Mail configuration staged in ${result.dir} (${result.passwd} mailboxes, ${result.domains} domains); sandbox provider does not write Dovecot/Exim paths`, ...result };
  }
  if (process.getuid && process.getuid() !== 0) return { ok: false, output: 'Root privileges are required to deploy mail configuration' };
  const steps = [];
  try {
    fs.mkdirSync('/etc/dovecot', { recursive: true });
    fs.writeFileSync('/etc/dovecot/openadmin.passwd', fs.readFileSync(path.join(result.dir, 'passwd')), { mode: 0o640 });
    const doveGid = spawnSync('id', ['-g', 'dovecot'], { encoding: 'utf8' });
    if (doveGid.status === 0) {
      fs.chownSync('/etc/dovecot/openadmin.passwd', 0, Number(doveGid.stdout.trim()));
    }
    fs.writeFileSync('/etc/dovecot/conf.d/99-openadmin.conf', DOVECOT_CONF, { mode: 0o644 });
    steps.push('Dovecot passwd-file written');
  } catch (e) { steps.push(`Dovecot failed: ${e.message}`); }

  const eximDir = '/etc/exim4/openadmin';
  try {
    fs.mkdirSync(eximDir, { recursive: true });
    for (const f of ['domains', 'aliases', 'autoreplies', 'catchall', 'domain-owners']) {
      fs.copyFileSync(path.join(result.dir, f), path.join(eximDir, f));
    }
    fs.mkdirSync('/etc/exim4/conf.d/main', { recursive: true });
    fs.mkdirSync('/etc/exim4/conf.d/router', { recursive: true });
    fs.mkdirSync('/etc/exim4/conf.d/transport', { recursive: true });
    fs.writeFileSync('/etc/exim4/conf.d/main/000_openadmin', eximMain(), { mode: 0o644 });
    fs.writeFileSync('/etc/exim4/conf.d/router/050_openadmin_aliases', eximRouter(), { mode: 0o644 });
    fs.writeFileSync('/etc/exim4/conf.d/router/070_openadmin_local', eximLocalRouter(), { mode: 0o644 });
    fs.writeFileSync('/etc/exim4/conf.d/router/080_openadmin_remote', eximRemoteRouter(), { mode: 0o644 });
    fs.writeFileSync('/etc/exim4/conf.d/transport/100_openadmin_delivery', eximTransport(), { mode: 0o644 });
    const conf = '/etc/exim4/update-exim4.conf.conf';
    if (fs.existsSync(conf)) {
      let text = fs.readFileSync(conf, 'utf8');
      text = text.replace(/^dc_use_split_config=.*$/m, "dc_use_split_config='true'");
      text = text.replace(/^dc_local_interfaces=.*$/m, "dc_local_interfaces='0.0.0.0'");
      if (!/^dc_use_split_config=/m.test(text)) text += "\ndc_use_split_config='true'\n";
      if (!/^dc_local_interfaces=/m.test(text)) text += "\ndc_local_interfaces='0.0.0.0'\n";
      fs.writeFileSync(conf, text);
    }
    spawnSync('update-exim4.conf', [], { encoding: 'utf8', timeout: 30000 });
    steps.push('Exim routers/transport installed');
  } catch (e) { steps.push(`Exim failed: ${e.message}`); }

  const dove = spawnSync('systemctl', ['reload-or-restart', 'dovecot'], { encoding: 'utf8' });
  const exim = spawnSync('sh', ['-c', 'systemctl stop exim4 2>/dev/null; sleep 1; pkill -x exim4 2>/dev/null; sleep 1; systemctl start exim4'], { encoding: 'utf8', timeout: 30000 });
  const ok = dove.status === 0 && exim.status === 0;
  return {
    ok,
    output: `Dovecot ${dove.status === 0 ? 'reloaded' : 'failed'}, Exim ${exim.status === 0 ? 'restarted' : 'failed'} (${result.passwd} mailboxes); ${steps.join('; ')}`,
    ...result,
  };
}

export function mailStatus({ userId = null, domain = null } = {}) {
  const dir = mailRoot();
  const files = ['passwd', 'domains', 'aliases', 'autoreplies', 'catchall']
    .filter((f) => fs.existsSync(path.join(dir, f)))
    .map((f) => ({ name: f, bytes: fs.statSync(path.join(dir, f)).size }));
  const summary = mailSummary({ userId, domain });
  return {
    directory: dir,
    files,
    configBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    accounts: summary.total,
    activeAccounts: summary.active,
    suspendedAccounts: summary.suspended,
    scope: summary.scope,
    source: 'email_accounts',
    timestamp: nowIso(),
    skipped: Number(setting('mail_skipped_accounts', '0')) || 0,
    lastSync: setting('mail_last_sync', ''),
    deployable: systemProvider().id === 'linux',
    dovecot: systemProvider().serviceStatus('dovecot')?.status || null,
    exim: systemProvider().serviceStatus('exim')?.status || null,
  };
}
