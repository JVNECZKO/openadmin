// Demo accounts, shell access and skeleton directory.
import fs from 'node:fs';
import path from 'node:path';
import { all, get, run, nowIso, setting, setSetting, hashPassword, audit } from '../db.mjs';
import { html as h } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, table, badge, alert, tabs, form, field } from '../ui/components.mjs';
import { systemProvider } from '../providers/index.mjs';

const A = '/admin/user-tools';

export function register(router) {
  router.get(A, (ctx) => {
    const tab = ['demo', 'shell', 'skeleton'].includes(String(ctx.query.tab)) ? String(ctx.query.tab) : 'demo';
    const demos = all("SELECT * FROM users WHERE demo = 1 ORDER BY id");
    const users = all("SELECT * FROM users WHERE level IN ('user','reseller') ORDER BY username");
    const skel = setting('skeleton_directory', '/etc/skel');
    let files = [];
    try { files = fs.readdirSync(skel).slice(0, 30); } catch { /* ignore */ }
    const body = h`
      ${tabs([{ key: 'demo', label: 'Demo accounts', count: demos.length }, { key: 'shell', label: 'Shell access', count: users.filter((u) => u.shell_enabled).length }, { key: 'skeleton', label: 'Skeleton' }], tab, { base: A })}
      ${tab === 'demo' ? h`
        ${card('Utwórz konto demo', h`<form method="post" action="${A}/demo" class="row"><input type="hidden" name="_csrf" value="${ctx.csrf}">
          <input name="label" placeholder="np. demo1" required><button class="btn btn-primary" type="submit">Utwórz</button></form>
          <p class="small muted mt-12">Konto demo ma losowe hasło, brak domeny i flagę demo. Hasło pokażemy raz.</p>`)}
        ${card('Konta demo', table({
          columns: [{ label: 'Login', key: 'username' }, { label: 'Utworzono', key: 'created_at' }, { label: 'Status', render: (r) => badge(r.suspended ? 'zawieszone' : 'aktywne', r.suspended ? 'danger' : 'ok') }],
          rows: demos,
          actions: [{ label: 'Usuń', form: (r) => `${A}/demo/${r.id}/delete`, icon: 'trash', danger: true, confirm: 'Usunąć konto demo?' }],
          empty: 'Brak kont demo.',
        }), { padded: false })}
      ` : ''}
      ${tab === 'shell' ? h`
        ${card('Dostęp do shella', table({
          columns: [{ label: 'Konto', key: 'username' }, { label: 'Poziom', key: 'level' }, { label: 'Shell', render: (r) => badge(r.shell_enabled ? 'włączony' : 'wyłączony', r.shell_enabled ? 'ok' : 'muted') }],
          rows: users,
          actions: [{ label: 'Przełącz', form: (r) => `${A}/shell/${encodeURIComponent(r.username)}`, icon: 'terminal', confirm: (r) => `Przełączyć shell dla ${r.username}?` }],
        }), { padded: false })}
        ${alert('Przełączenie zmienia powłokę systemową (usermod -s /bin/bash lub nologin). Terminal w panelu respektuje tę flagę.', 'info')}
      ` : ''}
      ${tab === 'skeleton' ? h`
        ${card('Katalog szablonu', form([
          field({ name: 'path', label: 'Ścieżka', value: skel, required: true, full: true }),
        ], { action: `${A}/skeleton`, csrf: ctx.csrf, submit: 'Zapisz' }), { sub: 'Nowe konta kopiują zawartość tego katalogu (bez nadpisywania).' })}
        ${card('Zawartość', h`${files.length ? h`<ul class="small">${files.map((f) => h`<li class="cell-mono">${f}</li>`)}</ul>` : '<p class="small muted">Katalog pusty lub niedostępny.</p>'}`)}
      ` : ''}`;
    return page(ctx, { title: 'User Tools', subtitle: 'Demo, shell i skeleton', body, wide: true });
  });

  router.post(`${A}/demo`, (ctx) => {
    const label = String(ctx.body.label || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20) || 'demo';
    let username = label; let n = 1;
    while (get('SELECT id FROM users WHERE username = ?', username)) username = `${label}${++n}`;
    const password = `Demo-${Math.random().toString(36).slice(2, 10)}!`;
    const r = systemProvider().createUser(username);
    if (!r.ok) return ctx.redirect(`${A}?tab=demo&flash=${encodeURIComponent(r.output || 'create failed')}&type=error`);
    run("INSERT INTO users(username, password, email, level, owner, package, demo, created_at, must_change_password) VALUES(?,?,?,?,?,?,?,?,0)",
      username, hashPassword(password), '', 'user', null, null, 1, nowIso());
    audit(ctx.user.username, 'admin', 'user.demo.create', username, ctx.ip);
    const body = h`${card('Konto demo', h`<p>Login: <code>${username}</code></p><p>Hasło: <code>${password}</code></p><a class="btn btn-primary" href="${A}?tab=demo">Wróć</a>`)}`;
    return page(ctx, { title: 'Konto demo', subtitle: 'Zapisz hasło', body });
  });
  router.post(`${A}/demo/:id/delete`, (ctx) => {
    const u = get('SELECT * FROM users WHERE id = ? AND demo = 1', Number(ctx.params.id));
    if (u) { systemProvider().deleteUser(u.username); run('DELETE FROM users WHERE id = ?', u.id); }
    return ctx.redirect(`${A}?tab=demo&flash=Usuni%C4%99to`);
  });
  router.post(`${A}/shell/:username`, (ctx) => {
    const u = get('SELECT * FROM users WHERE username = ? AND level IN (\'user\',\'reseller\')', ctx.params.username);
    if (!u) return ctx.redirect(`${A}?tab=shell&flash=Nie%20znaleziono&type=error`);
    const next = !u.shell_enabled;
    const r = systemProvider().setShell(u.username, next);
    if (!r.ok) return ctx.redirect(`${A}?tab=shell&flash=${encodeURIComponent(r.output || 'failed')}&type=error`);
    run('UPDATE users SET shell_enabled = ? WHERE id = ?', next ? 1 : 0, u.id);
    audit(ctx.user.username, 'admin', 'user.shell', `${u.username}:${next}`, ctx.ip);
    return ctx.redirect(`${A}?tab=shell&flash=Shell%20zaktualizowany`);
  });
  router.post(`${A}/skeleton`, (ctx) => {
    const p = String(ctx.body.path || '').trim();
    if (!p.startsWith('/')) return ctx.redirect(`${A}?tab=skeleton&flash=Ścieżka%20musi%20być%20absolutna&type=error`);
    setSetting('skeleton_directory', p);
    return ctx.redirect(`${A}?tab=skeleton&flash=Zapisano`);
  });
}
