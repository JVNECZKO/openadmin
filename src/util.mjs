// Small, dependency-free helpers shared by the UI and the HTTP layer.
import crypto from 'node:crypto';

export const LEVELS = { user: 1, reseller: 2, admin: 3 };

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
export const e = escapeHtml;

export function attr(value) {
  return escapeHtml(value);
}

export function uid(prefix = '') {
  return prefix + crypto.randomBytes(6).toString('hex');
}

export function randomPassword(len = 14) {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#%^*-_';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export function formatBytes(mb) {
  const n = Number(mb) || 0;
  if (n < 1) return `${Math.round(n * 1024)} KB`;
  if (n < 1024) return `${n.toFixed(n < 10 ? 1 : 0)} MB`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(2)} GB`;
  return `${(n / 1024 / 1024).toFixed(2)} TB`;
}

export function formatDate(iso, { time = false } = {}) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const opts = { year: 'numeric', month: 'short', day: '2-digit' };
  if (time) { opts.hour = '2-digit'; opts.minute = '2-digit'; }
  return d.toLocaleDateString('en-GB', opts);
}

export function timeAgo(iso) {
  if (!iso) return 'never';
  const delta = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(delta / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 31) return `${days} d ago`;
  return formatDate(iso);
}

export function pct(used, total) {
  if (!Number(total)) return 0;
  return Math.min(100, Math.round((Number(used) / Number(total)) * 100));
}

export function isEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v || ''));
}

export function isDomain(v) {
  return /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i.test(String(v || ''));
}

export function isUsername(v) {
  return /^[a-z0-9][a-z0-9_.-]{0,31}$/i.test(String(v || ''));
}

export function isIp(v) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(String(v || '')) || /^[0-9a-f:]+$/i.test(String(v || ''));
}

export function safeJson(value, fallback = {}) {
  try { return JSON.parse(value); } catch { return fallback; }
}

/** Basic HTML templating: tagged template that escapes interpolations unless wrapped. */
export function html(strings, ...values) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) {
      const v = values[i];
      if (Array.isArray(v)) out += v.join('');
      else if (v && v.__raw) out += v.value;
      else if (v === null || v === undefined || v === false) out += '';
      else out += escapeHtml(v);
    }
  });
  return { __raw: true, value: out, toString() { return out; } };
}
export const raw = (value) => ({ __raw: true, value: Array.isArray(value) ? value.join('') : String(value ?? '') });

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function parseForm(body) {
  const params = new URLSearchParams(body || '');
  const out = {};
  for (const [k, v] of params) {
    if (k.endsWith('[]')) {
      const key = k.slice(0, -2);
      (out[key] ||= []).push(v);
    } else if (k in out) {
      out[k] = [].concat(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function slugify(v) {
  return String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function clamp(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

export function humanLevel(level) {
  return { admin: 'Administrator', reseller: 'Reseller', user: 'User' }[level] || level;
}
