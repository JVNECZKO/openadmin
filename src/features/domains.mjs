import fs from 'node:fs';
// Domains, subdomains, DNS zones, domain pointers and redirects.
import { all, get, run, nowIso, setting, audit } from '../db.mjs';
import { limitsFor } from '../auth.mjs';
import { html as h, isDomain, formatBytes, formatDate, e } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, table, form, btn, badge, statusBadge, pageHead, alert, emptyState, tabs, toolbar, kvList } from '../ui/components.mjs';
import { icon } from '../ui/icons.mjs';
import { domainSelect, listCard } from '../ui/pages/list.mjs';
import { quota, visibleDomains, domainFor } from '../core/access.mjs';
import { provisionDomain } from './files.mjs';
import { rebuildZone, zoneMeta, zonePath } from '../dns.mjs';
import { runHooks } from '../plugins.mjs';
import { apply } from '../apply.mjs';
import { generateSelfSigned } from '../ssl.mjs';

const PHP = ['8.4', '8.3', '8.2', '8.1', '7.4'];

function serverIp() { return setting('server_ip', '127.0.0.1'); }

export function createZone(domainId, domain) {
  const ip = serverIp();
  const ns1 = setting('ns1', 'ns1.localhost');
  const ns2 = setting('ns2', 'ns2.localhost');
  const records = [
    ['@', 'A', ip, null, 3600],
    ['www', 'A', ip, null, 3600],
    ['mail', 'A', ip, null, 3600],
    ['ftp', 'A', ip, null, 3600],
    ['@', 'MX', `mail.${domain}.`, 10, 3600],
    ['@', 'TXT', `v=spf1 a mx ip4:${ip} ~all`, null, 3600],
    ['_dmarc', 'TXT', `v=DMARC1; p=quarantine; rua=mailto:postmaster@${domain}`, null, 3600],
    ['@', 'NS', ns1.endsWith('.') ? ns1 : ns1 + '.', null, 3600],
    ['@', 'NS', ns2.endsWith('.') ? ns2 : ns2 + '.', null, 3600],
    ['_imaps._tcp', 'SRV', `0 1 993 mail.${domain}.`, null, 3600],
    ['_submission._tcp', 'SRV', `0 1 587 mail.${domain}.`, null, 3600],
  ];
  for (const [name, type, value, priority, ttl] of records) {
    run('INSERT INTO dns_records(domain_id, name, type, value, priority, ttl) VALUES(?,?,?,?,?,?)', domainId, name, type, value, priority, ttl);
  }
  try { rebuildZone(domain); } catch { /* DNS staging is best effort */ }
}

export function userDomains(ctx) {
  const domains = visibleDomains(ctx.user);
  const lim = limitsFor(ctx.user);
  const rows = domains.map((d) => ({
    ...d,
    subCount: get('SELECT COUNT(*) n FROM subdomains WHERE domain_id = ?', d.id).n,
    mailCount: get('SELECT COUNT(*) n FROM email_accounts WHERE domain_id = ?', d.id).n,
    dnsCount: get('SELECT COUNT(*) n FROM dns_records WHERE domain_id = ?', d.id).n,
  }));
  const body = h`
    ${alert(`Domains use <strong>/home/${ctx.user.username}/domains/&lt;domain&gt;/public_html</strong> as their document root, exactly like DirectAdmin.`, 'info')}
    ${listCard({
      title: 'Domains', sub: `${rows.length} domain${rows.length === 1 ? '' : 's'}${lim.domains ? ` of ${lim.domains} allowed` : ' · unlimited'}`,
      columns: [
        { label: 'Domain', render: (r) => h`<a class="cell-strong" href="/user/dns?domain=${r.name}">${r.name}</a><span class="cell-sub">${r.docroot || ''}</span>` },
        { label: 'PHP', key: 'php_version' },
        { label: 'Subdomains', render: (r) => r.subCount },
        { label: 'Mailboxes', render: (r) => r.mailCount },
        { label: 'SSL', render: (r) => (r.ssl ? badge('Enabled', 'ok') : badge('Off', 'muted')) },
        { label: 'Disk', render: (r) => formatBytes(r.disk_mb), align: 'right' },
      ],
      rows,
      createHref: '/user/domains/create',
      createLabel: 'Add domain',
      actions: [
        { label: 'DNS', href: (r) => `/user/dns?domain=${r.name}`, icon: 'dns' },
        { label: 'Files', href: (r) => `/user/files?path=${encodeURIComponent(r.docroot || '/')}`, icon: 'folder' },
        { label: 'SSL', href: (r) => `/user/ssl?domain=${r.name}`, icon: 'lock' },
        { label: 'Edytuj', href: (r) => `/user/domains/${r.id}/edit`, icon: 'edit' },
        { label: 'Otwórz', href: (r) => `http://${r.name}/`, icon: 'globe' },
        { label: 'Logi', href: (r) => `/user/domains/${r.id}/logs`, icon: 'file' },
        { label: 'Delete', href: '#', icon: 'trash', danger: true, form: (r) => `/user/domains/${r.id}/delete`, confirm: 'Delete this domain and its DNS zone, mail and databases?', icon: 'trash' },
      ],
      empty: 'No domains yet. Add your first domain to get started.',
    })}`;
  return page(ctx, { title: 'Domains', subtitle: 'Manage the domains hosted on your account', body });
}

export function domainCreatePage(ctx, error = '') {
  const domains = visibleDomains(ctx.user);
  const q = quota(ctx.user, 'domains');
  const body = h`${error ? alert(error, 'danger') : ''}
    ${!q.ok ? alert(`You have reached your domain limit (${q.used}/${q.limit}). Remove a domain or ask your reseller for a larger package.`, 'warn') : ''}
    ${card('Add a domain', h`
      <form method="post" action="/user/domains/create" class="oa-form">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <div class="form-grid">
          <div class="field"><label class="field-label" for="dname">Domain name <span class="req">*</span></label>
            <input id="dname" name="domain" type="text" required placeholder="example.com" value="${ctx.body.domain || ''}" ${!q.ok ? 'disabled' : ''}>
            <p class="field-help">Enter the domain without http:// or a trailing slash.</p></div>
          <div class="field"><label class="field-label" for="php">PHP version</label>
            <select id="php" name="php_version">${PHP.map((v) => h`<option value="${v}" ${v === setting('php_default', '8.3') ? 'selected' : ''}>PHP ${v}</option>`)}</select></div>
          <div class="field field-full"><label class="check-field"><input type="checkbox" name="create_dns" value="1" checked><span>Create a DNS zone with default A, MX, SPF, DMARC and NS records</span></label></div>
          <div class="field field-full"><label class="check-field"><input type="checkbox" name="ssl" value="1" checked><span>Enable SSL for this domain (issue a free Let's Encrypt certificate)</span></label></div>
        </div>
        <div class="form-actions">
          <button class="btn btn-primary" type="submit" ${!q.ok ? 'disabled' : ''}>${icon('plus', { size: 16 })}<span>Create domain</span></button>
          <a class="btn btn-ghost" href="/user/domains">Cancel</a>
        </div>
      </form>`)}
    ${card('Existing domains', h`${domains.length ? kvList(domains.map((d) => [d.name, d.docroot || '—']), { cols: 1 }) : emptyState('None yet')}`)}`;
  return page(ctx, { title: 'Add domain', subtitle: 'Create a new domain on your account', body });
}

export function registerDomainsPost(router) {
  router.post('/user/domains/create', (ctx) => {
    const name = String(ctx.body.domain || '').trim().toLowerCase();
    if (!isDomain(name)) return domainCreatePage(ctx, 'That does not look like a valid domain name. Example: example.com');
    if (get('SELECT id FROM domains WHERE name = ?', name)) return domainCreatePage(ctx, 'That domain already exists on the server.');
    if (get('SELECT id FROM domains WHERE name = ?', name)) return domainCreatePage(ctx, 'Domain already exists.');
    const q = quota(ctx.user, 'domains');
    if (!q.ok) return domainCreatePage(ctx, `Domain limit reached (${q.used}/${q.limit}).`);
    const php = PHP.includes(String(ctx.body.php_version)) ? String(ctx.body.php_version) : '8.3';
    const docroot = `/home/${ctx.user.username}/domains/${name}/public_html`;
    const r = run(`INSERT INTO domains(user_id, username, name, docroot, php_version, ssl, status, is_main, ip, created_at)
                   VALUES(?,?,?,?,?,?,?,?,?,?)`,
      ctx.user.id, ctx.user.username, name, docroot, php, ctx.body.ssl ? 1 : 0, 'active',
      get('SELECT COUNT(*) n FROM domains WHERE user_id = ?', ctx.user.id).n === 0 ? 1 : 0, serverIp(), nowIso());
    if (ctx.body.create_dns) createZone(r.lastInsertRowid, name);
    provisionDomain(ctx.user.username, name);
    if (ctx.body.ssl) {
      try { generateSelfSigned(name, 365); } catch { /* the wizard reports certificate errors */ }
    }
    apply({ web: true, dns: true });
    audit(ctx.user.username, ctx.user.level, 'domain.create', name, ctx.ip);
    try { runHooks('domain.create', { domain: name, username: ctx.user.username, php }); } catch { /* ignore */ }
    return ctx.redirect('/user/domains?flash=' + encodeURIComponent(`Domain ${name} created`));
  });

  router.get('/user/domains/:id/logs', (ctx) => {
    const d = domainFor(ctx.user, ctx.params.id);
    if (!d) return ctx.redirect('/user/domains?flash=Domain%20not%20found&type=error');
    const candidates = [
      `/var/log/nginx/${d.name}.access.log`, `/var/log/nginx/${d.name}.error.log`,
      `/var/log/apache2/${d.name}.access.log`, `/var/log/apache2/${d.name}.error.log`,
      `/usr/local/lsws/logs/${d.name}.access.log`, `/usr/local/lsws/logs/${d.name}.error.log`,
    ].filter((f) => { try { return fs.existsSync(f); } catch { return false; } });
    const logs = candidates.map((f) => {
      let text = '';
      try { text = fs.readFileSync(f, 'utf8').split('\n').slice(-200).join('\n'); } catch { text = 'Nie można odczytać pliku'; }
      return { file: f, text };
    });
    const body = h`${card(`Logi: ${d.name}`, logs.length ? h`${logs.map((l) => h`<h3 class="form-section">${l.file}</h3><pre class="code-block small" style="max-height:320px;overflow:auto">${l.text || '(pusty)'}</pre>`)}` : h`<p class="small muted">Brak plików logów dla tej domeny. Na Linuksie pojawią się po pierwszym żądaniu do strony.</p>`, { actions: [h`<a class="link small" href="http://${d.name}/" target="_blank">Otwórz stronę</a>`] })}`;
    return page(ctx, { title: 'Logi domeny', subtitle: d.name, body, wide: true });
  });

  router.get('/user/domains/:id/edit', (ctx) => {
    const d = domainFor(ctx.user, ctx.params.id);
    if (!d) return ctx.redirect('/user/domains?flash=Domain%20not%20found&type=error');
    const body = h`${card(`Edit domain · ${d.name}`, h`<form method="post" action="/user/domains/${d.id}/update" class="oa-form">
      <input type="hidden" name="_csrf" value="${ctx.csrf}">
      <div class="form-grid">
        <div class="field"><label class="field-label">Domain</label><input value="${d.name}" disabled></div>
        <div class="field"><label class="field-label">Document root</label><input value="${d.docroot || ''}" disabled></div>
        <div class="field"><label class="field-label">PHP version</label><select name="php_version">${PHP.map((v) => h`<option ${v === d.php_version ? 'selected' : ''}>${v}</option>`)}</select></div>
        <div class="field"><label class="check-field"><input type="checkbox" name="ssl" value="1" ${d.ssl ? 'checked' : ''}> <span>SSL enabled</span></label></div>
      </div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">Save domain</button><a class="btn btn-ghost" href="/user/domains">Cancel</a></div>
    </form>`)}`;
    return page(ctx, { title: 'Edit domain', subtitle: d.name, body });
  });

  router.post('/user/domains/:id/update', (ctx) => {
    const d = domainFor(ctx.user, ctx.params.id);
    if (!d) return ctx.redirect('/user/domains?flash=Domain%20not%20found&type=error');
    const php = PHP.includes(String(ctx.body.php_version)) ? String(ctx.body.php_version) : d.php_version;
    run('UPDATE domains SET php_version = ?, ssl = ? WHERE id = ?', php, ctx.body.ssl ? 1 : 0, d.id);
    apply({ web: true });
    audit(ctx.user.username, ctx.user.level, 'domain.update', d.name, ctx.ip);
    return ctx.redirect('/user/domains?flash=Domain%20updated');
  });

  router.post('/user/domains/:id/delete', (ctx) => {
    const d = domainFor(ctx.user, ctx.params.id);
    if (!d) return ctx.redirect('/user/domains?flash=Domain%20not%20found&type=error');
    run('DELETE FROM domains WHERE id = ?', d.id);
    run('DELETE FROM ssl_certs WHERE domain = ?', d.name);
    try { fs.rmSync(zonePath(d.name), { force: true }); } catch { /* ignore */ }
    apply({ web: true, dns: true });
    audit(ctx.user.username, ctx.user.level, 'domain.delete', d.name, ctx.ip);
    return ctx.redirect('/user/domains?flash=' + encodeURIComponent(`Domain ${d.name} deleted`));
  });

  /* ----------------------------------------------------------- subdomains */
  router.post('/user/subdomains/create', (ctx) => {
    const d = domainFor(ctx.user, ctx.body.domain);
    if (!d) return ctx.redirect('/user/subdomains?flash=Choose%20a%20valid%20domain&type=error');
    const sub = String(ctx.body.name || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(sub)) return ctx.redirect('/user/subdomains?flash=Invalid%20subdomain%20name&type=error');
    const q = quota(ctx.user, 'subdomains');
    if (!q.ok) return ctx.redirect('/user/subdomains?flash=Subdomain%20limit%20reached&type=error');
    const docroot = `/home/${ctx.user.username}/domains/${d.name}/public_html/${sub}`;
    run(`INSERT INTO subdomains(domain_id, username, name, php_version, docroot, created_at) VALUES(?,?,?,?,?,?)`,
      d.id, ctx.user.username, sub, d.php_version, docroot, nowIso());
    run(`INSERT INTO dns_records(domain_id, name, type, value, ttl) VALUES(?,?,?,?,?)`, d.id, sub, 'A', d.ip || serverIp(), 3600);
    apply({ web: true, dns: true });
    audit(ctx.user.username, ctx.user.level, 'subdomain.create', `${sub}.${d.name}`, ctx.ip);
    return ctx.redirect('/user/subdomains?flash=' + encodeURIComponent(`Subdomain ${sub}.${d.name} created`));
  });

  router.post('/user/subdomains/:id/update', (ctx) => {
    const sub = get('SELECT * FROM subdomains WHERE id = ? AND username = ?', Number(ctx.params.id), ctx.user.username);
    if (!sub) return ctx.redirect('/user/subdomains?flash=Not%20found&type=error');
    const php = PHP.includes(String(ctx.body.php_version)) ? String(ctx.body.php_version) : sub.php_version;
    const docroot = String(ctx.body.docroot || sub.docroot);
    if (!docroot.startsWith(`/home/${ctx.user.username}/`)) return ctx.redirect('/user/subdomains?flash=Document%20root%20must%20be%20inside%20home&type=error');
    run('UPDATE subdomains SET php_version = ?, docroot = ? WHERE id = ?', php, docroot, sub.id);
    apply({ web: true });
    audit(ctx.user.username, ctx.user.level, 'subdomain.update', `${sub.name}`, ctx.ip);
    return ctx.redirect('/user/subdomains?flash=Subdomain%20updated');
  });

  router.post('/user/subdomains/:id/delete', (ctx) => {
    const s = get('SELECT * FROM subdomains WHERE id = ?', Number(ctx.params.id));
    if (!s || s.username !== ctx.user.username) return ctx.redirect('/user/subdomains?flash=Not%20found&type=error');
    const d = get('SELECT * FROM domains WHERE id = ?', s.domain_id);
    run('DELETE FROM subdomains WHERE id = ?', s.id);
    run('DELETE FROM dns_records WHERE domain_id = ? AND name = ? AND type = ?', s.domain_id, s.name, 'A');
    apply({ web: true, dns: true });
    audit(ctx.user.username, ctx.user.level, 'subdomain.delete', `${s.name}.${d?.name || ''}`, ctx.ip);
    return ctx.redirect('/user/subdomains?flash=' + encodeURIComponent(`Subdomain ${s.name}.${d?.name || ''} deleted`));
  });

  /* ------------------------------------------------------------------ DNS */
  router.post('/user/dns/add', (ctx) => {
    const d = domainFor(ctx.user, ctx.body.domain);
    if (!d) return ctx.redirect('/user/dns?flash=Domain%20not%20found&type=error');
    const type = String(ctx.body.type || 'A').toUpperCase();
    const value = String(ctx.body.value || '').trim();
    if (!value) return ctx.redirect('/user/dns?domain=' + encodeURIComponent(d.name) + '&flash=Record%20value%20is%20required&type=error');
    run('INSERT INTO dns_records(domain_id, name, type, value, priority, ttl) VALUES(?,?,?,?,?,?)',
      d.id, String(ctx.body.name || '@').trim() || '@', type, value,
      ctx.body.priority ? Number(ctx.body.priority) : null, Number(ctx.body.ttl) || 3600);
    rebuildZone(d.name);
    apply({ dns: true });
    audit(ctx.user.username, ctx.user.level, 'dns.create', `${d.name} ${type} ${ctx.body.name}`, ctx.ip);
    return ctx.redirect('/user/dns?domain=' + encodeURIComponent(d.name) + '&flash=Record%20added');
  });

  router.post('/user/dns/:id/delete', (ctx) => {
    const r = get('SELECT * FROM dns_records WHERE id = ?', Number(ctx.params.id));
    if (!r) return ctx.redirect('/user/dns?flash=Record%20not%20found&type=error');
    const d = domainFor(ctx.user, r.domain_id);
    if (!d) return ctx.redirect('/user/dns?flash=Access%20denied&type=error');
    run('DELETE FROM dns_records WHERE id = ?', r.id);
    rebuildZone(d.name);
    apply({ dns: true });
    return ctx.redirect('/user/dns?domain=' + encodeURIComponent(d.name) + '&flash=Record%20deleted');
  });

  router.post('/user/dns/:id/update', (ctx) => {
    const r = get('SELECT * FROM dns_records WHERE id = ?', Number(ctx.params.id));
    const d = r ? domainFor(ctx.user, r.domain_id) : null;
    if (!d) return ctx.redirect('/user/dns?flash=Record%20not%20found&type=error');
    run('UPDATE dns_records SET name = ?, type = ?, value = ?, priority = ?, ttl = ? WHERE id = ?',
      String(ctx.body.name || '@'), String(ctx.body.type || 'A').toUpperCase(), String(ctx.body.value || ''),
      ctx.body.priority ? Number(ctx.body.priority) : null, Number(ctx.body.ttl) || 3600, r.id);
    rebuildZone(d.name);
    apply({ dns: true });
    audit(ctx.user.username, ctx.user.level, 'dns.update', `${d.name} #${r.id}`, ctx.ip);
    return ctx.redirect('/user/dns?domain=' + encodeURIComponent(d.name) + '&flash=Record%20updated');
  });

  router.post('/user/dns/rebuild', (ctx) => {
    const d = domainFor(ctx.user, ctx.body.domain);
    if (!d) return ctx.redirect('/user/dns?flash=Domain%20not%20found&type=error');
    const result = rebuildZone(d.name);
    return ctx.redirect('/user/dns?domain=' + encodeURIComponent(d.name) + '&flash=' + encodeURIComponent(result.ok ? 'Zone rebuilt and validated' : `Zone rebuilt with warnings: ${result.check.output}`) + (result.ok ? '' : '&type=error'));
  });

  /* ------------------------------------------------------------- redirects */
  router.post('/user/redirects/create', (ctx) => {
    const d = domainFor(ctx.user, ctx.body.domain);
    if (!d) return ctx.redirect('/user/redirects?flash=Domain%20not%20found&type=error');
    const to = String(ctx.body.to_url || '').trim();
    if (!/^https?:\/\//i.test(to)) return ctx.redirect('/user/redirects?flash=Target%20must%20start%20with%20http(s)://&type=error');
    run('INSERT INTO redirects(domain_id, username, from_path, to_url, type, created_at) VALUES(?,?,?,?,?,?)',
      d.id, ctx.user.username, String(ctx.body.from_path || '/').trim(), to, String(ctx.body.type || '301'), nowIso());
    return ctx.redirect('/user/redirects?flash=Redirect%20created');
  });

  router.post('/user/redirects/:id/update', (ctx) => {
    const r = get('SELECT * FROM redirects WHERE id = ? AND username = ?', Number(ctx.params.id), ctx.user.username);
    if (!r) return ctx.redirect('/user/redirects?flash=Not%20found&type=error');
    const to = String(ctx.body.to_url || '').trim();
    if (!/^https?:\/\//i.test(to)) return ctx.redirect('/user/redirects?flash=Target%20must%20start%20with%20http(s)://&type=error');
    run('UPDATE redirects SET from_path=?, to_url=?, type=? WHERE id=?', String(ctx.body.from_path || '/'), to, String(ctx.body.type || '301'), r.id);
    audit(ctx.user.username, ctx.user.level, 'redirect.update', `${r.domain_id}:${to}`, ctx.ip);
    return ctx.redirect('/user/redirects?flash=Redirect%20updated');
  });

  router.post('/user/redirects/:id/delete', (ctx) => {
    const r = get('SELECT * FROM redirects WHERE id = ?', Number(ctx.params.id));
    if (r && r.username === ctx.user.username) run('DELETE FROM redirects WHERE id = ?', r.id);
    return ctx.redirect('/user/redirects?flash=Redirect%20deleted');
  });

  /* ---------------------------------------------------------------- pointers */
  router.post('/user/pointers/create', (ctx) => {
    const d = domainFor(ctx.user, ctx.body.domain);
    if (!d) return ctx.redirect('/user/pointers?flash=Domain%20not%20found&type=error');
    const alias = String(ctx.body.alias || '').trim().toLowerCase();
    if (!isDomain(alias)) return ctx.redirect('/user/pointers?flash=Invalid%20pointer%20domain&type=error');
    if (get('SELECT id FROM domains WHERE name = ?', alias)) return ctx.redirect('/user/pointers?flash=That%20domain%20already%20exists&type=error');
    run('INSERT INTO dns_records(domain_id, name, type, value, ttl) VALUES(?,?,?,?,?)', d.id, `pointer-${alias}`, 'POINTER', alias, 3600);
    audit(ctx.user.username, ctx.user.level, 'pointer.create', alias, ctx.ip);
    return ctx.redirect('/user/pointers?flash=' + encodeURIComponent(`Pointer ${alias} → ${d.name} created`));
  });

  router.post('/user/pointers/:id/update', (ctx) => {
    const p = get("SELECT * FROM dns_records WHERE id = ? AND type = 'POINTER'", Number(ctx.params.id));
    const d = p ? domainFor(ctx.user, p.domain_id) : null;
    if (!d) return ctx.redirect('/user/pointers?flash=Not%20found&type=error');
    const alias = String(ctx.body.alias || '').trim().toLowerCase();
    if (!isDomain(alias) || get('SELECT id FROM domains WHERE name = ?', alias)) return ctx.redirect('/user/pointers?flash=Invalid%20or%20existing%20domain&type=error');
    run('UPDATE dns_records SET name=?, value=? WHERE id=?', `pointer-${alias}`, alias, p.id);
    rebuildZone(d.name); apply({ dns: true });
    audit(ctx.user.username, ctx.user.level, 'pointer.update', alias, ctx.ip);
    return ctx.redirect('/user/pointers?flash=Pointer%20updated');
  });

  router.post('/user/pointers/:id/delete', (ctx) => {
    run("DELETE FROM dns_records WHERE id = ? AND type = 'POINTER'", Number(ctx.params.id));
    return ctx.redirect('/user/pointers?flash=Pointer%20removed');
  });
}

export function register(router) {
  router.get('/user/domains', (ctx) => userDomains(ctx));
  router.get('/user/domains/create', (ctx) => domainCreatePage(ctx));

  router.get('/user/subdomains', (ctx) => {
    const domains = visibleDomains(ctx.user);
    const selected = ctx.query.domain || domains[0]?.name;
    const d = domains.find((x) => x.name === selected) || domains[0];
    const rows = d ? all('SELECT * FROM subdomains WHERE domain_id = ? ORDER BY name', d.id) : [];
    const editing = ctx.query.edit ? rows.find((r) => String(r.id) === String(ctx.query.edit)) : null;
    const body = h`
      ${domains.length ? domainSelect(domains, d?.name, { action: '/user/subdomains' }) : alert('Add a domain before creating subdomains.', 'warn')}
      ${listCard({
        title: 'Subdomains', sub: d ? `For ${d.name}` : '',
        columns: [
          { label: 'Subdomain', render: (r) => h`<span class="cell-strong">${r.name}.${d?.name}</span><span class="cell-sub">${r.docroot}</span>` },
          { label: 'PHP', render: (r) => r.php_version || d?.php_version },
          { label: 'Created', render: (r) => formatDate(r.created_at) },
        ],
        rows,
        empty: 'No subdomains for this domain yet.',
        actions: [
          { label: 'Edytuj', href: (r) => `/user/subdomains?domain=${encodeURIComponent(d?.name || '')}&edit=${r.id}`, icon: 'edit' },
          { label: 'Files', href: (r) => `/user/files?path=${encodeURIComponent(r.docroot || '/')}`, icon: 'folder' },
          { label: 'Delete', form: (r) => `/user/subdomains/${r.id}/delete`, confirm: 'Delete this subdomain?', icon: 'trash', danger: true },
        ],
        footer: d ? h`<form method="post" action="/user/subdomains/create" class="inline-form">
          <input type="hidden" name="_csrf" value="${ctx.csrf}"><input type="hidden" name="domain" value="${d.name}">
          <input type="text" name="name" placeholder="blog" required style="max-width:180px">
          <button class="btn btn-primary btn-sm" type="submit">${icon('plus', { size: 14 })} Add subdomain</button>
        </form>` : '',
      })}
      ${editing ? card(`Edytuj subdomenę · ${editing.name}.${d?.name}`, h`<form method="post" action="/user/subdomains/${editing.id}/update" class="oa-form">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <div class="form-grid">
          <div class="field"><label class="field-label">Subdomena</label><input value="${editing.name}.${d?.name}" disabled></div>
          <div class="field"><label class="field-label">PHP</label><select name="php_version">${PHP.map((v) => h`<option ${v === (editing.php_version || d?.php_version) ? 'selected' : ''}>${v}</option>`)}</select></div>
          <div class="field field-full"><label class="field-label">Document root</label><input name="docroot" value="${editing.docroot || ''}"></div>
        </div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Zapisz</button><a class="btn btn-ghost" href="/user/subdomains?domain=${encodeURIComponent(d?.name || '')}">Anuluj</a></div>
      </form>`) : ''}`;
    return page(ctx, { title: 'Subdomains', subtitle: 'Create and manage subdomains on your domains', body });
  });

  router.get('/user/dns', (ctx) => {
    const domains = visibleDomains(ctx.user);
    const selected = ctx.query.domain || domains[0]?.name;
    const d = domains.find((x) => x.name === selected) || domains[0];
    const records = d ? all('SELECT * FROM dns_records WHERE domain_id = ? ORDER BY type, name', d.id) : [];
    const editing = ctx.query.edit ? records.find((r) => String(r.id) === String(ctx.query.edit)) : null;
    const body = h`
      ${!domains.length ? alert('Add a domain first to manage its DNS zone.', 'warn') : ''}
      ${d ? domainSelect(domains, d.name, { action: '/user/dns' }) : ''}
      ${d ? card(`DNS zone · ${d.name}`, h`
        ${alert(`Zone file: <code>${zoneMeta(d.name)?.file || zonePath(d.name)}</code> · ${zoneMeta(d.name)?.checked ? 'validated' : 'not validated yet'}`, 'info')}
        <div class="table-wrap"><table class="data-table">
          <thead><tr><th>Name</th><th>Type</th><th>Value</th><th>Priority</th><th>TTL</th><th class="col-actions">Actions</th></tr></thead>
          <tbody>${records.map((r) => h`<tr>
            <td class="cell-mono">${r.name}</td>
            <td>${badge(r.type, 'brand')}</td>
            <td class="cell-mono truncate" style="max-width:380px">${r.value}</td>
            <td>${r.priority ?? '—'}</td>
            <td>${r.ttl}</td>
            <td class="col-actions"><div class="row-actions">
              <a class="icon-btn" href="/user/dns?domain=${d.name}&edit=${r.id}" title="Edit">${icon('edit', { size: 16 })}</a>
              <form method="post" action="/user/dns/${r.id}/delete" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}">
                <button class="icon-btn danger" type="submit" title="Delete" onclick="return confirm('Delete this record?')">${icon('trash', { size: 16 })}</button></form>
            </div></td>
          </tr>`)}
          </tbody>
        </table></div>`, { padded: false, actions: [h`<form method="post" action="/user/dns/rebuild" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}"><input type="hidden" name="domain" value="${d.name}"><button class="btn btn-secondary btn-sm" type="submit">Rebuild zone</button></form>`] }) : ''}
      ${d && editing ? card(`Edit record · ${editing.type} ${editing.name}`, h`<form method="post" action="/user/dns/${editing.id}/update" class="oa-form">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <div class="form-grid">
          <div class="field"><label class="field-label">Name</label><input name="name" value="${editing.name}" required></div>
          <div class="field"><label class="field-label">Type</label><select name="type">
            ${['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA'].map((t) => h`<option ${t === editing.type ? 'selected' : ''}>${t}</option>`)}
          </select></div>
          <div class="field field-full"><label class="field-label">Value</label><input name="value" value="${editing.value}" required></div>
          <div class="field"><label class="field-label">Priority</label><input name="priority" type="number" value="${editing.priority ?? ''}"></div>
          <div class="field"><label class="field-label">TTL</label><input name="ttl" type="number" value="${editing.ttl}"></div>
        </div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Save record</button><a class="btn btn-ghost" href="/user/dns?domain=${d.name}">Cancel</a></div>
      </form>`) : ''}
      ${d ? card('Add DNS record', h`<form method="post" action="/user/dns/add" class="oa-form">
        <input type="hidden" name="_csrf" value="${ctx.csrf}"><input type="hidden" name="domain" value="${d.name}">
        <div class="form-grid">
          <div class="field"><label class="field-label">Name</label><input name="name" value="@" placeholder="@ or www"></div>
          <div class="field"><label class="field-label">Type</label><select name="type">
            ${['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA'].map((t) => h`<option>${t}</option>`)}
          </select></div>
          <div class="field field-full"><label class="field-label">Value</label><input name="value" placeholder="192.0.2.1 or target.example.com." required></div>
          <div class="field"><label class="field-label">Priority (MX/SRV)</label><input name="priority" type="number" min="0" max="65535"></div>
          <div class="field"><label class="field-label">TTL</label><input name="ttl" type="number" value="3600" min="60"></div>
        </div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">${icon('plus', { size: 16 })} Add record</button></div>
      </form>`) : ''}`;
    return page(ctx, { title: 'DNS Management', subtitle: d ? `Zone file for ${d.name}` : 'Manage DNS records', body });
  });

  router.get('/user/pointers', (ctx) => {
    const domains = visibleDomains(ctx.user);
    const pointers = all(`SELECT r.*, d.name domain FROM dns_records r JOIN domains d ON d.id = r.domain_id
                          WHERE r.type = 'POINTER' AND d.user_id = ? ORDER BY r.value`, ctx.user.id);
    const editing = ctx.query.edit ? pointers.find((r) => String(r.id) === String(ctx.query.edit)) : null;
    const body = h`
      ${alert('A domain pointer makes an additional domain serve the same content as an existing domain. Add the pointer, then create an A record for it in its own DNS zone.', 'info')}
      ${listCard({
        title: 'Domain pointers', sub: `${pointers.length} pointer(s)`,
        columns: [
          { label: 'Pointer domain', render: (r) => h`<span class="cell-strong">${r.value}</span>` },
          { label: 'Points to', render: (r) => r.domain },
          { label: 'Created', render: (r) => formatDate(r.created_at) },
        ],
        rows: pointers,
        empty: 'No domain pointers yet.',
        actions: [
          { label: 'Edytuj', href: (r) => `/user/pointers?edit=${r.id}`, icon: 'edit' },
          { label: 'Remove', form: (r) => `/user/pointers/${r.id}/delete`, confirm: 'Remove this pointer?', icon: 'trash', danger: true },
        ],
        footer: h`<form method="post" action="/user/pointers/create" class="inline-form" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <input type="hidden" name="_csrf" value="${ctx.csrf}">
          <select name="domain" style="width:220px">${domains.map((d) => h`<option value="${d.name}">${d.name}</option>`)}</select>
          <input type="text" name="alias" placeholder="alias-domain.com" style="max-width:240px">
          <button class="btn btn-primary btn-sm" type="submit">${icon('plus', { size: 14 })} Add pointer</button>
        </form>`,
      })}
      ${editing ? card(`Edytuj pointer · ${editing.value}`, h`<form method="post" action="/user/pointers/${editing.id}/update" class="oa-form">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <div class="form-grid"><div class="field field-full"><label class="field-label">Nowa domena wskaźnika</label><input name="alias" value="${editing.value}" required></div></div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Zapisz</button><a class="btn btn-ghost" href="/user/pointers">Anuluj</a></div>
      </form>`) : ''}`;
    return page(ctx, { title: 'Domain Pointers', subtitle: 'Alias extra domains to content you already host', body });
  });

  router.get('/user/redirects', (ctx) => {
    const rows = all('SELECT r.*, d.name domain FROM redirects r JOIN domains d ON d.id = r.domain_id WHERE r.username = ? ORDER BY r.created_at DESC', ctx.user.username);
    const editing = ctx.query.edit ? rows.find((r) => String(r.id) === String(ctx.query.edit)) : null;
    const domains = visibleDomains(ctx.user);
    const body = h`
      ${listCard({
        title: 'Site redirects', sub: 'HTTP redirects mapped to your domains',
        columns: [
          { label: 'From', render: (r) => h`<span class="cell-mono">${r.domain}${r.from_path}</span>` },
          { label: 'To', render: (r) => h`<span class="cell-mono">${r.to_url}</span>` },
          { label: 'Type', render: (r) => badge(r.type, 'brand') },
          { label: 'Created', render: (r) => formatDate(r.created_at) },
        ],
        rows,
        empty: 'No redirects configured.',
        actions: [
          { label: 'Edytuj', href: (r) => `/user/redirects?edit=${r.id}`, icon: 'edit' },
          { label: 'Delete', form: (r) => `/user/redirects/${r.id}/delete`, confirm: 'Delete redirect?', icon: 'trash', danger: true },
        ],
        footer: h`<form method="post" action="/user/redirects/create" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <input type="hidden" name="_csrf" value="${ctx.csrf}">
          <select name="domain" style="width:200px">${domains.map((d) => h`<option value="${d.name}">${d.name}</option>`)}</select>
          <input name="from_path" placeholder="/old-page" style="max-width:150px">
          <input name="to_url" placeholder="https://example.com/new-page" style="max-width:280px">
          <select name="type" style="width:90px"><option>301</option><option>302</option></select>
          <button class="btn btn-primary btn-sm" type="submit">${icon('plus', { size: 14 })} Add redirect</button>
        </form>`,
      })}
      ${editing ? card(`Edytuj przekierowanie · ${editing.domain}${editing.from_path}`, h`<form method="post" action="/user/redirects/${editing.id}/update" class="oa-form">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <div class="form-grid">
          <div class="field"><label class="field-label">Od</label><input name="from_path" value="${editing.from_path}" required></div>
          <div class="field"><label class="field-label">Do URL</label><input name="to_url" value="${editing.to_url}" required></div>
          <div class="field"><label class="field-label">Typ</label><select name="type">${['301','302'].map((x) => h`<option ${x === editing.type ? 'selected' : ''}>${x}</option>`)}</select></div>
        </div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Zapisz</button><a class="btn btn-ghost" href="/user/redirects">Anuluj</a></div>
      </form>`) : ''}`;
    return page(ctx, { title: 'Site Redirects', subtitle: 'Redirect requests to another URL', body });
  });

  // Register POST handlers from the shared module.
  registerDomainsPost(router);
  void e; void tabs; void toolbar; void pageHead; void statusBadge; void form; void table;
}
