// Real, bounded file editor for panel-managed configuration and (as root on
// Linux) selected system files. Every save is backed up and validated.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { config } from './config.mjs';
import { systemProvider } from './providers/index.mjs';

const SYSTEM_FILES = [
  '/etc/nginx/nginx.conf',
  '/etc/apache2/apache2.conf',
  '/etc/httpd/conf/httpd.conf',
  '/etc/exim4/exim4.conf',
  '/etc/dovecot/dovecot.conf',
  '/etc/bind/named.conf.local',
  '/etc/named.conf',
];

function under(root, p) {
  const resolved = path.resolve(p);
  return resolved === path.resolve(root) || resolved.startsWith(path.resolve(root) + path.sep);
}

export function editorTargets() {
  const targets = [];
  const add = (file, label, writable) => { if (fs.existsSync(file)) targets.push({ path: file, label, writable }); };
  const web = path.join(config.dataDir, 'webserver');
  for (const server of fs.existsSync(web) ? fs.readdirSync(web) : []) {
    const dir = path.join(web, server, 'sites');
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.endsWith('.conf')) : []) {
      add(path.join(dir, f), `${server}: ${f}`, true);
    }
  }
  add(path.join(config.dataDir, 'dns', 'named.conf.openadmin'), 'dns: named.conf', true);
  add(path.join(config.dataDir, 'mail', 'domains'), 'mail: domains', true);
  add(path.join(config.dataDir, 'mail', 'aliases'), 'mail: aliases', true);
  for (const f of fs.existsSync(path.join(config.dataDir, 'cron')) ? fs.readdirSync(path.join(config.dataDir, 'cron')).filter((x) => x.endsWith('.cron')) : []) {
    add(path.join(config.dataDir, 'cron', f), `cron: ${f}`, true);
  }
  const root = systemProvider().id === 'linux' && process.getuid && process.getuid() === 0;
  if (root) for (const f of SYSTEM_FILES) add(f, f, true);
  return targets;
}

export function readTarget(file) {
  const targets = editorTargets();
  const target = targets.find((t) => t.path === file);
  if (!target) return { ok: false, error: 'File is not in the editable set' };
  try {
    const stat = fs.statSync(file);
    if (stat.size > 2 * 1024 * 1024) return { ok: false, error: 'File is larger than 2 MB' };
    return {
      ok: true, path: file, writable: target.writable,
      content: fs.readFileSync(file, 'utf8'),
      bytes: stat.size, mtime: stat.mtime.toISOString(),
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function validate(file, content) {
  const tmp = `${file}.openadmin-check-${process.pid}`;
  fs.writeFileSync(tmp, content);
  try {
    if (file.endsWith('.conf') && file.includes('/webserver/nginx/sites/')) {
      if ((content.match(/\{/g) || []).length !== (content.match(/\}/g) || []).length) return 'Unbalanced braces';
    } else if (file.endsWith('.conf') && file.includes('/webserver/nginx/')) {
      const bin = spawnSync('sh', ['-c', 'command -v nginx'], { encoding: 'utf8' });
      if (bin.status === 0) {
        const r = spawnSync(bin.stdout.trim(), ['-t', '-c', tmp], { encoding: 'utf8', timeout: 15000 });
        if (r.status !== 0) return (r.stderr || '').trim() || 'nginx rejected the configuration';
      } else if ((content.match(/\{/g) || []).length !== (content.match(/\}/g) || []).length) {
        return 'Unbalanced braces';
      }
    }
    if (file.endsWith('named.conf.openadmin')) {
      const r = spawnSync('named-checkconf', [tmp], { encoding: 'utf8', timeout: 15000 });
      if (r.status !== 0) return (r.stderr || '').trim() || 'named-checkconf rejected the file';
    }
    return null;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export function saveTarget(file, content) {
  const targets = editorTargets();
  const target = targets.find((t) => t.path === file);
  if (!target) return { ok: false, error: 'File is not in the editable set' };
  if (!target.writable) return { ok: false, error: 'File is read-only in this provider' };
  if (!under(file.startsWith('/etc') ? '/etc' : config.dataDir, file)) return { ok: false, error: 'Path escapes the editable root' };
  const problem = validate(file, content);
  if (problem) return { ok: false, error: `Validation failed: ${problem}` };
  const backup = `${file}.bak.${Date.now()}`;
  try {
    fs.copyFileSync(file, backup);
    fs.writeFileSync(file, content, { mode: fs.statSync(file).mode });
    return { ok: true, backup };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
