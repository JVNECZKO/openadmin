// Storage destinations and capacity alerts.
import fs from 'node:fs';
import path from 'node:path';
import { all, get, run, nowIso, audit, setting, setSetting } from './db.mjs';

export function listStorage() {
  return all('SELECT * FROM storage_paths ORDER BY id').map((s) => {
    let total = 0; let free = 0;
    try { const st = fs.statfsSync(s.path); total = st.blocks * st.bsize; free = st.bavail * st.bsize; } catch { /* ignore */ }
    const used = total ? (total - free) / total * 100 : 0;
    return { ...s, total, free, used, alert: used >= s.alert_percent, exists: fs.existsSync(s.path) };
  });
}

export function saveStorage(body, actor = 'admin') {
  const p = String(body.path || '').trim();
  if (!p.startsWith('/')) return { ok: false, error: 'Ścieżka musi być absolutna' };
  if (body.id) {
    run('UPDATE storage_paths SET name=?, path=?, type=?, alert_percent=? WHERE id=?', String(body.name || p), p, String(body.type || 'ext4'), Math.min(99, Math.max(50, Number(body.alert_percent || 90))), Number(body.id));
    return { ok: true, id: Number(body.id) };
  }
  try { fs.mkdirSync(p, { recursive: true, mode: 0o755 }); } catch (e) { return { ok: false, error: e.message }; }
  const r = run('INSERT INTO storage_paths(name, path, type, alert_percent, is_default, created_at) VALUES(?,?,?,?,?,?)',
    String(body.name || p), p, String(body.type || 'ext4'), Math.min(99, Math.max(50, Number(body.alert_percent || 90))), body.is_default ? 1 : 0, nowIso());
  if (body.is_default) { run('UPDATE storage_paths SET is_default = 0 WHERE id != ?', r.lastInsertRowid); setSetting('storage_default', p); }
  audit(actor, 'admin', 'storage.add', p, '');
  return { ok: true, id: r.lastInsertRowid };
}

export function deleteStorage(id, actor = 'admin') {
  const row = get('SELECT * FROM storage_paths WHERE id = ?', Number(id));
  if (!row) return { ok: false, error: 'Not found' };
  if (row.is_default) return { ok: false, error: 'Nie można usunąć domyślnego storage' };
  run('DELETE FROM storage_paths WHERE id = ?', row.id);
  audit(actor, 'admin', 'storage.delete', row.path, '');
  return { ok: true };
}

export function storageWarnings() {
  return listStorage().filter((s) => s.alert);
}

export function storageOverview() {
  return { paths: listStorage(), defaultPath: setting('storage_default', '/home'), warnings: storageWarnings() };
}
