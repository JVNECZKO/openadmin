// Live cPanel/DirectAdmin transfer over SSH + rsync. Files are copied to a
// staging directory, webroots are mapped to the target account and every step
// is written to import_jobs. Database dumps are intentionally left to the
// archive importer unless the remote admin supplies SQL dumps.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { config } from './config.mjs';
import { get, run, all, nowIso, audit } from './db.mjs';
import { encryptSecret, decryptSecret } from './secrets.mjs';
import { userHome } from './paths.mjs';
import { which } from './sys.mjs';
import { apply } from './apply.mjs';

function sshArgs({ host, port = 22, username, password, key }) {
  const args = ['-p', String(port), '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15', '-o', 'UserKnownHostsFile=/dev/null'];
  const sshpass = which('sshpass');
  if (password && sshpass) args.unshift('-e'); // consumed by sshpass below
  if (key) args.push('-i', key);
  return { args, sshpass: password ? sshpass : '' };
}

function withAuth(base, opts) {
  if (opts.password) {
    const sshpass = which('sshpass');
    if (!sshpass) return { ok: false, error: 'Do transferu z hasłem potrzebny jest sshpass (apt install sshpass). Użyj klucza SSH.' };
    return { ok: true, cmd: sshpass, args: ['-e', ...base], env: { ...process.env, SSHPASS: opts.password } };
  }
  return { ok: true, cmd: 'ssh', args: base, env: process.env };
}

export function checkTools() {
  return { ssh: !!which('ssh'), rsync: !!which('rsync'), sshpass: !!which('sshpass') };
}

export function liveJobs(limit = 50) {
  return all("SELECT * FROM import_jobs WHERE source IN ('cpanel-live','da-live') ORDER BY id DESC LIMIT ?", Number(limit));
}

export function testLive({ host, port = 22, username, password, key, source = 'cpanel' }) {
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(String(host || ''))) return { ok: false, error: 'Nieprawidłowy host' };
  if (!/^[a-z_][a-z0-9_-]{0,31}$/i.test(String(username || ''))) return { ok: false, error: 'Nieprawidłowy użytkownik SSH' };
  const tools = checkTools();
  if (!tools.ssh) return { ok: false, error: 'Brak klienta ssh' };
  if (password && !tools.sshpass) return { ok: false, error: 'Brak sshpass — użyj klucza SSH lub zainstaluj sshpass' };
  if (config.provider !== 'linux') return { ok: true, simulated: true, output: 'Połączenie SSH zasymulowane (sandbox)' };
  let keyFile = null;
  try {
    let keyPath = null;
    if (key) {
      keyFile = path.join(config.dataDir, `transfer-key-${Date.now()}`);
      fs.writeFileSync(keyFile, key, { mode: 0o600 });
      keyPath = keyFile;
    }
    const base = ['-p', String(port), '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15', '-o', 'UserKnownHostsFile=/dev/null', ...(keyPath ? ['-i', keyPath] : []), `${username}@${host}`, 'echo OPENADMIN_OK'];
    const auth = withAuth(base, { password });
    if (!auth.ok) return auth;
    const r = spawnSync(auth.cmd, auth.args, { encoding: 'utf8', timeout: 30000, env: auth.env });
    return r.status === 0 && /OPENADMIN_OK/.test(r.stdout) ? { ok: true, output: 'SSH działa' } : { ok: false, error: (r.stderr || r.stdout || 'SSH failed').trim().slice(0, 500) };
  } finally {
    if (keyFile) try { fs.rmSync(keyFile, { force: true }); } catch { /* ignore */ }
  }
}

export function createLiveJob(body, actor = 'admin') {
  const source = body.source === 'directadmin' ? 'da-live' : 'cpanel-live';
  const host = String(body.host || '').trim();
  const username = String(body.username || '').trim();
  const target = String(body.target || '').trim();
  if (!get('SELECT id FROM users WHERE username = ?', target)) return { ok: false, error: 'Konto docelowe nie istnieje' };
  const opts = { host, port: Number(body.port || 22), username, password: body.password ? encryptSecret(String(body.password)) : null, key: body.key ? encryptSecret(String(body.key)) : null, sourceDir: String(body.source_dir || '').trim() };
  const r = run('INSERT INTO import_jobs(source, host, username, target, status, progress, log, options, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    source, host, username, target, 'pending', 0, '', JSON.stringify(opts), nowIso());
  audit(actor, 'admin', 'import.live.create', `${host}:${username} -> ${target}`, '');
  return { ok: true, id: r.lastInsertRowid };
}

function log(jobId, line) {
  const row = get('SELECT log FROM import_jobs WHERE id = ?', jobId);
  run('UPDATE import_jobs SET log = ? WHERE id = ?', `${row?.log || ''}${new Date().toISOString()} ${line}\n`, jobId);
}

export function runLiveJob(jobId) {
  const job = get('SELECT * FROM import_jobs WHERE id = ?', Number(jobId));
  if (!job) return { ok: false, error: 'Job not found' };
  const opts = JSON.parse(job.options || '{}');
  const target = get('SELECT * FROM users WHERE username = ?', job.target);
  if (!target) return { ok: false, error: 'Target user missing' };
  run("UPDATE import_jobs SET status = 'running', progress = 10 WHERE id = ?", job.id);
  log(job.id, `start ${job.source} ${job.host} -> ${target.username}`);
  if (config.provider !== 'linux') {
    run("UPDATE import_jobs SET status = 'complete', progress = 100, finished_at = ? WHERE id = ?", nowIso(), job.id);
    log(job.id, 'sandbox: transfer simulated');
    return { ok: true, simulated: true };
  }
  const tools = checkTools();
  if (!tools.ssh || !tools.rsync) {
    run("UPDATE import_jobs SET status = 'failed', finished_at = ? WHERE id = ?", nowIso(), job.id);
    log(job.id, 'missing ssh/rsync');
    return { ok: false, error: 'Brak ssh lub rsync' };
  }
  let keyFile = null;
  const staging = fs.mkdtempSync(path.join(config.dataDir, 'live-import-'));
  try {
    let keyPath = null;
    if (opts.key) {
      keyFile = path.join(config.dataDir, `transfer-key-${Date.now()}`);
      fs.writeFileSync(keyFile, decryptSecret(opts.key), { mode: 0o600 });
      keyPath = keyFile;
    }
    const remote = `${opts.username}@${opts.host}`;
    const sourceDir = opts.sourceDir || `/home/${opts.username}/`;
    const sshOpts = `ssh -p ${Number(opts.port) || 22} -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -o UserKnownHostsFile=/dev/null${keyPath ? ` -i ${keyPath}` : ''}`;
    const args = ['-az', '--delete', '-e', sshOpts, `${remote}:${sourceDir}`, staging + '/'];
    let r;
    if (opts.password) {
      if (!tools.sshpass) throw new Error('sshpass is required for password transfer');
      r = spawnSync(tools.sshpass, ['-e', 'rsync', ...args], { encoding: 'utf8', timeout: 1800000, env: { ...process.env, SSHPASS: decryptSecret(opts.password) } });
    } else {
      r = spawnSync('rsync', args, { encoding: 'utf8', timeout: 1800000 });
    }
    if (r.status !== 0) throw new Error((r.stderr || 'rsync failed').trim().slice(0, 800));
    log(job.id, 'files copied to staging');
    run('UPDATE import_jobs SET progress = 60 WHERE id = ?', job.id);
    const home = userHome(target.username);
    fs.mkdirSync(home, { recursive: true });
    const dirs = fs.readdirSync(staging, { withFileTypes: true });
    let copied = 0;
    const primary = get('SELECT * FROM domains WHERE user_id = ? ORDER BY is_main DESC, id LIMIT 1', target.id);
    for (const ent of dirs) {
      if (!ent.isDirectory()) continue;
      const p = path.join(staging, ent.name);
      if (ent.name === 'public_html' && primary) {
        fs.mkdirSync(primary.docroot, { recursive: true });
        fs.cpSync(p, primary.docroot, { recursive: true, force: true });
        copied++;
      } else if (ent.name === 'domains') {
        for (const d of fs.readdirSync(p)) {
          const dd = get('SELECT * FROM domains WHERE name = ? AND user_id = ?', d, target.id);
          if (!dd) continue;
          const pub = path.join(p, d, 'public_html');
          if (fs.existsSync(pub)) { fs.mkdirSync(dd.docroot, { recursive: true }); fs.cpSync(pub, dd.docroot, { recursive: true, force: true }); copied++; }
        }
      }
    }
    if (!copied) {
      fs.cpSync(staging, path.join(home, 'imported', `live-${job.id}`), { recursive: true, force: true });
    }
    spawnSync('chown', ['-R', `${target.username}:${target.username}`, home], { encoding: 'utf8', timeout: 120000 });
    log(job.id, `webroots copied: ${copied}`);
    if (primary) apply({ web: true, pools: true });
    run("UPDATE import_jobs SET status = 'complete', progress = 100, finished_at = ? WHERE id = ?", nowIso(), job.id);
    log(job.id, 'done');
    audit('admin', 'admin', 'import.live.complete', job.host, '');
    return { ok: true, copied };
  } catch (e) {
    run("UPDATE import_jobs SET status = 'failed', finished_at = ? WHERE id = ?", nowIso(), job.id);
    log(job.id, `failed: ${e.message}`);
    return { ok: false, error: e.message };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    if (keyFile) try { fs.rmSync(keyFile, { force: true }); } catch { /* ignore */ }
  }
}
