// Administrator Security Center: one page for host hardening.
import { all, get, run, nowIso, audit } from '../db.mjs';
import { html as h, formatDate } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, table, btn, badge, alert, emptyState, kvList, form, field, tabs } from '../ui/components.mjs';
import { icon } from '../ui/icons.mjs';
import {
  capabilities, securitySummary, addIpBlock, removeIpBlock, getSsh, saveSsh,
  listRootKeys, importRootKey, generateRootKey, deleteRootKey,
  getPasswordPolicy, savePasswordPolicy, countryStatus, setCountry,
  compilerState, setGroupAccess, setCompilerRestriction,
  getForkBomb, saveForkBomb, smtpRestrictions, saveSmtpRestrictions,
  modsecStatus, saveModsec, applyFirewall,
} from '../security.mjs';

const A = '/admin/security';

function tabOf(ctx) {
  const t = String(ctx.query.tab || 'overview');
  return ['overview', 'firewall', 'ssh', 'keys', 'policy', 'countries', 'groups', 'mail', 'waf'].includes(t) ? t : 'overview';
}

function statusLine(ok, yes = 'gotowe', no = 'niedostępne') {
  return badge(ok ? yes : no, ok ? 'ok' : 'warn', { dot: true });
}

export function register(router) {
  router.get(A, (ctx) => {
    const tab = tabOf(ctx);
    const s = securitySummary();
    const ssh = getSsh();
    const keys = listRootKeys();
    const blocks = all('SELECT * FROM ip_blocks ORDER BY created_at DESC').map((b) => ({ ...b, expired: b.expires_at && b.expires_at <= nowIso() }));
    const countries = countryStatus();
    const groups = compilerState();
    const fork = getForkBomb();
    const policy = getPasswordPolicy();
    const mod = modsecStatus();
    const nav = tabs([
      { key: 'overview', label: 'Przegląd' },
      { key: 'firewall', label: 'IP block', count: blocks.filter((b) => !b.expired).length },
      { key: 'ssh', label: 'SSH' },
      { key: 'keys', label: 'Klucze roota', count: keys.length },
      { key: 'policy', label: 'Hasła' },
      { key: 'countries', label: 'Kraje', count: countries.rows.length },
      { key: 'groups', label: 'Grupy' },
      { key: 'mail', label: 'SMTP' },
      { key: 'waf', label: 'ModSecurity' },
    ], tab, { base: A });

    let body = nav;

    if (tab === 'overview') {
      body += h`
        ${!s.caps.root ? alert('Panel nie działa jako root — zmiany systemowe będą odrzucane.', 'warn') : ''}
        ${configSandbox(s.caps.provider) ? alert('Tryb sandbox: operacje są zapisywane w katalogu danych, nie na hoście.', 'info') : ''}
        <div class="grid grid-3">
          ${card('Firewall', h`<div class="stack">${kvList([
            ['nftables', statusLine(s.caps.nft)],
            ['Zablokowane IP', String(s.blocks)],
            ['Kraje', String(s.countries)],
            ['Ograniczenia SMTP', statusLine(s.smtp, 'włączone', 'wyłączone')],
          ])}<a class="btn btn-secondary btn-sm" href="${A}?tab=firewall">Zarządzaj</a></div>`)}
          ${card('SSH', h`<div class="stack">${kvList([
            ['sshd', statusLine(s.caps.ssh)],
            ['Port', String(ssh.port)],
            ['Hasło', statusLine(ssh.password_authentication, 'włączone', 'wyłączone')],
            ['Root login', ssh.permit_root_login],
          ])}<a class="btn btn-secondary btn-sm" href="${A}?tab=ssh">Zarządzaj</a></div>`)}
          ${card('Klucze roota', h`<div class="stack">${kvList([
            ['Klucze', String(keys.length)],
            ['Ostatni', keys[0] ? `${keys[0].name} · ${formatDate(keys[0].created_at)}` : 'brak'],
          ])}<a class="btn btn-secondary btn-sm" href="${A}?tab=keys">Zarządzaj</a></div>`)}
          ${card('Polityka haseł', h`<div class="stack">${kvList([
            ['Min. długość', String(policy.minlen)],
            ['Klasy znaków', String(policy.minclass)],
          ])}<a class="btn btn-secondary btn-sm" href="${A}?tab=policy">Zarządzaj</a></div>`)}
          ${card('Fork bomb', h`<div class="stack">${kvList([
            ['Status', statusLine(fork.enabled, 'włączone', 'wyłączone')],
            ['nproc', String(fork.nproc)],
            ['nofile', String(fork.nofile)],
          ])}<a class="btn btn-secondary btn-sm" href="${A}?tab=groups">Zarządzaj</a></div>`)}
          ${card('ModSecurity', h`<div class="stack">${kvList([
            ['Apache', statusLine(s.caps.apache)],
            ['mod_security2', statusLine(mod.supported)],
            ['Engine', mod.engine],
          ])}<a class="btn btn-secondary btn-sm" href="${A}?tab=waf">Zarządzaj</a></div>`)}
        </div>`;
    }

    if (tab === 'firewall') {
      body += h`
        ${!s.caps.nft ? alert('nftables nie jest zainstalowane. Zainstaluj pakiet <code>nftables</code>, aby blokady działały.', 'warn') : ''}
        ${card('Dodaj blokadę IP', form([
          field({ name: 'cidr', label: 'Adres lub CIDR', placeholder: '203.0.113.7 lub 203.0.113.0/24', required: true }),
          field({ name: 'reason', label: 'Powód', placeholder: 'np. brute force' }),
          field({ name: 'expires_at', label: 'Wygasa (opcjonalnie)', type: 'datetime-local' }),
        ], { action: `${A}/ipblock/add`, csrf: ctx.csrf, submit: 'Zablokuj' }))}
        ${card('Zablokowane adresy', table({
          columns: [
            { label: 'CIDR', render: (r) => h`<span class="cell-mono">${r.cidr}</span>` },
            { label: 'Powód', key: 'reason' },
            { label: 'Dodał', key: 'created_by' },
            { label: 'Wygasa', render: (r) => r.expires_at ? formatDate(r.expires_at, { time: true }) : 'nigdy' },
            { label: 'Status', render: (r) => badge(r.expired ? 'wygasła' : 'aktywna', r.expired ? 'muted' : 'ok') },
          ],
          rows: blocks,
          actions: [{ label: 'Usuń', form: (r) => `${A}/ipblock/${r.id}/delete`, icon: 'trash', danger: true, confirm: (r) => `Usunąć blokadę ${r.cidr}?` }],
          empty: 'Brak blokad IP.',
        }), { padded: false })}
        ${card('Zastosuj ponownie', h`<form method="post" action="${A}/firewall/apply"><input type="hidden" name="_csrf" value="${ctx.csrf}">
          <p class="small muted">Przebudowuje nftables z bieżących blokad, krajów i ograniczeń SMTP. Może przerwać istniejące połączenia.</p>
          <button class="btn btn-secondary" type="submit">${icon('refresh', { size: 16 })} Zastosuj firewall</button></form>`)}
      `;
    }

    if (tab === 'ssh') {
      body += h`
        ${card('Konfiguracja SSH', form([
          field({ name: 'port', label: 'Port SSH', type: 'number', value: ssh.port, min: 1, max: 65535, required: true }),
          field({ name: 'permit_root_login', label: 'Logowanie roota', type: 'select', value: ssh.permit_root_login, options: [
            { value: 'prohibit-password', label: 'Tylko klucze (prohibit-password)' },
            { value: 'yes', label: 'Hasło i klucze (yes)' },
            { value: 'no', label: 'Wyłączone (no)' },
            { value: 'forced-commands-only', label: 'Tylko wymuszone komendy' },
          ] }),
          field({ name: 'max_auth_tries', label: 'MaxAuthTries', type: 'number', value: ssh.max_auth_tries, min: 1, max: 20 }),
          field({ name: 'password_authentication', label: 'Logowanie hasłem', type: 'checkbox', value: ssh.password_authentication, help: 'Zalecane: wyłączone, jeśli używasz kluczy.' }),
        ], { action: `${A}/ssh`, csrf: ctx.csrf, submit: 'Zapisz SSH' }), { sub: 'Zapis tworzy drop-in /etc/ssh/sshd_config.d/99-openadmin.conf, waliduje sshd -t i przeładowuje usługę.' })}
        ${alert('Zmiana portu SSH wymaga zaktualizowania zapory i może zablokować obecne połączenie. Zachowaj sesję awaryjną (konsola VNC).', 'warn')}
      `;
    }

    if (tab === 'keys') {
      body += h`
        ${card('Import klucza publicznego', form([
          field({ name: 'name', label: 'Nazwa', placeholder: 'admin-laptop', required: true }),
          field({ name: 'public_key', label: 'Klucz publiczny', type: 'textarea', rows: 4, required: true, full: true, placeholder: 'ssh-ed25519 AAAA...' }),
        ], { action: `${A}/keys/import`, csrf: ctx.csrf, submit: 'Dodaj klucz' }))}
        ${card('Wygeneruj nowy klucz roota', h`<form method="post" action="${A}/keys/generate" class="row"><input type="hidden" name="_csrf" value="${ctx.csrf}">
          <input name="name" placeholder="np. emergency" required><button class="btn btn-secondary" type="submit">${icon('key', { size: 16 })} Wygeneruj</button></form>
          <p class="small muted mt-12">Klucz prywatny pokaże się tylko raz. Zostanie dodany do authorized_keys roota.</p>`)}
        ${card('Klucze roota', table({
          columns: [
            { label: 'Nazwa', key: 'name' },
            { label: 'Odcisk', render: (r) => h`<span class="cell-mono small">${r.fingerprint || '—'}</span>` },
            { label: 'Dodano', render: (r) => formatDate(r.created_at, { time: true }) },
          ],
          rows: keys,
          actions: [{ label: 'Usuń', form: (r) => `${A}/keys/${r.id}/delete`, icon: 'trash', danger: true, confirm: (r) => `Usunąć klucz ${r.name}?` }],
          empty: 'Brak kluczy roota dodanych przez panel.',
        }), { padded: false })}
      `;
    }

    if (tab === 'policy') {
      body += h`
        ${card('Polityka haseł', form([
          field({ name: 'minlen', label: 'Minimalna długość', type: 'number', value: policy.minlen, min: 8, max: 64 }),
          field({ name: 'minclass', label: 'Wymagane klasy znaków', type: 'number', value: policy.minclass, min: 1, max: 4, help: '1–4: małe, duże, cyfry, znaki specjalne.' }),
          field({ name: 'maxrepeat', label: 'Maks. powtórzeń znaku', type: 'number', value: policy.maxrepeat, min: 1, max: 10 }),
          field({ name: 'enforce_root', label: 'Egzekwuj także dla roota', type: 'checkbox', value: policy.enforce_root }),
          field({ name: 'dictcheck', label: 'Sprawdzaj słownik haseł', type: 'checkbox', value: policy.dictcheck }),
        ], { action: `${A}/policy`, csrf: ctx.csrf, submit: 'Zapisz politykę' }), { sub: 'Zapis do /etc/security/pwquality.conf.d/99-openadmin.conf oraz walidacja w panelu.' })}
      `;
    }

    if (tab === 'countries') {
      body += h`
        ${card('Blokuj kraj', h`<form method="post" action="${A}/countries" class="row">
          <input type="hidden" name="_csrf" value="${ctx.csrf}">
          <input name="country" placeholder="np. ru" maxlength="2" required style="max-width:120px">
          <input name="enabled" type="hidden" value="1">
          <button class="btn btn-primary" type="submit">Dodaj blokadę</button>
        </form>
        <p class="small muted mt-12">Listy CIDR są pobierane z ipdeny.com i cache'owane w ${ctx.user.level === 'admin' ? '/var/lib/openadmin/geoip' : 'katalogu danych'}. Blokada dotyczy ruchu przychodzącego przez nftables.</p>`, { sub: `Cache: ${countries.cached} plik(ów)` })}
        ${card('Zablokowane kraje', table({
          columns: [{ label: 'Kraj', render: (r) => h`<span class="cell-mono">${r.country.toUpperCase()}</span>` }, { label: 'Tryb', key: 'mode' }, { label: 'Dodano', render: (r) => formatDate(r.created_at) }],
          rows: countries.rows,
          actions: [{ label: 'Odblokuj', form: (r) => `${A}/countries/${r.country}/delete`, icon: 'trash', danger: true, confirm: (r) => `Odblokować ${r.country.toUpperCase()}?` }],
          empty: 'Brak blokad krajów.',
        }), { padded: false })}
      `;
    }

    if (tab === 'groups') {
      body += h`
        ${card('Dostęp do kompilatora i sudo', h`
          <form method="post" action="${A}/groups" class="row">
            <input type="hidden" name="_csrf" value="${ctx.csrf}">
            <select name="group"><option value="compiler">compiler</option><option value="sudo">sudo / wheel</option></select>
            <select name="user">${groups.users.map((u) => h`<option>${u}</option>`)}</select>
            <select name="enabled"><option value="1">Dodaj</option><option value="0">Usuń</option></select>
            <button class="btn btn-secondary" type="submit">Wykonaj</button>
          </form>
          ${kvList([['compiler members', groups.compilerMembers.join(', ') || '—'], ['sudo members', groups.wheelMembers.join(', ') || '—']])}
        `, { sub: 'Grupy systemowe; zmiany są natychmiastowe i audytowane.' })}
        ${card('Ograniczenie kompilatora', h`<form method="post" action="${A}/compiler">
          <input type="hidden" name="_csrf" value="${ctx.csrf}">
          <label class="check-field"><input type="checkbox" name="enabled" value="1" ${groups.enabled ? 'checked' : ''}> <span>Odbierz kompilator użytkownikom spoza grupy compiler</span></label>
          <p class="small muted">Zmienia uprawnienia /usr/bin/gcc, g++ i cc na 0750. Root nadal może kompilować. Wymaga grupy compiler.</p>
          <button class="btn btn-secondary" type="submit">Zapisz</button></form>`)}
        ${card('Fork bomb protection', form([
          field({ name: 'enabled', label: 'Włącz limity', type: 'checkbox', value: fork.enabled }),
          field({ name: 'nproc', label: 'Max procesów', type: 'number', value: fork.nproc, min: 16, max: 100000 }),
          field({ name: 'nofile', label: 'Max otwartych plików', type: 'number', value: fork.nofile, min: 256, max: 1048576 }),
        ], { action: `${A}/forkbomb`, csrf: ctx.csrf, submit: 'Zapisz limity' }), { sub: 'Zapis do /etc/security/limits.d/99-openadmin.conf' })}
      `;
    }

    if (tab === 'mail') {
      body += h`
        ${card('Ograniczenia SMTP', h`
          <form method="post" action="${A}/smtp">
            <input type="hidden" name="_csrf" value="${ctx.csrf}">
            <label class="check-field"><input type="checkbox" name="enabled" value="1" ${smtpRestrictions() ? 'checked' : ''}> <span>Blokuj bezpośrednie połączenia SMTP użytkownikom (tylko MTA i root)</span></label>
            <p class="small muted">Reguła nftables OUTPUT: porty 25/465/587 dla UID innych niż root i Exim. Może zablokować zewnętrzne relaye używane przez aplikacje.</p>
            <button class="btn btn-secondary" type="submit">Zapisz i zastosuj</button>
          </form>`, { sub: 'Ochrona przed spamem wychodzącym z pominięciem MTA' })}
        ${alert('Włączaj tylko świadomie — aplikacje wysyłające bezpośrednio przez SMTP zewnętrzny przestaną działać.', 'warn')}
      `;
    }

    if (tab === 'waf') {
      body += h`
        ${!mod.supported ? alert('ModSecurity nie jest wykryty (Apache mod_security2 lub nginx z modułem). Możesz zapisać politykę, ale nie zostanie zastosowana, dopóki WAF nie jest zainstalowany.', 'warn') : ''}
        ${card('Polityka ModSecurity', form([
          field({ name: 'engine', label: 'Tryb', type: 'select', value: mod.engine, options: [
            { value: 'On', label: 'On — blokuj' }, { value: 'DetectionOnly', label: 'DetectionOnly — tylko loguj' }, { value: 'Off', label: 'Off' },
          ] }),
          field({ name: 'paranoia', label: 'Paranoia level', type: 'select', value: mod.paranoia, options: ['1', '2', '3', '4'] }),
        ], { action: `${A}/modsec`, csrf: ctx.csrf, submit: 'Zapisz politykę' }), { sub: `Plik: ${mod.conf}` })}
        ${kvList([['CRS', mod.crs ? 'obecny' : 'brak'], ['Apache', s.caps.apache ? 'tak' : 'nie'], ['mod_security2', mod.supported ? 'tak' : 'nie']])}
      `;
    }

    return page(ctx, { title: 'Security Center', subtitle: 'Firewall, SSH, klucze, polityki i WAF w jednym miejscu', body, wide: true });
  });

  router.post(`${A}/ipblock/add`, (ctx) => {
    const r = addIpBlock(ctx.body.cidr, { reason: String(ctx.body.reason || ''), expiresAt: ctx.body.expires_at || null, actor: ctx.user.username });
    return ctx.redirect(`${A}?tab=firewall&flash=${encodeURIComponent(r.ok ? 'Blokada dodana i zastosowana' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/ipblock/:id/delete`, (ctx) => {
    const r = removeIpBlock(ctx.params.id, ctx.user.username);
    return ctx.redirect(`${A}?tab=firewall&flash=${encodeURIComponent(r.ok ? 'Blokada usunięta' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/firewall/apply`, (ctx) => {
    const r = applyFirewall();
    audit(ctx.user.username, 'admin', 'security.firewall.apply', '', ctx.ip);
    return ctx.redirect(`${A}?tab=firewall&flash=${encodeURIComponent(r.ok ? 'Firewall zastosowany' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/ssh`, (ctx) => {
    const r = saveSsh(ctx.body, ctx.user.username);
    return ctx.redirect(`${A}?tab=ssh&flash=${encodeURIComponent(r.ok ? 'Konfiguracja SSH zapisana' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/keys/import`, (ctx) => {
    const r = importRootKey(ctx.body.name, ctx.body.public_key, ctx.user.username);
    return ctx.redirect(`${A}?tab=keys&flash=${encodeURIComponent(r.ok ? 'Klucz dodany' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/keys/generate`, (ctx) => {
    const r = generateRootKey(ctx.body.name, ctx.user.username);
    if (!r.ok) return ctx.redirect(`${A}?tab=keys&flash=${encodeURIComponent(r.error)}&type=error`);
    const body = h`${card('Klucz wygenerowany', h`${alert('Pobierz klucz prywatny teraz — nie pokaże się ponownie.', 'warn')}
      ${kvList([['Klucz publiczny', h`<code class="cell-mono">${r.publicKey}</code>`], ['Odcisk', r.fingerprint]])}
      <textarea class="code-block" rows="8" readonly>${r.privateKey}</textarea>
      <div class="row mt-18"><a class="btn btn-primary" href="${A}?tab=keys">Wróć</a></div>`)}`;
    return page(ctx, { title: 'Klucz roota', subtitle: 'Zapisz go bezpiecznie', body });
  });
  router.post(`${A}/keys/:id/delete`, (ctx) => {
    const r = deleteRootKey(ctx.params.id, ctx.user.username);
    return ctx.redirect(`${A}?tab=keys&flash=${encodeURIComponent(r.ok ? 'Klucz usunięty' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/policy`, (ctx) => {
    savePasswordPolicy(ctx.body, ctx.user.username);
    return ctx.redirect(`${A}?tab=policy&flash=Polityka%20hase%C5%82%20zapisana`);
  });
  router.post(`${A}/countries`, async (ctx) => {
    const r = await setCountry(ctx.body.country, true, ctx.user.username);
    return ctx.redirect(`${A}?tab=countries&flash=${encodeURIComponent(r.ok ? (r.cached ? 'Kraj zablokowany' : `Zapisano, ale listy CIDR nie pobrano: ${r.error}`) : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/countries/:country/delete`, async (ctx) => {
    const r = await setCountry(ctx.params.country, false, ctx.user.username);
    return ctx.redirect(`${A}?tab=countries&flash=${encodeURIComponent(r.ok ? 'Kraj odblokowany' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/groups`, (ctx) => {
    const r = setGroupAccess(ctx.body.group, ctx.body.user, String(ctx.body.enabled) === '1', ctx.user.username);
    return ctx.redirect(`${A}?tab=groups&flash=${encodeURIComponent(r.ok ? 'Grupa zaktualizowana' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/compiler`, (ctx) => {
    const r = setCompilerRestriction(!!ctx.body.enabled, ctx.user.username);
    return ctx.redirect(`${A}?tab=groups&flash=${encodeURIComponent(r.ok ? 'Ustawienie kompilatora zapisane' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/forkbomb`, (ctx) => {
    saveForkBomb(ctx.body, ctx.user.username);
    return ctx.redirect(`${A}?tab=groups&flash=Limity%20zapisane`);
  });
  router.post(`${A}/smtp`, (ctx) => {
    const r = saveSmtpRestrictions(!!ctx.body.enabled, ctx.user.username);
    return ctx.redirect(`${A}?tab=mail&flash=${encodeURIComponent(r.ok ? 'Ograniczenia SMTP zapisane' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/modsec`, (ctx) => {
    const r = saveModsec(ctx.body, ctx.user.username);
    return ctx.redirect(`${A}?tab=waf&flash=${encodeURIComponent(r.ok ? 'Polityka WAF zapisana' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
}

function configSandbox(provider) {
  return provider !== 'linux';
}
