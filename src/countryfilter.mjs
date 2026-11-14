// Country e-mail filtering. Enforcement requires an Exim build with GeoIP;
// otherwise the policy is stored and reported as unsupported (never faked).
import { all, run, nowIso, audit } from './db.mjs';
import { eximBin } from './mailops.mjs';
import { sh } from './sys.mjs';

export function geoipSupport() {
  const bin = eximBin();
  if (!bin) return { supported: false, reason: 'Exim nie jest zainstalowany' };
  const r = sh(bin, ['-bV'], { timeout: 10000 });
  const supported = /GeoIP|geoip/i.test(r.stdout || '');
  return { supported, reason: supported ? 'Exim wspiera GeoIP' : 'Exim nie ma wkompilowanego GeoIP' };
}

export function listCountries() { return all('SELECT * FROM country_email_policy ORDER BY country'); }

export function addCountry(code, actor = 'admin') {
  const cc = String(code || '').toLowerCase();
  if (!/^[a-z]{2}$/.test(cc)) return { ok: false, error: 'Kod kraju to dwie litery' };
  run("INSERT OR IGNORE INTO country_email_policy(country, action, created_at) VALUES(?, 'reject', ?)", cc, nowIso());
  audit(actor, 'admin', 'mail.country.add', cc, '');
  return { ok: true, supported: geoipSupport().supported };
}

export function removeCountry(code) {
  run('DELETE FROM country_email_policy WHERE country = ?', String(code || '').toLowerCase());
  return { ok: true };
}

export function aclText() {
  const list = listCountries().map((r) => r.country);
  if (!list.length) return '';
  return `# Managed by OpenAdmin — requires Exim GeoIP\ndeny message = Sender country blocked by OpenAdmin\n     condition = \${if inlist{\$sender_host_country}{${list.join(',')}}{yes}{no}}\n`;
}
