// Plain-language readiness checks for the admin dashboard / setup wizard.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { all, get, setting } from './db.mjs';
import { config } from './config.mjs';
import { systemProvider } from './providers/index.mjs';
import { activeServer } from './webserver.mjs';
import { poolStatus } from './phpfpm.mjs';
import { mailStatus } from './mail.mjs';
import { applyStatus } from './apply.mjs';
import { sslStatus } from './ssl.mjs';

function tcp(port, host = '127.0.0.1', timeout = 500) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (ok) => { try { s.destroy(); } catch { /* ignore */ } resolve(ok); };
    s.setTimeout(timeout);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}

function digPublic(domain, type) {
  const r = spawnSync('dig', ['+short', '+time=2', '+tries=1', type, domain, '@1.1.1.1'], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0 ? r.stdout.trim().split('\n').filter(Boolean) : null;
}

function dig(domain, type) {
  const r = spawnSync('dig', ['+short', '+time=2', '+tries=1', type, domain, '@127.0.0.1'], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0 ? r.stdout.trim().split('\n').filter(Boolean) : null;
}

function item(id, label, status, detail, fix = null) {
  return { id, label, status, detail, fix };
}

export async function healthReport() {
  const provider = systemProvider();
  const server = activeServer();
  const checks = [];
  checks.push(item('setup', 'Konfiguracja początkowa', setting('setup_complete', '0') === '1' ? 'ok' : 'warn',
    setting('setup_complete', '0') === '1' ? 'Kreator zakończony' : 'Uruchom kreator pierwszej konfiguracji', { label: 'Otwórz kreator', action: 'setup', href: '/admin/setup' }));
  checks.push(item('https', 'Panel po HTTPS', config.https ? 'ok' : 'warn',
    config.https ? 'Certyfikat panelu aktywny' : 'Panel działa po HTTP; przeglądarka ostrzega o niezabezpieczonym połączeniu', { label: 'Włącz HTTPS', action: 'https' }));

  const webSvc = server.id === 'apache' ? 'httpd' : server.id === 'openlitespeed' || server.id === 'litespeed' ? 'openlitespeed' : 'nginx';
  const webStatus = provider.serviceStatus(webSvc);
  const webUp = webStatus.status === 'running';
  checks.push(item('web', `Serwer WWW (${server.label})`, webUp ? 'ok' : 'fail',
    webUp ? 'Usługa działa' : 'Usługa nie działa — strony nie będą dostępne', { label: 'Wdróż ponownie', action: 'web' }));

  const php = provider.serviceStatus('php-fpm');
  const users = all("SELECT username FROM users WHERE level IN ('user','reseller')");
  const pools = users.map((u) => poolStatus(u.username));
  const phpOk = php.status === 'running' && (pools.length === 0 || pools.some((p) => p.exists));
  checks.push(item('php', 'PHP-FPM', phpOk ? 'ok' : 'fail', phpOk ? `Działa · ${pools.filter((p) => p.exists).length} pul` : 'PHP nie działa lub brak pul dla kont', { label: 'Wdróż PHP', action: 'web' }));

  const db = provider.serviceStatus('mysqld');
  checks.push(item('db', 'Baza danych (MariaDB)', db.status === 'running' ? 'ok' : 'fail', db.status === 'running' ? 'Usługa działa' : 'Baza nie działa — panel i strony mogą nie działać'));

  const dnsSvc = provider.serviceStatus('bind');
  const zones = all('SELECT name FROM domains ORDER BY name');
  checks.push(item('dns', 'Serwer DNS (BIND)', dnsSvc.status === 'running' ? 'ok' : 'fail', dnsSvc.status === 'running' ? `Działa · ${zones.length} stref` : 'DNS nie działa — domeny nie będą rozwiązywane', { label: 'Wdróż strefy', action: 'dns' }));

  const mail = mailStatus();
  checks.push(item('mail', 'Poczta (Exim + Dovecot)', mail.exim === 'running' && mail.dovecot === 'running' ? 'ok' : 'warn',
    `Exim: ${mail.exim || 'brak'} · Dovecot: ${mail.dovecot || 'brak'} · skrzynek: ${mail.accounts}`, { label: 'Wdróż pocztę', action: 'mail' }));

  for (const [port, label] of [[80, 'HTTP'], [443, 'HTTPS'], [25, 'SMTP'], [993, 'IMAPS'], [2222, 'panel']]) {
    const open = await tcp(port);
    checks.push(item(`port-${port}`, `Port ${port} (${label})`, open ? 'ok' : port === 443 || port === 993 ? 'warn' : 'fail',
      open ? 'Nasłuchuje' : 'Zamknięty lub usługa nie działa'));
  }

  const apply = applyStatus();
  checks.push(item('apply', 'Ostatnie wdrożenie zmian', apply.pending ? 'warn' : apply.lastAt ? (apply.ok ? 'ok' : 'fail') : 'warn',
    apply.pending ? 'Są zmiany oczekujące na wdrożenie' : apply.lastAt ? `${apply.ok ? 'OK' : 'Błędy'} · ${apply.lastAt}` : 'Jeszcze nie uruchamiano',
    { label: 'Wdróż wszystko', action: 'apply' }));

  const certs = all("SELECT domain, expires_at FROM ssl_certs WHERE status = 'active'");
  const soon = certs.filter((c) => c.expires_at && new Date(c.expires_at).getTime() - Date.now() < 30 * 864e5);
  checks.push(item('certs', 'Certyfikaty SSL', soon.length ? 'warn' : 'ok', soon.length ? `${soon.length} certyfikat(ów) wygasa w ciągu 30 dni` : `${certs.length} aktywnych certyfikatów`));

  const lastBackup = get("SELECT * FROM backups WHERE filename LIKE 'admin_backup_%' ORDER BY created_at DESC LIMIT 1");
  const backupAge = lastBackup ? (Date.now() - new Date(lastBackup.created_at).getTime()) / 864e5 : 999;
  checks.push(item('backup', 'Kopie zapasowe', backupAge <= 7 ? 'ok' : 'warn',
    lastBackup ? `Ostatnia: ${lastBackup.created_at}` : 'Brak kopii serwera',
    { label: 'Zrób kopię', action: 'backup' }));

  let disk = null;
  try {
    const st = fs.statfsSync(config.dataDir);
    disk = Math.round(((st.blocks - st.bavail) / st.blocks) * 100);
  } catch { /* unknown */ }
  checks.push(item('disk', 'Miejsce na dysku', disk === null ? 'warn' : disk > 90 ? 'fail' : disk > 75 ? 'warn' : 'ok',
    disk === null ? 'Nie można odczytać' : `Zajęte ${disk}%`));

  if (provider.id === 'linux') for (const d of zones.slice(0, 5)) {
    const a = dig(d.name, 'A');
    const expected = setting('server_ip', '127.0.0.1');
    const ok = Array.isArray(a) && a.includes(expected);
    checks.push(item(`dns-${d.name}`, `DNS: ${d.name}`, ok ? 'ok' : 'warn',
      ok ? `A → ${expected}` : `A wskazuje ${a && a.length ? a.join(', ') : 'brak'} zamiast ${expected}`,
      { label: 'Wdróż DNS', action: 'dns' }));
    const mailCount = get('SELECT COUNT(*) n FROM email_accounts WHERE domain = ?', d.name).n;
    if (mailCount > 0) {
    const txt = dig(d.name, 'TXT') || [];
    const spf = txt.some((v) => v.includes('v=spf1'));
    const dmarc = (dig(`_dmarc.${d.name}`, 'TXT') || []).some((v) => v.includes('v=DMARC1'));
    const dkim = (dig(`default._domainkey.${d.name}`, 'TXT') || []).length > 0;
    const missing = [!spf && 'SPF', !dmarc && 'DMARC', !dkim && 'DKIM'].filter(Boolean);
    checks.push(item(`mailauth-${d.name}`, `Poczta: ${d.name}`, missing.length ? 'warn' : 'ok',
      missing.length ? `Brakuje: ${missing.join(', ')}` : 'SPF, DKIM i DMARC opublikowane'));
    }
  }

  const publicZone = zones.find((z) => !/\.(local|localhost|test|example|invalid)$/i.test(z.name));
  if (provider.id === 'linux' && publicZone) {
    const pub = digPublic(publicZone.name, 'A');
    const expected = setting('server_ip', '127.0.0.1');
    checks.push(item('public-dns', `Publiczny DNS: ${publicZone.name}`, pub && pub.includes(expected) ? 'ok' : 'warn',
      pub && pub.includes(expected) ? 'Domena widoczna w publicznym DNS' : 'Nie widzimy domeny w publicznym DNS — może trwać propagacja lub brak delegacji u registrar'));
  }

  const counts = { ok: 0, warn: 0, fail: 0 };
  for (const c of checks) counts[c.status] = (counts[c.status] || 0) + 1;
  return { checks, counts, summary: counts.fail ? 'fail' : counts.warn ? 'warn' : 'ok', mail, apply };
}
