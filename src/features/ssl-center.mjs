// Administrator AutoSSL and service certificate management.
import { all } from '../db.mjs';
import { html as h, formatDate } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, table, badge, alert, tabs, form, field, kvList } from '../ui/components.mjs';
import { autoSslStatus, setSslKeyType, issueCertificate, renewExpiring, installServiceCert, logs } from '../autossl.mjs';

const A = '/admin/ssl-center';

export function register(router) {
  router.get(A, (ctx) => {
    const tab = ['overview', 'logs', 'service'].includes(String(ctx.query.tab)) ? String(ctx.query.tab) : 'overview';
    const st = autoSslStatus();
    const domains = all('SELECT name FROM domains ORDER BY name');
    const body = h`
      ${tabs([{ key: 'overview', label: 'Certyfikaty', count: st.certs.length }, { key: 'logs', label: 'Logi', count: st.logs.length }, { key: 'service', label: 'Certyfikat usług' }], tab, { base: A })}
      ${tab === 'overview' ? h`
        ${card('AutoSSL', h`${kvList([['Certbot', st.certbot || 'brak — używany self-signed'], ['Wygasające <30 dni', String(st.expiring.length)], ['Typ klucza', st.keyType]])}
          <form method="post" action="${A}/keytype" class="row mt-18"><input type="hidden" name="_csrf" value="${ctx.csrf}">
            <select name="type">${['rsa2048', 'rsa4096', 'ecdsa-p256'].map((t) => h`<option ${t === st.keyType ? 'selected' : ''}>${t}</option>`)}</select>
            <button class="btn btn-secondary" type="submit">Zmień typ klucza</button></form>
          <form method="post" action="${A}/renew" class="mt-12"><input type="hidden" name="_csrf" value="${ctx.csrf}"><button class="btn btn-secondary" type="submit">Odnów wygasające</button></form>`)}
        ${card('Wystaw certyfikat', form([
          field({ name: 'domain', label: 'Domena', type: 'select', options: domains.map((d) => d.name) }),
          field({ name: 'email', label: 'E-mail ACME (opcjonalnie)' }),
        ], { action: `${A}/issue`, csrf: ctx.csrf, submit: 'Wystaw' }))}
        ${card('Aktywne certyfikaty', table({
          columns: [
            { label: 'Domena', key: 'domain' }, { label: 'Typ', key: 'type' }, { label: 'Klucz', key: 'key_type' },
            { label: 'Wygasa', render: (r) => r.expires_at ? formatDate(r.expires_at, { time: true }) : '—' },
            { label: 'Status', render: (r) => new Date(r.expires_at).getTime() - Date.now() < 30 * 864e5 ? badge('wygasa', 'warn') : badge('OK', 'ok') },
          ],
          rows: st.certs,
          empty: 'Brak certyfikatów.',
        }), { padded: false })}
        ${alert('Bez publicznego DNS i portu 80 certbot nie wystawi Let’s Encrypt; panel użyje self-signed i pokaże to w logu.', 'info')}
      ` : ''}
      ${tab === 'logs' ? h`${card('Logi AutoSSL', table({
        columns: [{ label: 'Czas', render: (r) => formatDate(r.created_at, { time: true }) }, { label: 'Domena', key: 'domain' }, { label: 'Akcja', key: 'action' }, { label: 'Status', render: (r) => badge(r.status, r.status === 'ok' ? 'ok' : 'danger') }, { label: 'Szczegóły', render: (r) => h`<span class="small muted">${r.detail || '—'}</span>` }],
        rows: logs(200), empty: 'Brak logów.',
      }), { padded: false })}` : ''}
      ${tab === 'service' ? h`
        ${card('Certyfikat dla Exim/Dovecot', form([
          field({ name: 'domain', label: 'Domena certyfikatu', type: 'select', options: st.certs.map((c) => c.domain) }),
        ], { action: `${A}/service`, csrf: ctx.csrf, submit: 'Zainstaluj dla usług' }))}
        ${alert('Zapisuje certyfikat w /etc/openadmin/service-tls, tworzy drop-in Exima/Dovecota, waliduje i przeładowuje usługi. Wymaga roota na Linuxie.', 'warn')}
      ` : ''}`;
    return page(ctx, { title: 'AutoSSL Center', subtitle: 'Certyfikaty, odnowienia i TLS usług', body, wide: true });
  });

  router.post(`${A}/keytype`, (ctx) => {
    const r = setSslKeyType(ctx.body.type, ctx.user.username);
    return ctx.redirect(`${A}?flash=${encodeURIComponent(r.ok ? 'Typ klucza zapisany' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/issue`, (ctx) => {
    const r = issueCertificate(ctx.body.domain, { email: ctx.body.email, actor: ctx.user.username });
    return ctx.redirect(`${A}?flash=${encodeURIComponent(r.ok ? 'Certyfikat wystawiony' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/renew`, (ctx) => {
    const out = renewExpiring(ctx.user.username);
    return ctx.redirect(`${A}?tab=logs&flash=${encodeURIComponent(out.length ? `Odnowiono ${out.filter((x) => x.ok).length}/${out.length}` : 'Brak certyfikatów do odnowienia')}`);
  });
  router.post(`${A}/service`, (ctx) => {
    const r = installServiceCert(ctx.body.domain, ctx.user.username);
    return ctx.redirect(`${A}?tab=service&flash=${encodeURIComponent(r.ok ? 'Certyfikat usług zainstalowany' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
}
