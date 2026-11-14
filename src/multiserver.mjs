// Multi-server registry and health checks against remote OpenAdmin nodes.
import { all, get, run, nowIso, audit } from './db.mjs';
import { encryptSecret, decryptSecret } from './secrets.mjs';

export function nodes() { return all('SELECT * FROM servers ORDER BY name'); }

export function saveNode(body, actor = 'admin') {
  const name = String(body.name || '').trim();
  const url = String(body.url || '').trim().replace(/\/$/, '');
  if (!name) return { ok: false, error: 'Nazwa jest wymagana' };
  if (!/^https?:\/\/[a-z0-9.:[\]-]+$/i.test(url)) return { ok: false, error: 'URL musi być http(s)' };
  const role = ['web', 'db', 'dns', 'mail', 'backup'].includes(body.role) ? body.role : 'web';
  const token = body.token ? encryptSecret(String(body.token)) : null;
  if (body.id) {
    run('UPDATE servers SET name=?, url=?, role=?, token_enc=COALESCE(?, token_enc), enabled=? WHERE id=?', name, url, role, token, body.enabled === undefined || !!body.enabled ? 1 : 0, Number(body.id));
    return { ok: true, id: Number(body.id) };
  }
  const r = run('INSERT INTO servers(name, url, token_enc, role, enabled, created_at) VALUES(?,?,?,?,?,?)', name, url, token, role, 1, nowIso());
  audit(actor, 'admin', 'multiserver.add', `${name}:${url}`, '');
  return { ok: true, id: r.lastInsertRowid };
}

export function deleteNode(id, actor = 'admin') {
  run('DELETE FROM servers WHERE id = ?', Number(id));
  audit(actor, 'admin', 'multiserver.delete', String(id), '');
  return { ok: true };
}

export async function checkNode(node) {
  try {
    const headers = node.token_enc ? { Authorization: `Bearer ${decryptSecret(node.token_enc)}` } : {};
    const ping = await fetch(`${node.url}/api/v1/ping`, { headers, signal: AbortSignal.timeout(8000) });
    const json = await ping.json().catch(() => ({}));
    return { ok: ping.ok && json.ok !== false, status: ping.status, product: json.product || '', version: json.version || '' };
  } catch (e) { return { ok: false, error: e.message }; }
}

export async function testNode(id) {
  const node = get('SELECT * FROM servers WHERE id = ?', Number(id));
  if (!node) return { ok: false, error: 'Node not found' };
  const r = await checkNode(node);
  run('UPDATE servers SET last_seen_at=?, last_status=? WHERE id=?', nowIso(), r.ok ? `ok ${r.version || ''}`.trim() : `error: ${r.error || r.status}`, node.id);
  return r;
}

export async function refreshNodes() {
  const out = [];
  for (const n of nodes()) out.push({ name: n.name, ...(await testNode(n.id)) });
  return out;
}

export function summary() {
  return { nodes: nodes(), online: nodes().filter((n) => String(n.last_status || '').startsWith('ok')).length };
}
