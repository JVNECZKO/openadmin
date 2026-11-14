// Small privileged-operations toolkit shared by the advanced modules.
// Every write is atomic, optionally backed up, and simulated in sandbox mode.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { config } from './config.mjs';

export function which(bin) {
  const r = spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0 ? (r.stdout || '').trim() : '';
}

export function isRoot() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

export function sh(cmd, args = [], { input, timeout = 30000, env } = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', input, timeout, maxBuffer: 16 * 1024 * 1024, env: env ? { ...process.env, ...env } : process.env });
  return { ok: r.status === 0, status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim(), error: r.error?.message || '' };
}

export function home() {
  return process.env.HOME || requireHome();
}
function requireHome() { return '/root'; }

/** Real path for a managed file; sandbox mirrors it under the data dir. */
export function managedPath(file) {
  if (config.provider === 'linux') return file;
  return path.join(config.dataDir, 'simulated', file.replace(/^\/+/, ''));
}

export function readManaged(file) {
  try { return fs.readFileSync(managedPath(file), 'utf8'); } catch { return null; }
}

export function writeManaged(file, content, { mode = 0o644, backup = true } = {}) {
  const target = managedPath(file);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
  if (backup && fs.existsSync(target)) {
    const dir = path.join(path.dirname(target), '.openadmin-backups');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.copyFileSync(target, path.join(dir, `${path.basename(target)}.${Date.now()}`)); } catch { /* ignore */ }
  }
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, target);
  if (config.provider === 'linux' && process.getuid?.() === 0) {
    try { fs.chownSync(target, 0, 0); } catch { /* ignore */ }
  }
  return { ok: true, path: target, simulated: config.provider !== 'linux' };
}

export function removeManaged(file) {
  try { fs.rmSync(managedPath(file), { force: true }); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
}

export function backupFile(file) {
  if (config.provider !== 'linux') return null;
  if (!fs.existsSync(file)) return null;
  const dir = '/var/lib/openadmin/backups/config';
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const out = path.join(dir, `${path.basename(file)}.${new Date().toISOString().replace(/[:.]/g, '-')}`);
  try { fs.copyFileSync(file, out); return out; } catch { return null; }
}

export function serviceReload(name) {
  if (config.provider !== 'linux') return { ok: true, simulated: true, output: `${name} reload simulated` };
  const r = sh('systemctl', ['reload', name]);
  if (!r.ok) return { ...sh('systemctl', ['restart', name]), output: r.stderr || r.error };
  return r;
}

export function validateSshd(configFile) {
  const bin = which('sshd') || '/usr/sbin/sshd';
  if (!fs.existsSync(bin)) return { ok: false, error: 'sshd not found' };
  return sh(bin, ['-t', '-f', configFile]);
}

export function ipFamily(cidr) {
  const value = String(cidr).split('/')[0];
  return value.includes(':') ? 6 : 4;
}

export function validCidr(cidr) {
  const s = String(cidr).trim();
  const m = /^([0-9a-fA-F:.]+)(?:\/(\d{1,3}))?$/.exec(s);
  if (!m) return false;
  const host = m[1];
  const bits = m[2] === undefined ? null : Number(m[2]);
  if (host.includes(':')) {
    if (bits !== null && (bits < 0 || bits > 128)) return false;
    try { new URL(`http://[${host}]`); return true; } catch { return false; }
  }
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some((p) => p === '' || !/^\d{1,3}$/.test(p) || Number(p) > 255)) return false;
  if (bits !== null && (bits < 0 || bits > 32)) return false;
  return true;
}

export function safeName(value) {
  return /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(String(value || ''));
}
