// Plan limits: feature sets, global feature switches and best-effort host
// enforcement (quota, process limits, PHP-FPM sizing, systemd slice).
import fs from 'node:fs';
import path from 'node:path';
import { all, get, run, nowIso, setting, setSetting, audit } from './db.mjs';
import { getJson, setJson } from './json.mjs';
import { limitsFor } from './auth.mjs';
import { which, sh, isRoot, writeManaged } from './sys.mjs';
import { fpmSettings } from './phpstack.mjs';
import { deployPools } from './phpfpm.mjs';

export const FEATURES = [
  ['domains', 'Domeny'], ['subdomains', 'Subdomeny'], ['emails', 'Poczta'], ['ftp', 'FTP'],
  ['databases', 'Bazy danych'], ['dns_control', 'DNS'], ['ssl', 'SSL'], ['cron', 'Cron'],
  ['ssh', 'SSH / terminal'], ['wordpress', 'WordPress'], ['nodejs', 'Node.js'], ['python', 'Python'],
  ['git', 'Git'], ['spam', 'Filtr spamu'], ['catch_all', 'Catch-all'], ['cgi', 'CGI'],
];

export function featureSets() { return all('SELECT * FROM feature_sets ORDER BY name'); }

export function saveFeatureSet(body, actor = 'admin') {
  const name = String(body.name || '').trim();
  if (!/^[a-zA-Z0-9_.-]{2,40}$/.test(name)) return { ok: false, error: 'Nieprawidłowa nazwa' };
  const features = {};
  for (const [key] of FEATURES) features[key] = !!(body[`f_${key}`] || body.features?.includes?.(key));
  if (body.id) {
    run('UPDATE feature_sets SET name=?, features=? WHERE id=?', name, JSON.stringify(features), Number(body.id));
    return { ok: true, id: Number(body.id) };
  }
  const r = run('INSERT INTO feature_sets(name, features, created_at) VALUES(?,?,?)', name, JSON.stringify(features), nowIso());
  audit(actor, 'admin', 'plan.feature_set.add', name, '');
  return { ok: true, id: r.lastInsertRowid };
}

export function deleteFeatureSet(id) { run('DELETE FROM feature_sets WHERE id = ?', Number(id)); return { ok: true }; }

export function disabledFeatures() {
  return new Set(getJson('disabled_features', []));
}

export function setFeatureDisabled(feature, disabled, actor = 'admin') {
  if (!FEATURES.some(([k]) => k === feature)) return { ok: false, error: 'Nieznana funkcja' };
  const set = disabledFeatures();
  if (disabled) set.add(feature); else set.delete(feature);
  setJson('disabled_features', [...set]);
  audit(actor, 'admin', 'plan.feature.toggle', `${feature}:${disabled ? 'off' : 'on'}`, '');
  return { ok: true, disabled: [...set] };
}

export function packageResources(pkgName) {
  const pkg = pkgName ? get('SELECT * FROM packages WHERE name = ?', pkgName) : null;
  const lim = pkg ? JSON.parse(pkg.limits || '{}') : {};
  return {
    cpu_percent: Number(lim.cpu_percent || 0),
    memory_mb: Number(lim.memory_mb || 0),
    io_read_mbps: Number(lim.io_read_mbps || 0),
    io_write_mbps: Number(lim.io_write_mbps || 0),
    max_processes: Number(lim.max_processes || 0),
    inodes: Number(lim.inodes || 0),
    disk_mb: Number(lim.disk_mb || 0),
  };
}

/** Best-effort hard limits. Every skipped part is reported, never faked. */
export function applyUserLimits(username, actor = 'admin') {
  const user = get('SELECT * FROM users WHERE username = ?', username);
  if (!user) return { ok: false, error: 'User not found' };
  const lim = limitsFor(user);
  const report = { user: username, applied: [], skipped: [] };
  const nproc = Number(lim.max_processes || 0);
  if (nproc) {
    writeManaged(`/etc/security/limits.d/99-openadmin-${username}.conf`,
      `# Managed by OpenAdmin\n${username} hard nproc ${nproc}\n${username} hard nofile ${Math.max(1024, nproc * 16)}\n`, { mode: 0o644 });
    report.applied.push('limits.conf (nproc/nofile)');
  }
  const slice = `/etc/systemd/system/openadmin-user-${username}.slice`;
  const parts = ['[Slice]'];
  if (lim.cpu_percent) parts.push(`CPUQuota=${Math.max(1, Number(lim.cpu_percent))}%`);
  if (lim.memory_mb) parts.push(`MemoryMax=${Math.max(64, Number(lim.memory_mb))}M`);
  if (lim.max_processes) parts.push(`TasksMax=${Math.max(16, Number(lim.max_processes))}`);
  if (parts.length > 1) {
    writeManaged(slice, parts.join('\n') + '\n', { mode: 0o644 });
    if (which('systemctl') && isRoot()) sh('systemctl', ['daemon-reload']);
    report.applied.push('systemd slice (prepared)');
  }
  if (lim.disk_mb && which('setquota')) {
    if (!isRoot()) report.skipped.push('quota: root required');
    else {
      const blocks = Math.max(1, Math.round(Number(lim.disk_mb) * 1024 / 1024));
      const inodes = Number(lim.inodes || 0);
      const q = sh('setquota', ['-u', username, String(blocks), String(blocks), String(inodes), String(inodes), '/home']);
      if (q.ok) report.applied.push('dysk/inode quota');
      else report.skipped.push(`quota: ${q.stderr || q.error || 'filesystem does not support quota'}`);
    }
  } else if (lim.disk_mb) report.skipped.push('quota: setquota unavailable');
  if (lim.memory_mb) {
    const cur = fpmSettings(username);
    const children = Math.max(2, Math.min(50, Math.floor(Number(lim.memory_mb) / 96)));
    setJson(`fpm_pool:${username}`, { ...cur, 'pm.max_children': children });
    report.applied.push(`PHP-FPM pm.max_children=${children}`);
  }
  audit(actor, 'admin', 'plan.limits.apply', username, '');
  return { ok: true, report };
}

export function applyAllLimits(actor = 'admin') {
  const out = all("SELECT username FROM users WHERE level IN ('user','reseller')").map((u) => applyUserLimits(u.username, actor));
  deployPools();
  return out;
}

export function planOverview() {
  const packages = all('SELECT * FROM packages ORDER BY name');
  const disabled = [...disabledFeatures()];
  return { packages, featureSets: featureSets(), disabled };
}
