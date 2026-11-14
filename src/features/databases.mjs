// Database management backed by a real MariaDB server when one is reachable.
// Without a server the panel records the database metadata and says so.
import { all, get, run, nowIso, hashPassword, audit } from '../db.mjs';
import { limitsFor } from '../auth.mjs';
import { html as h, formatBytes, formatDate } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, badge, alert, kvList, btn, emptyState } from '../ui/components.mjs';
import { listCard } from '../ui/pages/list.mjs';
import { quota } from '../core/access.mjs';
import { detect, listDatabases, databaseSizes, createDatabase, dropDatabase, createAccount, dropAccount } from '../mariadb.mjs';
import { encryptSecret, ssoToken } from '../secrets.mjs';
import { status as appStatus, phpMyAdminSsoEnabled } from '../apps.mjs';

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
    const body = h`
      ${mst.connected
        ? alert(`Connected to <strong>MariaDB ${mst.version}</strong> as <code>${mst.currentUser}</code>. Databases are created on the server immediately.`, 'ok')
        : alert('MariaDB is not reachable from the panel, so new databases are recorded but not created on a server. Install it on the host (the installer supports <code>--with-mariadb</code>) or set <code>OA_MYSQL_ADMIN_USER</code> / <code>OA_MYSQL_ADMIN_PASSWORD</code>.', 'warn')}
      ${listCard({
        title: 'Databases', sub: `${rows.length} of ${lim.databases || '∞'} · ${formatBytes(total)} used · ${mst.connected ? 'live server' : 'metadata only'}`,
        columns: [
          { label: 'Database', render: (r) => h`<span class="cell-strong">${r.db_name}</span><span class="cell-sub">user: ${r.db_user}</span>` },
          { label: 'State', render: (r) => (mst.connected ? (r.live ? badge('on server', 'ok') : badge('missing', 'danger')) : badge('recorded', 'muted')) },
          { label: 'Size', render: (r) => formatBytes(r.size), align: 'right' },
          { label: 'Created', render: (r) => (r.created_at ? formatDate(r.created_at) : '—') },
        ],
        rows,
        empty: 'No databases yet.',
        createHref: '/user/databases/create', createLabel: 'Create database',
        actions: [
          { label: 'phpMyAdmin', href: (r) => (r.password_enc && appStatus('phpmyadmin').installed && phpMyAdminSsoEnabled()
            ? `/phpmyadmin/signon.php?token=${encodeURIComponent(ssoToken({ userId: ctx.user.id, db: r.db_name }))}`
            : `/phpmyadmin/?db=${encodeURIComponent(r.db_name)}`), icon: 'database' },
          { label: 'Hasło', href: (r) => (r.id ? `/user/databases/${r.id}/password` : '#'), icon: 'key', show: (r) => !!r.id },
          { label: 'Delete', form: (r) => `/user/databases/${r.id}/delete`, confirm: 'Delete this database and all its tables?', icon: 'trash', danger: true, show: (r) => !!r.id },
        ],
      })}
      <div class="grid grid-2">
        ${card('Connection details', h`${kvList([
          ['Host', 'localhost'],
          ['Port', '3306'],
          ['Server', mst.connected ? mst.version : 'not connected'],
          ['Account prefix', ctx.user.username + '_'],
          ['phpMyAdmin', h`<a class="link" href="/phpmyadmin/">/phpmyadmin/</a>`],
        ])}`)}
        ${card('Client access', h`<pre class="code-block">mysql -h localhost -u ${ctx.user.username}_app -p
SHOW DATABASES;</pre>
        <p class="small muted mt-12">Use the password set when the database was created. phpMyAdmin is available at <code>/phpmyadmin/</code>.</p>`)}
      </div>`;
    return page(ctx, { title: 'Databases', subtitle: 'MySQL / MariaDB databases', body });
  });

  router.get('/user/databases/create', (ctx) => {
    const q = quota(ctx.user, 'databases');
    const mst = detect();
    const body = h`${card('Create database', h`<form method="post" action="/user/databases/create" class="oa-form">
      <input type="hidden" name="_csrf" value="${ctx.csrf}">
      ${!q.ok ? alert(`Database limit reached (${q.used}/${q.limit}).`, 'warn') : ''}
      ${!mst.connected ? alert('No MariaDB server is connected: the database will be recorded but not created on a server.', 'warn') : ''}
      <div class="form-grid">
        <div class="field"><label class="field-label">Database name <span class="req">*</span></label>
          <div class="field-control"><span class="field-suffix" style="left:11px;right:auto">${ctx.user.username}_</span>
            <input name="name" required pattern="[a-zA-Z0-9_]{1,32}" style="padding-left:${ctx.user.username.length + 2}ch" placeholder="app"></div>
          <p class="field-help">Letters, numbers and underscores only.</p></div>
        <div class="field"><label class="field-label">Database user</label>
          <div class="field-control"><span class="field-suffix" style="left:11px;right:auto">${ctx.user.username}_</span>
            <input name="db_user" pattern="[a-zA-Z0-9_]{1,32}" style="padding-left:${ctx.user.username.length + 2}ch" placeholder="app"></div></div>
        <div class="field"><label class="field-label">Password <span class="req">*</span></label>
          <div class="field-control"><input id="dbpass" name="password" type="password" required minlength="8">
            <button class="btn btn-secondary btn-sm" type="button" data-genpass="#dbpass" style="margin-left:8px">Generate</button></div></div>
        <div class="field"><label class="field-label">Character set</label><select name="charset"><option>utf8mb4</option><option>utf8</option><option>latin1</option></select></div>
      </div>
      <div class="form-actions"><button class="btn btn-primary" type="submit" ${!q.ok ? 'disabled' : ''}>Create database</button><a class="btn btn-ghost" href="/user/databases">Cancel</a></div>
    </form>`)}`;
    return page(ctx, { title: 'Create Database', subtitle: 'Add a MariaDB database and user', body });
  });

  router.post('/user/databases/create', (ctx) => {
    const q = quota(ctx.user, 'databases');
    if (!q.ok) return ctx.redirect('/user/databases?flash=Database%20limit%20reached&type=error');
    const name = String(ctx.body.name || '').replace(/[^a-zA-Z0-9_]/g, '').slice(0, 32);
    if (!name) return ctx.redirect('/user/databases?flash=Invalid%20database%20name&type=error');
    const dbName = `${ctx.user.username}_${name}`;
    const dbUser = `${ctx.user.username}_${String(ctx.body.db_user || name).replace(/[^a-zA-Z0-9_]/g, '').slice(0, 32)}`;
    if (get('SELECT id FROM databases WHERE db_name = ?', dbName)) return ctx.redirect('/user/databases?flash=Database%20already%20exists&type=error');
    const password = String(ctx.body.password || '');
    if (password.length < 8) return ctx.redirect('/user/databases?flash=Password%20must%20be%20at%20least%208%20characters&type=error');
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
    return ctx.redirect('/user/databases?flash=' + encodeURIComponent(`Database ${dbName} created${mst.connected ? ' on the server' : ' (recorded only)'}`));
  });

  router.get('/user/databases/:id/password', (ctx) => {
    const db = get('SELECT * FROM databases WHERE id = ? AND user_id = ?', Number(ctx.params.id), ctx.user.id);
    if (!db) return ctx.redirect('/user/databases?flash=Database%20not%20found&type=error');
    const body = h`${card(`Zmiana hasła · ${db.db_name}`, h`<form method="post" action="/user/databases/${db.id}/password" class="oa-form">
      <input type="hidden" name="_csrf" value="${ctx.csrf}">
      <div class="form-grid"><div class="field field-full"><label class="field-label">Nowe hasło</label><input name="password" type="password" minlength="8" required></div></div>
      <div class="form-actions"><button class="btn btn-primary" type="submit">Zmień hasło</button><a class="btn btn-ghost" href="/user/databases">Anuluj</a></div>
    </form>`)}`;
    return page(ctx, { title: 'Database password', subtitle: db.db_name, body });
  });

  router.post('/user/databases/:id/password', (ctx) => {
    const db = get('SELECT * FROM databases WHERE id = ? AND user_id = ?', Number(ctx.params.id), ctx.user.id);
    if (!db) return ctx.redirect('/user/databases?flash=Database%20not%20found&type=error');
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
    if (!db) return ctx.redirect('/user/databases?flash=Database%20not%20found&type=error');
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
