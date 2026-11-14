// DNS operations: zone TTL, templates, MX entry and cleanup.
import { all, get, run, nowIso, audit } from './db.mjs';
import { rebuildZone, rebuildAll, deployZones } from './dns.mjs';

export function setZoneTtl(domain, ttl, actor = 'admin') {
  const d = get('SELECT * FROM domains WHERE name = ?', domain);
  if (!d) return { ok: false, error: 'Domena nie istnieje' };
  const n = Number(ttl);
  if (!Number.isInteger(n) || n < 60 || n > 604800) return { ok: false, error: 'TTL musi być 60–604800' };
  run('UPDATE domains SET dns_ttl = ? WHERE id = ?', n, d.id);
  const z = rebuildZone(domain);
  audit(actor, 'admin', 'dns.ttl', `${domain}:${n}`, '');
  return { ok: z.ok, output: `TTL ${n}s zapisany`, error: z.ok ? '' : z.check?.output };
}

export function templates() { return all('SELECT * FROM dns_templates ORDER BY name'); }

export function saveTemplate(body, actor = 'admin') {
  const name = String(body.name || '').trim();
  if (!/^[a-zA-Z0-9_. -]{2,60}$/.test(name)) return { ok: false, error: 'Nieprawidłowa nazwa' };
  let records = [];
  try { records = JSON.parse(String(body.records || '[]')); } catch { return { ok: false, error: 'Rekordy muszą być poprawnym JSON' }; }
  if (!Array.isArray(records)) return { ok: false, error: 'Rekordy muszą być tablicą' };
  const clean = records.filter((r) => r && ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'CAA'].includes(String(r.type).toUpperCase()) && r.value).map((r) => ({
    name: String(r.name || '@'), type: String(r.type).toUpperCase(), value: String(r.value), priority: r.priority ? Number(r.priority) : null, ttl: Number(r.ttl || 3600),
  }));
  if (body.id) run('UPDATE dns_templates SET name=?, records=? WHERE id=?', name, JSON.stringify(clean), Number(body.id));
  else run('INSERT INTO dns_templates(name, records, created_at) VALUES(?,?,?)', name, JSON.stringify(clean), nowIso());
  audit(actor, 'admin', 'dns.template.save', name, '');
  return { ok: true, count: clean.length };
}

export function deleteTemplate(id) { run('DELETE FROM dns_templates WHERE id = ?', Number(id)); return { ok: true }; }

export function applyTemplate(domain, templateId, { replace = false, actor = 'admin' } = {}) {
  const d = get('SELECT * FROM domains WHERE name = ?', domain);
  const t = get('SELECT * FROM dns_templates WHERE id = ?', Number(templateId));
  if (!d || !t) return { ok: false, error: 'Domena lub szablon nie istnieje' };
  let records = [];
  try { records = JSON.parse(t.records || '[]'); } catch { records = []; }
  if (replace) run("DELETE FROM dns_records WHERE domain_id = ? AND type NOT IN ('NS','SOA')", d.id);
  let added = 0;
  for (const r of records) {
    if (get('SELECT id FROM dns_records WHERE domain_id = ? AND name = ? AND type = ? AND value = ?', d.id, r.name, r.type, r.value)) continue;
    run('INSERT INTO dns_records(domain_id, name, type, value, priority, ttl) VALUES(?,?,?,?,?,?)', d.id, r.name, r.type, r.value, r.priority || null, r.ttl || 3600);
    added++;
  }
  const z = rebuildZone(domain);
  audit(actor, 'admin', 'dns.template.apply', `${domain} <- ${t.name}`, '');
  return { ok: z.ok, added, error: z.ok ? '' : z.check?.output };
}

export function setMx(domain, host, priority = 10, actor = 'admin') {
  const d = get('SELECT * FROM domains WHERE name = ?', domain);
  if (!d) return { ok: false, error: 'Domena nie istnieje' };
  const value = String(host || '').trim().replace(/\.$/, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value)) return { ok: false, error: 'Nieprawidłowy host MX' };
  run("DELETE FROM dns_records WHERE domain_id = ? AND type = 'MX'", d.id);
  run("INSERT INTO dns_records(domain_id, name, type, value, priority, ttl) VALUES(?, '@', 'MX', ?, ?, ?)", d.id, value, Number(priority) || 10, 3600);
  const z = rebuildZone(domain);
  audit(actor, 'admin', 'dns.mx', `${domain}:${value}`, '');
  return { ok: z.ok, error: z.ok ? '' : z.check?.output };
}

export function cleanupDns({ apply = false, actor = 'admin' } = {}) {
  const dupes = all(`SELECT domain_id, name, type, value, COUNT(*) n, MIN(id) keep FROM dns_records
    GROUP BY domain_id, name, type, value HAVING COUNT(*) > 1`);
  const invalid = all("SELECT * FROM dns_records WHERE value IS NULL OR trim(value) = ''");
  let removed = 0;
  if (apply) {
    for (const d of dupes) {
      run('DELETE FROM dns_records WHERE domain_id = ? AND name = ? AND type = ? AND value = ? AND id != ?', d.domain_id, d.name, d.type, d.value, d.keep);
      removed += d.n - 1;
    }
    for (const r of invalid) run('DELETE FROM dns_records WHERE id = ?', r.id);
    rebuildAll();
    for (const d of dupes) rebuildZone(get('SELECT name FROM domains WHERE id = ?', d.domain_id)?.name);
  }
  audit(actor, 'admin', 'dns.cleanup', apply ? `removed ${removed}` : 'dry-run', '');
  return { ok: true, duplicates: dupes.length, duplicateRecords: dupes.reduce((a, d) => a + d.n - 1, 0), invalid: invalid.length, removed, apply };
}

export function dnsOverview() {
  return {
    zones: all('SELECT d.id, d.name, d.dns_ttl, (SELECT COUNT(*) FROM dns_records WHERE domain_id = d.id) records FROM domains d ORDER BY d.name'),
    templates: templates().length,
    lastDeploy: null,
  };
}
