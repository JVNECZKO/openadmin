// JSON values persisted in the settings table.
import { get, run } from './db.mjs';
import { safeJson } from './util.mjs';

export function getJson(key, fallback = null) {
  const row = get('SELECT value FROM settings WHERE key = ?', key);
  if (!row) return fallback;
  return safeJson(row.value, row.value);
}

export function setJson(key, value) {
  run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key, typeof value === 'string' ? value : JSON.stringify(value));
}

export function updateJson(key, fn, fallback = {}) {
  const next = fn(getJson(key, fallback) || fallback);
  setJson(key, next);
  return next;
}
