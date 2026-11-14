// DNS operations: templates, automatic records, validation, zone diffs,
// controlled rollback and BIND import/export.
//
// The module is deliberately shell-free: every value that reaches a zone file
// is validated here and rendered by dns.mjs. Zone file paths stay internal and
// are only returned by publicZoneInfo() when the caller asks for expert mode.
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import { spawnSync } from 'node:child_process';
import { all, get, run, nowIso, setting, setSetting, audit } from './db.mjs';
import { config } from './config.mjs';
import { rebuildZone, rebuildAll, renderZone, zonePath, zoneMeta } from './dns.mjs';
import { isDomain, isIp } from './util.mjs';
import { dkimStatus, generateDkim } from './dkim.mjs';

export const DNS_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'CAA', 'NS', 'POINTER'];
const TTL_MIN = 60;
const TTL_MAX = 604800;
const MAX_IMPORT_BYTES = 512 * 1024;
const MAX_IMPORT_LINES = 4000;
const SNAPSHOT_LIMIT = 10;
const PRESERVE_ON_REPLACE = new Set(['NS', 'SOA', 'POINTER']);
const BINDING_PREFIX = 'dns_template_binding:';
const RECORD_NAME = /^@$|^\*$|^\*\.|^(?:_|(?:\*\.)?[a-z0-9])[a-z0-9_-]{0,62}(?:\.[a-z0-9_](?:[a-z0-9_-]{0,62}))*$/i;

function cleanText(value) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
}

function normName(name) {
  const raw = cleanText(name).toLowerCase();
  if (!raw) return '@';
  return raw.endsWith('.') ? raw.replace(/\.+$/, '') || '@' : raw;
}

function normHost(value) {
  return cleanText(value).toLowerCase().replace(/\.+$/, '');
}

function isIpv4(value) {
  const parts = String(value || '').split('.');
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function isIpv6(value) {
  const raw = String(value || '');
  if (!raw.includes(':') || !/^[0-9a-f:]+$/i.test(raw)) return false;
  try { return !!new URL(`http://[${raw}]`); } catch { return false; }
}

function priorityOf(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 65535 ? n : null;
}

/* ------------------------------------------------------------- validation */

/**
 * Validate one record. Returns { ok, error, record } where record is the
 * normalized shape used by the rest of the module.
 */
export function validateRecord(input = {}) {
  const type = String(input.type || '').toUpperCase().trim();
  const name = normName(input.name);
  const ttl = Number(input.ttl || 3600);
  const priority = priorityOf(input.priority, type === 'MX' ? 10 : null);
  const record = { name, type, value: cleanText(input.value), priority, ttl };
  const fail = (code, message) => ({ ok: false, code, message, record });
  if (!DNS_TYPES.includes(type)) return fail('invalid_type', `Nieobsługiwany typ rekordu "${type || '(brak)'}".`);
  if (!RECORD_NAME.test(name) || name.length > 253) return fail('invalid_name', `Nieprawidłowa nazwa rekordu "${name}".`);
  if (!Number.isInteger(ttl) || ttl < TTL_MIN || ttl > TTL_MAX) return fail('invalid_ttl', `TTL musi być liczbą ${TTL_MIN}–${TTL_MAX}.`);
  if (!record.value) return fail('empty_value', `Rekord ${type} ${name} nie ma wartości.`);
  if (record.value.length > 4096) return fail('value_too_long', 'Wartość rekordu jest zbyt długa (limit 4096 znaków).');
  if (type === 'MX' && priority === null) return fail('invalid_priority', 'MX wymaga priorytetu 0–65535.');

  if (type === 'A') {
    if (!isIpv4(record.value)) return fail('invalid_ipv4', `"${record.value}" nie jest adresem IPv4.`);
    record.value = record.value.trim();
  } else if (type === 'AAAA') {
    if (!isIpv6(record.value)) return fail('invalid_ipv6', `"${record.value}" nie jest adresem IPv6.`);
    record.value = record.value.toLowerCase();
  } else if (type === 'CNAME' || type === 'NS' || type === 'POINTER') {
    const target = normHost(record.value);
    if (!isDomain(target)) return fail('invalid_host', `"${record.value}" nie jest poprawną nazwą hosta.`);
    if (type === 'CNAME' && (name === '@' || name === '')) return fail('apex_cname', 'CNAME w apex domeny jest niedozwolony — użyj rekordu A/AAAA.');
    record.value = target;
  } else if (type === 'MX') {
    const target = normHost(record.value);
    if (!isDomain(target)) return fail('invalid_host', 'MX musi wskazywać poprawny host.');
    record.value = target;
  } else if (type === 'TXT') {
    if (/[\r\n]/.test(input.value)) return fail('invalid_txt', 'TXT nie może zawierać znaków nowej linii.');
    record.value = String(input.value).replace(/\s+/g, ' ').trim();
  } else if (type === 'SRV') {
    const m = /^(\d{1,5})\s+(\d{1,5})\s+(\d{1,5})\s+([a-z0-9.-]+?)\.?$/i.exec(record.value);
    const srvHost = m ? normHost(m[4]) : '';
    if (!m || Number(m[1]) > 65535 || Number(m[2]) > 65535 || Number(m[3]) > 65535 || !isDomain(srvHost)) {
      return fail('invalid_srv', 'SRV wymaga formatu „priorytet waga port host”.');
    }
    record.value = `${Number(m[1])} ${Number(m[2])} ${Number(m[3])} ${srvHost}.`;
  } else if (type === 'CAA') {
    if (!/^\d{1,3}\s+(issue|issuewild|iodef)\s+"[^"\r\n]{1,255}"$/i.test(record.value)) {
      return fail('invalid_caa', 'CAA wymaga formatu: flaga issue/issuewild/iodef "wartość".');
    }
  }
  return { ok: true, record };
}

/** Validate a full record set, including cross-record conflicts. */
export function validateRecords(records = [], { domain = '' } = {}) {
  const errors = [];
  const warnings = [];
  const normalized = [];
  const list = Array.isArray(records) ? records : [];
  if (list.length > 500) errors.push({ code: 'too_many_records', message: 'Strefa może zawierać najwyżej 500 rekordów.' });
  list.slice(0, 500).forEach((entry, index) => {
    const checked = validateRecord(entry);
    if (!checked.ok) {
      errors.push({ code: checked.code, message: checked.message, index });
      return;
    }
    normalized.push(checked.record);
  });

  const byName = new Map();
  const exact = new Set();
  for (const record of normalized) {
    const signature = `${record.name}|${record.type}|${record.priority ?? ''}|${record.value}`;
    if (exact.has(signature)) {
      errors.push({ code: 'duplicate_record', message: `Duplikat rekordu ${record.type} ${record.name} → ${record.value}.` });
    }
    exact.add(signature);
    const list = byName.get(record.name) || [];
    list.push(record);
    byName.set(record.name, list);
  }
  for (const [name, list] of byName) {
    const cnames = list.filter((record) => record.type === 'CNAME');
    if (cnames.length && list.length > 1) {
      const others = list.filter((record) => record.type !== 'CNAME').map((record) => record.type);
      errors.push({ code: 'cname_conflict', message: `CNAME ${name} nie może współistnieć z rekordami: ${[...new Set(others)].join(', ')}.` });
    }
    if (cnames.length > 1 && new Set(cnames.map((record) => record.value)).size > 1) {
      errors.push({ code: 'cname_conflict', message: `Nazwa ${name} ma więcej niż jeden CNAME.` });
    }
    const mx = list.filter((record) => record.type === 'MX');
    if (mx.length > 1 && new Set(mx.map((record) => record.value)).size === 1) {
      warnings.push({ code: 'duplicate_mx', message: `MX ${name} ma zduplikowany ten sam host — sprawdź priorytety.` });
    }
    if (name !== '@' && list.some((record) => record.type === 'A' || record.type === 'AAAA')) {
      const apex = byName.get('@') || [];
      if (apex.some((record) => record.type === 'CNAME')) {
        errors.push({ code: 'apex_cname', message: 'CNAME w apex blokuje rekordy hostów potomnych.' });
      }
    }
  }
  if (domain && !isDomain(domain)) errors.push({ code: 'invalid_domain', message: 'Nieprawidłowa nazwa strefy.' });
  return { ok: errors.length === 0, errors, warnings, records: normalized };
}

/* --------------------------------------------------------------- defaults */

/** Automatic records for a new domain: A/AAAA, MX, SPF, DKIM, DMARC and
 *  autodiscover/autoconfig. NS/SOA are rendered by dns.mjs and never duplicated. */
export function defaultZoneRecords(domain, {
  ip = setting('server_ip', '127.0.0.1'),
  ipv6 = setting('server_ip6', ''),
  mailHost = '',
  ttl = Number(setting('dns_default_ttl', '3600')) || 3600,
  dkimPublicKey = '',
} = {}) {
  if (!isDomain(domain)) return [];
  const mail = normHost(mailHost || `mail.${domain}`);
  const records = [
    { name: '@', type: 'A', value: ip, ttl },
    { name: 'www', type: 'A', value: ip, ttl },
    { name: 'mail', type: 'A', value: ip, ttl },
    { name: 'ftp', type: 'A', value: ip, ttl },
  ];
  if (isIpv6(ipv6)) {
    records.push(
      { name: '@', type: 'AAAA', value: ipv6, ttl },
      { name: 'www', type: 'AAAA', value: ipv6, ttl },
      { name: 'mail', type: 'AAAA', value: ipv6, ttl },
    );
  }
  records.push(
    { name: '@', type: 'MX', value: mail, priority: 10, ttl },
    { name: '@', type: 'TXT', value: `v=spf1 a mx ip4:${ip}${isIpv6(ipv6) ? ` ip6:${ipv6}` : ''} ~all`, ttl },
    { name: '_dmarc', type: 'TXT', value: `v=DMARC1; p=quarantine; rua=mailto:postmaster@${domain}`, ttl },
    { name: 'autodiscover', type: 'CNAME', value: mail, ttl },
    { name: 'autoconfig', type: 'CNAME', value: mail, ttl },
    { name: '_imaps._tcp', type: 'SRV', value: `0 1 993 ${mail}.`, ttl },
    { name: '_submission._tcp', type: 'SRV', value: `0 1 587 ${mail}.`, ttl },
  );
  if (dkimPublicKey) records.push({ name: 'default._domainkey', type: 'TXT', value: dkimPublicKey, ttl });
  return records;
}

/** Placeholders make one template usable for every domain/package. */
export function expandTemplateRecords(records, { domain, ip = setting('server_ip', '127.0.0.1'), ipv6 = setting('server_ip6', ''), mailHost = '' } = {}) {
  const mail = normHost(mailHost || `mail.${domain}`);
  const ns1 = normHost(setting('ns1', 'ns1.localhost'));
  const ns2 = normHost(setting('ns2', 'ns2.localhost'));
  const replacements = {
    '{domain}': domain, '{ip}': ip, '{ip6}': ipv6, '{mail}': mail,
    '{ns1}': ns1, '{ns2}': ns2, '{origin}': domain,
  };
  return (Array.isArray(records) ? records : []).map((entry) => {
    const record = { ...entry };
    if (typeof record.value === 'string') {
      record.value = record.value.replace(/\{[a-z0-9]+\}/gi, (token) => replacements[token.toLowerCase()] ?? token);
    }
    if (typeof record.name === 'string' && record.name.includes('{')) {
      record.name = record.name.replace(/\{[a-z0-9]+\}/gi, (token) => replacements[token.toLowerCase()] ?? token);
    }
    return record;
  });
}

/* -------------------------------------------------------------- templates */

export function templates() { return all('SELECT * FROM dns_templates ORDER BY name'); }

function parseTemplateRecords(row) {
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.records || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function validateTemplateInput(records) {
  const errors = [];
  const clean = [];
  const expandedRecords = [];
  for (const entry of Array.isArray(records) ? records : []) {
    if (!entry || typeof entry !== 'object') continue;
    const expanded = expandTemplateRecords([entry], { domain: 'example.com', ip: '192.0.2.1', ipv6: '2001:db8::1' })[0];
    const checked = validateRecord(expanded);
    if (!checked.ok) errors.push(checked);
    else {
      clean.push(checked.record);
      expandedRecords.push(checked.record);
    }
  }
  // Cross-record conflicts (CNAME exclusivity, duplicates) are validated here
  // too, so an unusable template cannot be saved.
  const cross = validateRecords(expandedRecords, { domain: 'example.com' });
  errors.push(...cross.errors);
  return { errors, clean };
}

export function saveTemplate(body, actor = 'admin') {
  const name = cleanText(body.name);
  if (!/^[a-zA-Z0-9_. -]{2,60}$/.test(name)) return { ok: false, error: 'Nieprawidłowa nazwa szablonu' };
  let raw = [];
  try {
    raw = typeof body.records === 'string' ? JSON.parse(body.records || '[]') : body.records;
  } catch { return { ok: false, error: 'Rekordy muszą być poprawnym JSON' }; }
  if (!Array.isArray(raw)) return { ok: false, error: 'Rekordy muszą być tablicą' };
  const { errors, clean } = validateTemplateInput(raw);
  if (errors.length) return { ok: false, error: `Szablon odrzucony: ${errors.slice(0, 3).map((e) => e.message).join(' ')}` };
  const records = clean.map((record) => ({
    name: record.name, type: record.type, value: record.value,
    priority: record.priority ?? null, ttl: record.ttl || 3600,
  }));
  if (body.id) run('UPDATE dns_templates SET name = ?, records = ? WHERE id = ?', name, JSON.stringify(records), Number(body.id));
  else run('INSERT INTO dns_templates(name, records, created_at) VALUES(?,?,?)', name, JSON.stringify(records), nowIso());
  audit(actor, 'admin', 'dns.template.save', name, '');
  return { ok: true, count: records.length, records };
}

export function deleteTemplate(id, actor = 'admin') {
  run('DELETE FROM dns_templates WHERE id = ?', Number(id));
  for (const key of all("SELECT key FROM settings WHERE key LIKE 'dns_template_binding:%'")) {
    const value = String(setting(key.key, '') || '');
    if (Number(value) === Number(id)) run('DELETE FROM settings WHERE key = ?', key.key);
  }
  audit(actor, 'admin', 'dns.template.delete', String(id), '');
  return { ok: true };
}

/* --------------------------------------------------------- bindings/scope */

const SCOPES = new Set(['default', 'package', 'reseller', 'domain']);

function bindingKey(scope, key = '') {
  if (scope === 'default') return `${BINDING_PREFIX}default`;
  return `${BINDING_PREFIX}${scope}:${cleanText(key).toLowerCase()}`;
}

export function setTemplateBinding({ scope = 'default', key = '', templateId = null, actor = 'admin' } = {}) {
  const normalizedScope = String(scope || 'default').toLowerCase();
  if (!SCOPES.has(normalizedScope)) return { ok: false, error: 'Nieprawidłowy zakres szablonu' };
  if (normalizedScope !== 'default' && !cleanText(key)) return { ok: false, error: 'Brak klucza zakresu szablonu' };
  if (normalizedScope === 'domain' && !isDomain(cleanText(key))) return { ok: false, error: 'Nieprawidłowa domena dla szablonu' };
  // Tenant boundary: a reseller may only bind templates to its own reseller
  // scope, its own packages and customers of its own packages. Users cannot
  // bind at all; administrators keep full control.
  const actorRow = actor && actor !== 'admin' ? get('SELECT * FROM users WHERE username = ?', String(actor)) : null;
  if (actorRow && actorRow.level === 'user') return { ok: false, error: 'Brak uprawnień do wiązania szablonów DNS' };
  if (actorRow?.level === 'reseller') {
    if (normalizedScope === 'default') return { ok: false, error: 'Tylko administrator może ustawić globalny szablon DNS' };
    if (normalizedScope === 'reseller' && cleanText(key) !== actorRow.username) return { ok: false, error: 'Reseller może ustawić szablon tylko dla siebie' };
    if (normalizedScope === 'package') {
      const pkg = get('SELECT * FROM packages WHERE name = ?', cleanText(key));
      if (!pkg || (pkg.owner && pkg.owner !== actorRow.username)) return { ok: false, error: 'Ten pakiet należy do innego resellera' };
    }
    if (normalizedScope === 'domain') {
      const owned = get('SELECT d.id FROM domains d JOIN users u ON u.id = d.user_id WHERE d.name = ? AND (u.owner = ? OR u.username = ?)', cleanText(key), actorRow.username, actorRow.username);
      if (!owned) return { ok: false, error: 'Ta domena nie należy do Twoich klientów' };
    }
  }
  const storageKey = bindingKey(normalizedScope, key);
  if (templateId === null || templateId === undefined || templateId === '') {
    run('DELETE FROM settings WHERE key = ?', storageKey);
    audit(actor, 'admin', 'dns.template.bind', `${normalizedScope}:${key}:none`, '');
    return { ok: true, cleared: true };
  }
  const template = get('SELECT * FROM dns_templates WHERE id = ?', Number(templateId));
  if (!template) return { ok: false, error: 'Szablon nie istnieje' };
  setSetting(storageKey, String(template.id));
  audit(actor, 'admin', 'dns.template.bind', `${normalizedScope}:${key}:${template.name}`, '');
  return { ok: true, id: template.id, scope: normalizedScope, key: cleanText(key) };
}

export function templateBindings() {
  const rows = all("SELECT key, value FROM settings WHERE key LIKE 'dns_template_binding:%' ORDER BY key");
  return rows.map((row) => {
    const raw = String(row.key).slice(BINDING_PREFIX.length);
    const [scope, ...rest] = raw.split(':');
    const key = rest.join(':');
    const template = get('SELECT id, name FROM dns_templates WHERE id = ?', Number(row.value));
    return { scope, key: key || null, templateId: Number(row.value), templateName: template?.name || null };
  });
}

/** Precedence: explicit domain override → package → reseller → global default. */
export function resolveTemplate({ packageName = '', reseller = '', domain = '' } = {}) {
  const binding = (scope, key) => {
    const value = setting(bindingKey(scope, key), '');
    if (!value) return null;
    return get('SELECT * FROM dns_templates WHERE id = ?', Number(value));
  };
  if (domain) {
    const template = binding('domain', domain);
    if (template) return { source: 'domain', key: domain, template };
  }
  if (packageName) {
    const template = binding('package', packageName);
    if (template) return { source: 'package', key: packageName, template };
    // Packages can also carry a template reference directly in their limits
    // (handy for API/imports and for package copies without a GUI binding).
    const pkg = get('SELECT * FROM packages WHERE name = ?', packageName);
    let limits = {};
    try { limits = JSON.parse(pkg?.limits || '{}'); } catch { limits = {}; }
    const ref = limits.dns_template || limits.dnsTemplate;
    if (ref) {
      const byLimits = /^\d+$/.test(String(ref))
        ? get('SELECT * FROM dns_templates WHERE id = ?', Number(ref))
        : get('SELECT * FROM dns_templates WHERE name = ?', String(ref));
      if (byLimits) return { source: 'package-limits', key: packageName, template: byLimits };
    }
  }
  if (reseller) {
    const template = binding('reseller', reseller);
    if (template) return { source: 'reseller', key: reseller, template };
  }
  const fallback = binding('default', '');
  if (fallback) return { source: 'default', key: null, template: fallback };
  return { source: 'builtin', key: null, template: null };
}

/* ------------------------------------------------------------------- zone */

export function zoneRecords(domain) {
  return all(`SELECT r.* FROM dns_records r JOIN domains d ON d.id = r.domain_id WHERE d.name = ? ORDER BY r.type, r.name, r.id`, domain)
    .map((row) => ({ id: row.id, name: row.name, type: row.type, value: row.value, priority: row.priority, ttl: row.ttl }));
}

function signature(record) {
  return `${record.name}|${record.type}|${record.priority ?? ''}|${record.value}`;
}

export function diffZone(current = [], desired = []) {
  const currentMap = new Map(current.map((record) => [signature(record), record]));
  const desiredMap = new Map(desired.map((record) => [signature(record), record]));
  let added = desired.filter((record) => !currentMap.has(signature(record)));
  let removed = current.filter((record) => !desiredMap.has(signature(record)));
  const changed = [];
  const grouped = (list) => {
    const map = new Map();
    for (const record of list) {
      const key = `${record.name}|${record.type}|${record.priority ?? ''}`;
      const group = map.get(key) || [];
      group.push(record);
      map.set(key, group);
    }
    return map;
  };
  const removedGroups = grouped(removed);
  const addedGroups = grouped(added);
  const usedAdded = new Set();
  const usedRemoved = new Set();
  for (const [key, before] of removedGroups) {
    const after = addedGroups.get(key) || [];
    if (before.length !== 1 || after.length !== 1) continue;
    changed.push({ before: before[0], after: after[0] });
    usedRemoved.add(signature(before[0]));
    usedAdded.add(signature(after[0]));
  }
  added = added.filter((record) => !usedAdded.has(signature(record)));
  removed = removed.filter((record) => !usedRemoved.has(signature(record)));
  return {
    added, removed, changed,
    counts: { added: added.length, removed: removed.length, changed: changed.length, unchanged: current.filter((record) => desiredMap.has(signature(record))).length },
  };
}

function desiredRecords(domain, { templateId = null, packageName = '', reseller = '', ip, ipv6, mailHost } = {}) {
  const chosen = templateId
    ? { source: 'template', key: null, template: get('SELECT * FROM dns_templates WHERE id = ?', Number(templateId)) || null }
    : resolveTemplate({ packageName, reseller, domain });
  if (chosen.template) {
    const expanded = expandTemplateRecords(parseTemplateRecords(chosen.template), { domain, ip, ipv6, mailHost });
    return { source: chosen.source, template: chosen.template, records: expanded };
  }
  const dkim = dkimStatus(domain);
  const dkimKey = dkim.exists && dkim.publicKey ? dkim.publicKey : '';
  return { source: 'builtin', template: null, records: defaultZoneRecords(domain, { ip, ipv6, mailHost, dkimPublicKey: dkimKey }) };
}

function mergePreserved(current, desired) {
  const existing = new Set(desired.map(signature));
  const preserved = current.filter((record) => PRESERVE_ON_REPLACE.has(String(record.type).toUpperCase()) && !existing.has(signature(record)));
  return [...desired, ...preserved];
}

/** Preview (and validate) a zone change without writing anything. */
export function previewZoneChange(domain, opts = {}) {
  if (!isDomain(domain)) return { ok: false, errors: [{ code: 'invalid_domain', message: 'Nieprawidłowa domena.' }], domain };
  const row = get('SELECT * FROM domains WHERE name = ?', domain);
  if (!row) return { ok: false, errors: [{ code: 'not_found', message: 'Domena nie istnieje.' }], domain };
  const chosen = desiredRecords(domain, opts);
  if (opts.templateId && !chosen.template) {
    return { ok: false, errors: [{ code: 'invalid_template', message: 'Wybrany szablon DNS nie istnieje.' }], domain, diff: { added: [], removed: [], changed: [], counts: { added: 0, removed: 0, changed: 0, unchanged: 0 } } };
  }
  const current = zoneRecords(domain);
  const desired = mergePreserved(current, chosen.records);
  const validation = validateRecords(desired, { domain });
  const diff = diffZone(current, desired);
  return {
    ok: validation.ok,
    domain,
    source: chosen.source,
    template: chosen.template ? { id: chosen.template.id, name: chosen.template.name } : null,
    records: desired,
    current,
    diff,
    errors: validation.errors,
    warnings: validation.warnings,
  };
}

function snapshotList(domain) {
  try {
    const parsed = JSON.parse(setting(`dns_zone_snapshots:${domain}`, '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function storeSnapshot(domain, { actor = 'admin', source = 'apply' } = {}) {
  const id = `z${crypto.randomBytes(8).toString('hex')}`;
  const snapshot = {
    id, domain, actor, source, at: nowIso(),
    records: zoneRecords(domain).map(({ name, type, value, priority, ttl }) => ({ name, type, value, priority, ttl })),
  };
  setSetting(`dns_zone_snapshot:${id}`, JSON.stringify(snapshot));
  const list = snapshotList(domain);
  list.unshift({ id, at: snapshot.at, actor, source, count: snapshot.records.length });
  const keep = list.slice(0, SNAPSHOT_LIMIT);
  for (const stale of list.slice(SNAPSHOT_LIMIT)) run('DELETE FROM settings WHERE key = ?', `dns_zone_snapshot:${stale.id}`);
  setSetting(`dns_zone_snapshots:${domain}`, JSON.stringify(keep));
  return snapshot;
}

function commitZoneRecords(domain, records, { actor = 'admin', source = 'apply' } = {}) {
  const row = get('SELECT * FROM domains WHERE name = ?', domain);
  if (!row) return { ok: false, error: 'Domena nie istnieje' };
  const snapshot = storeSnapshot(domain, { actor, source });
  try {
    run('DELETE FROM dns_records WHERE domain_id = ?', row.id);
    for (const record of records) {
      run('INSERT INTO dns_records(domain_id, name, type, value, priority, ttl) VALUES(?,?,?,?,?,?)',
        row.id, record.name, record.type, record.value, record.priority ?? null, record.ttl || 3600);
    }
    const zone = rebuildZone(domain);
    if (!zone.ok) {
      restoreSnapshot(snapshot);
      return { ok: false, error: zone.check?.output || 'Walidacja strefy nie powiodła się', snapshotId: snapshot.id, rolledBack: true };
    }
    audit(actor, 'admin', 'dns.zone.apply', `${domain}:${source}`, '');
    return { ok: true, snapshotId: snapshot.id, file: zone.file, records: records.length, content: zone.content };
  } catch (error) {
    try { restoreSnapshot(snapshot); } catch { /* best effort */ }
    return { ok: false, error: error.message, snapshotId: snapshot.id, rolledBack: true };
  }
}

function restoreSnapshot(snapshot) {
  const row = get('SELECT * FROM domains WHERE name = ?', snapshot.domain);
  if (!row) return { ok: false, error: 'Domena nie istnieje' };
  run('DELETE FROM dns_records WHERE domain_id = ?', row.id);
  for (const record of snapshot.records || []) {
    run('INSERT INTO dns_records(domain_id, name, type, value, priority, ttl) VALUES(?,?,?,?,?,?)',
      row.id, record.name || '@', record.type, record.value, record.priority ?? null, record.ttl || 3600);
  }
  return { ok: true, domain: snapshot.domain, records: (snapshot.records || []).length };
}

/** Apply a template/builtin zone plan with a pre-change snapshot. */
export function applyZonePlan(domain, { dryRun = false, actor = 'admin', ...opts } = {}) {
  const preview = previewZoneChange(domain, opts);
  if (!preview.ok) return preview;
  if (dryRun) return { ...preview, dryRun: true };
  const applied = commitZoneRecords(domain, preview.records, { actor, source: preview.template ? `template:${preview.template.name}` : preview.source });
  return {
    ...preview,
    ...applied,
    ok: applied.ok === true,
    error: applied.error || '',
    diff: preview.diff,
  };
}

export function lastZoneSnapshot(domain) {
  const list = snapshotList(domain);
  return list[0] || null;
}

/** Controlled rollback of the last applied zone change (or a specific one). */
export function rollbackZoneChange(domain, snapshotId = '', { actor = 'admin' } = {}) {
  if (!isDomain(domain)) return { ok: false, error: 'Nieprawidłowa domena' };
  const id = cleanText(snapshotId) || lastZoneSnapshot(domain)?.id || '';
  if (!id) return { ok: false, error: 'Brak zapisanego punktu przywracania strefy' };
  let snapshot;
  try { snapshot = JSON.parse(setting(`dns_zone_snapshot:${id}`, '')); } catch { snapshot = null; }
  if (!snapshot || snapshot.domain !== domain) return { ok: false, error: 'Punkt przywracania nie należy do tej domeny' };
  try {
    restoreSnapshot(snapshot);
    const zone = rebuildZone(domain);
    run('DELETE FROM settings WHERE key = ?', `dns_zone_snapshot:${id}`);
    const list = snapshotList(domain).filter((entry) => entry.id !== id);
    setSetting(`dns_zone_snapshots:${domain}`, JSON.stringify(list));
    audit(actor, 'admin', 'dns.zone.rollback', `${domain}:${id}`, '');
    return { ok: zone.ok, restored: (snapshot.records || []).length, file: zone.ok ? zone.file : '', error: zone.ok ? '' : zone.check?.output };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

/* ----------------------------------------------------------- apply legacy */

export function applyTemplate(domain, templateId, { replace = false, actor = 'admin' } = {}) {
  const d = get('SELECT * FROM domains WHERE name = ?', domain);
  const template = get('SELECT * FROM dns_templates WHERE id = ?', Number(templateId));
  if (!d || !template) return { ok: false, error: 'Domena lub szablon nie istnieje' };
  const expanded = expandTemplateRecords(parseTemplateRecords(template), { domain });
  const current = zoneRecords(domain);
  const base = replace ? [] : current;
  const merged = mergePreserved(base, expanded);
  const seen = new Set();
  const desired = merged.filter((record) => {
    const key = `${record.name}|${record.type}|${record.priority ?? ''}|${record.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const validation = validateRecords(desired, { domain });
  if (!validation.ok) return { ok: false, error: validation.errors.map((error) => error.message).join(' ') };
  const diff = diffZone(current, desired);
  const applied = commitZoneRecords(domain, desired, { actor, source: `template:${template.name}` });
  audit(actor, 'admin', 'dns.template.apply', `${domain} <- ${template.name}`, '');
  return { ok: applied.ok, added: diff.counts.added, changed: diff.counts.changed, removed: diff.counts.removed, error: applied.error || '', snapshotId: applied.snapshotId };
}

export function setZoneTtl(domain, ttl, actor = 'admin') {
  const d = get('SELECT * FROM domains WHERE name = ?', domain);
  if (!d) return { ok: false, error: 'Domena nie istnieje' };
  const n = Number(ttl);
  if (!Number.isInteger(n) || n < TTL_MIN || n > TTL_MAX) return { ok: false, error: `TTL musi być ${TTL_MIN}–${TTL_MAX}` };
  run('UPDATE domains SET dns_ttl = ? WHERE id = ?', n, d.id);
  const z = rebuildZone(domain);
  audit(actor, 'admin', 'dns.ttl', `${domain}:${n}`, '');
  return { ok: z.ok, output: `TTL ${n}s zapisany`, error: z.ok ? '' : z.check?.output };
}

export function setMx(domain, host, priority = 10, actor = 'admin') {
  const d = get('SELECT * FROM domains WHERE name = ?', domain);
  if (!d) return { ok: false, error: 'Domena nie istnieje' };
  const checked = validateRecord({ name: '@', type: 'MX', value: host, priority: priority || 10 });
  if (!checked.ok) return { ok: false, error: checked.message };
  const current = zoneRecords(domain).filter((record) => record.type !== 'MX');
  const desired = [...current, checked.record];
  const applied = commitZoneRecords(domain, desired, { actor, source: 'mx' });
  audit(actor, 'admin', 'dns.mx', `${domain}:${checked.record.value}`, '');
  return { ok: applied.ok, error: applied.error || '' };
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

/* ---------------------------------------------------------- BIND import/export */

function stripComment(line) {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"' && line[i - 1] !== '\\') quoted = !quoted;
    else if (char === ';' && !quoted) return line.slice(0, i);
  }
  return line;
}

function tokenize(line) {
  const tokens = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') { quoted = !quoted; continue; }
    if (!quoted && /\s/.test(char)) {
      if (current) { tokens.push(current); current = ''; }
      continue;
    }
    if (char === '\\' && i + 1 < line.length) { current += line[i + 1]; i++; continue; }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

function relativeName(name, origin) {
  const raw = normName(name).replace(/\.$/, '');
  if (raw === '@' || raw === '') return '@';
  if (raw === origin) return '@';
  if (raw.endsWith(`.${origin}`)) return raw.slice(0, -(origin.length + 1));
  return raw;
}

/** Parse a domain-scoped BIND zone (SOA/NS/$TTL/$ORIGIN supported). No shell. */
export function parseBind(text, { domain } = {}) {
  const errors = [];
  const warnings = [];
  const records = [];
  if (!isDomain(domain)) return { ok: false, errors: [{ code: 'invalid_domain', message: 'Nieprawidłowa domena importu.' }], records, warnings };
  const input = String(text ?? '');
  if (Buffer.byteLength(input, 'utf8') > MAX_IMPORT_BYTES) return { ok: false, errors: [{ code: 'too_large', message: 'Plik strefy przekracza 512 KB.' }], records, warnings };
  const rawLines = input.split(/\r?\n/);
  if (rawLines.length > MAX_IMPORT_LINES) return { ok: false, errors: [{ code: 'too_many_lines', message: 'Plik strefy ma zbyt wiele linii.' }], records, warnings };
  let origin = domain;
  let inParens = false;
  for (let index = 0; index < rawLines.length; index++) {
    const raw = rawLines[index];
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw)) {
      errors.push({ code: 'invalid_character', message: `Linia ${index + 1}: niedozwolone znaki kontrolne.`, line: index + 1 });
      continue;
    }
    let line = stripComment(raw).trim();
    if (!line) continue;
    if (inParens) {
      if (line.includes(')')) inParens = false;
      continue;
    }
    if (line.startsWith('$TTL')) continue;
    if (line.startsWith('$ORIGIN')) {
      const next = normHost(line.split(/\s+/)[1] || '');
      if (!isDomain(next)) errors.push({ code: 'invalid_origin', message: `Linia ${index + 1}: nieprawidłowy $ORIGIN.`, line: index + 1 });
      else origin = next;
      continue;
    }
    if (/\bSOA\b/i.test(line)) {
      if (line.includes('(') && !line.includes(')')) inParens = true;
      continue;
    }
    if (line.includes('(') || line.includes(')')) {
      errors.push({ code: 'unsupported_multiline', message: `Linia ${index + 1}: rekordy wielolinijkowe inne niż SOA nie są obsługiwane.`, line: index + 1 });
      continue;
    }
    const tokens = tokenize(line);
    if (!tokens.length) continue;
    let cursor = 0;
    let name = '@';
    if (!/^\d+$/.test(tokens[0]) && !/^IN$/i.test(tokens[0]) && !DNS_TYPES.includes(tokens[0].toUpperCase())) {
      name = tokens[cursor++];
    }
    let ttl = Number(setting('dns_default_ttl', '3600')) || 3600;
    if (/^\d+$/.test(tokens[cursor] || '')) ttl = Number(tokens[cursor++]);
    if (/^IN$/i.test(tokens[cursor] || '')) cursor++;
    const type = String(tokens[cursor++] || '').toUpperCase();
    if (type === 'NS') { warnings.push({ code: 'ns_ignored', message: `Linia ${index + 1}: rekord NS jest generowany przez panel — pominięty.` }); continue; }
    if (type === 'SOA') continue;
    if (!DNS_TYPES.includes(type)) {
      errors.push({ code: 'unsupported_type', message: `Linia ${index + 1}: nieobsługiwany typ "${type || '(brak)'}".`, line: index + 1 });
      continue;
    }
    const rest = tokens.slice(cursor);
    let priority = null;
    let value = '';
    if (type === 'MX') {
      priority = Number(rest[0]);
      value = rest.slice(1).join(' ');
    } else if (type === 'CAA') {
      // The tokenizer strips quotes; CAA syntax requires the value in quotes.
      value = rest.length >= 2 ? `${rest[0]} ${rest[1]} "${rest.slice(2).join(' ').replace(/^"|"$/g, '')}"` : rest.join(' ');
    } else {
      // BIND splits a long TXT string into adjacent quoted chunks that are
      // concatenated without spaces by resolvers.
      value = type === 'TXT' ? rest.join('') : rest.join(' ');
    }
    if (type === 'CNAME' || type === 'MX' || type === 'NS') {
      if (value && !value.endsWith('.')) value = `${value}.${origin}.`;
    }
    const recordName = relativeName(name, origin);
    const checked = validateRecord({ name: recordName, type, value, priority: type === 'MX' ? priority : null, ttl });
    if (!checked.ok) {
      errors.push({ code: checked.code, message: `Linia ${index + 1}: ${checked.message}`, line: index + 1 });
      continue;
    }
    records.push(checked.record);
  }
  const validation = validateRecords(records, { domain });
  return {
    ok: errors.length === 0 && validation.ok,
    errors: [...errors, ...validation.errors.map((error) => ({ ...error, message: `Import: ${error.message}` }))],
    warnings: [...warnings, ...validation.warnings],
    records: validation.records,
    origin,
  };
}

export function exportBind(domain) {
  if (!isDomain(domain)) return { ok: false, error: 'Nieprawidłowa domena' };
  const row = get('SELECT * FROM domains WHERE name = ?', domain);
  if (!row) return { ok: false, error: 'Domena nie istnieje' };
  const text = renderZone(domain);
  return { ok: true, domain, text, bytes: Buffer.byteLength(text, 'utf8'), records: zoneRecords(domain).length };
}

export function exportAllBind() {
  const domains = all('SELECT name FROM domains ORDER BY name').map((row) => row.name);
  return domains.map((domain) => ({ domain, ...exportBind(domain) })).filter((entry) => entry.ok);
}

/** Import a BIND zone for exactly one domain. dryRun returns a diff only. */
export function importBind(domain, text, { dryRun = true, actor = 'admin' } = {}) {
  if (!isDomain(domain)) return { ok: false, error: 'Nieprawidłowa domena', errors: [{ code: 'invalid_domain', message: 'Nieprawidłowa domena.' }] };
  const parsed = parseBind(text, { domain });
  if (!parsed.ok) return { ok: false, error: parsed.errors[0]?.message || 'Nie udało się sparsować strefy', errors: parsed.errors, warnings: parsed.warnings };
  const current = zoneRecords(domain);
  const desired = mergePreserved(current, parsed.records);
  const validation = validateRecords(desired, { domain });
  if (!validation.ok) return { ok: false, error: validation.errors[0]?.message || 'Strefa zawiera konflikty', errors: validation.errors, warnings: validation.warnings };
  const diff = diffZone(current, desired);
  if (dryRun) return { ok: true, dryRun: true, domain, diff, records: desired, warnings: parsed.warnings, errors: [] };
  const applied = commitZoneRecords(domain, desired, { actor, source: 'bind-import' });
  return { ok: applied.ok, dryRun: false, domain, diff, ...applied, error: applied.error || '', warnings: parsed.warnings };
}

/* -------------------------------------------------------------- delegation */

function digRecords(domain, type, timeout = 3000) {
  const result = spawnSync('dig', ['+short', '+time=2', '+tries=1', type, domain], { encoding: 'utf8', timeout, shell: false });
  if (result.status !== 0) return null;
  return String(result.stdout || '').split('\n').map((line) => line.trim()).filter(Boolean);
}

function expectedNameservers(domain) {
  const rows = all("SELECT value FROM dns_records r JOIN domains d ON d.id = r.domain_id WHERE d.name = ? AND r.type = 'NS'", domain)
    .map((row) => normHost(row.value));
  const configured = [setting('ns1', ''), setting('ns2', '')].map(normHost).filter(Boolean);
  return [...new Set([...rows, ...configured])];
}

function classifyDelegation(domain, nameservers, expected, { serverIp = setting('server_ip', '127.0.0.1'), addresses = null } = {}) {
  const ns = (nameservers || []).map(normHost).filter(Boolean);
  const exp = (expected || []).map(normHost).filter(Boolean);
  const matches = exp.filter((name) => ns.includes(name));
  const a = (addresses || []).filter(Boolean);
  const propagated = a.length ? a.includes(serverIp) : null;
  let status = 'pending';
  let ok = false;
  let detail = '';
  if (!ns.length) {
    detail = 'Brak publicznych rekordów NS — domena nie jest jeszcze delegowana do tego serwera.';
  } else if (!exp.length) {
    status = 'delegated';
    ok = true;
    detail = `Domena delegowana do: ${ns.join(', ')}.`;
  } else if (matches.length) {
    status = 'delegated';
    ok = true;
    detail = `Delegacja poprawna (${matches.join(', ')}).`;
  } else {
    status = 'mismatch';
    detail = `Publiczne NS (${ns.join(', ')}) nie wskazują na ten serwer (${exp.join(', ')}).`;
  }
  return {
    ok, status, ns, expected: exp, addresses: a, propagated,
    detail, checkedAt: nowIso(), retryable: status !== 'delegated',
  };
}

/** Synchronous delegation probe used by the provisioning pipeline. Uses dig
 *  without a shell; when dig is unavailable it reports "unavailable" instead
 *  of inventing success. */
export function probeDelegation(domain, { expected = null, timeout = 3000 } = {}) {
  if (!isDomain(domain)) return { ok: false, status: 'invalid', ns: [], expected: [], detail: 'Nieprawidłowa domena.', checkedAt: nowIso(), retryable: false };
  const ns = digRecords(domain, 'NS', timeout);
  const addresses = digRecords(domain, 'A', timeout);
  if (ns === null) {
    return { ok: false, status: 'unavailable', ns: [], expected: expectedNameservers(domain), addresses: [], detail: 'Brak narzędzia dig — delegacji nie da się sprawdzić na tym hoście.', checkedAt: nowIso(), retryable: true };
  }
  return classifyDelegation(domain, ns, expected || expectedNameservers(domain), { addresses });
}

/** Async delegation check with an injectable resolver (used by tests/UI). */
export async function checkDelegation(domain, { resolveNs = dns.resolveNs, resolve4 = dns.resolve4, expected = null, timeoutMs = 3000 } = {}) {
  if (!isDomain(domain)) return { ok: false, status: 'invalid', ns: [], expected: [], detail: 'Nieprawidłowa domena.', checkedAt: nowIso(), retryable: false };
  const limit = (promise) => Promise.race([
    Promise.resolve(promise),
    new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
  let ns = null;
  let addresses = null;
  try { ns = await limit(resolveNs(domain)); } catch { ns = null; }
  try { addresses = await limit(resolve4(domain)); } catch { addresses = null; }
  if (ns === null && addresses === null) {
    return { ok: false, status: 'unavailable', ns: [], expected: expected || expectedNameservers(domain), addresses: [], propagated: null, detail: 'Nie udało się odpytać DNS publicznego.', checkedAt: nowIso(), retryable: true };
  }
  return classifyDelegation(domain, ns || [], expected || expectedNameservers(domain), { addresses: addresses || [] });
}

/* ------------------------------------------------------ public (UI) view */

/** UI helper: zone file paths are only returned to expert mode. */
export function publicZoneInfo(domain, { expert = false } = {}) {
  if (!isDomain(domain)) return { ok: false, error: 'Nieprawidłowa domena' };
  const row = get('SELECT * FROM domains WHERE name = ?', domain);
  if (!row) return { ok: false, error: 'Domena nie istnieje' };
  const meta = zoneMeta(domain);
  return {
    ok: true,
    domain,
    records: zoneRecords(domain),
    checked: !!meta?.checked,
    expert: !!expert,
    file: expert ? (meta?.file || zonePath(domain)) : null,
    meta: expert ? meta : null,
    snapshots: snapshotList(domain),
  };
}

/** Ensure a DKIM key exists and return its public value; optional operation. */
export function ensureDkimRecord(domain, { actor = 'admin', generate = true } = {}) {
  if (!isDomain(domain)) return { ok: false, error: 'Nieprawidłowa domena' };
  let status = dkimStatus(domain);
  if (!status.exists && generate) {
    const generated = generateDkim(domain, 'default');
    if (!generated.ok) return { ok: false, error: generated.error || 'Nie udało się wygenerować DKIM' };
    status = dkimStatus(domain);
  }
  if (!status.exists || !status.publicKey) return { ok: false, error: 'Brak klucza DKIM', skipped: true };
  audit(actor, 'admin', 'dns.dkim.ensure', domain, '');
  return { ok: true, selector: status.selector || 'default', publicKey: status.publicKey };
}

/** Exposed for tests/UI: whether provider is sandbox (network probes are real
 *  regardless; this is only informational). */
export function dnsProviderInfo() {
  return { provider: config.provider, zoneDir: config.provider === 'linux' ? null : 'data/dns' };
}

void zonePath;
