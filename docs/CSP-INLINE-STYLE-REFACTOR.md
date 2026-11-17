# CSP inline-style refactor — 2026-11-17

## Goal

Remove `style-src 'unsafe-inline'` from the panel CSP and stop emitting
`style` attributes or JavaScript CSSOM writes.

## What changed

- Inventoried **267 inline style attributes** across 37 server-rendered modules.
- Extracted 119 static presentation declarations into named CSS rules in
  `src/public/app.css`; duplicated exact declarations were reduced to shared
  classes.
- Replaced dynamic progress widths with CSP-safe `pct-0` … `pct-100` classes
  used by dashboard, quota, webmail, backup, reseller and provisioning views.
- Replaced dynamic table-column width styles by removing the unused width
  option; `kvList` uses `kv-cols-1` … `kv-cols-4`; skeleton/drawer width styles
  were removed because no caller supplied them.
- App logos now select size classes (`app-logo-34/40/44/46/52`) and brand
  background classes via `data-app-icon`; QR SVGs use `.qr-svg`; no style
  attributes are generated.
- Replaced JavaScript `element.style` writes (clipboard fallback, upload progress,
  app-catalogue target highlight, update textarea) with CSS classes:
  `visually-hidden-fixed`, `pct-*`, `flash-target`, `offscreen-textarea`.
- Both panel CSP paths now use `style-src 'self'` with no `unsafe-inline`.

## Verification

- Source regression test: no `style=` attribute remains in `.mjs`, `.js` or
  `.html` under `src/`.
- Rendered regression test: representative admin/user routes return CSP
  `style-src 'self'` and contain no inline style attributes.
- `node --test`: **313/313 pass**.
- QA: **54/54**, 395 route/width checks, 0 issues, 65 screenshots at
  390/768/1024/1280/1440 px (light and dark representative pages).
- Visual review of admin dashboard and app catalogue confirms logos, cards,
  progress meters and mobile touch targets render correctly.

## Scope note

The generated customer website placeholder in `src/features/advanced.mjs` keeps
its own `<style>` block because it is content served for a customer's website,
not panel HTML and not covered by the panel CSP. It can be moved to the generated
site stylesheet separately.
