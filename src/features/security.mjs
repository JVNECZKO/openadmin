import fs from 'node:fs';
// SSL/TLS certificates, password changes, login keys and SSH keys.
import crypto from 'node:crypto';
import { all, get, run, nowIso, hashPassword, verifyPassword, audit, setting } from '../db.mjs';
import { destroyUserSessions, activeSessions, reissueSession } from '../auth.mjs';
import { html as h, formatDate, randomPassword } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, table, btn, badge, alert, emptyState, kvList, tabs } from '../ui/components.mjs';
import { icon } from '../ui/icons.mjs';
import { listCard } from '../ui/pages/list.mjs';
import { visibleDomains, domainFor } from '../core/access.mjs';
import { issueLetsEncrypt, generateSelfSigned, installPem, certPaths, sslStatus, certbotAvailable } from '../ssl.mjs';
import { validate } from '../webserver.mjs';
import { apply } from '../apply.mjs';
import { systemProvider } from '../providers/index.mjs';
import { passwordPolicyError } from '../security.mjs';

function daysUntil(iso) {
  if (!iso) return null;
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 864e5);
}

export function register(router) {
  /* ------------------------------------------------------------------ SSL */
  router.get('/user/ssl', (ctx) => {
    const domains = visibleDomains(ctx.user);
    const name = ctx.query.domain || domains[0]?.name;
    const d = domains.find((x) => x.name === name) || domains[0];
    const certs = d ? all('SELECT * FROM ssl_certs WHERE domain = ? ORDER BY created_at DESC', d.name) : [];
    const active = certs.find((c) => c.status === 'active');
    const tabsHtml = h`<div class="tabs">
      <a class="tab active" href="/user/ssl">Certificates</a>
      <a class="tab" href="/user/ssl?tab=acme${d ? '&domain=' + d.name : ''}">ACME / Let's Encrypt</a>
      <a class="tab" href="/user/ssl?tab=upload${d ? '&domain=' + d.name : ''}">Upload certificate</a>
    </div>`;
    const tab = ctx.query.tab || 'certificates';
    const status = sslStatus();
    const body = h`
      ${tabsHtml}
      ${alert(`OpenSSL ${status.openssl ? 'available' : 'missing'} · certbot ${status.certbot ? 'available' : 'not installed (ACME issuance unavailable)'} · certificates in <code>${status.directory}</code>`, status.certbot ? 'info' : 'warn')}
      ${domains.length ? h`<div class="toolbar"><form method="get" action="/user/ssl" class="row">
        <input type="hidden" name="tab" value="${tab}">
        <label class="field-label u-s11" for="sslDomain">Domain</label>
        <select class="u-s15" id="sslDomain" name="domain" data-domain-select>${domains.map((x) => h`<option value="${x.name}" ${x.name === d?.name ? 'selected' : ''}>${x.name}</option>`)}</select>
        <noscript><button class="btn btn-secondary btn-sm">Switch</button></noscript></form></div>` : ''}
      ${!domains.length ? alert('Add a domain before installing certificates.', 'warn') : ''}

      ${tab === 'certificates' ? h`
        ${active ? card('Current certificate', h`
          <div class="grid grid-2">
            ${kvList([
              ['Domain', active.domain],
              ['Issuer', active.issuer || '—'],
              ['Type', active.type],
              ['Valid until', formatDate(active.expires_at)],
              ['Expires in', daysUntil(active.expires_at) !== null ? `${daysUntil(active.expires_at)} days` : '—'],
              ['Status', badge(active.status, 'ok')],
            ])}
            <div>
              <p class="small muted">Certificate fingerprint</p>
              <pre class="code-block small">${active.cert ? String(active.cert).slice(0, 40) + '…' : 'SHA256: ' + crypto.createHash('sha256').update(active.domain + active.created_at).digest('hex').slice(0, 40)}</pre>
              <form class="u-s27" method="post" action="/user/ssl/renew"><input type="hidden" name="_csrf" value="${ctx.csrf}">
                <input type="hidden" name="domain" value="${d.name}">
                <button class="btn btn-secondary btn-sm" type="submit">${icon('refresh', { size: 14 })} Force renewal</button></form>
            </div>
          </div>`) : alert('No certificate installed for this domain. Issue a free Let\'s Encrypt certificate below.', 'info')}
        ${card('Issue free certificate', h`
          <p class="small muted mb-18">Let's Encrypt certificates are free, valid for 90 days and renew automatically. Domain validation uses HTTP-01.</p>
          <form method="post" action="/user/ssl/issue" class="row">
            <input type="hidden" name="_csrf" value="${ctx.csrf}"><input type="hidden" name="domain" value="${d?.name || ''}">
            <label class="check-field"><input type="checkbox" name="www" value="1" checked> <span>Include www.${d?.name || ''}</span></label>
            <label class="check-field"><input type="checkbox" name="force" value="1"> <span>Force reissue</span></label>
            <button class="btn btn-primary" type="submit" ${!d ? 'disabled' : ''}>${icon('lock', { size: 16 })} Issue certificate</button>
          </form>`)}
        ${listCard({
          title: 'Certificate history', sub: `${certs.length} certificate(s)`,
          columns: [
            { label: 'Domain', key: 'domain' },
            { label: 'Type', render: (r) => badge(r.type, 'brand') },
            { label: 'Issuer', render: (r) => r.issuer || '—' },
            { label: 'Expires', render: (r) => h`${formatDate(r.expires_at)} ${daysUntil(r.expires_at) !== null && daysUntil(r.expires_at) < 14 ? badge('renew soon', 'warn') : ''}` },
            { label: 'Status', render: (r) => badge(r.status, r.status === 'active' ? 'ok' : 'muted') },
          ],
          rows: certs, empty: 'No certificates yet.',
          actions: [{ label: 'Delete', form: (r) => `/user/ssl/${r.id}/delete`, confirm: 'Delete certificate?', icon: 'trash', danger: true }],
        })}` : ''}

      ${tab === 'acme' ? card("ACME / Let's Encrypt settings", h`
        <form method="post" action="/user/ssl/acme" class="oa-form">
          <input type="hidden" name="_csrf" value="${ctx.csrf}"><input type="hidden" name="domain" value="${d?.name || ''}">
          <div class="form-grid">
            <div class="field"><label class="field-label">Challenge type</label><select name="challenge"><option value="http-01">HTTP-01 (port 80)</option><option value="dns-01">DNS-01</option><option value="tls-alpn-01">TLS-ALPN-01</option></select></div>
            <div class="field"><label class="field-label">Key type</label><select name="key_type"><option value="ec-256">ECDSA P-256</option><option value="rsa-2048">RSA 2048</option><option value="rsa-4096">RSA 4096</option></select></div>
            <div class="field"><label class="field-label">Contact email</label><input name="email" type="email" value="${ctx.user.email || ''}"></div>
            <div class="field"><label class="field-label">Auto-renew</label><select name="autorenew"><option value="1">Enabled</option><option value="0">Disabled</option></select></div>
          </div>
          <div class="form-actions"><button class="btn btn-primary" type="submit">Save ACME settings</button></div>
        </form>`) : ''}

      ${tab === 'upload' ? card('Install a certificate', h`
        <form method="post" action="/user/ssl/upload" class="oa-form">
          <input type="hidden" name="_csrf" value="${ctx.csrf}"><input type="hidden" name="domain" value="${d?.name || ''}">
          <div class="form-grid">
            <div class="field field-full"><label class="field-label">Certificate (PEM) <span class="req">*</span></label><textarea name="cert" rows="8" required placeholder="-----BEGIN CERTIFICATE-----"></textarea></div>
            <div class="field field-full"><label class="field-label">Private key (PEM) <span class="req">*</span></label><textarea name="key" rows="8" required placeholder="-----BEGIN PRIVATE KEY-----"></textarea></div>
            <div class="field field-full"><label class="field-label">CA bundle (optional)</label><textarea name="ca" rows="4" placeholder="-----BEGIN CERTIFICATE-----"></textarea></div>
          </div>
          <div class="form-actions"><button class="btn btn-primary" type="submit" ${!d ? 'disabled' : ''}>${icon('upload', { size: 16 })} Install certificate</button></div>
        </form>`) : ''}

      ${tab === 'certificates' ? card('Create self-signed certificate', h`
        <form method="post" action="/user/ssl/self-signed" class="row">
          <input type="hidden" name="_csrf" value="${ctx.csrf}"><input type="hidden" name="domain" value="${d?.name || ''}">
          <input class="u-s28" name="common_name" placeholder="Common name (CN)" value="${d?.name || ''}">
          <input class="u-s29" name="days" type="number" value="365">
          <button class="btn btn-secondary" type="submit">Create self-signed</button>
        </form>`, { sub: 'Useful for internal or staging hostnames' }) : ''}`;
    return page(ctx, { title: 'SSL/TLS Certificates', subtitle: d ? `Secure ${d.name} with HTTPS` : 'Manage HTTPS certificates', body });
  });

  router.post('/user/ssl/issue', (ctx) => {
    const d = domainFor(ctx.user, ctx.body.domain);
    if (!d) return ctx.redirect('/user/ssl?flash=Domain%20not%20found&type=error');
    const result = issueLetsEncrypt(d.name, d.docroot, ctx.user.email || '');
    if (!result.ok) return ctx.redirect('/user/ssl?domain=' + encodeURIComponent(d.name) + '&flash=' + encodeURIComponent(result.error) + '&type=error');
    apply({ web: true });
    audit(ctx.user.username, ctx.user.level, 'ssl.issue', d.name, ctx.ip);
    return ctx.redirect('/user/ssl?domain=' + encodeURIComponent(d.name) + '&flash=' + encodeURIComponent(`Certificate issued for ${d.name}`));
  });

  router.post('/user/ssl/renew', (ctx) => {
    const d = domainFor(ctx.user, ctx.body.domain);
    if (!d) return ctx.redirect('/user/ssl?flash=Domain%20not%20found&type=error');
    const current = get("SELECT * FROM ssl_certs WHERE domain = ? AND status = 'active' ORDER BY id DESC LIMIT 1", d.name);
    let result;
    if (current?.type === 'letsencrypt') result = issueLetsEncrypt(d.name, d.docroot, ctx.user.email || '');
    else result = generateSelfSigned(d.name, 365);
    if (!result.ok) return ctx.redirect('/user/ssl?domain=' + encodeURIComponent(d.name) + '&flash=' + encodeURIComponent(result.error) + '&type=error');
    apply({ web: true });
    audit(ctx.user.username, ctx.user.level, 'ssl.renew', d.name, ctx.ip);
    return ctx.redirect('/user/ssl?domain=' + encodeURIComponent(d.name) + '&flash=Certificate%20renewed');
  });

  router.post('/user/ssl/upload', (ctx) => {
    const d = domainFor(ctx.user, ctx.body.domain);
    if (!d) return ctx.redirect('/user/ssl?flash=Domain%20not%20found&type=error');
    const cert = String(ctx.body.cert || '').trim();
    const key = String(ctx.body.key || '').trim();
    if (!cert.includes('BEGIN CERTIFICATE') || !key.includes('PRIVATE KEY')) {
      return ctx.redirect('/user/ssl?domain=' + encodeURIComponent(d.name) + '&flash=' + encodeURIComponent('Certificate and key must be PEM encoded') + '&type=error');
    }
    const result = installPem(d.name, cert, key, 'custom');
    if (!result.ok) return ctx.redirect('/user/ssl?domain=' + encodeURIComponent(d.name) + '&flash=' + encodeURIComponent(result.error) + '&type=error');
    run('UPDATE ssl_certs SET username = ? WHERE domain = ? AND username IS NULL', ctx.user.username, d.name);
    apply({ web: true });
    audit(ctx.user.username, ctx.user.level, 'ssl.upload', d.name, ctx.ip);
    return ctx.redirect('/user/ssl?domain=' + encodeURIComponent(d.name) + '&flash=Certificate%20installed');
  });

  router.post('/user/ssl/self-signed', (ctx) => {
    const d = domainFor(ctx.user, ctx.body.domain);
    if (!d) return ctx.redirect('/user/ssl?flash=Domain%20not%20found&type=error');
    const result = generateSelfSigned(d.name, Number(ctx.body.days) || 365);
    if (!result.ok) return ctx.redirect('/user/ssl?domain=' + encodeURIComponent(d.name) + '&flash=' + encodeURIComponent(result.error) + '&type=error');
    run('UPDATE ssl_certs SET username = ? WHERE domain = ? AND username IS NULL', ctx.user.username, d.name);
    apply({ web: true });
    audit(ctx.user.username, ctx.user.level, 'ssl.selfsigned', d.name, ctx.ip);
    return ctx.redirect('/user/ssl?domain=' + encodeURIComponent(d.name) + '&flash=' + encodeURIComponent(`Self-signed certificate created (valid until ${new Date(result.expiresAt).toLocaleDateString('en-GB')})`));
  });

  router.post('/user/ssl/:id/delete', (ctx) => {
    const c = get('SELECT * FROM ssl_certs WHERE id = ?', Number(ctx.params.id));
    if (c && (c.username === ctx.user.username || c.domain === ctx.user.domain)) {
      run('DELETE FROM ssl_certs WHERE id = ?', c.id);
      const paths = certPaths(c.domain);
      try { fs.rmSync(paths.dir, { recursive: true, force: true }); } catch { /* ignore */ }
      run('UPDATE domains SET ssl = 0 WHERE name = ?', c.domain);
      apply({ web: true });
    }
    return ctx.redirect('/user/ssl?domain=' + encodeURIComponent(c?.domain || '') + '&flash=Certificate%20deleted');
  });

  router.post('/user/ssl/acme', (ctx) => {
    run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      `acme_${ctx.user.username}`, JSON.stringify(ctx.body));
    return ctx.redirect('/user/ssl?domain=' + encodeURIComponent(ctx.body.domain || '') + '&flash=ACME%20settings%20saved');
  });

  /* ------------------------------------------------------------- password */
  router.get('/user/password', (ctx) => {
    const body = h`${ctx.query.force || ctx.user.must_change_password ? alert('Your password was set by an administrator. Please choose a new one now.', 'warn') : ''}
      <div class="grid grid-2">
        ${card('Change password', h`<form method="post" action="/user/password" class="oa-form">
          <input type="hidden" name="_csrf" value="${ctx.csrf}">
          <div class="form-grid">
            <div class="field field-full"><label class="field-label">Current password</label><input name="current" type="password" required autocomplete="current-password"></div>
            <div class="field"><label class="field-label">New password</label>
              <div class="field-control"><input id="newpass" name="password" type="password" required minlength="8"><button class="btn btn-secondary btn-sm u-s18" type="button" data-genpass="#newpass">Generate</button></div>
              <p class="field-help">At least 8 characters. Use a password manager.</p></div>
            <div class="field"><label class="field-label">Confirm new password</label><input name="confirm" type="password" required minlength="8"></div>
            <div class="field field-full"><label class="check-field"><input type="checkbox" name="signout" value="1" checked> <span>Sign out all other sessions</span></label></div>
          </div>
          <div class="form-actions"><button class="btn btn-primary" type="submit">${icon('key', { size: 16 })} Update password</button></div>
        </form>`)}
        ${card('Account security', h`${kvList([
          ['Username', ctx.user.username],
          ['Email', ctx.user.email || '—'],
          ['Last login', formatDate(ctx.user.last_login, { time: true })],
          ['Last IP', ctx.user.last_ip || '—'],
          ['Active sessions', String(activeSessions(ctx.user.id).length)],
          ['Two-factor auth', badge('Not configured', 'muted')],
        ])}
        <p class="small muted mt-18">Two-factor authentication can be enforced server-wide from Admin → Server Settings.</p>`)}
      </div>
      ${card('Active sessions', h`${table({
        columns: [
          { label: 'IP address', key: 'ip' },
          { label: 'Started', render: (r) => formatDate(r.created_at, { time: true }) },
          { label: 'Expires', render: (r) => formatDate(r.expires_at, { time: true }) },
          { label: 'User agent', render: (r) => h`<span class="truncate small u-s30">${r.ua || '—'}</span>` },
        ],
        rows: activeSessions(ctx.user.id), empty: 'No active sessions.',
      })}`)}`;
    return page(ctx, { title: 'Password', subtitle: 'Update your panel credentials', body });
  });

  router.post('/user/password', (ctx) => {
    const current = String(ctx.body.current || '');
    const next = String(ctx.body.password || '');
    if (!verifyPassword(current, ctx.user.password)) return ctx.redirect('/user/password?flash=Current%20password%20is%20incorrect&type=error');
    const policyError = passwordPolicyError(next);
    if (policyError) return ctx.redirect('/user/password?flash=' + encodeURIComponent(policyError) + '&type=error');
    if (next !== String(ctx.body.confirm || '')) return ctx.redirect('/user/password?flash=Passwords%20do%20not%20match&type=error');
    run('UPDATE users SET password = ?, must_change_password = 0 WHERE id = ?', hashPassword(next), ctx.user.id);
    if (ctx.body.signout) destroyUserSessions(ctx.user.id);
    else reissueSession(ctx);
    audit(ctx.user.username, ctx.user.level, 'password.change', '', ctx.ip);
    return ctx.redirect('/user/password?flash=Password%20updated');
  });

  /* ------------------------------------------------------------ login keys */
  router.get('/user/login-keys', (ctx) => {
    const rows = all('SELECT * FROM login_keys WHERE user_id = ? ORDER BY created_at DESC', ctx.user.id);
    const fresh = ctx.query.created;
    const body = h`
      ${fresh ? alert(h`<strong>Copy your new login key now.</strong><br>Key ID: <code>${fresh}</code> — the secret is only shown once and cannot be recovered.`, 'warn') : ''}
      ${alert('Login keys let scripts authenticate to the API without storing your password. They can be limited by command and expiry.', 'info')}
      ${listCard({
        title: 'Login keys', sub: `${rows.length} active key(s)`,
        columns: [
          { label: 'Key ID', render: (r) => h`<span class="cell-mono">${r.key_id}</span>` },
          { label: 'Expires', render: (r) => (r.expires_at ? formatDate(r.expires_at) : 'Never') },
          { label: 'Commands', render: (r) => h`<span class="small">${r.commands || 'All commands'}</span>` },
          { label: 'Last used', render: (r) => (r.last_used ? formatDate(r.last_used, { time: true }) : 'Never') },
        ],
        rows, empty: 'No login keys yet.',
        actions: [{ label: 'Revoke', form: (r) => `/user/login-keys/${r.id}/delete`, confirm: 'Revoke this key?', icon: 'trash', danger: true }],
        footer: h`<form class="u-s31" method="post" action="/user/login-keys/create">
          <input type="hidden" name="_csrf" value="${ctx.csrf}">
          <input class="u-s32" name="name" placeholder="deploy-script">
          <select name="days"><option value="30">30 days</option><option value="90" selected>90 days</option><option value="365">1 year</option><option value="0">Never expires</option></select>
          <input class="u-s33" name="commands" placeholder="CMD_API_DOMAIN,CMD_API_POP">
          <button class="btn btn-primary btn-sm" type="submit">${icon('plus', { size: 14 })} Create key</button>
        </form>`,
      })}
      ${card('Using login keys', h`<pre class="code-block">curl -u "${ctx.user.username}:KEY_ID:SECRET" \\
  http://${setting('server_name', 'localhost')}:${setting('panel_port', '2222')}/CMD_API_DOMAIN</pre>`)}`;
    return page(ctx, { title: 'Login Keys', subtitle: 'API credentials for automation', body });
  });

  router.post('/user/login-keys/create', (ctx) => {
    const keyId = crypto.randomBytes(6).toString('hex');
    const secret = crypto.randomBytes(24).toString('base64url');
    const days = Number(ctx.body.days) || 0;
    run('INSERT INTO login_keys(user_id, key_id, secret, expires_at, commands, created_at) VALUES(?,?,?,?,?,?)',
      ctx.user.id, keyId, hashPassword(secret), days ? new Date(Date.now() + days * 864e5).toISOString() : null,
      String(ctx.body.commands || '').trim(), nowIso());
    audit(ctx.user.username, ctx.user.level, 'loginkey.create', keyId, ctx.ip);
    const body = h`${card('Login key created', h`
      ${alert('This secret is shown only once. Store it in your deployment tool now.', 'warn')}
      ${kvList([['Key ID', h`<code>${keyId}</code>`], ['Secret', h`<code>${secret}</code>`], ['Expires', days ? formatDate(new Date(Date.now() + days * 864e5)) : 'Never'], ['Username', ctx.user.username]])}
      <div class="row mt-18">${btn('Done', { href: '/user/login-keys' })}</div>`)}`;
    return page(ctx, { title: 'Login Key Created', subtitle: 'Copy the secret now', body });
  });

  router.post('/user/login-keys/:id/delete', (ctx) => {
    run('DELETE FROM login_keys WHERE id = ? AND user_id = ?', Number(ctx.params.id), ctx.user.id);
    return ctx.redirect('/user/login-keys?flash=Login%20key%20revoked');
  });

  /* -------------------------------------------------------------- SSH keys */
  router.get('/user/ssh-keys', (ctx) => {
    const rows = all('SELECT * FROM ssh_keys WHERE user_id = ? ORDER BY created_at DESC', ctx.user.id);
    const body = h`${listCard({
      title: 'SSH keys', sub: 'Public keys authorized for shell access',
      columns: [
        { label: 'Name', key: 'name' },
        { label: 'Fingerprint', render: (r) => h`<span class="cell-mono">${r.fingerprint || '—'}</span>` },
        { label: 'Added', render: (r) => formatDate(r.created_at) },
      ],
      rows, empty: 'No SSH keys added.',
      actions: [{ label: 'Delete', form: (r) => `/user/ssh-keys/${r.id}/delete`, confirm: 'Remove this key?', icon: 'trash', danger: true }],
      footer: h`<form class="u-s31" method="post" action="/user/ssh-keys/create">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <input class="u-s34" name="name" placeholder="laptop">
        <input class="u-s35" name="public_key" placeholder="ssh-ed25519 AAAAC3… user@host">
        <button class="btn btn-primary btn-sm" type="submit">${icon('plus', { size: 14 })} Add key</button>
      </form>`,
    })}${card('Shell access', h`<p class="small muted">Shell access is <strong>${ctx.caps.ssh ? 'enabled' : 'disabled'}</strong> for your account. Use SSH at <code>${ctx.user.username}@${setting('server_name', 'localhost')}</code> on port 22.</p>`)}`;
    return page(ctx, { title: 'SSH Keys', subtitle: 'Manage authorized public keys', body });
  });

  router.post('/user/ssh-keys/create', (ctx) => {
    const key = String(ctx.body.public_key || '').trim();
    if (!/^(ssh-|ecdsa-)/.test(key)) return ctx.redirect('/user/ssh-keys?flash=Invalid%20public%20key&type=error');
    const fp = 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').slice(0, 43).replace(/=+$/, '');
    const installed = systemProvider().installSshKey(ctx.user.username, key);
    if (!installed.ok) return ctx.redirect('/user/ssh-keys?flash=' + encodeURIComponent(installed.output) + '&type=error');
    run('INSERT INTO ssh_keys(user_id, name, public_key, fingerprint, created_at) VALUES(?,?,?,?,?)',
      ctx.user.id, String(ctx.body.name || 'key'), key, fp, nowIso());
    return ctx.redirect('/user/ssh-keys?flash=SSH%20key%20added');
  });

  router.post('/user/ssh-keys/:id/delete', (ctx) => {
    const row = get('SELECT * FROM ssh_keys WHERE id = ? AND user_id = ?', Number(ctx.params.id), ctx.user.id);
    if (row) systemProvider().removeSshKey(ctx.user.username, row.public_key);
    run('DELETE FROM ssh_keys WHERE id = ? AND user_id = ?', Number(ctx.params.id), ctx.user.id);
    return ctx.redirect('/user/ssh-keys?flash=SSH%20key%20removed');
  });

  void randomPassword; void tabs; void emptyState; void card;
}
