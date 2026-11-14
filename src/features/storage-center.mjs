// Administrator storage destinations.
import { html as h, formatBytes } from '../util.mjs';
import { page } from '../ui/respond.mjs';
import { card, table, badge, alert, form, field, kvList } from '../ui/components.mjs';
import { storageOverview, saveStorage, deleteStorage } from '../storage.mjs';

const A = '/admin/storage';

export function register(router) {
  router.get(A, (ctx) => {
    const ov = storageOverview();
    const editing = ctx.query.edit ? ov.paths.find((r) => String(r.id) === String(ctx.query.edit)) : null;
    const body = h`
      ${ov.warnings.length ? alert(`${ov.warnings.length} lokalizacja(e) przekraczają próg zapełnienia.`, 'warn') : ''}
      ${card('Dodaj lokalizację', form([
        field({ name: 'name', label: 'Nazwa', required: true }),
        field({ name: 'path', label: 'Ścieżka absolutna', required: true, placeholder: '/mnt/storage2' }),
        field({ name: 'type', label: 'Typ', type: 'select', options: ['ext4', 'xfs', 'btrfs', 'zfs', 'cephfs', 'nfs'] }),
        field({ name: 'alert_percent', label: 'Alert %', type: 'number', value: 90, min: 50, max: 99 }),
        field({ name: 'is_default', label: 'Domyślna dla nowych kont', type: 'checkbox' }),
      ], { action: `${A}/add`, csrf: ctx.csrf, submit: 'Dodaj storage' }))}
      ${card('Lokalizacje', table({
        columns: [
          { label: 'Nazwa', key: 'name' }, { label: 'Ścieżka', render: (r) => h`<span class="cell-mono small">${r.path}</span>` },
          { label: 'Typ', key: 'type' }, { label: 'Zajęte', render: (r) => r.total ? `${r.used.toFixed(1)}%` : '—' },
          { label: 'Wolne', render: (r) => r.total ? formatBytes(r.free / 1024 / 1024) : '—' },
          { label: 'Status', render: (r) => r.alert ? badge('alert', 'danger') : r.exists ? badge('OK', 'ok') : badge('brak', 'warn') },
        ],
        rows: ov.paths,
        actions: [
          { label: 'Edytuj', href: (r) => `${A}?edit=${r.id}`, icon: 'edit' },
          { label: 'Usuń', form: (r) => `${A}/${r.id}/delete`, icon: 'trash', danger: true, show: (r) => !r.is_default, confirm: 'Usunąć lokalizację?' },
        ],
        empty: 'Brak lokalizacji.',
      }), { padded: false })}
      ${editing ? card(`Edytuj storage · ${editing.name}`, form([
        field({ name: 'name', label: 'Nazwa', value: editing.name, required: true }),
        field({ name: 'path', label: 'Ścieżka', value: editing.path, required: true }),
        field({ name: 'type', label: 'Typ', type: 'select', value: editing.type, options: ['ext4', 'xfs', 'btrfs', 'zfs', 'cephfs', 'nfs'] }),
        field({ name: 'alert_percent', label: 'Alert %', type: 'number', value: editing.alert_percent, min: 50, max: 99 }),
      ], { action: `${A}/${editing.id}/update`, csrf: ctx.csrf, submit: 'Zapisz storage' })) : ''}
      ${kvList([['Domyślna ścieżka', ov.defaultPath]])}
      ${alert('Istniejące konta pozostają w /home; nowa ścieżka domyślna jest zapisywana jako ustawienie i nie przenosi danych automatycznie.', 'info')}`;
    return page(ctx, { title: 'Storage Destinations', subtitle: 'Ścieżki, pojemność i alerty', body, wide: true });
  });

  router.post(`${A}/add`, (ctx) => {
    const r = saveStorage(ctx.body, ctx.user.username);
    return ctx.redirect(`${A}?flash=${encodeURIComponent(r.ok ? 'Storage dodany' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/:id/update`, (ctx) => {
    const r = saveStorage({ ...ctx.body, id: ctx.params.id }, ctx.user.username);
    return ctx.redirect(`${A}?flash=${encodeURIComponent(r.ok ? 'Storage zaktualizowany' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
  router.post(`${A}/:id/delete`, (ctx) => {
    const r = deleteStorage(ctx.params.id, ctx.user.username);
    return ctx.redirect(`${A}?flash=${encodeURIComponent(r.ok ? 'Usunięto' : r.error)}${r.ok ? '' : '&type=error'}`);
  });
}
