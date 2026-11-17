// Admin health/readiness page with plain-language status and one-click fixes.
import { html as h } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, alert, badge, kvList, btn } from '../ui/components.mjs';
import { healthReport } from '../health.mjs';
import { apply } from '../apply.mjs';
import { runBackupJob, backupSettings, notifyAdmin } from '../scheduler.mjs';
import { sendMail } from '../mta.mjs';
import { get, setting, setSetting } from '../db.mjs';
import { enablePanelHttps } from '../setup.mjs';


export function register(router) {
  router.get('/admin/health', async (ctx) => {
    const report = await healthReport();
    const bs = backupSettings();
    const badgeFor = (s) => s === 'ok' ? badge('OK', 'ok', { dot: true }) : s === 'warn' ? badge('Uwaga', 'warn', { dot: true }) : badge('Błąd', 'danger', { dot: true });
    const body = h`
      ${report.counts.fail ? alert(`${report.counts.fail} rzeczy wymaga naprawy. Kliknij „Napraw”, aby wdrożyć konfigurację ponownie.`, 'danger') : report.counts.warn ? alert('Panel działa, ale kilka rzeczy warto poprawić.', 'warn') : alert('Wszystko działa.', 'ok')}
      ${card('Stan serwera', h`<div class="table-wrap"><table class="data-table responsive-table">
        <thead><tr><th>Element</th><th>Stan</th><th>Szczegóły</th><th class="col-actions">Naprawa</th></tr></thead>
        <tbody>${report.checks.map((c) => h`<tr>
          <td class="cell-strong" data-label="Element">${c.label}</td>
          <td data-label="Stan">${badgeFor(c.status)}</td>
          <td class="small muted" data-label="Szczegóły">${c.detail}</td>
          <td class="col-actions" data-label="Naprawa">${c.fix ? h`<form method="post" action="/admin/health/fix" class="inline">
            <input type="hidden" name="_csrf" value="${ctx.csrf}"><input type="hidden" name="action" value="${c.fix.action}">
            <button class="btn btn-secondary btn-sm" type="submit">${c.fix.label}</button></form>` : '—'}</td>
        </tr>`)}</tbody></table></div>`) }
      <div class="grid grid-2">
        ${card('Kopie zapasowe', h`<form method="post" action="/admin/health/settings" class="oa-form">
          <input type="hidden" name="_csrf" value="${ctx.csrf}">
          <div class="form-grid">
            <div class="field"><label class="field-label">Automatyczne kopie</label><select name="backup_enabled"><option value="1" ${bs.enabled ? 'selected' : ''}>Włączone (codziennie)</option><option value="0" ${bs.enabled ? '' : 'selected'}>Wyłączone</option></select></div>
            <div class="field"><label class="field-label">Przechowuj dni</label><input name="backup_retention_days" type="number" min="3" max="365" value="${bs.retentionDays}"></div>
            <div class="field"><label class="field-label">Minimalna liczba kopii</label><input name="backup_keep" type="number" min="1" max="30" value="${bs.keep}"></div>
            <div class="field"><label class="field-label">E-mail powiadomień</label><input name="notify_email" type="email" value="${bs.notifyEmail}"></div>
          </div>
          <p class="small muted">Ostatnia kopia: ${bs.lastRun || 'brak'} · kopie trafiają do katalogu danych panelu.</p>
          <div class="form-actions"><button class="btn btn-primary" type="submit">Zapisz</button></div>
        </form>
        <div class="row mt-18">
          <form method="post" action="/admin/health/fix" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}"><input type="hidden" name="action" value="backup">
            <button class="btn btn-secondary btn-sm" type="submit">Zrób kopię teraz</button></form>
          <form method="post" action="/admin/health/fix" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}"><input type="hidden" name="action" value="test-notify">
            <button class="btn btn-ghost btn-sm" type="submit">Wyślij test powiadomienia</button></form>
          <form method="post" action="/admin/health/fix" class="inline"><input type="hidden" name="_csrf" value="${ctx.csrf}"><input type="hidden" name="action" value="test-mail">
            <button class="btn btn-ghost btn-sm" type="submit">Wyślij test poczty</button></form>
        </div>`)}
        ${card('Szybkie naprawy', h`<div class="stack u-s49">
          <form method="post" action="/admin/health/fix"><input type="hidden" name="_csrf" value="${ctx.csrf}"><input type="hidden" name="action" value="apply">
            <button class="btn btn-primary" type="submit">Wdróż wszystko ponownie</button></form>
          <form method="post" action="/admin/health/fix"><input type="hidden" name="_csrf" value="${ctx.csrf}"><input type="hidden" name="action" value="web">
            <button class="btn btn-secondary" type="submit">Wdróż strony (vhosty + PHP)</button></form>
          <form method="post" action="/admin/health/fix"><input type="hidden" name="_csrf" value="${ctx.csrf}"><input type="hidden" name="action" value="dns">
            <button class="btn btn-secondary" type="submit">Wdróż DNS</button></form>
          <form method="post" action="/admin/health/fix"><input type="hidden" name="_csrf" value="${ctx.csrf}"><input type="hidden" name="action" value="mail">
            <button class="btn btn-secondary" type="submit">Wdróż pocztę</button></form>
        </div>`, { sub: 'Każda akcja pokaże wynik w dzienniku panelu' })}
      </div>`;
    return page(ctx, { title: 'Stan serwera', subtitle: 'Co działa, co wymaga naprawy', body, wide: true });
  });

  router.post('/admin/health/fix', (ctx) => {
    const action = String(ctx.body.action || '');
    let result = { ok: true, message: 'OK' };
    if (action === 'backup') {
      const r = runBackupJob({ force: true });
      result = { ok: r.ok, message: r.ok ? `Kopia: ${r.filename || 'gotowa'}` : r.error };
    } else if (action === 'test-mail') {
      const admin = get("SELECT * FROM users WHERE level='admin' ORDER BY id LIMIT 1");
      const to = String(ctx.body.to || admin?.email || '');
      const r = sendMail({ from: `panel@${setting('server_name', 'localhost')}`, to, subject: 'Test dostarczalności OpenAdmin', body: 'Jeśli to czytasz, poczta wychodząca działa.' });
      result = { ok: r.ok, message: r.ok ? `Wysłano test na ${to}` : r.output };
    } else if (action === 'test-notify') {
      const r = notifyAdmin('Test powiadomienia', 'To jest testowa wiadomość z panelu OpenAdmin.');
      result = { ok: r.ok, message: r.emailed ? 'Wysłano e-mail' : 'Zapisano w panelu (brak MTA lub adresu e-mail)' };
    } else if (action === 'https') {
      const r = enablePanelHttps();
      return ctx.redirect('/admin/setup?flash=' + encodeURIComponent(r.ok ? 'HTTPS gotowy — uruchom panel ponownie' : r.error) + (r.ok ? '' : '&type=error'));
    } else if (['web', 'dns', 'mail', 'apply'].includes(action)) {
      const r = action === 'apply' ? apply({ web: true, dns: true, mail: true, pools: true }) : apply({ [action]: true });
      result = { ok: r.ok, message: r.ok ? 'Wdrożono zmiany' : 'Wdrożenie zgłosiło błędy — sprawdź szczegóły niżej' };
    } else {
      result = { ok: false, message: 'Nieznana akcja' };
    }
    return ctx.redirect('/admin/health?flash=' + encodeURIComponent(result.message) + (result.ok ? '' : '&type=error'));
  });

  router.post('/admin/health/settings', (ctx) => {
    setSetting('backup_enabled', ctx.body.backup_enabled === '0' ? '0' : '1');
    setSetting('backup_retention_days', String(Math.max(3, Math.min(365, Number(ctx.body.backup_retention_days) || 14))));
    setSetting('backup_keep', String(Math.max(1, Math.min(30, Number(ctx.body.backup_keep) || 3))));
    setSetting('notify_email', String(ctx.body.notify_email || ''));
    return ctx.redirect('/admin/health?flash=' + encodeURIComponent('Ustawienia zapisane'));
  });
}
