// Panel and OS update center. Checks are read-only; applying is explicit and
// always preceded by a local backup/staging report.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { config, VERSION } from './config.mjs';
import { setting, setSetting, audit, nowIso } from './db.mjs';
import { which, sh, isRoot } from './sys.mjs';

const REPO = 'JVNECZKO/openadmin';

export async function checkPanel() {
  const current = VERSION;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { 'user-agent': 'OpenAdmin-update-check' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return { ok: false, error: `GitHub HTTP ${res.status}`, current };
    const json = await res.json();
    const latest = String(json.tag_name || '').replace(/^v/, '') || current;
    return { ok: true, current, latest, url: json.tarball_url || `https://codeload.github.com/${REPO}/tar.gz/refs/heads/main`, notes: json.body || '', published: json.published_at || '', update: cmp(latest, current) > 0 };
  } catch (e) {
    return { ok: false, error: e.message, current };
  }
}

function cmp(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

export function osCheck() {
  if (config.provider !== 'linux') return { ok: true, packages: [], simulated: true };
  const r = sh('apt-get', ['-s', 'upgrade'], { timeout: 60000 });
  if (!r.ok) return { ok: false, error: r.stderr || r.error, packages: [] };
  const packages = r.stdout.split('\n').filter((l) => /^Inst /.test(l)).map((l) => {
    const m = /^Inst (\S+) \[([^\]]+)\] \(([^ ]+)/.exec(l);
    return m ? { name: m[1], from: m[2], to: m[3] } : { name: l.replace(/^Inst /, '') };
  });
  return { ok: true, packages, simulated: false };
}

export async function stagePanelUpdate({ apply = false, actor = 'admin' } = {}) {
  if (!isRoot() && config.provider === 'linux') return { ok: false, error: 'Root privileges required' };
  const check = await checkPanel();
  if (!check.ok) return { ok: false, error: check.error };
  if (!check.update) return { ok: true, current: check.current, latest: check.latest, note: 'Brak nowszej wersji' };
  if (!apply) return { ok: true, dryRun: true, current: check.current, latest: check.latest, url: check.url, backupDir: path.join(config.dataDir, 'updates') };
  const dir = path.join(config.dataDir, 'updates');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tar = path.join(dir, `panel-${check.latest}.tar.gz`);
  const dl = sh('curl', ['-fL', '--max-time', '120', '-o', tar, check.url], { timeout: 130000 });
  if (!dl.ok) return { ok: false, error: `Download failed: ${dl.stderr || dl.error}` };
  const extract = fs.mkdtempSync(path.join(dir, 'stage-'));
  const ex = spawnSync('tar', ['-xzf', tar, '-C', extract, '--strip-components=1'], { encoding: 'utf8', timeout: 120000 });
  if (ex.status !== 0) return { ok: false, error: (ex.stderr || 'extract failed').trim() };
  if (!fs.existsSync(path.join(extract, 'src', 'server.mjs'))) return { ok: false, error: 'Paczka nie zawiera src/server.mjs' };
  const backup = path.join(dir, `backup-${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz`);
  const b = spawnSync('tar', ['-czf', backup, '-C', config.root, 'src', 'bin', 'package.json'], { encoding: 'utf8', timeout: 120000 });
  if (b.status !== 0) return { ok: false, error: `Backup failed: ${(b.stderr || '').trim()}` };
  const cp = spawnSync('cp', ['-a', path.join(extract, 'src'), config.root + '/'], { encoding: 'utf8', timeout: 120000 });
  const cpBin = spawnSync('cp', ['-a', path.join(extract, 'bin'), config.root + '/'], { encoding: 'utf8', timeout: 120000 });
  if (cp.status !== 0 || cpBin.status !== 0) return { ok: false, error: 'Copy failed; backup retained at ' + backup };
  setSetting('panel_last_update', nowIso());
  audit(actor, 'admin', 'updates.panel', `${check.current} -> ${check.latest}`, '');
  return { ok: true, applied: true, backup, current: check.current, latest: check.latest, restart: 'systemctl restart openadmin' };
}

export function applyOsUpdates({ apply = false, actor = 'admin' } = {}) {
  if (config.provider !== 'linux') return { ok: true, simulated: true, packages: [] };
  if (!isRoot()) return { ok: false, error: 'Root privileges required' };
  const check = osCheck();
  if (!check.ok) return check;
  if (!apply) return { ...check, dryRun: true };
  const r = sh('apt-get', ['-y', 'upgrade'], { timeout: 1800000 });
  audit(actor, 'admin', 'updates.os', `${check.packages.length} packages`, '');
  return { ok: r.ok, output: r.stdout || r.stderr, count: check.packages.length };
}

export function updateInfo() {
  return { current: VERSION, lastPanel: setting('panel_last_update', ''), lastOs: setting('os_last_update', '') };
}
