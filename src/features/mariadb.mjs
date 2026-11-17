// Live MariaDB administration: status, databases, users and an SQL console.
import { html as h, formatBytes, formatDate } from '../util.mjs';
import { audit, all, run, get, nowIso } from '../db.mjs';
import { page } from '../ui/respond.mjs';
import { card, table, btn, badge, alert, emptyState, kvList, statCard } from '../ui/components.mjs';
import { icon } from '../ui/icons.mjs';
import { listCard } from '../ui/pages/list.mjs';
import { detect, listDatabases, databaseSizes, accounts, createDatabase, dropDatabase, createAccount, query, status } from '../mariadb.mjs';

export function register(router) {
  router.get('/admin/mariadb', (ctx) => {
    const st = status();
    const sizes = st.connected ? databaseSizes() : { ok: false, map: {} };
    const dbs = st.connected ? (listDatabases().rows || []) : [];
    const users = st.connected ? (accounts().rows || []) : [];
    let last = null;
    try { last = JSON.parse(get('SELECT value FROM settings WHERE key = ?', `sqlconsole:${ctx.session?.token || ''}`)?.value || 'null'); } catch { last = null; }
    const body = h`
      ${!st.connected ? alert(`MariaDB is not reachable: ${st.error}. Install it on the server (the installer supports <code>--with-mariadb</code>), or set <code>OA_MYSQL_ADMIN_USER</code> / <code>OA_MYSQL_ADMIN_PASSWORD</code>.`, 'warn') : ''}
      <div class="stat-grid">
        ${statCard({ label: 'Server', value: st.connected ? 'Online' : 'Offline', sub: st.version || st.error, icon: 'database', tone: st.connected ? 'ok' : 'danger' })}
        ${statCard({ label: 'Databases', value: String(dbs.length), sub: 'excluding system schemas', icon: 'folder' })}
        ${statCard({ label: 'Accounts', value: String(users.length), sub: 'non-system users', icon: 'users' })}
        ${statCard({ label: 'Client', value: st.client ? 'mariadb' : 'missing', sub: st.client || 'no client binary', icon: 'terminal' })}
      </div>
      <div class="grid grid-2">
        ${card('Connection', h`${kvList([
          ['Status', st.connected ? badge('connected', 'ok') : badge('offline', 'danger')],
          ['Version', st.version || '—'],
          ['Admin account', st.currentUser || '—'],
          ['Client binary', st.client || '—'],
        ])}
        <form method="post" action="/admin/mariadb/refresh" class="mt-18"><input type="hidden" name="_csrf" value="${ctx.csrf}">
          <button class="btn btn-secondary btn-sm" type="submit">Re-detect</button></form>`)}
        ${card('Create database', h`<form method="post" action="/admin/mariadb/create" class="oa-form">
          <input type="hidden" name="_csrf" value="${ctx.csrf}">
          <div class="form-grid">
            <div class="field"><label class="field-label">Database</label><input name="db" required pattern="[A-Za-z0-9_]+" placeholder="customer_app"></div>
            <div class="field"><label class="field-label">Owner account</label><input name="user" pattern="[A-Za-z0-9_]+" placeholder="customer_app"></div>
            <div class="field"><label class="field-label">Password</label><input name="password" type="password" minlength="8" placeholder="at least 8 characters"></div>
            <div class="field"><label class="field-label">Character set</label><select name="charset"><option>utf8mb4</option><option>utf8</option><option>latin1</option></select></div>
          </div>
          <div class="form-actions"><button class="btn btn-primary" type="submit" ${st.connected ? '' : 'disabled'}>${icon('plus', { size: 16 })} Create database</button></div>
        </form>`)}
      </div>
      ${listCard({
        title: 'Databases', sub: `${dbs.length} databases on ${st.version || 'the server'}`,
        columns: [
          { label: 'Database', render: (d) => h`<span class="cell-mono">${d}</span>` },
          { label: 'Size', render: (d) => formatBytes(sizes.map?.[d] || 0), align: 'right' },
          { label: 'Tables', render: (d) => query(`SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = '${d.replace(/'/g, '')}'`).rows?.[0]?.[0] || '0', align: 'right' },
        ],
        rows: dbs,
        empty: st.connected ? 'No user databases yet.' : 'Connect MariaDB to list databases.',
        actions: [{ label: 'Drop', form: (d) => `/admin/mariadb/${encodeURIComponent(d)}/drop`, icon: 'trash', danger: true, confirm: 'Trwale usunąć tę bazę danych?' }],
      })}
      ${card('SQL console', h`
        <form method="post" action="/admin/mariadb/sql" class="oa-form">
          <input type="hidden" name="_csrf" value="${ctx.csrf}">
          <div class="field field-full"><label class="field-label">Statement</label>
            <textarea name="sql" rows="6" class="code-editor" placeholder="SELECT user, host FROM mysql.user;">${last?.sql || ''}</textarea></div>
          <div class="form-actions"><button class="btn btn-primary" type="submit" ${st.connected ? '' : 'disabled'}>${icon('play', { size: 16 })} Run query</button></div>
        </form>
        ${last ? (last.ok
          ? h`<div class="alert alert-ok">Query OK · ${last.rows?.length || 0} row(s)</div><pre class="code-block">${(last.rows || []).slice(0, 100).map((r) => r.join('\t')).join('\n') || last.output}</pre>`
          : h`<div class="alert alert-danger">${last.error}</div>`) : ''}`)}
      ${card('Accounts', h`${table({
        columns: [
          { label: 'User', render: (u) => h`<span class="cell-mono">${u[0]}</span>` },
          { label: 'Host', render: (u) => h`<span class="cell-mono">${u[1]}</span>` },
        ],
        rows: users,
        empty: 'No non-system accounts.',
      })}`, { sub: 'MariaDB accounts visible to the panel', actions: [h`<a class="link small" href="/phpmyadmin" target="_blank" rel="noopener">Open phpMyAdmin</a>`] })}`;
    return page(ctx, { title: 'MariaDB', subtitle: 'Live database server administration', body });
  });

  router.post('/admin/mariadb/refresh', (ctx) => {
    detect(true);
    return ctx.redirect('/admin/mariadb?flash=Connection%20refreshed');
  });

  router.post('/admin/mariadb/create', (ctx) => {
    const db = String(ctx.body.db || '');
    const user = String(ctx.body.user || db);
    const created = createDatabase(db);
    if (!created.ok) return ctx.redirect('/admin/mariadb?flash=' + encodeURIComponent(created.error) + '&type=error');
    if (ctx.body.password) {
      const acct = createAccount(db, user, String(ctx.body.password));
      if (!acct.ok) return ctx.redirect('/admin/mariadb?flash=' + encodeURIComponent(acct.error) + '&type=error');
    }
    audit(ctx.user.username, 'admin', 'mariadb.create', db, ctx.ip);
    return ctx.redirect('/admin/mariadb?flash=' + encodeURIComponent(`Database ${db} created`));
  });

  router.post('/admin/mariadb/:db/drop', (ctx) => {
    const db = ctx.params.db;
    const r = dropDatabase(db);
    if (!r.ok) return ctx.redirect('/admin/mariadb?flash=' + encodeURIComponent(r.error) + '&type=error');
    audit(ctx.user.username, 'admin', 'mariadb.drop', db, ctx.ip);
    return ctx.redirect('/admin/mariadb?flash=' + encodeURIComponent(`Database ${db} dropped`));
  });

  router.post('/admin/mariadb/sql', (ctx) => {
    const sql = String(ctx.body.sql || '').trim();
    if (!sql) return ctx.redirect('/admin/mariadb?flash=Enter%20a%20statement&type=error');
    const r = query(sql);
    run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      `sqlconsole:${ctx.session.token}`, JSON.stringify({ sql, ...r, at: nowIso() }));
    audit(ctx.user.username, 'admin', 'mariadb.query', sql.slice(0, 120), ctx.ip);
    return ctx.redirect('/admin/mariadb?flash=' + encodeURIComponent(r.ok ? `Query OK · ${r.rows.length} row(s)` : r.error) + (r.ok ? '' : '&type=error'));
  });
}

void all; void formatDate; void emptyState; void btn;
