// Database management backed by a real MariaDB server when one is reachable.
// Without a server the panel records the database metadata and says so.
import { all, get, run, nowIso, hashPassword, audit } from '../db.mjs';
import { limitsFor } from '../auth.mjs';
import { html as h, formatBytes, formatDate, randomPassword } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, badge, alert, kvList, btn, emptyState } from '../ui/components.mjs';
import { listCard } from '../ui/pages/list.mjs';
import { quota } from '../core/access.mjs';
import { detect, listDatabases, databaseSizes, createDatabase, dropDatabase, createAccount, dropAccount } from '../mariadb.mjs';
import { encryptSecret, ssoToken, ssoErrorMessage, impersonationForSession } from '../secrets.mjs';
import { status as appStatus, phpMyAdminSsoEnabled, pmaSignonCookie } from '../apps.mjs';

/** Availability of the phpMyAdmin hand-off, with a reason for the UI. */
function pmaState() {
  const app = appStatus('phpmyadmin');
  const installed = !!app?.installed;
  const running = !!app?.running;
  const sso = installed && phpMyAdminSsoEnabled();
  let reason = '';
  if (!installed) reason = 'phpMyAdmin nie jest zainstalowany. Administrator może go zainstalować w Admin → Web Apps.';
  else if (!sso) reason = 'Jednokrotne logowanie nie jest skonfigurowane. Administrator może je włączyć w Admin → Web Apps.';
  else if (!running) reason = 'phpMyAdmin jest zainstalowany, ale nie działa. Uruchom go w Admin → Web Apps.';
  return { app, installed, running, sso, reason };
}

function pmaCell(ctx, row, state) {
  if (!state.installed) return h`<span class="small muted" title="${state.reason}">niedostępne</span>`;
  if (!state.sso) return h`<span class="small muted" title="${state.reason}">SSO wyłączone</span>`;
  if (!state.running) return h`<span class="small muted" title="${state.reason}">zatrzymane</span>`;
  if (!row.id || !row.password_enc) {
    return h`<span class="small muted" title="Brak zapisanego hasła bazy — ustaw hasło, aby otworzyć phpMyAdmin bez drugiego logowania.">brak hasła</span>`;
  }
  return h`<form method="post" action="/user/databases/${row.id}/phpmyadmin" class="inline">
    <button class="btn btn-secondary btn-sm" type="submit" title="Otwórz phpMyAdmin dla ${row.db_name} — jednorazowe logowanie">phpMyAdmin</button></form>`;
}

function pmaErrorNotice(ctx, rows) {
  const code = String(ctx.query.pma_error || '');
  if (!code) return '';
  const requested = String(ctx.query.pma_db || '');
  const row = requested ? rows.find((r) => r.db_name === requested) : null;
  const retry = row?.id
    ? h` <form method="post" action="/user/databases/${row.id}/phpmyadmin" class="inline"><button class="btn btn-secondary btn-sm" type="submit">Spróbuj ponownie</button></form>`
    : h` <a class="btn btn-secondary btn-sm" href="/user/databases">Spróbuj ponownie</a>`;
  return alert(h`<strong>Nie udało się otworzyć phpMyAdmin.</strong> ${ssoErrorMessage(code)}${retry}`, 'danger');
}

export function register(router) {
  router.get('/user/databases', (ctx) => {
    const meta = all('SELECT * FROM databases WHERE user_id = ? ORDER BY db_name', ctx.user.id);
    const lim = limitsFor(ctx.user);
    const mst = detect();
    const live = mst.connected ? (listDatabases().rows || []) : [];
    const sizes = mst.connected ? (databaseSizes().map || {}) : {};
    const known = new Set(meta.map((m) => m.db_name));
    const rows = meta.map((m) => ({ ...m, live: live.includes(m.db_name), size: sizes[m.db_name] ?? m.size_mb }));
    for (const db of live.filter((d) => d.startsWith(ctx.user.username + '_') && !known.has(d))) {
      rows.push({ id: null, db_name: db, db_user: '—', live: true, size: sizes[db] || 0, created_at: null });
    }
    const total = rows.reduce((a, r) => a + (Number(r.size) || 0), 0);
    const q = String(ctx.query.q || '').trim().toLowerCase();
    const filtered = q ? rows.filter((r) => `${r.db_name} ${r.db_user}`.toLowerCase().includes(q)) : rows;
    const shown = filtered.slice(0, 100);
    const pma = pmaState();
    const body = h`
      ${pmaErrorNotice(ctx, rows)}
      ${mst.connected
        ? alert(h`Połączono z <strong>MariaDB ${mst.version}</strong> jako <code>${mst.currentUser}</code>. Bazy są tworzone na serwerze natychmiast.`, 'ok')
        : alert(h`MariaDB nie jest osiągalna z panelu, więc nowe bazy są tylko zapisywane, a nie tworzone na serwerze. Zainstaluj ją na hoście (instalator obsługuje <code>--with-mariadb</code>) albo ustaw <code>OA_MYSQL_ADMIN_USER</code> / <code>OA_MYSQL_ADMIN_PASSWORD</code>.`, 'warn')}
      ${pma.installed && !pma.sso ? alert(h`${pma.reason} ${ctx.user.level === 'admin' ? h`<a class="link" href="/admin/web-apps">Przejdź do Admin → Web Apps</a>` : 'Poproś administratora o włączenie jednokrotnego logowania.'}`, 'info') : ''}
      ${!pma.installed ? alert(pma.reason, 'info') : ''}
      ${listCard({
        title: 'Bazy danych', sub: `${filtered.length} z ${lim.databases || '∞'} · ${formatBytes(total)} · ${mst.connected ? 'serwer live' : 'tylko metadane'}`, footer: h`<form method="get" action="/user/databases" class="row"><input name="q" value="${q}" placeholder="Szukaj bazy lub użytkownika" style="flex:1;max-width:320px"><button class="btn btn-secondary btn-sm" type="submit">Filtruj</button></form>`,
        columns: [
          { label: 'Baza danych', render: (r) => h`<span class="cell-strong">${r.db_name}</span><span class="cell-sub">user: ${r.db_user}</span>` },
          { label: 'Stan', render: (r) => (mst.connected ? (r.live ? badge('na serwerze', 'ok') : badge('brak', 'danger')) : badge('zapisana', 'muted')) },
          { label: 'Rozmiar', render: (r) => formatBytes(r.size), align: 'right' },
          { label: 'Utworzono', render: (r) => (r.created_at ? formatDate(r.created_at) : '—') },
          { label: 'phpMyAdmin', render: (r) => pmaCell(ctx, r, pma) },
        ],
        rows: shown,
        empty: q ? 'Brak baz pasujących do filtra.' : 'Brak baz danych.',
        createHref: '/user/databases/create', createLabel: 'Dodaj bazę',
        actions: [
          { label: 'Hasło', href: (r) => (r.id ? `/user/databases/${r.id}/password` : '#'), icon: 'key', show: (r) => !!r.id },
          { label: 'Usuń', form: (r) => `/user/databases/${r.id}/delete`, confirm: 'Delete this database and all its tables?', icon: 'trash', danger: true, show: (r) => !!r.id },
        ],
      })}
      <div class="grid grid-2">
        ${card('Szczegóły połączenia', h`${kvList([
          ['Host', 'localhost'],
          ['Port', '3306'],
          ['Serwer', mst.connected ? mst.version : 'niepołączony'],
          ['Prefiks konta', ctx.user.username + '_'],
          ['phpMyAdmin', pma.sso && pma.running
            ? h`<span class="badge badge-ok">jednokrotne logowanie</span>`
            : h`<span class="small muted">niedostępne — ${pma.reason || 'brak zapisanego hasła bazy'}</span>`],
        ])}`)}
        ${card('Dostęp klienta', h`<pre class="code-block">mysql -h localhost -u ${ctx.user.username}_app -p
SHOW DATABASES;</pre>
        <p class="small muted mt-12">Użyj hasła ustawionego przy tworzeniu bazy. Przycisk phpMyAdmin otwiera bazę bez drugiego logowania tylko wtedy, gdy zapisano dla niej dane dostępowe.</p>`)}
      </div>`;
    return page(ctx, { title: 'Bazy danych', subtitle: 'Bazy MySQL / MariaDB', body });
  });

  router.get('/user/databases/create', (ctx) => {
    const q = quota(ctx.user, 'databases');
    const mst = detect();
    const body = h`${card('Dodaj bazę danych', h`<form method="post" action="/user/databases/create" class="oa-form">
      <input type="hidden" name="_csrf" value="${ctx.csrf}">
      ${!q.ok ? alert(`Osiągnięto limit baz (${q.used}/${q.limit}).`, 'warn') : ''}
      ${!mst.connected ? alert('Brak połączenia z MariaDB: baza zostanie zapisana, ale nie utworzona na serwerze.', 'warn') : ''}
      <div class="form-grid">
        <div class="field"><label class="field-label">Nazwa bazy <span class="req">*</span></label>
          <div class="input-group"><span class="input-prefix">${ctx.user.username}_</span><input name="name" required pattern="[a-zA-Z0-9_]{1,32}" placeholder="app"></div>
          <p class="field-help">Tylko litery, cyfry i podkreślenia.</p></div>
        <div class="field"><label class="field-label">Użytkownik bazy</label>
          <div class="input-group"><span class="input-prefix">${ctx.user.username}_</span><input name="db_user" pattern="[a-zA-Z0-9_]{1,32}" placeholder="app"></div></div>
        <div class="field"><label class="field-label">Hasło</label>
          <div class="field-control"><input id="dbpass" name="password" type="password" minlength="8" placeholder="Pozostaw puste, aby wygenerować" autocomplete="new-password">
            <button class="btn btn-secondary btn-sm" type="button" data-genpass="#dbpass" style="margin-left:8px">Wygeneruj</button></div>
          <p class="field-help">Jeśli pozostawisz puste, panel wygeneruje silne hasło i pokaże je tylko raz.</p></div>
        <div class="field"><label class="field-label">Kodowanie znaków</label><select name="charset"><option>utf8mb4</option><option>utf8</option><option>latin1</option></select></div>
      </div>
      <div class="form-actions"><button class="btn btn-primary" type="submit" ${!q.ok ? 'disabled' : ''}>Dodaj bazę</button><a class="btn btn-ghost" href="/user/databases">Anuluj</a></div>
    </form>`)}`;
    return page(ctx, { title: 'Dodaj bazę danych', subtitle: 'Utwórz bazę MariaDB i użytkownika', body });
  });

  router.post('/user/databases/create', (ctx) => {
    const q = quota(ctx.user, 'databases');
    if (!q.ok) return ctx.redirect('/user/databases?flash=Osi%C4%85gni%C4%99to%20limit%20baz&type=error');
    const name = String(ctx.body.name || '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 32);
    if (!name) return ctx.redirect('/user/databases?flash=Invalid%20database%20name&type=error');
    const dbName = `${ctx.user.username}_${name}`;
    const dbUser = `${ctx.user.username}_${String(ctx.body.db_user || name).replace(/[^a-zA-Z0-9_]/g, '').slice(0, 32)}`;
    if (get('SELECT id FROM databases WHERE db_name = ?', dbName)) return ctx.redirect('/user/databases?flash=Baza%20ju%C5%BC%20istnieje&type=error');
    const password = String(ctx.body.password || '') || randomPassword(20);
    const mst = detect();
    if (mst.connected) {
      const created = createDatabase(dbName);
      if (!created.ok) return ctx.redirect('/user/databases?flash=' + encodeURIComponent(created.error) + '&type=error');
      const account = createAccount(dbName, dbUser, password);
      if (!account.ok) {
        dropDatabase(dbName);
        return ctx.redirect('/user/databases?flash=' + encodeURIComponent(account.error) + '&type=error');
      }
    }
    run('INSERT INTO databases(user_id, db_name, db_user, password, password_enc, size_mb, created_at) VALUES(?,?,?,?,?,?,?)',
      ctx.user.id, dbName, dbUser, hashPassword(password), encryptSecret(password), 0, nowIso());
    audit(ctx.user.username, ctx.user.level, 'database.create', dbName, ctx.ip);
    const body = h`<div class="grid grid-2">
      ${card('Baza danych utworzona', h`${alert(h`Baza <strong>${dbName}</strong> jest gotowa${mst.connected ? ' na serwerze MariaDB' : ' (zapisana lokalnie — MariaDB jest niedostępna)'}.`, 'ok')}
        ${kvList([['Baza', dbName], ['Użytkownik', dbUser], ['Host', 'localhost'], ['Hasło', h`<code>${password}</code>`]])}
        <p class="small muted">Hasło jest widoczne tylko teraz. Zapisz je w menedżerze haseł. Możesz je później zmienić w liście baz.</p>
        <div class="row mt-18"><a class="btn btn-primary" href="/user/databases">Wróć do baz danych</a><a class="btn btn-secondary" href="/user/databases/create">Utwórz kolejną</a></div>`)}
      ${card('Połączenie', h`<pre class="code-block">mysql -h localhost -u ${dbUser} -p
SHOW DATABASES;</pre><p class="small muted mt-12">Użyj powyższego hasła. phpMyAdmin otworzy tę bazę jednym kliknięciem, jeśli administrator włączył SSO.</p>`)}
    </div>`;
    return page(ctx, { title: 'Baza danych utworzona', subtitle: dbName, body });
  });

  /* --------------------------------------------------- phpMyAdmin SSO hand-off */
  router.post('/user/databases/:id/phpmyadmin', (ctx) => {
    const db = get('SELECT * FROM databases WHERE id = ? AND user_id = ?', Number(ctx.params.id), ctx.user.id);
    if (!db) return ctx.redirect('/user/databases?pma_error=db_missing');
    if (ctx.session?.support || impersonationForSession(ctx.cookies['OA_SESSION'])?.readOnly) {
      return ctx.redirect('/user/databases?pma_error=read_only');
    }
    const pma = pmaState();
    if (!pma.installed) return ctx.redirect('/user/databases?pma_error=unavailable&pma_db=' + encodeURIComponent(db.db_name));
    if (!pma.sso || !pma.running) return ctx.redirect('/user/databases?pma_error=sso_disabled&pma_db=' + encodeURIComponent(db.db_name));
    if (!db.password_enc) return ctx.redirect('/user/databases?pma_error=no_credential&pma_db=' + encodeURIComponent(db.db_name));
    // One-time, session-bound nonce. It is delivered to phpMyAdmin as an
    // HttpOnly cookie scoped to /phpmyadmin — never as a URL parameter.
    const token = ssoToken({
      userId: ctx.user.id,
      db: db.db_name,
      sessionToken: ctx.cookies['OA_SESSION'],
    });
    ctx.res.setHeader('Set-Cookie', pmaSignonCookie(token, { req: ctx.req }));
    audit(ctx.user.username, ctx.user.level, 'database.phpmyadmin.sso', db.db_name, ctx.ip);
    return ctx.redirect('/phpmyadmin/signon.php?db=' + encodeURIComponent(db.db_name));
  });

  router.get('/user/databases/:id/password', (ctx) => {
    const db = get('SELECT * FROM databases WHERE id = ? AND user_id = ?', Number(ctx.params.id), ctx.user.id);
    if (!db) return ctx.redirect('/user/databases?flash=Nie%20znaleziono%20bazy&type=error');
    const body = h`${card(`Zmiana hasła · ${db.db_name}`, h`<form method="post" action="/user/databases/${db.id}/password" class="oa-form">
      <input type="hidden" name="_csrf" value="${ctx.csrf}">
      <div class="form-grid"><div class="field field-full"><label class="field-label">Nowe hasło</label><input name="password" type="password" minlength="8" required></div></div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">Zmień hasło</button><a class="btn btn-ghost" href="/user/databases">Anuluj</a></div>
    </form>`)}`;
    return page(ctx, { title: 'Hasło bazy danych', subtitle: db.db_name, body });
  });

  router.post('/user/databases/:id/password', (ctx) => {
    const db = get('SELECT * FROM databases WHERE id = ? AND user_id = ?', Number(ctx.params.id), ctx.user.id);
    if (!db) return ctx.redirect('/user/databases?flash=Nie%20znaleziono%20bazy&type=error');
    const password = String(ctx.body.password || '');
    if (password.length < 8) return ctx.redirect(`/user/databases/${db.id}/password?flash=Password%20must%20be%208%2B%20characters&type=error`);
    if (detect().connected) {
      const r = createAccount(db.db_name, db.db_user, password);
      if (!r.ok) return ctx.redirect(`/user/databases/${db.id}/password?flash=${encodeURIComponent(r.error)}&type=error`);
    }
    run('UPDATE databases SET password = ?, password_enc = ? WHERE id = ?', hashPassword(password), encryptSecret(password), db.id);
    audit(ctx.user.username, ctx.user.level, 'database.password', db.db_name, ctx.ip);
    return ctx.redirect('/user/databases?flash=Password%20changed');
  });

  router.post('/user/databases/:id/delete', (ctx) => {
    const db = get('SELECT * FROM databases WHERE id = ? AND user_id = ?', Number(ctx.params.id), ctx.user.id);
    if (!db) return ctx.redirect('/user/databases?flash=Nie%20znaleziono%20bazy&type=error');
    let note = '';
    if (detect().connected) {
      const dropped = dropDatabase(db.db_name);
      if (dropped.ok) note = ' on the server';
      dropAccount(db.db_user);
    }
    run('DELETE FROM databases WHERE id = ?', db.id);
    audit(ctx.user.username, ctx.user.level, 'database.delete', db.db_name, ctx.ip);
    return ctx.redirect('/user/databases?flash=' + encodeURIComponent(`Database ${db.db_name} deleted${note}`));
  });

}
