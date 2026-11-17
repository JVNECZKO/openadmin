// Email management: mailboxes, forwarders, autoresponders, vacations,
// catch-all, mailing lists, spam filters and usage reporting.
import { all, get, run, nowIso, hashPassword, audit, setting } from '../db.mjs';
import { limitsFor } from '../auth.mjs';
import { html as h, raw, isEmail, formatBytes, formatDate, randomPassword } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, table, btn, badge, alert, emptyState, kvList, progress } from '../ui/components.mjs';
import { icon } from '../ui/icons.mjs';
import { domainSelect, listCard } from '../ui/pages/list.mjs';
import { quota, visibleDomains, domainFor } from '../core/access.mjs';
import { dovecotHash, syncMail } from '../mail.mjs';
import { apply } from '../apply.mjs';
import { dkimStatus, generateDkim, deployDkim } from '../dkim.mjs';
import { systemProvider } from '../providers/index.mjs';
import { runHooks } from '../plugins.mjs';
import { qrSvg } from '../qr.mjs';
import net from 'node:net';

const MAIL_DOMAIN = (ctx, name) => domainFor(ctx.user, name) || visibleDomains(ctx.user)[0];

function mailNav(ctx, active) {
  return h`<div class="tabs">
    <a class="tab ${active === 'accounts' ? 'active' : ''}" href="/user/email">Email accounts</a>
    <a class="tab ${active === 'forwarders' ? 'active' : ''}" href="/user/email/forwarders">Forwarders</a>
    <a class="tab ${active === 'autoresponders' ? 'active' : ''}" href="/user/email/autoresponders">Autoresponders</a>
    <a class="tab ${active === 'vacation' ? 'active' : ''}" href="/user/email/vacation">Vacation messages</a>
    <a class="tab ${active === 'catchall' ? 'active' : ''}" href="/user/email/catch-all">Catch-all</a>
    <a class="tab ${active === 'lists' ? 'active' : ''}" href="/user/email/lists">Mailing lists</a>
    <a class="tab ${active === 'spam' ? 'active' : ''}" href="/user/email/spam">Spam filters</a>
    <a class="tab ${active === 'usage' ? 'active' : ''}" href="/user/email/usage">Usage</a>
    <a class="tab ${active === 'setup' ? 'active' : ''}" href="/user/email/setup">Setup guide</a>
  </div>`;
}

export function register(router) {
  /* ------------------------------------------------------------ accounts */
  router.get('/user/email', (ctx) => {
    const domains = visibleDomains(ctx.user);
    const selected = ctx.query.domain || domains[0]?.name;
    const d = domains.find((x) => x.name === selected) || domains[0];
    const rows = d ? all('SELECT * FROM email_accounts WHERE domain_id = ? ORDER BY local_part', d.id) : [];
    const editing = ctx.query.edit ? get('SELECT * FROM email_accounts WHERE id = ?', Number(ctx.query.edit)) : null;
    const canEdit = editing && domainFor(ctx.user, editing.domain_id) ? editing : null;
    const lim = limitsFor(ctx.user);
    const totalUsed = get('SELECT COALESCE(SUM(used_mb),0) u FROM email_accounts WHERE domain IN (SELECT name FROM domains WHERE user_id = ?)', ctx.user.id).u;
    const body = h`
      ${mailNav(ctx, 'accounts')}
      ${domains.length ? domainSelect(domains, d?.name, { action: '/user/email' }) : alert('Add a domain before creating mailboxes.', 'warn')}
      ${listCard({
        title: 'Skrzynki e-mail', sub: `${rows.length} ${rows.length === 1 ? 'skrzynka' : 'skrzynek'} na ${d?.name || '—'} · ${formatBytes(totalUsed)} zajęte${lim.emails ? ` · limit ${lim.emails}` : ''}`,
        columns: [
          { label: 'Skrzynka', dataLabel: 'Skrzynka', render: (r) => h`<span class="cell-strong">${r.local_part}@${r.domain}</span><span class="cell-sub">${r.suspended ? 'Zawieszona' : 'Aktywna'}</span>` },
          { label: 'Limit', dataLabel: 'Limit', render: (r) => h`<div class="u-s67">${progress(r.used_mb, r.quota_mb || 1, { showText: false })}<span class="cell-sub">${formatBytes(r.used_mb)} / ${r.quota_mb ? formatBytes(r.quota_mb) : 'bez limitu'}</span></div>` },
          { label: 'Utworzono', dataLabel: 'Utworzono', render: (r) => formatDate(r.created_at) },
        ],
        rows,
        createHref: d ? `/user/email/create?domain=${d.name}` : null,
        createLabel: 'Utwórz skrzynkę',
        empty: 'Brak skrzynek na tej domenie.',
        responsive: true,
        actionsMenu: true,
        actions: [
          { label: 'Edytuj', href: (r) => `/user/email?domain=${encodeURIComponent(r.domain)}&edit=${r.id}`, icon: 'edit' },
          { label: 'Webmail', href: (r) => `/webmail?email=${encodeURIComponent(r.local_part + '@' + r.domain)}`, icon: 'mail' },
          { label: 'Ustawienia klienta', href: (r) => `/user/email/${r.id}/setup`, icon: 'settings' },
          { label: (r) => r.suspended ? 'Wznów' : 'Zawieś', form: (r) => `/user/email/${r.id}/toggle`, icon: 'lock' },
          { label: 'Usuń', form: (r) => `/user/email/${r.id}/delete`, confirm: 'Usunąć skrzynkę i wszystkie jej wiadomości?', icon: 'trash', danger: true },
        ],
        footer: h`<div class="row"><span class="small muted">${icon('info', { size: 14 })} Skrzynki używają tych samych zasad haseł co konta panelu. Webmail: <a class="link" href="/webmail">/webmail</a></span></div>`,
      })}
      ${canEdit ? card(`Edit mailbox · ${canEdit.local_part}@${canEdit.domain}`, h`<form method="post" action="/user/email/${canEdit.id}/update" class="oa-form">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <div class="form-grid">
          <div class="field"><label class="field-label">Mailbox</label><input value="${canEdit.local_part}@${canEdit.domain}" disabled></div>
          <div class="field"><label class="field-label">New password (leave blank to keep)</label><input name="password" type="password" minlength="8"></div>
          <div class="field"><label class="field-label">Quota (MB)</label><input name="quota_mb" type="number" min="0" value="${canEdit.quota_mb}"><p class="field-help">0 = unlimited.</p></div>
        </div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Save mailbox</button><a class="btn btn-ghost" href="/user/email?domain=${encodeURIComponent(canEdit.domain)}">Cancel</a></div>
      </form>`) : ''}`;
    return page(ctx, { title: 'Skrzynki e-mail', subtitle: 'Twórz skrzynki POP3/IMAP i zarządzaj nimi', body });
  });

  router.get('/user/email/create', (ctx) => {
    const domains = visibleDomains(ctx.user);
    const d = MAIL_DOMAIN(ctx, ctx.query.domain);
    const q = quota(ctx.user, 'emails');
    const body = h`
      ${mailNav(ctx, 'accounts')}
      ${!q.ok ? alert(`Mailbox limit reached (${q.used}/${q.limit}).`, 'warn') : ''}
      ${card('Create mailbox', h`<form method="post" action="/user/email/create" class="oa-form">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <div class="form-grid">
          <div class="field"><label class="field-label">Domain</label>
            <select name="domain">${domains.map((x) => h`<option value="${x.name}" ${x.name === d?.name ? 'selected' : ''}>${x.name}</option>`)}</select></div>
          <div class="field"><label class="field-label" for="local">Mailbox name <span class="req">*</span></label>
            <div class="field-control"><input id="local" name="local_part" type="text" placeholder="info" required><span class="field-suffix">@${d?.name || 'domain'}</span></div>
            <p class="field-help">Letters, numbers, dots, hyphens and underscores.</p></div>
          <div class="field"><label class="field-label" for="mpass">Password <span class="req">*</span></label>
            <div class="field-control"><input id="mpass" name="password" type="password" required minlength="8" placeholder="At least 8 characters">
              <button class="btn btn-secondary btn-sm u-s18" type="button" data-genpass="#mpass">Generate</button></div></div>
          <div class="field"><label class="field-label">Quota (MB)</label><input name="quota_mb" type="number" min="0" value="1024"><p class="field-help">0 = unlimited.</p></div>
        </div>
        <div class="form-actions"><button class="btn btn-primary" type="submit" ${!q.ok || !domains.length ? 'disabled' : ''}>${icon('plus', { size: 16 })} Create mailbox</button>
          <a class="btn btn-ghost" href="/user/email">Cancel</a></div>
      </form>`)}`;
    return page(ctx, { title: 'Create Email Account', subtitle: 'Add a POP3/IMAP mailbox', body });
  });

  router.post('/user/email/create', (ctx) => {
    const d = domainFor(ctx.user, ctx.body.domain);
    if (!d) return ctx.redirect('/user/email?flash=Domain%20not%20found&type=error');
    const local = String(ctx.body.local_part || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(local)) return ctx.redirect('/user/email?flash=Invalid%20mailbox%20name&type=error');
    if (!ctx.body.password || String(ctx.body.password).length < 8) return ctx.redirect('/user/email?flash=Password%20must%20be%20at%20least%208%20characters&type=error');
    const q = quota(ctx.user, 'emails');
    if (!q.ok) return ctx.redirect('/user/email?flash=Mailbox%20limit%20reached&type=error');
    let mailHash = null;
    try { mailHash = dovecotHash(String(ctx.body.password)); } catch { /* openssl unavailable */ }
    run(`INSERT INTO email_accounts(domain_id, domain, local_part, password, quota_mb, used_mb, suspended, created_at, mail_hash)
         VALUES(?,?,?,?,?,?,?,?,?)`, d.id, d.name, local, hashPassword(String(ctx.body.password)), Number(ctx.body.quota_mb) || 0, 0, 0, nowIso(), mailHash);
    syncMail();
    apply({ mail: true });
    audit(ctx.user.username, ctx.user.level, 'email.create', `${local}@${d.name}`, ctx.ip);
    try { runHooks('email.create', { email: `${local}@${d.name}` }); } catch { /* ignore */ }
    return ctx.redirect('/user/email?domain=' + encodeURIComponent(d.name) + '&flash=' + encodeURIComponent(`Mailbox ${local}@${d.name} created`));
  });

  router.post('/user/email/:id/update', (ctx) => {
    const m = get('SELECT * FROM email_accounts WHERE id = ?', Number(ctx.params.id));
    if (!m || !domainFor(ctx.user, m.domain_id)) return ctx.redirect('/user/email?flash=Not%20found&type=error');
    const password = String(ctx.body.password || '');
    if (password && password.length < 8) return ctx.redirect('/user/email?domain=' + encodeURIComponent(m.domain) + '&flash=Password%20must%20be%208%2B%20characters&type=error');
    run('UPDATE email_accounts SET quota_mb = ? WHERE id = ?', Number(ctx.body.quota_mb) || 0, m.id);
    if (password) {
      let mailHash = null;
      try { mailHash = dovecotHash(password); } catch { /* ignore */ }
      run('UPDATE email_accounts SET password = ?, mail_hash = ? WHERE id = ?', hashPassword(password), mailHash, m.id);
    }
    syncMail(); apply({ mail: true });
    audit(ctx.user.username, ctx.user.level, 'email.update', `${m.local_part}@${m.domain}`, ctx.ip);
    return ctx.redirect('/user/email?domain=' + encodeURIComponent(m.domain) + '&flash=Mailbox%20updated');
  });

  router.post('/user/email/:id/delete', (ctx) => {
    const m = get('SELECT * FROM email_accounts WHERE id = ?', Number(ctx.params.id));
    if (!m) return ctx.redirect('/user/email?flash=Mailbox%20not%20found&type=error');
    if (!domainFor(ctx.user, m.domain_id)) return ctx.redirect('/user/email?flash=Access%20denied&type=error');
    run('DELETE FROM email_accounts WHERE id = ?', m.id);
    syncMail();
    apply({ mail: true });
    audit(ctx.user.username, ctx.user.level, 'email.delete', `${m.local_part}@${m.domain}`, ctx.ip);
    return ctx.redirect('/user/email?domain=' + encodeURIComponent(m.domain) + '&flash=Mailbox%20deleted');
  });

  router.post('/user/email/:id/toggle', (ctx) => {
    const m = get('SELECT * FROM email_accounts WHERE id = ?', Number(ctx.params.id));
    if (!m || !domainFor(ctx.user, m.domain_id)) return ctx.redirect('/user/email?flash=Not%20found&type=error');
    run('UPDATE email_accounts SET suspended = ? WHERE id = ?', m.suspended ? 0 : 1, m.id);
    return ctx.redirect('/user/email?domain=' + encodeURIComponent(m.domain) + '&flash=' + encodeURIComponent(`Mailbox ${m.suspended ? 'enabled' : 'suspended'}`));
  });

  /* ---------------------------------------------------------- forwarders */
  router.get('/user/email/forwarders', (ctx) => {
    const domains = visibleDomains(ctx.user);
    const rows = all(`SELECT f.* FROM email_forwarders f JOIN domains d ON d.id = f.domain_id WHERE d.user_id = ? ORDER BY f.source`, ctx.user.id);
    const editing = ctx.query.edit ? rows.find((r) => String(r.id) === String(ctx.query.edit)) : null;
    const body = h`
      ${mailNav(ctx, 'forwarders')}
      ${listCard({
        title: 'Email forwarders', sub: `${rows.length} forwarder(s)`,
        columns: [
          { label: 'Source', render: (r) => h`<span class="cell-mono">${r.source}@${r.domain}</span>` },
          { label: 'Destination', render: (r) => h`<span class="cell-mono">${r.dest}</span>` },
          { label: 'Keep copy', render: (r) => (r.keep_copy ? badge('Yes', 'ok') : badge('No', 'muted')) },
          { label: 'Created', render: (r) => formatDate(r.created_at) },
        ],
        rows, empty: 'No forwarders configured.',
        actions: [
          { label: 'Edit', href: (r) => `/user/email/forwarders?edit=${r.id}`, icon: 'edit' },
          { label: 'Delete', form: (r) => `/user/email/forwarders/${r.id}/delete`, confirm: 'Usunąć przekierowanie poczty?', icon: 'trash', danger: true },
        ],
        footer: h`<form class="u-s31" method="post" action="/user/email/forwarders/create">
          <input type="hidden" name="_csrf" value="${ctx.csrf}">
          <select name="domain">${domains.map((d) => h`<option value="${d.name}">${d.name}</option>`)}</select>
          <input class="u-s63" name="source" placeholder="sales" required>
          <span class="muted">→</span>
          <input class="u-s28" name="dest" type="email" placeholder="you@elsewhere.com" required>
          <label class="check-field small"><input type="checkbox" name="keep_copy" value="1" checked> Keep copy</label>
          <button class="btn btn-primary btn-sm" type="submit">${icon('plus', { size: 14 })} Add forwarder</button>
        </form>`,
      })}
      ${editing ? card(`Edit forwarder · ${editing.source}@${editing.domain}`, h`<form method="post" action="/user/email/forwarders/${editing.id}/update" class="oa-form">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <div class="form-grid">
          <div class="field"><label class="field-label">Source</label><input value="${editing.source}@${editing.domain}" disabled></div>
          <div class="field"><label class="field-label">Destination</label><input name="dest" type="email" value="${editing.dest}" required></div>
          <div class="field"><label class="check-field"><input type="checkbox" name="keep_copy" value="1" ${editing.keep_copy ? 'checked' : ''}> <span>Keep copy</span></label></div>
        </div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Save forwarder</button><a class="btn btn-ghost" href="/user/email/forwarders">Cancel</a></div>
      </form>`) : ''}`;
    return page(ctx, { title: 'Email Forwarders', subtitle: 'Forward mail to another address', body });
  });

  router.post('/user/email/forwarders/create', (ctx) => {
    const d = domainFor(ctx.user, ctx.body.domain);
    const source = String(ctx.body.source || '').trim().toLowerCase();
    const dest = String(ctx.body.dest || '').trim();
    if (!d || !source || !isEmail(dest)) return ctx.redirect('/user/email/forwarders?flash=Invalid%20forwarder&type=error');
    run('INSERT INTO email_forwarders(domain_id, domain, source, dest, keep_copy, created_at) VALUES(?,?,?,?,?,?)',
      d.id, d.name, source, dest, ctx.body.keep_copy ? 1 : 0, nowIso());
    syncMail();
    apply({ mail: true });
    return ctx.redirect('/user/email/forwarders?flash=Forwarder%20created');
  });

  router.post('/user/email/forwarders/:id/update', (ctx) => {
    const f = get('SELECT * FROM email_forwarders WHERE id = ?', Number(ctx.params.id));
    if (!f || !domainFor(ctx.user, f.domain_id)) return ctx.redirect('/user/email/forwarders?flash=Not%20found&type=error');
    const dest = String(ctx.body.dest || '').trim();
    if (!isEmail(dest)) return ctx.redirect('/user/email/forwarders?flash=Invalid%20destination&type=error');
    run('UPDATE email_forwarders SET dest = ?, keep_copy = ? WHERE id = ?', dest, ctx.body.keep_copy ? 1 : 0, f.id);
    syncMail(); apply({ mail: true });
    audit(ctx.user.username, ctx.user.level, 'email.forwarder.update', `${f.source}@${f.domain}`, ctx.ip);
    return ctx.redirect('/user/email/forwarders?flash=Forwarder%20updated');
  });

  router.post('/user/email/forwarders/:id/delete', (ctx) => {
    const f = get('SELECT * FROM email_forwarders WHERE id = ?', Number(ctx.params.id));
    if (f && domainFor(ctx.user, f.domain_id)) run('DELETE FROM email_forwarders WHERE id = ?', f.id);
    syncMail();
    apply({ mail: true });
    return ctx.redirect('/user/email/forwarders?flash=Forwarder%20deleted');
  });

  /* -------------------------------------------------------- autoresponders */
  router.get('/user/email/autoresponders', (ctx) => {
    const rows = all(`SELECT a.* FROM autoresponders a JOIN domains d ON d.id = a.domain_id WHERE d.user_id = ? ORDER BY a.email`, ctx.user.id);
    const domains = visibleDomains(ctx.user);
    const body = h`
      ${mailNav(ctx, 'autoresponders')}
      ${listCard({
        title: 'Autoresponders', sub: 'Automatically reply to incoming mail',
        columns: [
          { label: 'Email', render: (r) => h`<span class="cell-mono">${r.email}</span>` },
          { label: 'Subject', render: (r) => r.subject },
          { label: 'Status', render: (r) => (r.enabled ? badge('Enabled', 'ok') : badge('Disabled', 'muted')) },
          { label: 'Actions', render: (r) => h`<a class="link small" href="/user/email/autoresponders/${r.id}">Edit</a>` },
        ],
        rows, empty: 'No autoresponders yet.',
        actions: [{ label: 'Delete', form: (r) => `/user/email/autoresponders/${r.id}/delete`, confirm: 'Usunąć autoresponder?', icon: 'trash', danger: true }],
        footer: h`<form class="u-s31" method="post" action="/user/email/autoresponders/create">
          <input type="hidden" name="_csrf" value="${ctx.csrf}">
          <select name="domain">${domains.map((d) => h`<option value="${d.name}">${d.name}</option>`)}</select>
          <input class="u-s68" name="email" type="email" placeholder="support@example.com" required>
          <input class="u-s26" name="subject" placeholder="Subject" required>
          <button class="btn btn-primary btn-sm" type="submit">${icon('plus', { size: 14 })} Add autoresponder</button>
        </form>`,
      })}`;
    return page(ctx, { title: 'Autoresponders', subtitle: 'Send automatic replies from a mailbox', body });
  });

  router.post('/user/email/autoresponders/create', (ctx) => {
    const d = domainFor(ctx.user, ctx.body.domain);
    const addr = String(ctx.body.email || '').trim().toLowerCase();
    const subject = String(ctx.body.subject || '').trim();
    const bodyText = String(ctx.body.body || 'Thank you for your message. We will get back to you shortly.').trim();
    if (!d || !isEmail(addr) || !subject) return ctx.redirect('/user/email/autoresponders?flash=Invalid%20autoresponder&type=error');
    run('INSERT INTO autoresponders(domain_id, domain, email, subject, body, enabled, created_at) VALUES(?,?,?,?,?,?,?)',
      d.id, d.name, addr, subject, bodyText, 1, nowIso());
    syncMail();
    apply({ mail: true });
    return ctx.redirect('/user/email/autoresponders?flash=Autoresponder%20created');
  });

  router.get('/user/email/autoresponders/:id', (ctx) => {
    const a = get('SELECT * FROM autoresponders WHERE id = ?', Number(ctx.params.id));
    if (!a || !domainFor(ctx.user, a.domain_id)) return ctx.redirect('/user/email/autoresponders?flash=Not%20found&type=error');
    const body = h`${mailNav(ctx, 'autoresponders')}
      ${card('Edit autoresponder', h`<form method="post" action="/user/email/autoresponders/${a.id}/update" class="oa-form">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <div class="form-grid">
          <div class="field"><label class="field-label">Email</label><input value="${a.email}" disabled></div>
          <div class="field"><label class="field-label">Subject</label><input name="subject" value="${a.subject}" required></div>
          <div class="field field-full"><label class="field-label">Message</label><textarea name="body" rows="7">${a.body}</textarea></div>
          <div class="field field-full"><label class="check-field"><input type="checkbox" name="enabled" value="1" ${a.enabled ? 'checked' : ''}> <span>Enabled</span></label></div>
        </div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Save</button><a class="btn btn-ghost" href="/user/email/autoresponders">Cancel</a></div>
      </form>`)}`;
    return page(ctx, { title: 'Edit Autoresponder', subtitle: a.email, body });
  });

  router.post('/user/email/autoresponders/:id/update', (ctx) => {
    const a = get('SELECT * FROM autoresponders WHERE id = ?', Number(ctx.params.id));
    if (!a || !domainFor(ctx.user, a.domain_id)) return ctx.redirect('/user/email/autoresponders?flash=Not%20found&type=error');
    run('UPDATE autoresponders SET subject = ?, body = ?, enabled = ? WHERE id = ?',
      String(ctx.body.subject || a.subject), String(ctx.body.body || a.body), ctx.body.enabled ? 1 : 0, a.id);
    return ctx.redirect('/user/email/autoresponders?flash=Autoresponder%20updated');
  });

  router.post('/user/email/autoresponders/:id/delete', (ctx) => {
    const a = get('SELECT * FROM autoresponders WHERE id = ?', Number(ctx.params.id));
    if (a && domainFor(ctx.user, a.domain_id)) run('DELETE FROM autoresponders WHERE id = ?', a.id);
    return ctx.redirect('/user/email/autoresponders?flash=Autoresponder%20deleted');
  });

  /* ------------------------------------------------------------- vacation */
  router.get('/user/email/vacation', (ctx) => {
    const domains = visibleDomains(ctx.user);
    const selected = ctx.query.domain || domains[0]?.name;
    const d = domains.find((x) => x.name === selected);
    const rows = d ? all('SELECT * FROM vacation WHERE domain = ? ORDER BY email', d.name) : [];
    const editing = ctx.query.edit ? rows.find((r) => String(r.id) === String(ctx.query.edit)) : null;
    const body = h`${mailNav(ctx, 'vacation')}
      ${domains.length ? domainSelect(domains, d?.name, { action: '/user/email/vacation' }) : ''}
      ${listCard({
        title: 'Vacation messages', sub: 'Automatic replies while you are away',
        columns: [
          { label: 'Mailbox', render: (r) => h`<span class="cell-mono">${r.email}</span>` },
          { label: 'Subject', render: (r) => r.subject },
          { label: 'Period', render: (r) => r.start_date || r.end_date ? h`${formatDate(r.start_date)} → ${formatDate(r.end_date)}` : 'Always' },
          { label: 'Status', render: (r) => (r.enabled ? badge('Active', 'ok') : badge('Off', 'muted')) },
        ],
        rows, empty: 'No vacation messages.',
        actions: [
          { label: 'Edytuj', href: (r) => `/user/email/vacation?domain=${encodeURIComponent(d?.name || '')}&edit=${r.id}`, icon: 'edit' },
          { label: 'Toggle', form: (r) => `/user/email/vacation/${r.id}/toggle`, icon: 'refresh' },
          { label: 'Delete', form: (r) => `/user/email/vacation/${r.id}/delete`, confirm: 'Usunąć wiadomość urlopową?', icon: 'trash', danger: true },
        ],
        footer: d ? h`<form method="post" action="/user/email/vacation/create" class="oa-form u-s69">
          <input type="hidden" name="_csrf" value="${ctx.csrf}"><input type="hidden" name="domain" value="${d.name}">
          <div class="form-grid">
            <div class="field"><label class="field-label">Mailbox</label><input name="email" type="email" placeholder="you@${d.name}" required></div>
            <div class="field"><label class="field-label">Subject</label><input name="subject" placeholder="Out of office" required></div>
            <div class="field field-full"><label class="field-label">Message</label><textarea name="body" rows="4">I am currently away and will reply when I return.</textarea></div>
            <div class="field"><label class="field-label">Start date</label><input name="start_date" type="date"></div>
            <div class="field"><label class="field-label">End date</label><input name="end_date" type="date"></div>
          </div>
          <div class="form-actions"><button class="btn btn-primary btn-sm" type="submit">${icon('plus', { size: 14 })} Add vacation message</button></div>
        </form>` : '',
      })}
      ${editing ? card(`Edytuj autoresponder · ${editing.email}`, h`<form method="post" action="/user/email/vacation/${editing.id}/update" class="oa-form">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <div class="form-grid">
          <div class="field"><label class="field-label">Mailbox</label><input value="${editing.email}" disabled></div>
          <div class="field"><label class="field-label">Subject</label><input name="subject" value="${editing.subject}" required></div>
          <div class="field field-full"><label class="field-label">Message</label><textarea name="body" rows="5">${editing.body}</textarea></div>
          <div class="field"><label class="field-label">Start</label><input name="start_date" type="date" value="${editing.start_date || ''}"></div>
          <div class="field"><label class="field-label">End</label><input name="end_date" type="date" value="${editing.end_date || ''}"></div>
        </div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Zapisz</button><a class="btn btn-ghost" href="/user/email/vacation?domain=${encodeURIComponent(editing.domain)}">Anuluj</a></div>
      </form>`) : ''}`;
    return page(ctx, { title: 'Vacation Messages', subtitle: 'Schedule automatic out-of-office replies', body });
  });

  router.post('/user/email/vacation/create', (ctx) => {
    const d = domainFor(ctx.user, ctx.body.domain);
    const email = String(ctx.body.email || '').trim().toLowerCase();
    if (!d || !isEmail(email) || !email.endsWith('@' + d.name)) return ctx.redirect('/user/email/vacation?domain=' + encodeURIComponent(d?.name || '') + '&flash=Invalid%20mailbox&type=error');
    run(`INSERT INTO vacation(domain, email, subject, body, start_date, end_date, enabled, created_at) VALUES(?,?,?,?,?,?,?,?)
         ON CONFLICT(email) DO UPDATE SET subject = excluded.subject, body = excluded.body, start_date = excluded.start_date, end_date = excluded.end_date, enabled = 1`,
      d.name, email, String(ctx.body.subject || 'Out of office'), String(ctx.body.body || ''), ctx.body.start_date || null, ctx.body.end_date || null, 1, nowIso());
    return ctx.redirect('/user/email/vacation?domain=' + encodeURIComponent(d.name) + '&flash=Vacation%20message%20saved');
  });

  router.post('/user/email/vacation/:id/update', (ctx) => {
    const v = get('SELECT * FROM vacation WHERE id = ?', Number(ctx.params.id));
    if (!v || !domainFor(ctx.user, v.domain)) return ctx.redirect('/user/email/vacation?flash=Not%20found&type=error');
    run('UPDATE vacation SET subject=?, body=?, start_date=?, end_date=? WHERE id=?', String(ctx.body.subject || v.subject), String(ctx.body.body || ''), ctx.body.start_date || null, ctx.body.end_date || null, v.id);
    audit(ctx.user.username, ctx.user.level, 'email.vacation.update', v.email, ctx.ip);
    return ctx.redirect('/user/email/vacation?domain=' + encodeURIComponent(v.domain) + '&flash=Updated');
  });

  router.post('/user/email/vacation/:id/toggle', (ctx) => {
    const v = get('SELECT * FROM vacation WHERE id = ?', Number(ctx.params.id));
    if (v) run('UPDATE vacation SET enabled = ? WHERE id = ?', v.enabled ? 0 : 1, v.id);
    return ctx.redirect('/user/email/vacation?domain=' + encodeURIComponent(v?.domain || '') + '&flash=Updated');
  });

  router.post('/user/email/vacation/:id/delete', (ctx) => {
    const v = get('SELECT * FROM vacation WHERE id = ?', Number(ctx.params.id));
    if (v) run('DELETE FROM vacation WHERE id = ?', v.id);
    return ctx.redirect('/user/email/vacation?domain=' + encodeURIComponent(v?.domain || '') + '&flash=Deleted');
  });

  /* ------------------------------------------------------------- catch-all */
  router.get('/user/email/catch-all', (ctx) => {
    const domains = visibleDomains(ctx.user);
    const selected = ctx.query.domain || domains[0]?.name;
    const d = domains.find((x) => x.name === selected);
    const row = d ? get('SELECT * FROM catchall WHERE domain_id = ?', d.id) : null;
    const mailboxes = d ? all('SELECT * FROM email_accounts WHERE domain_id = ? ORDER BY local_part', d.id) : [];
    const body = h`${mailNav(ctx, 'catchall')}
      ${domains.length ? domainSelect(domains, d?.name, { action: '/user/email/catch-all' }) : ''}
      ${d ? card(`Catch-all for ${d.name}`, h`
        <p class="small muted mb-18">Any message sent to an address on this domain that does not exist will be delivered to the address below.</p>
        ${row ? kvList([['Current catch-all', row.dest || 'Discard'], ['Updated', formatDate(row.created_at)]]) : alert('Catch-all is not configured for this domain.', 'info')}
        <form class="u-s70" method="post" action="/user/email/catch-all/save">
          <input type="hidden" name="_csrf" value="${ctx.csrf}"><input type="hidden" name="domain" value="${d.name}">
          <div class="field u-s42"><label class="field-label">Deliver to</label>
            <select name="dest"><option value="">Discard (blackhole)</option>
              ${mailboxes.map((m) => h`<option value="${m.local_part}@${m.domain}" ${row?.dest === m.local_part + '@' + m.domain ? 'selected' : ''}>${m.local_part}@${m.domain}</option>`)}
              <option value="__custom">Custom address…</option>
            </select></div>
          <div class="field u-s71"><label class="field-label">Or enter an address</label><input name="custom_dest" type="email" placeholder="catchall@elsewhere.com"></div>
          <button class="btn btn-primary" type="submit">Save</button>
        </form>
        ${row ? h`<form class="u-s55" method="post" action="/user/email/catch-all/delete"><input type="hidden" name="_csrf" value="${ctx.csrf}">
          <input type="hidden" name="domain" value="${d.name}"><button class="btn btn-quiet-danger btn-sm" type="submit">Remove catch-all</button></form>` : ''}
      `) : ''}`;
    return page(ctx, { title: 'Catch-All Email', subtitle: 'Deliver unknown recipients to one mailbox', body });
  });

  router.post('/user/email/catch-all/save', (ctx) => {
    const d = domainFor(ctx.user, ctx.body.domain);
    if (!d) return ctx.redirect('/user/email/catch-all?flash=Domain%20not%20found&type=error');
    let dest = String(ctx.body.dest || '');
    if (dest === '__custom' || !dest) dest = String(ctx.body.custom_dest || '');
    run(`INSERT INTO catchall(domain_id, domain, dest, created_at) VALUES(?,?,?,?)
         ON CONFLICT(domain_id) DO UPDATE SET dest = excluded.dest`, d.id, d.name, dest || null, nowIso());
    syncMail();
    apply({ mail: true });
    return ctx.redirect('/user/email/catch-all?domain=' + encodeURIComponent(d.name) + '&flash=Catch-all%20saved');
  });

  router.post('/user/email/catch-all/delete', (ctx) => {
    const d = domainFor(ctx.user, ctx.body.domain);
    if (d) run('DELETE FROM catchall WHERE domain_id = ?', d.id);
    syncMail();
    apply({ mail: true });
    return ctx.redirect('/user/email/catch-all?flash=Catch-all%20removed');
  });

  /* --------------------------------------------------------- mailing lists */
  router.get('/user/email/lists', (ctx) => {
    const rows = all(`SELECT l.* FROM mailing_lists l JOIN domains d ON d.id = l.domain_id WHERE d.user_id = ? ORDER BY l.name`, ctx.user.id);
    const editing = ctx.query.edit ? rows.find((r) => String(r.id) === String(ctx.query.edit)) : null;
    const domains = visibleDomains(ctx.user);
    const body = h`${mailNav(ctx, 'lists')}
      ${listCard({
        title: 'Mailing lists', sub: 'Discussion lists powered by Mailman-compatible storage',
        columns: [
          { label: 'List', render: (r) => h`<span class="cell-strong">${r.name}@${r.domain}</span><span class="cell-sub">${(r.members || '').split(',').filter(Boolean).length} subscriber(s)</span>` },
          { label: 'Members', render: (r) => h`<span class="truncate u-s30">${r.members || '—'}</span>` },
          { label: 'Created', render: (r) => formatDate(r.created_at) },
        ],
        rows, empty: 'No mailing lists yet.',
        actions: [
          { label: 'Edytuj', href: (r) => `/user/email/lists?edit=${r.id}`, icon: 'edit' },
          { label: 'Delete', form: (r) => `/user/email/lists/${r.id}/delete`, confirm: 'Usunąć listę mailingową?', icon: 'trash', danger: true },
        ],
        footer: h`<form class="u-s31" method="post" action="/user/email/lists/create">
          <input type="hidden" name="_csrf" value="${ctx.csrf}">
          <select name="domain">${domains.map((d) => h`<option value="${d.name}">${d.name}</option>`)}</select>
          <input class="u-s34" name="name" placeholder="announce" required>
          <input class="u-s72" name="members" placeholder="a@example.com, b@example.com">
          <button class="btn btn-primary btn-sm" type="submit">${icon('plus', { size: 14 })} Create list</button>
        </form>`,
      })}
      ${editing ? card(`Edytuj listę · ${editing.name}@${editing.domain}`, h`<form method="post" action="/user/email/lists/${editing.id}/update" class="oa-form">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <div class="form-grid">
          <div class="field"><label class="field-label">Lista</label><input value="${editing.name}@${editing.domain}" disabled></div>
          <div class="field field-full"><label class="field-label">Członkowie (po przecinku)</label><textarea name="members" rows="4">${editing.members || ''}</textarea></div>
        </div>
        <div class="form-actions"><button class="btn btn-primary" type="submit">Zapisz</button><a class="btn btn-ghost" href="/user/email/lists">Anuluj</a></div>
      </form>`) : ''}`;
    return page(ctx, { title: 'Mailing Lists', subtitle: 'Create announcement and discussion lists', body });
  });

  router.post('/user/email/lists/create', (ctx) => {
    const d = domainFor(ctx.user, ctx.body.domain);
    const name = String(ctx.body.name || '').trim().toLowerCase();
    if (!d || !/^[a-z0-9-]{1,40}$/.test(name)) return ctx.redirect('/user/email/lists?flash=Invalid%20list%20name&type=error');
    run('INSERT INTO mailing_lists(domain_id, domain, name, members, created_at) VALUES(?,?,?,?,?)',
      d.id, d.name, name, String(ctx.body.members || '').trim(), nowIso());
    return ctx.redirect('/user/email/lists?flash=Mailing%20list%20created');
  });

  router.post('/user/email/lists/:id/update', (ctx) => {
    const l = get('SELECT * FROM mailing_lists WHERE id = ?', Number(ctx.params.id));
    if (!l || !domainFor(ctx.user, l.domain_id)) return ctx.redirect('/user/email/lists?flash=Not%20found&type=error');
    run('UPDATE mailing_lists SET members = ? WHERE id = ?', String(ctx.body.members || '').trim(), l.id);
    audit(ctx.user.username, ctx.user.level, 'email.list.update', l.name, ctx.ip);
    return ctx.redirect('/user/email/lists?flash=List%20updated');
  });

  router.post('/user/email/lists/:id/delete', (ctx) => {
    const l = get('SELECT * FROM mailing_lists WHERE id = ?', Number(ctx.params.id));
    if (l && domainFor(ctx.user, l.domain_id)) run('DELETE FROM mailing_lists WHERE id = ?', l.id);
    return ctx.redirect('/user/email/lists?flash=List%20deleted');
  });

  /* --------------------------------------------------------------- spam */
  router.get('/user/email/spam', (ctx) => {
    const domains = visibleDomains(ctx.user);
    const selected = ctx.query.domain || domains[0]?.name;
    const d = domains.find((x) => x.name === selected);
    const filters = d ? all('SELECT * FROM email_filters WHERE domain = ? ORDER BY created_at DESC', d.name) : [];
    const editing = ctx.query.edit ? filters.find((r) => String(r.id) === String(ctx.query.edit)) : null;
    const body = h`${mailNav(ctx, 'spam')}
      ${domains.length ? domainSelect(domains, d?.name, { action: '/user/email/spam' }) : ''}
      ${card('Spam filter rules', h`
        ${filters.length ? table({
          columns: [
            { label: 'If', render: (r) => h`<span class="cell-mono">${r.field} ${r.operator}</span>` },
            { label: 'Value', render: (r) => h`<span class="cell-mono">${r.value}</span>` },
            { label: 'Then', render: (r) => badge(`${r.action}${r.target ? ' → ' + r.target : ''}`, 'brand') },
            { label: 'Status', render: (r) => (r.enabled ? badge('Active', 'ok') : badge('Off', 'muted')) },
          ],
          rows: filters,
          actions: [
            { label: 'Edytuj', href: (r) => `/user/email/spam?domain=${encodeURIComponent(d?.name || '')}&edit=${r.id}`, icon: 'edit' },
            { label: 'Delete', form: (r) => `/user/email/spam/${r.id}/delete`, icon: 'trash', danger: true, confirm: 'Usunąć regułę?' },
          ],
        }) : emptyState('No spam rules for this domain.')}
        <form class="u-s73" method="post" action="/user/email/spam/create">
          <input type="hidden" name="_csrf" value="${ctx.csrf}">
          <input type="hidden" name="domain" value="${d?.name || ''}">
          <select name="field"><option value="subject">Subject</option><option value="from">From</option><option value="to">To</option><option value="body">Body</option></select>
          <select name="operator"><option value="contains">contains</option><option value="equals">equals</option><option value="starts">starts with</option></select>
          <input class="u-s26" name="value" placeholder="text to match" required>
          <select name="action"><option value="move">move to folder</option><option value="discard">discard</option><option value="tag">tag subject</option></select>
          <input class="u-s29" name="target" placeholder="Junk">
          <button class="btn btn-primary btn-sm" type="submit">${icon('plus', { size: 14 })} Add rule</button>
        </form>
        ${editing ? h`<form method="post" action="/user/email/spam/${editing.id}/update" class="oa-form mt-18">
          <input type="hidden" name="_csrf" value="${ctx.csrf}">
          <div class="form-grid">
            <div class="field"><label class="field-label">Field</label><select name="field">${['subject','from','to','body'].map((x) => h`<option ${x === editing.field ? 'selected' : ''}>${x}</option>`)}</select></div>
            <div class="field"><label class="field-label">Operator</label><select name="operator">${['contains','equals','starts'].map((x) => h`<option ${x === editing.operator ? 'selected' : ''}>${x}</option>`)}</select></div>
            <div class="field field-full"><label class="field-label">Value</label><input name="value" value="${editing.value}" required></div>
            <div class="field"><label class="field-label">Action</label><select name="action">${['move','discard','tag'].map((x) => h`<option ${x === editing.action ? 'selected' : ''}>${x}</option>`)}</select></div>
            <div class="field"><label class="field-label">Target</label><input name="target" value="${editing.target || ''}"></div>
          </div>
          <div class="form-actions"><button class="btn btn-primary" type="submit">Zapisz regułę</button><a class="btn btn-ghost" href="/user/email/spam?domain=${encodeURIComponent(d?.name || '')}">Anuluj</a></div>
        </form>` : ''}
      `, { sub: 'Rules applied by the spam filter (SpamAssassin compatible syntax)' })}
      ${card('Mail authentication', (() => {
        const dkim = d ? dkimStatus(d.name) : { exists: false };
        const spf = d ? all("SELECT value FROM dns_records WHERE domain_id = ? AND type = 'TXT' AND value LIKE 'v=spf1%'", d.id)[0] : null;
        const dmarc = d ? all("SELECT value FROM dns_records WHERE domain_id = ? AND type = 'TXT' AND name = '_dmarc'", d.id)[0] : null;
        return h`${kvList([
          ['SPF record', spf ? h`<code class="truncate">${spf.value}</code>` : badge('missing', 'warn')],
          ['DMARC record', dmarc ? h`<code class="truncate">${dmarc.value}</code>` : badge('missing', 'warn')],
          ['DKIM selector', dkim.exists ? `${dkim.selector}._domainkey` : badge('not generated', 'warn')],
          ['DKIM key', dkim.exists ? (dkim.keyPresent ? dkim.key_path : 'key file missing') : '—'],
          ['OpenDKIM service', systemProvider().serviceStatus('opendkim')?.status || 'not installed'],
        ])}
        ${d ? h`<form method="post" action="/user/email/dkim" class="mt-18">
          <input type="hidden" name="_csrf" value="${ctx.csrf}"><input type="hidden" name="domain" value="${d.name}">
          <button class="btn btn-primary btn-sm" type="submit">${dkim.exists ? 'Regenerate DKIM key' : 'Generate DKIM key'}</button>
          <span class="small muted">Creates a 2048-bit RSA key and publishes the TXT record.</span>
        </form>
        ${dkim.exists ? h`<pre class="code-block small mt-12">${dkim.selector}._domainkey.${d.name} IN TXT "${dkim.public_key}"</pre>` : ''}` : ''}`;
      })())}`
    return page(ctx, { title: 'Spam Filters', subtitle: 'Block unwanted mail at the domain level', body });
  });

  router.post('/user/email/dkim', (ctx) => {
    const d = domainFor(ctx.user, ctx.body.domain);
    if (!d) return ctx.redirect('/user/email/spam?flash=Domain%20not%20found&type=error');
    const result = generateDkim(d.name);
    let deployed = null;
    if (result.ok) { try { deployed = deployDkim(); } catch (e) { deployed = { ok: false, output: e.message }; } }
    audit(ctx.user.username, ctx.user.level, 'email.dkim', `${d.name}: ${result.ok ? 'generated' : result.error}`, ctx.ip);
    return ctx.redirect('/user/email/spam?domain=' + encodeURIComponent(d.name) + '&flash=' + encodeURIComponent(result.ok ? `DKIM key generated, published and ${deployed?.ok ? 'Exim signing reloaded' : 'deploy pending: ' + (deployed?.output || '')}` : result.error) + (result.ok ? '' : '&type=error'));
  });

  router.post('/user/email/spam/create', (ctx) => {
    const d = domainFor(ctx.user, ctx.body.domain);
    if (!d) return ctx.redirect('/user/email/spam?flash=Domain%20not%20found&type=error');
    run('INSERT INTO email_filters(domain, field, operator, value, action, target, enabled, created_at) VALUES(?,?,?,?,?,?,?,?)',
      d.name, String(ctx.body.field || 'subject'), String(ctx.body.operator || 'contains'),
      String(ctx.body.value || ''), String(ctx.body.action || 'move'), String(ctx.body.target || ''), 1, nowIso());
    return ctx.redirect('/user/email/spam?domain=' + encodeURIComponent(d.name) + '&flash=Filter%20added');
  });

  router.post('/user/email/spam/:id/update', (ctx) => {
    const r = get('SELECT * FROM email_filters WHERE id = ?', Number(ctx.params.id));
    if (!r || !domainFor(ctx.user, r.domain_id)) return ctx.redirect('/user/email/spam?flash=Not%20found&type=error');
    run('UPDATE email_filters SET field=?, operator=?, value=?, action=?, target=? WHERE id=?', String(ctx.body.field || r.field), String(ctx.body.operator || r.operator), String(ctx.body.value || ''), String(ctx.body.action || r.action), String(ctx.body.target || ''), r.id);
    audit(ctx.user.username, ctx.user.level, 'email.filter.update', r.value, ctx.ip);
    return ctx.redirect('/user/email/spam?domain=' + encodeURIComponent(r.domain) + '&flash=Rule%20updated');
  });

  router.post('/user/email/spam/:id/delete', (ctx) => {
    const f = get('SELECT * FROM email_filters WHERE id = ?', Number(ctx.params.id));
    if (f && domainFor(ctx.user, f.domain)) run('DELETE FROM email_filters WHERE id = ?', f.id);
    return ctx.redirect('/user/email/spam?domain=' + encodeURIComponent(f?.domain || '') + '&flash=Filter%20deleted');
  });

  /* -------------------------------------------------------------- usage */
  router.get('/user/email/usage', (ctx) => {
    const rows = all(`SELECT * FROM email_accounts WHERE domain IN (SELECT name FROM domains WHERE user_id = ?) ORDER BY used_mb DESC`, ctx.user.id);
    const total = rows.reduce((a, r) => a + (r.used_mb || 0), 0);
    const quotaTotal = rows.reduce((a, r) => a + (r.quota_mb || 0), 0);
    const body = h`${mailNav(ctx, 'usage')}
      <div class="stat-grid">
        <div class="stat-card"><div class="stat-icon">${icon('mail', { size: 20 })}</div><div class="stat-body"><span class="stat-label">Mailboxes</span><strong class="stat-value">${rows.length}</strong><span class="stat-sub">across all domains</span></div></div>
        <div class="stat-card"><div class="stat-icon tone-ok">${icon('database', { size: 20 })}</div><div class="stat-body"><span class="stat-label">Storage used</span><strong class="stat-value">${formatBytes(total)}</strong><span class="stat-sub">of ${formatBytes(quotaTotal)} allocated</span></div></div>
        <div class="stat-card"><div class="stat-icon tone-warn">${icon('chart', { size: 20 })}</div><div class="stat-body"><span class="stat-label">Largest mailbox</span><strong class="stat-value">${rows[0] ? `${rows[0].local_part}@${rows[0].domain}` : '—'}</strong><span class="stat-sub">${rows[0] ? formatBytes(rows[0].used_mb) : ''}</span></div></div>
        <div class="stat-card"><div class="stat-icon tone-brand">${icon('shield', { size: 20 })}</div><div class="stat-body"><span class="stat-label">Protection</span><strong class="stat-value">Active</strong><span class="stat-sub">spam + antivirus</span></div></div>
      </div>
      ${listCard({
        title: 'Mailbox usage', sub: 'Storage consumed per mailbox',
        columns: [
          { label: 'Mailbox', render: (r) => h`<span class="cell-strong">${r.local_part}@${r.domain}</span>` },
          { label: 'Used', render: (r) => formatBytes(r.used_mb), align: 'right' },
          { label: 'Quota', render: (r) => (r.quota_mb ? formatBytes(r.quota_mb) : 'Unlimited'), align: 'right' },
          { label: 'Utilisation', render: (r) => h`<div class="u-s74">${progress(r.used_mb, r.quota_mb || 1, { showText: false })}</div>` },
        ],
        rows,
      })}`;
    return page(ctx, { title: 'Email Usage', subtitle: 'Mailbox storage and quotas', body });
  });

  /* --------------------------------------------------------- mail onboarding */
  function dnsAuthHealth(domain) {
    const rows = all('SELECT name, type, value FROM dns_records WHERE domain_id = (SELECT id FROM domains WHERE name = ?)', domain);
    const txt = rows.filter((r) => r.type === 'TXT');
    const spf = txt.some((r) => r.name === '@' && String(r.value).includes('v=spf1'));
    const dmarc = txt.some((r) => String(r.name).includes('_dmarc') && String(r.value).includes('v=DMARC1'));
    const dkim = txt.some((r) => String(r.name).includes('_domainkey')) || !!dkimStatus(domain).exists;
    return { spf, dmarc, dkim, zoneRecords: rows.length };
  }

  function setupPage(ctx, account, extra = '') {
    const host = `mail.${account.domain}`;
    const autoUrl = `https://${ctx.req.headers.host || 'panel'}/mail/config-v1.1.xml?email=${encodeURIComponent(`${account.local_part}@${account.domain}`)}`;
    const qr = qrSvg(autoUrl, { size: 180 });
    const auth = dnsAuthHealth(account.domain);
    return page(ctx, {
      title: 'Mail setup guide',
      subtitle: `${account.local_part}@${account.domain}`,
      body: h`${mailNav(ctx, 'setup')}
        ${extra ? alert(extra, extra.includes('✅') ? 'ok' : 'warn') : ''}
        <div class="grid grid-2">
          ${card('Server settings', h`${kvList([
            ['E-mail', `${account.local_part}@${account.domain}`],
            ['Username', `${account.local_part}@${account.domain}`],
            ['IMAP host', host],
            ['IMAP SSL', '993 (SSL/TLS)'],
            ['IMAP STARTTLS', '143'],
            ['SMTP host', host],
            ['SMTP submission', '587 (STARTTLS)'],
            ['SMTP SSL', '465 (SSL/TLS)'],
            ['Webmail', h`<a class="link" href="/webmail?email=${encodeURIComponent(`${account.local_part}@${account.domain}`)}">Otwórz webmail</a>`],
          ])}<p class="small muted mt-12">Hasło to hasło skrzynki ustawione w panelu. Nie wysyłamy go e-mailem.</p>`)}
          ${card('Autokonfiguracja', h`<p class="small muted">Klient poczty może pobrać ustawienia automatycznie z tego adresu (Thunderbird / Outlook / Apple Mail).</p>
            <pre class="code-block small">${autoUrl}</pre>
            ${qr ? h`<div class="u-s66">${raw(qr)}<p class="small muted">Zeskanuj kod, aby otworzyć autokonfigurację.</p></div>` : ''}
            <form method="post" action="/user/email/${account.id}/test" class="mt-12"><input type="hidden" name="_csrf" value="${ctx.csrf}"><button class="btn btn-secondary btn-sm" type="submit">Test połączenia IMAP/SMTP</button></form>`)}
        </div>
        ${card('DNS poczty', h`<div class="stack">
          <div class="spread"><span>SPF</span>${badge(auth.spf ? 'opublikowany' : 'brak rekordu', auth.spf ? 'ok' : 'warn', { dot: true })}</div>
          <div class="spread"><span>DMARC</span>${badge(auth.dmarc ? 'opublikowany' : 'brak rekordu', auth.dmarc ? 'ok' : 'warn', { dot: true })}</div>
          <div class="spread"><span>DKIM</span>${badge(auth.dkim ? 'klucz opublikowany' : 'brak klucza', auth.dkim ? 'ok' : 'warn', { dot: true })}</div>
          <p class="small muted">Rekordów w strefie: ${auth.zoneRecords}. Braki uzupełnisz w DNS; panel pokazuje realny stan strefy, nie obietnicę.</p>
          <a class="link" href="/user/dns?domain=${encodeURIComponent(account.domain)}">Otwórz DNS domeny →</a>
        </div>`)}`,
    });
  }

  router.get('/user/email/setup', (ctx) => {
    const rows = all(`SELECT e.* FROM email_accounts e JOIN domains d ON d.id = e.domain_id
      WHERE d.user_id = ? ORDER BY e.domain, e.local_part LIMIT 100`, ctx.user.id);
    if (!rows.length) return ctx.redirect('/user/email');
    const selected = rows.find((r) => String(r.id) === String(ctx.query.id)) || rows[0];
    return setupPage(ctx, selected);
  });

  router.get('/user/email/:id/setup', (ctx) => {
    const account = get(`SELECT e.* FROM email_accounts e JOIN domains d ON d.id = e.domain_id
      WHERE e.id = ? AND d.user_id = ?`, Number(ctx.params.id), ctx.user.id);
    if (!account) return ctx.redirect('/user/email?flash=Mailbox%20not%20found&type=error');
    return setupPage(ctx, account);
  });

  router.post('/user/email/:id/test', (ctx) => {
    const account = get(`SELECT e.* FROM email_accounts e JOIN domains d ON d.id = e.domain_id
      WHERE e.id = ? AND d.user_id = ?`, Number(ctx.params.id), ctx.user.id);
    if (!account) return ctx.redirect('/user/email?flash=Mailbox%20not%20found&type=error');
    const probe = (port) => new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port, timeout: 1200 });
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('timeout', () => { socket.destroy(); resolve(false); });
      socket.once('error', () => resolve(false));
    });
    return Promise.all([probe(1143), probe(25)]).then(([imap, smtp]) => setupPage(ctx, account,
      `Test portów: IMAP ${imap ? '✅ otwarty' : '❌ zamknięty'}, SMTP ${smtp ? '✅ otwarty' : '❌ zamknięty'}. To test dostępności usług, nie weryfikacja hasła.`));
  });


}

void randomPassword;
