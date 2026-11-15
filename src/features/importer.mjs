// Admin UI for cPanel / DirectAdmin backup migration.
import fs from 'node:fs';
import path from 'node:path';
import { runPreflight } from '../preflight.mjs';
import { config } from '../config.mjs';
import { all, setting } from '../db.mjs';
import { html as h } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, alert, kvList, table, badge } from '../ui/components.mjs';
import { detectKind, importArchive, previewArchive } from '../importer.mjs';

const MAX_UPLOAD = 7 * 1024 * 1024;

export function register(router) {
  router.get('/admin/import', (ctx) => {
    const users = all("SELECT * FROM users WHERE level IN ('user','reseller') ORDER BY username");
    const body = h`
      ${alert('Obsługiwane są archiwa cPanel (cpmove-*.tar.gz) i DirectAdmin (backup .tar.gz). Import obejmuje pliki strony, strefy DNS i dumpy MySQL. Haseł e-mail nie da się przenieść — skrzynki trzeba utworzyć ponownie.', 'info')}
      ${card('Import backupu', h`<form method="post" action="/admin/import" class="oa-form" id="importForm">
        <input type="hidden" name="_csrf" value="${ctx.csrf}">
        <input type="hidden" name="data" id="importData">
        <input type="hidden" name="mode" id="importMode" value="import">
        <div class="form-grid">
          <div class="field"><label class="field-label">Konto docelowe</label><select name="target">${users.map((u) => h`<option value="${u.username}">${u.username} (${u.level})</option>`)}</select></div>
          <div class="field"><label class="field-label">Archiwum (do 7 MB przez przeglądarkę)</label><input type="file" id="importFile" accept=".gz,.tar.gz,.tgz"></div>
          <div class="field field-full"><label class="field-label">…albo ścieżka na serwerze (dla dużych plików)</label><input name="path" placeholder="/root/cpmove-user.tar.gz"></div>
        </div>
        <p class="small muted">Dla większych backupów wgraj plik przez SFTP do <code>${path.join(config.dataDir, 'imports')}</code> i podaj ścieżkę. Import nie nadpisuje istniejących domen — dopisuje rekordy DNS i pliki.</p>
        <div class="form-actions"><button class="btn btn-primary" type="submit" onclick="document.getElementById('importMode').value='import'">Analizuj i importuj</button> <button class="btn btn-secondary" type="submit" onclick="document.getElementById('importMode').value='preview'">Podgląd bez zmian</button></div>
      </form>`, { sub: 'Bezpieczne rozpakowanie, raport co zostało zaimportowane' })}
      ${card('Co jest importowane', h`<ul class="small" style="line-height:1.9;padding-left:18px">
        <li><strong>Pliki:</strong> katalogi <code>public_html</code> trafiają do odpowiednich domen.</li>
        <li><strong>DNS:</strong> rekordy A/AAAA/CNAME/MX/TXT/SRV/CAA ze stref <code>dnszones/*.db</code>.</li>
        <li><strong>Bazy:</strong> pliki <code>mysql/*.sql</code> są tworzone jako <code>użytkownik_nazwa</code>.</li>
        <li><strong>Pomijane:</strong> hasła e-mail, ustawienia PHP, cron — pokażemy je w raporcie.</li>
      </ul>`)}
      <script>
      (function(){
        var form=document.getElementById('importForm'), file=document.getElementById('importFile'), data=document.getElementById('importData');
        form.addEventListener('submit', function(e){
          if (!file.files.length) return;
          e.preventDefault();
          var f=file.files[0];
          if (f.size > ${MAX_UPLOAD}) { alert('Plik jest za duży dla przeglądarki (limit 7 MB). Użyj ścieżki na serwerze.'); return; }
          var r=new FileReader();
          r.onload=function(){ data.value=String(r.result).split(',')[1]||''; form.submit(); };
          r.readAsDataURL(f);
        });
      })();
      </script>`;
    return page(ctx, { title: 'Migracja z cPanel / DirectAdmin', subtitle: 'Import konta z backupu', body, wide: true });
  });

  router.post('/admin/import', async (ctx) => {
    const target = String(ctx.body.target || '');
    let file = String(ctx.body.path || '').trim();
    let temp = null;
    if (ctx.body.data) {
      try {
        const buf = Buffer.from(String(ctx.body.data), 'base64');
        if (buf.length > MAX_UPLOAD) return ctx.redirect('/admin/import?flash=Plik%20za%20du%C5%BCy&type=error');
        const dir = path.join(config.dataDir, 'imports');
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        temp = path.join(dir, `upload-${Date.now()}.tar.gz`);
        fs.writeFileSync(temp, buf, { mode: 0o600 });
        file = temp;
      } catch (e) {
        return ctx.redirect('/admin/import?flash=' + encodeURIComponent(e.message) + '&type=error');
      }
    }
    if (!file) return ctx.redirect('/admin/import?flash=Wybierz%20plik&type=error');
    if (!file.startsWith('/')) file = path.join(config.dataDir, 'imports', file);
    if (!fs.existsSync(file)) return ctx.redirect('/admin/import?flash=Plik%20nie%20istnieje&type=error');
    let detected;
    try { detected = detectKind(file); } catch (e) { detected = { ok: false, error: e.message }; }
    if (!detected.ok) { try { fs.rmSync(temp, { force: true }); } catch {} return ctx.redirect('/admin/import?flash=' + encodeURIComponent(detected.error) + '&type=error'); }
    if (String(ctx.body.mode || 'import') === 'preview') {
      let plan;
      try { plan = previewArchive(file); } catch (e) { plan = { ok: false, error: e.message }; }
      try { fs.rmSync(temp, { force: true }); } catch { /* ignore */ }
      if (!plan.ok) return ctx.redirect('/admin/import?flash=' + encodeURIComponent(plan.error || 'Nie udało się przeanalizować archiwum') + '&type=error');
      const body = h`${card('Plan importu — bez zmian', h`
        ${alert('To tylko podgląd. Nie utworzono kont, domen, rekordów DNS ani baz.', 'info')}
        ${kvList([
          ['Konto docelowe', target],
          ['Wykryty typ', plan.kind?.kind || 'generic'],
          ['Pliki w archiwum', String(plan.counts.files)],
          ['Strony / webrooty', String(plan.counts.webroots)],
          ['Domeny', plan.domains.join(', ') || 'brak'],
          ['Strefy DNS', plan.zones.join(', ') || 'brak'],
          ['Dumpy MySQL', plan.sqlFiles.join(', ') || 'brak'],
          ['Przykładowe pliki', plan.sampleFiles.slice(0, 8).join(', ') || 'brak'],
        ])}
      `)}
      ${card('Co zostanie zrobione po imporcie', h`<ul class="small" style="line-height:1.9;padding-left:18px">
        <li>Pliki trafią do katalogu użytkownika <strong>${target}</strong>.</li>
        <li>Domeny: <strong>${plan.domains.length}</strong>; rekordy DNS zostaną dopisane, bez kasowania istniejących.</li>
        <li>Bazy: <strong>${plan.counts.databases}</strong>; nazwy zostaną poprzedzone nazwą konta.</li>
        <li>Hasła e-mail, PHP i cron nie są przenoszone.</li>
      </ul>`)}
      <p><a class="btn btn-secondary" href="/admin/import">Wróć</a></p>`;
      return page(ctx, { title: 'Podgląd importu', subtitle: `Plan dla ${target}`, body, wide: true });
    }
    const pre = await runPreflight('import', { source: file, targetUsername: target });
    if (pre.blocked) { try { fs.rmSync(temp, { force: true }); } catch {} return ctx.redirect('/admin/import?flash=' + encodeURIComponent(`Preflight zablokował import: ${pre.checks.filter((c) => !c.ok && c.blocking).map((c) => c.label).join(', ')}`) + '&type=error'); }
    let result;
    try { result = importArchive({ filePath: file, targetUsername: target }); }
    catch (e) { result = { ok: false, error: e.message }; }
    try { fs.rmSync(temp, { force: true }); } catch { /* ignore */ }
    if (!result.ok) return ctx.redirect('/admin/import?flash=' + encodeURIComponent(result.error) + '&type=error');
    const body = h`${card('Import zakończony', h`
      ${alert('Backup został zaimportowany. Sprawdź strony i bazy przed przełączeniem DNS.', 'ok')}
      ${kvList([
        ['Typ backupu', result.kind],
        ['Domeny', result.domains.map((d) => `${d.domain} (+${d.records} rekordów)`).join(', ') || 'brak'],
        ['Rekordy DNS', String(result.dns)],
        ['Pliki', String(result.files)],
        ['Bazy danych', result.databases.join(', ') || 'brak'],
      ])}
      ${result.skipped.length ? h`<h3 class="form-section">Pominięte</h3><ul class="small">${result.skipped.map((s) => h`<li>${s}</li>`)}</ul>` : ''}
      <div class="row mt-18"><a class="btn btn-primary" href="/admin/users">Konta</a><a class="btn btn-secondary" href="/admin/health">Stan serwera</a><a class="btn btn-ghost" href="/admin/import">Kolejny import</a></div>`)}`;
    return page(ctx, { title: 'Wynik importu', subtitle: 'cPanel / DirectAdmin', body, wide: true });
  });
}
