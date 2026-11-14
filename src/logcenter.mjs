// Central log browser with bounded tail, literal filter, download and rotation.
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';
import { all } from './db.mjs';
import { writeManaged, readManaged, sh, which, isRoot } from './sys.mjs';

const FIXED = [
  ['nginx-access', 'Nginx access', '/var/log/nginx/access.log'],
  ['nginx-error', 'Nginx error', '/var/log/nginx/error.log'],
  ['apache-access', 'Apache access', '/var/log/apache2/access.log'],
  ['apache-error', 'Apache error', '/var/log/apache2/error.log'],
  ['exim', 'Exim mainlog', '/var/log/exim4/mainlog'],
  ['mail', 'Mail log', '/var/log/mail.log'],
  ['auth', 'Auth log', '/var/log/auth.log'],
  ['syslog', 'Syslog', '/var/log/syslog'],
  ['modsec', 'ModSecurity audit', '/var/log/modsec/audit.log'],
  ['panel', 'Panel log', '/var/log/openadmin/panel.log'],
];

export function sources() {
  const list = [];
  for (const [id, label, file] of FIXED) {
    if (fs.existsSync(file)) list.push({ id, label, file, size: fs.statSync(file).size });
  }
  if (config.provider !== 'linux') {
    const dir = path.join(config.dataDir, 'simulated', 'var', 'log');
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.log'))) list.push({ id: `sim:${f}`, label: f, file: path.join(dir, f), size: fs.statSync(path.join(dir, f)).size });
    }
  }
  return list;
}

function resolveSource(id) {
  const s = sources().find((x) => x.id === id);
  if (!s) return null;
  if (config.provider !== 'linux' && !s.file.startsWith(path.join(config.dataDir, 'simulated'))) return null;
  return s;
}

export function tail(id, { lines = 200, query = '' } = {}) {
  const src = resolveSource(String(id));
  if (!src) return { ok: false, error: 'Nieznane źródło logu' };
  const max = 512 * 1024;
  let text = '';
  try {
    const stat = fs.statSync(src.file);
    const start = Math.max(0, stat.size - max);
    const fd = fs.openSync(src.file, 'r');
    const buf = Buffer.alloc(Math.min(max, stat.size));
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch (e) { return { ok: false, error: e.message }; }
  let rows = text.split('\n').filter(Boolean);
  if (query) { const q = String(query).toLowerCase(); rows = rows.filter((r) => r.toLowerCase().includes(q)); }
  rows = rows.slice(-Math.min(2000, Math.max(1, Number(lines) || 200)));
  return { ok: true, rows, source: { id: src.id, label: src.label, file: src.file, size: src.size } };
}

export function downloadSource(id) {
  const src = resolveSource(String(id));
  if (!src) return { ok: false, error: 'Nieznane źródło logu' };
  try { return { ok: true, filename: path.basename(src.file), data: fs.readFileSync(src.file) }; } catch (e) { return { ok: false, error: e.message }; }
}

export function rotationConfig() {
  return readManaged('/etc/logrotate.d/openadmin') || `# Managed by OpenAdmin
/var/log/openadmin/*.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
`;
}

export function saveRotation(text, actor = 'admin') {
  const body = String(text || '');
  if (body.length > 20000) return { ok: false, error: 'Konfiguracja jest za duża' };
  writeManaged('/etc/logrotate.d/openadmin', body, { mode: 0o644 });
  if (config.provider === 'linux' && isRoot() && which('logrotate')) {
    const test = sh('logrotate', ['-d', '/etc/logrotate.d/openadmin'], { timeout: 30000 });
    if (!test.ok) return { ok: false, error: `logrotate -d: ${test.stderr || test.stdout}` };
  }
  return { ok: true };
}
