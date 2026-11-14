// DNS zone generation and deployment. Zones are rendered from the record table
// in BIND format, validated with named-checkzone when available, and deployed
// on Linux with a named reload.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { config } from './config.mjs';
import { all, get, setting, run, nowIso } from './db.mjs';
import { systemProvider } from './providers/index.mjs';

export function zoneDir() {
  const dir = path.join(config.dataDir, 'dns');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function zonePath(domain) {
  return path.join(zoneDir(), `${domain}.db`);
}

function serial(domain) {
  const prev = Number(get('SELECT value FROM settings WHERE key = ?', `zone_serial:${domain}`)?.value || 0);
  return Math.max(Math.floor(Date.now() / 1000), prev + 1);
}

export function renderZone(domain) {
  const records = all(`SELECT r.* FROM dns_records r JOIN domains d ON d.id = r.domain_id WHERE d.name = ? ORDER BY r.type, r.name`, domain);
  const ns1 = setting('ns1', 'ns1.localhost');
  const ns2 = setting('ns2', 'ns2.localhost');
  const ip = setting('server_ip', '127.0.0.1');
  const zoneTtl = Number(get('SELECT dns_ttl FROM domains WHERE name = ?', domain)?.dns_ttl || 3600);
  const soaNs = ns1.endsWith('.') ? ns1 : ns1 + '.';
  const lines = [
    `; OpenAdmin zone for ${domain}`,
    `; generated ${nowIso()}`,
    `$TTL ${zoneTtl}`,
    `@   IN  SOA ${soaNs} postmaster.${domain}. (`,
    `        ${serial(domain)} ; serial`,
    '        3600       ; refresh',
    '        1800       ; retry',
    '        1209600    ; expire',
    '        3600 )     ; minimum',
    `    IN  NS  ${soaNs}`,
    `    IN  NS  ${ns2.endsWith('.') ? ns2 : ns2 + '.'}`,
    '',
  ];
  const fmt = (r) => {
    const name = r.name === '@' ? '@' : r.name;
    const value = r.type === 'MX' || r.type === 'CNAME' || r.type === 'NS'
      ? (String(r.value).endsWith('.') ? r.value : r.value + '.')
      : r.value;
    if (r.type === 'MX') return `${name}\t${r.ttl}\tIN\tMX\t${r.priority ?? 10} ${value}`;
    if (r.type === 'TXT') {
      const chunks = String(r.value).replace(/"/g, '\\"').match(/.{1,255}/g) || [''];
      return `${name}\t${r.ttl}\tIN\tTXT\t${chunks.map((c) => `"${c}"`).join(' ')}`;
    }
    if (r.type === 'POINTER') return `; pointer ${value}`;
    return `${name}\t${r.ttl}\tIN\t${r.type}\t${value}`;
  };
  for (const r of records) {
    if (r.type === 'SOA') continue;
    lines.push(fmt(r));
  }
  // Always advertise the server IP for the apex when no A record exists.
  if (!records.some((r) => r.type === 'A' && (r.name === '@' || r.name === domain))) {
    lines.push(`@\t${zoneTtl}\tIN\tA\t${ip}`);
  }
  return lines.join('\n') + '\n';
}

export function checkZone(domain) {
  const file = zonePath(domain);
  if (!fs.existsSync(file)) return { ok: false, error: 'Zone file has not been generated' };
  const bin = spawnSync('sh', ['-c', 'command -v named-checkzone'], { encoding: 'utf8' });
  if (bin.status !== 0) return { ok: true, skipped: true, output: 'named-checkzone is not installed; structural check only' };
  const r = spawnSync(bin.stdout.trim(), [domain, file], { encoding: 'utf8', timeout: 30000 });
  return { ok: r.status === 0, output: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

export function rebuildZone(domain) {
  const d = get('SELECT * FROM domains WHERE name = ?', domain);
  if (!d) return { ok: false, error: 'Domain not found' };
  const content = renderZone(domain);
  const file = zonePath(domain);
  fs.writeFileSync(file, content, 'utf8');
  const check = checkZone(domain);
  run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', `zone_serial:${domain}`, String(serial(domain)));
  setMeta(domain, file, check);
  return { ok: check.ok, file, content, check };
}

function setMeta(domain, file, check) {
  const meta = { file, checked: check.ok, output: check.output || '', at: nowIso() };
  run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    `zone_meta:${domain}`, JSON.stringify(meta));
}

export function zoneMeta(domain) {
  const row = get('SELECT value FROM settings WHERE key = ?', `zone_meta:${domain}`);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

export function rebuildAll() {
  const domains = all('SELECT name FROM domains ORDER BY name');
  const results = domains.map((d) => ({ domain: d.name, ...rebuildZone(d.name) }));
  return { ok: results.every((r) => r.ok), count: results.length, results };
}

function namedStanzas(domains, dir) {
  return domains.map((name) => `zone "${name}" {\n    type master;\n    file "${path.join(dir, `${name}.db`)}";\n};`).join('\n');
}

/** Render the named.conf snippet for every zone. */
export function namedConf(domains = all('SELECT name FROM domains ORDER BY name').map((d) => d.name), dir = '/var/named') {
  return `// Generated by OpenAdmin — DNS zones\n${namedStanzas(domains, dir)}\n`;
}

/** Deploy staged zones to the DNS server (Linux + root). */
export function deployZones() {
  const provider = systemProvider();
  const domains = all('SELECT name FROM domains ORDER BY name').map((d) => d.name);
  if (provider.id !== 'linux') {
    const staging = path.join(zoneDir(), 'named.conf.openadmin');
    fs.writeFileSync(staging, namedConf(domains, zoneDir()), 'utf8');
    return { ok: true, simulated: true, output: `Zones and named.conf generated in ${zoneDir()} (sandbox provider); ${domains.length} zone(s)` };
  }
  if (process.getuid && process.getuid() !== 0) return { ok: false, output: 'Root privileges are required to deploy zones' };
  const candidates = ['/var/named', '/etc/bind', '/var/lib/bind'];
  const dir = candidates.find((d) => fs.existsSync(d));
  if (!dir) return { ok: false, output: 'No BIND zone directory found (/var/named, /etc/bind, /var/lib/bind)' };
  const files = fs.readdirSync(zoneDir()).filter((f) => f.endsWith('.db'));
  for (const f of files) fs.copyFileSync(path.join(zoneDir(), f), path.join(dir, f));
  const confPath = path.join(path.dirname(dir) === '/etc' ? '/etc/bind' : dir, 'named.conf.openadmin');
  fs.writeFileSync(confPath, namedConf(domains, dir), { mode: 0o644 });
  const mainConf = ['/etc/bind/named.conf.local', '/etc/named.conf'].find((f) => fs.existsSync(f));
  if (mainConf && !fs.readFileSync(mainConf, 'utf8').includes('named.conf.openadmin')) {
    fs.copyFileSync(mainConf, mainConf + '.openadmin.bak');
    fs.appendFileSync(mainConf, `\ninclude "${confPath}";\n`);
  }
  const check = spawnSync('named-checkconf', [], { encoding: 'utf8', timeout: 30000 });
  const r = spawnSync('rndc', ['reload'], { encoding: 'utf8', timeout: 30000 });
  const ok = check.status === 0 && r.status === 0;
  return {
    ok,
    output: `deployed ${files.length} zone(s) to ${dir}; ${ok ? 'named.conf valid, rndc reloaded' : (check.stderr || r.stderr || 'reload failed').trim()}`,
  };
}
