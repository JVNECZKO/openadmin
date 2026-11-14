// Administrator panel branding, ACL, network and settings export.
import { html as h } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, alert, tabs, form, field, kvList } from '../ui/components.mjs';
import { branding, saveBranding, acl, saveAcl, network, saveNetwork, exportSettings, importSettings, restartNow } from '../panelconfig.mjs';

const A = '/admin/panel-config';

export function register(router) {
  router.get(A, (ctx) => {
    const tab = ['branding', 'access', 'network', 'export'].includes(String(ctx.query.tab)) ? String(ctx.query.tab) : 'branding';
    const b = branding();
    const a = acl();
    const n = network();
    const body = h`
      ${tabs([{ key: 'branding', label: 'Branding' }, { key: 'access', label: 'ACL' }, { key: 'network', label: 'Sieć' }, { key: 'export', label: 'Import/Export' }], tab, { base: A })}
      ${tab === 'branding' ? h`
        ${card('Branding', form([
          field({ name: 'name', label: 'Nazwa panelu', value: b.name, required: true }),
          field({ name: 'subtitle', label: 'Podtytuł', value: b.subtitle }),
          field({ name: 'logo', label: 'URL logo', value: b.logo, full: true, placeholder: 'https://example.com/logo.png lub /assets/logo.svg' }),
          field({ name: 'footer', label: 'Stopka', value: b.footer, full: true }),
          field({ name: 'webmail', label: 'Nazwa webmaila', value: b.webmail }),
          field({ name: 'support', label: 'URL wsparcia', value: b.support }),
          field({ name: 'timezone', label: 'Strefa czasowa', value: b.timezone }),
        ], { action: `${A}/branding`, csrf: ctx.csrf, submit: 'Zapisz branding' }))}
      ` : ''}
      ${tab === 'access' ? h`
        ${card('ACL panelu', form([
          field({ name: 'disable_domains', label: 'Zablokuj dodawanie domen', type: 'checkbox', value: a.disable_domains }),
          field({ name: 'disable_emails', label: 'Zablokuj pocztę', type: 'checkbox', value: a.disable_emails }),
          field({ name: 'disable_ssh', label: 'Zablokuj SSH/terminal', type: 'checkbox', value: a.disable_ssh }),
          field({ name: 'disable_system_apps', label: 'Zablokuj aplikacje systemowe', type: 'checkbox', value: a.disable_system_apps }),
          field({ name: 'max_addon_domains', label: 'Limit addon domen', type: 'number', value: a.max_addon_domains, min: 0 }),
          field({ name: 'read_only', label: 'Tryb read-only dla użytkowników i resellerów', type: 'checkbox', value: a.read_only }),
        ], { action: `${A}/access`, csrf: ctx.csrf, submit: 'Zapisz ACL' }), { sub: 'ACL jest sprawdzane w capabilities(); nie usuwa istniejących danych.' })}
      ` : ''}
      ${tab === 'network' ? h`
        ${card('Adres i porty', form([
          field({ name: 'hostname', label: 'Hostname panelu', value: n.hostname }),
          field({ name: 'port', label: 'Port panelu', type: 'number', value: n.port, min: 1, max: 65535 }),
          field({ name: 'alias', label: 'Alias panelu', value: n.alias }),
          field({ name: 'enduserPort', label: 'Port enduser (planowany)', type: 'number', value: n.enduserPort }),
        ], { action: `${A}/network`, csrf: ctx.csrf, submit: 'Zapisz sieć' }))}
        <form method="post" action="${A}/restart"><input type="hidden" name="_csrf" value="${ctx.csrf}"><button class="btn btn-danger" type="submit" onclick="return confirm('Zrestartować panel? Połączenie zostanie przerwane.')">Restart panelu</button></form>
        ${alert('Zmiana portu wymaga restartu. Alias wymaga zewnętrznego reverse proxy/SNI; panel zapisuje ustawienie, ale sam nie tworzy vhosta dla aliasu.', 'warn')}
      ` : ''}
      ${tab === 'export' ? h`
        ${card('Eksport ustawień', h`<pre class="code-block small">${JSON.stringify(exportSettings(), null, 2)}</pre>
          <form method="post" action="${A}/export/download"><input type="hidden" name="_csrf" value="${ctx.csrf}"><button class="btn btn-secondary" type="submit">Pobierz JSON</button></form>`)}
        ${card('Import ustawień', h`<form method="post" action="${A}/import" class="oa-form"><input type="hidden" name="_csrf" value="${ctx.csrf}">
          <textarea name="json" rows="12" class="code-block" placeholder='{"brand_name":"..."}'></textarea>
          <div class="form-actions"><button class="btn btn-primary" type="submit">Importuj</button></div></form>`)}
      ` : ''}`;
    return page(ctx, { title: 'Panel Configuration', subtitle: 'Branding, ACL, sieć i ustawienia', body, wide: true });
  });

  router.post(`${A}/branding`, (ctx) => {
    const r = saveBranding(ctx.body, ctx.user.username);
    return ctx.redirect(`${A}?tab=branding&flash=${encodeURIComponent(r.ok ? 'Branding zapisany' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/access`, (ctx) => {
    saveAcl(ctx.body, ctx.user.username);
    return ctx.redirect(`${A}?tab=access&flash=ACL%20zapisany`);
  });
  router.post(`${A}/network`, (ctx) => {
    const r = saveNetwork(ctx.body, ctx.user.username);
    return ctx.redirect(`${A}?tab=network&flash=${encodeURIComponent(r.ok ? r.restart : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/restart`, (ctx) => {
    const r = restartNow();
    return ctx.redirect(`${A}?tab=network&flash=${encodeURIComponent(r.ok ? 'Restart panelu za chwilę' : r.error)}`);
  });
  router.post(`${A}/export/download`, (ctx) => {
    return { status: 200, raw: JSON.stringify(exportSettings(), null, 2), type: 'application/json' };
  });
  router.post(`${A}/import`, (ctx) => {
    const r = importSettings(ctx.body.json, ctx.user.username);
    return ctx.redirect(`${A}?tab=export&flash=${encodeURIComponent(r.ok ? `Zaimportowano ${r.count} ustawień` : r.error)}${r.ok ? '' : '&type=error'}`);
  });
}
