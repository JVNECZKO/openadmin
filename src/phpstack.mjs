// MultiPHP / PHP-FPM / Apache stack manager.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { config } from './config.mjs';
import { all, get, setting, setSetting, audit } from './db.mjs';
import { getJson, setJson } from './json.mjs';
import { which, sh, isRoot, writeManaged, readManaged, backupFile, serviceReload } from './sys.mjs';
import { deployPools, fpmUnit } from './phpfpm.mjs';

const INI_ALLOW = new Set([
  'memory_limit', 'upload_max_filesize', 'post_max_size', 'max_execution_time', 'max_input_time',
  'max_input_vars', 'display_errors', 'log_errors', 'error_reporting', 'date.timezone',
  'allow_url_fopen', 'allow_url_include', 'disable_functions', 'open_basedir', 'session.gc_maxlifetime',
  'opcache.enable', 'opcache.memory_consumption', 'opcache.max_accelerated_files', 'realpath_cache_size',
]);
const FPM_ALLOW = new Set(['pm', 'pm.max_children', 'pm.start_servers', 'pm.min_spare_servers', 'pm.max_spare_servers', 'pm.max_requests', 'pm.process_idle_timeout', 'rlimit_files', 'rlimit_core', 'request_terminate_timeout']);

export function versions() {
  const base = '/etc/php';
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base).filter((v) => /^\d+\.\d+$/.test(v) && fs.existsSync(path.join(base, v, 'fpm'))).sort((a, b) => Number(b.replace('.', '')) - Number(a.replace('.', '')));
}

export function phpBinary(v) {
  for (const p of [`/usr/bin/php${v}`, `/usr/local/bin/php${v}`, '/usr/bin/php']) if (fs.existsSync(p)) return p;
  return which('php');
}

export function extensions(v) {
  const bin = phpBinary(v);
  if (!bin) return [];
  const r = spawnSync(bin, ['-m'], { encoding: 'utf8', timeout: 15000 });
  return r.status === 0 ? r.stdout.split('\n').map((x) => x.trim()).filter((x) => x && !x.startsWith('[')) : [];
}

export function iniValues(v) {
  const bin = phpBinary(v);
  if (!bin) return {};
  const r = spawnSync(bin, ['-r', 'echo json_encode(ini_get_all(null,false));'], { encoding: 'utf8', timeout: 15000 });
  try { return JSON.parse(r.stdout || '{}'); } catch { return {}; }
}

export function managedIni(v) {
  return readManaged(`/etc/php/${v}/fpm/conf.d/99-openadmin.ini`) || '';
}

export function saveIni(v, body, actor = 'admin') {
  if (!versions().includes(v)) return { ok: false, error: 'Nieznana wersja PHP' };
  const lines = ['; Managed by OpenAdmin'];
  for (const [key, value] of Object.entries(body)) {
    if (!INI_ALLOW.has(key)) continue;
    const val = String(value).trim();
    if (!val || /[\r\n]/.test(val)) continue;
    lines.push(`${key} = ${val}`);
  }
  const file = `/etc/php/${v}/fpm/conf.d/99-openadmin.ini`;
  const prev = readManaged(file);
  writeManaged(file, lines.join('\n') + '\n', { mode: 0o644 });
  if (config.provider === 'linux') {
    const test = sh(`php-fpm${v}`, ['-t'], { timeout: 20000 });
    if (!test.ok) {
      if (prev !== null) writeManaged(file, prev, { mode: 0o644, backup: false });
      return { ok: false, error: `php-fpm${v} -t: ${test.stderr || test.stdout}` };
    }
    const rel = serviceReload(fpmUnit());
    if (!rel.ok) return { ok: false, error: `Reload failed: ${rel.stderr || rel.output}` };
  }
  audit(actor, 'admin', 'php.ini.save', v, '');
  return { ok: true, simulated: config.provider !== 'linux' };
}

export function toggleExtension(v, ext, enabled, actor = 'admin') {
  if (!/^[a-z0-9_]+$/i.test(ext)) return { ok: false, error: 'Invalid extension name' };
  if (!versions().includes(v)) return { ok: false, error: 'Unknown PHP version' };
  if (config.provider !== 'linux') {
    const key = `php_ext:${v}`;
    const set = new Set(getJson(key, []));
    if (enabled) set.add(ext); else set.delete(ext);
    setJson(key, [...set]);
    return { ok: true, simulated: true };
  }
  if (!isRoot()) return { ok: false, error: 'Root privileges required' };
  const tool = enabled ? which('phpenmod') : which('phpdismod');
  if (!tool) return { ok: false, error: 'Brak phpenmod/phpdismod (pakiet php-common)' };
  const r = sh(tool, ['-v', v, '-s', 'ALL', ext], { timeout: 30000 });
  if (!r.ok) return { ok: false, error: r.stderr || r.error };
  const rel = serviceReload(fpmUnit());
  audit(actor, 'admin', `php.ext.${enabled ? 'enable' : 'disable'}`, `${v}:${ext}`, '');
  return rel.ok ? { ok: true } : { ok: false, error: rel.stderr || rel.output };
}

export function fpmSettings(username) {
  return getJson(`fpm_pool:${username}`, {
    pm: 'ondemand', 'pm.max_children': 10, 'pm.start_servers': 2, 'pm.min_spare_servers': 1,
    'pm.max_spare_servers': 3, 'pm.max_requests': 500, 'pm.process_idle_timeout': '10s',
    'request_terminate_timeout': '60s', rlimit_files: 1024,
  });
}

export function saveFpmSettings(username, body, actor = 'admin') {
  const cur = fpmSettings(username);
  const next = { ...cur };
  for (const [k, v] of Object.entries(body)) {
    if (!FPM_ALLOW.has(k)) continue;
    next[k] = String(v).trim();
  }
  if (!['static', 'dynamic', 'ondemand'].includes(next.pm)) next.pm = 'ondemand';
  for (const key of ['pm.max_children', 'pm.start_servers', 'pm.min_spare_servers', 'pm.max_spare_servers', 'pm.max_requests', 'rlimit_files']) {
    const n = Number(next[key]);
    if (!Number.isFinite(n) || n < 0 || n > 100000) return { ok: false, error: `Invalid ${key}` };
  }
  setJson(`fpm_pool:${username}`, next);
  const dep = deployPools();
  audit(actor, 'admin', 'php.fpm.save', username, '');
  return { ok: dep.ok, output: dep.output, error: dep.ok ? '' : dep.output, simulated: dep.simulated };
}

export function apacheStatus() {
  const apache = which('apache2ctl');
  if (!apache) return { available: false, modules: [], enabled: [] };
  const r = sh('apache2ctl', ['-M'], { timeout: 15000 });
  const modules = r.ok ? r.stdout.split('\n').filter((x) => /_module/.test(x)).map((x) => x.trim()) : [];
  return { available: true, modules, enabled: modules };
}

export function toggleApacheModule(name, enabled, actor = 'admin') {
  if (!/^[a-z0-9_]+$/i.test(name)) return { ok: false, error: 'Invalid module' };
  if (config.provider !== 'linux') return { ok: true, simulated: true };
  if (!isRoot()) return { ok: false, error: 'Root privileges required' };
  const tool = enabled ? which('a2enmod') : which('a2dismod');
  if (!tool) return { ok: false, error: 'Apache is not installed' };
  const r = sh(tool, [name], { timeout: 30000 });
  if (!r.ok) return { ok: false, error: r.stderr || r.error };
  const test = sh('apache2ctl', ['configtest'], { timeout: 30000 });
  if (!test.ok) return { ok: false, error: `Apache configtest: ${test.stderr || test.stdout}` };
  const rel = serviceReload('apache2');
  audit(actor, 'admin', `apache.module.${enabled ? 'enable' : 'disable'}`, name, '');
  return rel.ok ? { ok: true } : { ok: false, error: rel.stderr || rel.output };
}
