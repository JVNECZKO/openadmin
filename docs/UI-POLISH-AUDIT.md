# OpenAdmin — UI/UX polish audit

**Project:** OpenAdmin 1.0.0 — server-rendered Node panel  
**Audited snapshot:** 2026-11-14 19:59–20:02 CET (18:59–19:02 UTC)  
**Source snapshot:** frozen working tree. Diff SHA-256: `d0758f81e21569310cc2b6ee81c80fecd2170e5b8c2e9c01c8ae6c8ad55cade7`  
**Artifacts:** `/tmp/visual-audit-final/` — `raw.json`, `shots/` (377 PNGs: 375 crawl + 2 dead-link probes), `logs/audit.log`  
**Scope:** login + admin/reseller/user views, 390/768/1440 px, light theme, GET pages only (no destructive submits).  
**Constraint respected:** no application source was edited.

> This is a snapshot of the working tree, not of `HEAD`. During the earlier part of the audit another process was editing `src/`; the lead froze edits at 19:58:56, a fresh server+profile was started, and this crawl ran against that frozen state. No source file changed during the final crawl. **Source edits resumed after the audit (~20:05–20:08), so verify these findings against the current working tree before applying fixes.**

---

## 1. Executive summary

**Verdict:** the shell and most screens are visually coherent and much more polished than the original complaint suggests. The login page, responsive sidebar/topbar, card/table system, engine picker, app catalog and automation screen are solid. The remaining issues are concentrated in **tablet/mobile data tables**, **silently missing table action buttons**, **escaped HTML inside alert banners**, and **mixed Polish/English copy in the core add-domain/edit-domain flow**.

**Counts by severity**

| Severity | Findings | Meaning |
|---|---:|---|
| **P0** | **0** | no crash/data-loss/blocking defect found |
| **P1** | **7** | high-priority visual/functional defect in a core flow or a control that disappears |
| **P2** | **15** | medium polish, consistency, accessibility or edge-state issue |
| **Total** | **22** | |

**Crawl health:** 186 page snapshots / 72 route variants / 375 crawl screenshots (+2 dead-link probes). **0** HTTP non-200 responses, **0** JavaScript exceptions, **0** failed asset requests, **0** `undefined`/`NaN`/`[object Object]` text, **0** duplicate IDs. 160 sampled page links all returned 200; only two sidebar links 404 (reported as P2-01).

**Not found / already good (details in §6):**
- No page-level horizontal overflow at 768 or 1440; one page overflows at 390 only.
- No sidebar/topbar breakage in the final snapshot; the mobile drawer works, breadcrumbs stay on one line, and the skip-link is correctly off-screen.
- No visible overlapping controls after manual review.
- No missing `<form action>` attributes; no visible POST form is submitted without a CSRF token when JavaScript is enabled.
- Forms now show submit protection (`aria-busy`, disabled submit) and the shell has focus rings, ARIA roles, live regions and a working auto-refresh control.

---

## 2. Top 20 actionable findings

> Screenshot shorthand: every `shots/...` path and every screenshot basename below lives under `/tmp/visual-audit-final/shots/`. The full artifacts are retained there.

### P1 — fix first

| # | ID | Action | URL / viewport | Evidence (screenshot) | Owner suggestion |
|---:|---|---|---|---|---|
| 1 | P1-01 | Escape alerts correctly; one alert also causes 105 px page overflow at 390 | `/user/domains` @390; also `/user/dns`, `/user/databases`, `/user/ssl`, `/admin/security?tab=firewall` | `shots/user__domains__390__full.png`, `shots/user__ssl__390__full.png` | `src/features/domains.mjs:41,483`, `databases.mjs:29`, `security.mjs:39`, `security-center.mjs:94`; CSS `.alert` |
| 2 | P1-02 | Render table action buttons even when no confirm text is supplied (28 missing buttons) | `/admin/plans?tab=features` @1440/390; `/admin/users` @1440; `/user/email` @1440; packages | `shots/admin__plans-features__1440__full.png`, `shots/admin__users__1440__full.png`, `shots/user__email__1440__full.png` | `src/ui/components.mjs:91–95` + callsites |
| 3 | P1-03 | Make data tables usable on tablet/mobile; reveal or pin the action column | 28 tables on 26 page snapshots @390; 8 @768; 3 @1440 (examples: `/admin/users`, `/reseller/domains`, `/user/email`, `/user/files`, `/user/backups`) | `shots/admin__users__390__full.png`, `shots/user__email__390__full.png`, `shots/user__files__390__full.png`, `shots/reseller__tickets__390__full.png` | `src/public/app.css` `.table-wrap`/`.data-table`; `src/ui/components.mjs` `table()` |
| 4 | P1-04 | Stop service-row action group from clipping the primary “Use” button at 390 | `/admin/web-server` @390 | `shots/admin__web-server__390__full.png` | `src/public/app.css:796–798`; `src/features/webserver.mjs:18–37,65–79` |
| 5 | P1-05 | Either implement real wizard steps or stop calling it a 4-step wizard; the 4 cards are all shown at once | `/user/websites/new` @390 and @1440 | `shots/user__websites-new__390__full.png`, `shots/user__websites-new__1440__full.png` | `src/features/wizards.mjs` `wizardForm`; `src/public/app.js`; CSS `.wizard-panel/.wizard-steps` already exists but is unused |
| 6 | P1-06 | Finish the Polish translation of core flows (server copy + `i18n.js` dictionary) | `/user/domains/create`, `/user/domains/1/edit`, `/user/backups`, `/user/ssl`, `/admin/web-server` @390/1440 | `shots/user__domains-create__390__full.png`, `shots/user__domain-edit__390__full.png`, `shots/admin__web-server__390__full.png` | `src/public/i18n.js`; strings in `src/features/domains.mjs`, `backups.mjs`, `security.mjs`, `webserver.mjs` |
| 7 | P1-07 | Raise contrast of muted labels/badges to WCAG AA (≥4.5:1) | all roles; examples `/admin/users`, `/user/app-catalog`, `/user/statistics` | `shots/user__app-catalog__390__full.png`, `shots/admin__users__1440__full.png` | `src/public/app.css:29–31` `--muted`; `.badge-muted`; `.small.muted` |

### P2 — next polish pass

| # | ID | Action | URL / viewport | Evidence (screenshot) | Owner suggestion |
|---:|---|---|---|---|---|
| 8 | P2-01 | Point Netdata/Rspamd nav entries at working routes (404 today) | `/admin/netdata`, `/admin/rspamd` @1440 | `shots/admin__netdata-404__1440__full.png`, `shots/admin__rspamd-404__1440__full.png` | `src/ui/nav.mjs:152–153`; compat pages already exist at `/compat/admin/netdata`, `/compat/admin/rspamd` |
| 9 | P2-02 | Add `/admin/automation` to nav/search so the new feature is discoverable | `/admin/automation` @1440 | `shots/admin__automation__1440__full.png` | `src/ui/nav.mjs`; route already registered in `src/routes/admin.mjs` |
| 10 | P2-03 | Give scrollable tab bars a visible affordance (arrow/fade/wrap) | security 9 tabs 776 px/364 px; mail 8 tabs 785 px; user email 8 tabs 896 px @390 | `shots/admin__security__390__full.png`, `shots/admin__mail__390__full.png`, `shots/user__email__390__full.png` | `src/public/app.css` `.tabs`/`.tab` |
| 11 | P2-04 | Disable/replace empty selects; show “no data” instead of a blank control | `/admin/php` default-version select (0 options); `/admin/log-center` source select (0 options) @390/1440 | `shots/admin__php__390__full.png`, `shots/admin__log-center__390__full.png` | `src/features/php-manager.mjs:50`; `src/features/log-center.mjs:21` |
| 12 | P2-05 | Keep “Ponów wszystkie” inside the empty-state card or hide it when the queue is empty | `/admin/mail?tab=queue` @390 | `shots/admin__mail-queue__390__full.png` | `src/features/mail-ops.mjs` queue tab |
| 13 | P2-06 | Paginate/virtualize large operational tables; add search/filter | `/admin/processes` 15,194 px tall @390; `/user/databases` 8,051 px / 112 rows @390 | `shots/admin__processes__390__full.png`, `shots/user__databases__390__full.png` | `src/routes/admin.mjs` processes; `src/features/databases.mjs` |
| 14 | P2-07 | Make auto-refresh default-on for monitoring pages, show a last-updated stamp, and strengthen the 9.5 px “OFF” chip | `/admin/users`, `/admin/processes`, `/admin/log-center` @390 | `shots/admin__users__390__full.png`, `shots/admin__processes__390__full.png` | `src/ui/layout.mjs` `autoRefreshControl()`; `src/public/app.js` `initAutoRefresh()` |
| 15 | P2-08 | Emit `_csrf` in table action forms server-side instead of relying on `app.js` injection | `/admin/users`, `/user/email`, `/admin/plans?tab=features`, `/user/domains` (42 POST forms) | form evidence in `raw.json` → `htmlScans`; no visual screenshot needed | `src/ui/components.mjs` `table()` |
| 16 | P2-09 | Unify date localization (`formatDate` hard-codes `en-GB`) | `/admin/users` “14 Nov 2026” vs `/reseller/settings` “14 lis 2026” @390/1440 | `shots/admin__users__1440__full.png`, `shots/reseller__settings__390__full.png` | `src/util.mjs:40–47` |
| 17 | P2-10 | Remove duplicated primary CTA (page header + card toolbar) | `/admin/users`, `/admin/user-packages` @1440 | `shots/admin__users__1440__full.png`, `shots/admin__user-packages__1440__full.png` | `src/features/user-admin.mjs`; list-card page header |
| 18 | P2-11 | Prevent equal-height grid from leaving a large blank block under “Usage by domain” | `/user/statistics` @1440 | `shots/user__statistics__1440__full.png` | `src/features/dashboard.mjs` statistics page; CSS `align-items:start` |
| 19 | P2-12 | Update help copy to the new 4-step website flow (engine/subdomains) | `/user/help` @390 | `shots/user__help__390__full.png` | `src/features/help.mjs` |
| 20 | P2-13 | Build the WebDisk URL from the current host/scheme/port instead of hard-coded `host:2222` | `/user/webdisk` @390 | `shots/user__webdisk__390__full.png` | `src/features/webdisk.mjs:21` |

Additional P2 findings (not in top 20): **P2-14** pluralization/grammar (`1 account(s)`, `4 mailbox(es)`, `1 instalacji`, `1 konta klienta`) and **P2-15** the 7,122 px mobile user dashboard with duplicated tool/app tiles — details in §4.

---

## 3. P1 details

### P1-01 — Raw escaped HTML in alert banners; `/user/domains` also overflows the page at 390

- **URLs:** `/user/domains` (worst), `/user/dns`, `/user/databases`, `/user/ssl`, `/admin/security?tab=firewall`.
- **Viewport:** 390, 768, 1440; worst at 390.
- **Selector / DOM:** `.alert.alert-info > div > div` (message container). The alert helper treats the message as text, so markup passed as a plain string (and any `&lt;…&gt;` entities) is displayed literally.
- **Evidence:** text observed in DOM (from the frozen server):
  - `/user/domains`: `Domains use <strong>/home/demouser/domains/&lt;domain&gt;/public_html</strong> as their document root…`
  - `/user/ssl`: `… certificates in <code>/tmp/…/data/ssl</code>`
  - `/user/databases`: `Connected to <strong>MariaDB …</strong> as <code>…</code>`
  - `/user/dns`: `Zone file: <code>/tmp/…/data/dns/example.com.db</code> · not validated yet`
  - `/admin/security?tab=firewall`: `… zainstaluj pakiet <code>nftables</code> …`
- **Screenshots:** `/tmp/visual-audit-final/shots/user__domains__390__full.png`, `user__dns__390__full.png`, `user__ssl__390__full.png`, `user__databases__390__full.png`, `admin__security-firewall__390__full.png`
- **Measured impact:** `/user/domains` @390 has `document.scrollWidth = 495` vs `innerWidth = 390` (**105 px** page-level overflow) and the alert text is clipped at the right edge.
- **Expected fix:** pass an `h`/`raw` fragment to `alert()` (or change `alert()` to accept a markup flag), and add `overflow-wrap:anywhere; min-width:0` to the alert message. Fix all five callsites, not only the visible one.
- **Owner files:** `src/features/domains.mjs:41,483`, `src/features/databases.mjs:29`, `src/features/security.mjs:39`, `src/features/security-center.mjs:94`; `src/ui/components.mjs` `alert()`; `src/public/app.css` `.alert`.

### P1-02 — 28 table action buttons are silently dropped

- **Root cause:** in `table()` the submit button is rendered only when `confirmText` is truthy:
  ```js
  ${confirmText ? raw(`<button …>`) : ''}
  ```
  A `form` action without `confirm` therefore renders an empty `<form class="inline">` and the action disappears.
- **Verified missing actions (28):**
  - `/admin/plans?tab=features`: **16/16** feature toggles (empty AKCJE column).
  - `/user/email`: **4/4** mailbox suspend/enable toggles.
  - Package copy actions: `/admin/user-packages` 2, `/admin/reseller-packages` 1, `/reseller/packages` 2 = **5**.
  - User actions: `/admin/users` login-as + suspend = 2, `/reseller/users` suspend = 1 = **3**.
- **Screenshots:** `/tmp/visual-audit-final/shots/admin__plans-features__1440__full.png`, `admin__plans-features__390__full.png`, `admin__users__1440__full.png`, `user__email__1440__full.png`, `admin__user-packages__1440__full.png`
- **Evidence:** raw HTML scan reports these actions as `POST` forms with **0 buttons**; 28 of the 34 zero-button forms are bugs (the other 6 are intentional: file-rename modals and PHP auto-submit filters).
- **Expected fix:** always render the button; attach `onclick="return confirm(...)"` only when `confirm` is present. Keep the same icon/title/tone.
- **Owner:** `src/ui/components.mjs:91–95`. Callsites: `features/plan-center.mjs:45`, `features/email.mjs:60`, `features/user-admin.mjs:394`, package-copy actions.

### P1-03 — Mobile/tablet tables hide key columns and all row actions

- **Viewport:** 390 (28 tables / 26 page snapshots), 768 (8 tables), 1440 (3 tables).
- **Selector:** `.table-wrap > table.data-table`; `.table-wrap` is `overflow-x:auto` but `.card` is `overflow:hidden`, and no scrollbar/shadow/hint is visible before the user swipes.
- **Examples:** `/admin/users` (8 cols, 772 px table in 362 px wrap), `/user/domains` (8 cols, 1,058 px / 362 px), `/reseller/domains` (9 cols, 1,016 px / 362 px), `/reseller/tickets` (status + actions hidden), `/user/email` (quota/actions hidden), `/user/files` (actions hidden), `/user/backups` (status + actions hidden), `/user/statistics`, `/user/subdomains`.
- **Screenshots:** `/tmp/visual-audit-final/shots/admin__users__390__full.png`, `user__email__390__full.png`, `user__files__390__full.png`, `user__backups__390__full.png`, `reseller__domains__390__full.png`, `reseller__tickets__390__full.png`
- **Expected fix:** at ≤560 px render the table as stacked key/value rows (label + value) or pin the action column and add a persistent right-edge fade/scroll hint. At minimum, the row actions must be reachable without horizontal exploration.
- **Owner:** `src/public/app.css` `.table-wrap`, `.data-table`, media queries; `src/ui/components.mjs` `table()`.

### P1-04 — `/admin/web-server` clips the primary “Use” control at 390

- **URL/viewport:** `/admin/web-server` @390.
- **Selector:** `#main-content section.card:nth-of-type(1) .service-row:nth-of-type(1) > div:last-child > form.inline > button`; measured right edge **24.3 px** beyond the card/viewport.
- **Screenshot:** `/tmp/visual-audit-final/shots/admin__web-server__390__full.png` — on the Nginx row the “Use” button is cut to “U” at the right edge.
- **Why:** `.service-row` is a non-wrapping flex row (`.strong` min-width 100 px + path copy + badges + action group); the same row is reused by the engine picker.
- **Expected fix:** allow `.service-row` to wrap/stack at small widths, hide or shorten the binary-path line, and keep the action group inside the card. Re-test both the Web server card and the website/domain engine pickers.
- **Owner:** `src/public/app.css:796–798`; `src/features/webserver.mjs:18–37` and `65–79`.

### P1-05 — “4 kroki” website flow is actually one long form

- **URL/viewport:** `/user/websites/new` @390 (2,673 px tall) and @1440 (1,977 px).
- **Selector:** `form#site-wizard [data-wizard-step="1..4"]` — all four step containers are rendered and visible simultaneously; there is no step nav/next/back, and the only submit is at the bottom. `.wizard-panel`, `.wizard-steps`, `.wizard-actions` CSS exists but the markup does not use those classes.
- **Additional:** the optional app fields (title/login/email/password) stay enabled even when “Brak — pusta strona” is selected.
- **Screenshots:** `/tmp/visual-audit-final/shots/user__websites-new__390__full.png`, `user__websites-new__1440__full.png`
- **Expected fix:** either implement a real wizard using the existing `.wizard-*` styles (show one step, progress indicator, Next/Back, per-step validation), or relabel the page as a single form and remove the “Krok N z 4” labels. Also disable/hide app credential fields when app = none.
- **Owner:** `src/features/wizards.mjs` `wizardForm()`; `src/public/app.js` (wire step controller); `src/public/app.css:1741–1804,2109–2116`.

### P1-06 — Core flows mix Polish and English

- **URLs/viewports:** `/user/domains/create` @390/1440, `/user/domains/1/edit` @390/1440, `/user/backups` @390, `/user/ssl` @390, `/admin/web-server` @390/1440.
- **Examples:**
  - Add domain: H1 “Dodaj domenę” + subtitle “Create a new domain on your account and choose its web engine”; card “Add a domain”; fields “Domain name / Web engine / PHP version / SSL mode”; button “Create domain”; only “Anuluj” is Polish.
  - Edit domain: H1 “Edit domain”, card/fields English; “Domena” and “Anuluj” Polish.
  - Backups: H1 “Kopie zapasowe” + English subtitle/card body/“Restore backup”/“Backup history”.
  - SSL: English H1/tabs/body; Polish nav.
  - Web server: Polish H1/subtitle, almost entirely English body.
- **Selector:** `.page-head-text h1/p`, `.card-head h2`, `.field-label`, `.btn`, `.tabs .tab`.
- **Screenshots:** `/tmp/visual-audit-final/shots/user__domains-create__390__full.png`, `user__domain-edit__390__full.png`, `user__backups__390__full.png`, `user__ssl__390__full.png`, `admin__web-server__390__full.png`
- **Root cause:** server strings are largely English; `src/public/i18n.js` only replaces a limited exact-match dictionary after DOMContentLoaded (which also produces a short English flash). It does not translate arbitrary headings, help text, option labels or button copy.
- **Expected fix:** translate the core page strings server-side (or complete and centralize the client dictionary), and add a lint/check for English strings in `pl` pages. At minimum, translate the five routes above end-to-end.
- **Owner:** `src/public/i18n.js`; `src/features/domains.mjs`, `backups.mjs`, `security.mjs`, `webserver.mjs`, `wizards.mjs`.

### P1-07 — Muted text and badges fail WCAG AA contrast

- **Selector:** `.muted`, `.small.muted`, `.badge-muted`, `.page-head-text p`, `.crumb`; measured with computed styles.
- **Measured:** `--muted: #6c7d90` on `--surface-3 #edf2f8` = **3.75:1**; on `--bg #f3f6fa` = **3.90:1**; on `#ffffff` = **4.22:1**. Normal text requires **4.5:1**; many labels are 11–12.5 px.
- **Examples:** “not installed” badges, app metadata chips (“v30”, “PHP + MariaDB”), page subtitles, breadcrumbs, table dates.
- **Screenshots:** `/tmp/visual-audit-final/shots/user__app-catalog__390__full.png`, `admin__users__1440__full.png`
- **Expected fix:** darken `--muted` (or use `--text-2` for small labels), verify ≥4.5:1 on white, `--bg` and `--surface-3`; keep sufficient differentiation for muted metadata.
- **Owner:** `src/public/app.css:29–31` and `.badge-muted`; design token review.

---

## 4. P2 details

### P2-01 — Two sidebar links return 404
- **URLs:** `/admin/netdata`, `/admin/rspamd`; both HTTP **404**; compatibility equivalents exist at `/compat/admin/netdata` and `/compat/admin/rspamd`.
- **Screenshots:** `/tmp/visual-audit-final/shots/admin__netdata-404__1440__full.png`, `admin__rspamd-404__1440__full.png`
- **Expected fix:** register `/admin/netdata` and `/admin/rspamd` (delegate to the compat pages) or change nav hrefs.
- **Owner:** `src/ui/nav.mjs:152–153`; `src/features/compat.mjs:487,502`.

### P2-02 — New Automation page is unreachable from navigation
- **URL:** `/admin/automation` returns 200 and renders fully; `nav.mjs` contains **0** automation entries; the command palette is built from the same nav index.
- **Screenshot:** `/tmp/visual-audit-final/shots/admin__automation__1440__full.png`
- **Expected fix:** add it under Server/Tools with an icon; consider a “Live/6 jobs” badge.
- **Owner:** `src/ui/nav.mjs`; route registration already in `src/routes/admin.mjs`.

### P2-03 — Tab bars are clipped with no scroll affordance at 390
- **Measured:** security 9 tabs, 364→776 px; mail 8 tabs, 364→785 px; user email 8 tabs, 364→896 px; also backup center, PHP, plans, user SSL.
- **Screenshots:** `admin__security__390__full.png`, `admin__mail__390__full.png`, `user__email__390__full.png`
- **Expected fix:** fade/arrow affordance and scroll-into-view for the active tab; consider wrapping or a select on very small widths.
- **Owner:** `src/public/app.css` `.tabs`.

### P2-04 — Blank selects look broken
- **URLs:** `/admin/php` (`select[name=version]`, 0 options), `/admin/log-center` (`select[name=source]`, 0 options); buttons “Ustaw domyślną”/“Pokaż” remain active.
- **Screenshots:** `admin__php__390__full.png`, `admin__log-center__390__full.png`
- **Expected fix:** disable/replace the control with an explicit empty state (“No PHP versions detected” / “No logs available”) and disable the submit.
- **Owner:** `src/features/php-manager.mjs:50`; `src/features/log-center.mjs:21`.

### P2-05 — Orphaned queue action in the empty state
- **URL:** `/admin/mail?tab=queue` @390. The empty-state card is followed by a lone “Ponów wszystkie” button with no context or surrounding table.
- **Screenshot:** `admin__mail-queue__390__full.png`
- **Expected fix:** place the action inside the empty state or hide it when the queue is empty.
- **Owner:** `src/features/mail-ops.mjs` queue tab.

### P2-06 — Unbounded operational tables
- **URLs:** `/admin/processes` = **15,194 px** tall at 390 (no pagination/filter); `/user/databases` = **8,051 px** at 390 with 112 demo rows (no pagination/search).
- **Screenshots:** `admin__processes__390__full.png`, `user__databases__390__full.png`, `user__databases__1440__full.png`
- **Expected fix:** server-side pagination (50/100 rows), search/filter, and a compact mobile row pattern. Keep the row action visible.
- **Owner:** `src/routes/admin.mjs` process page; `src/features/databases.mjs`.

### P2-07 — Auto-refresh is present but defaults to off on monitoring pages
- **URLs/examples:** `/admin/users`, `/admin/processes`, `/admin/log-center` @390. The control itself is visible and labelled (148 px wide at 390), but it defaults to `Off` on every page. Monitoring pages have no `meta refresh`, no polling and no last-updated stamp until the user enables it (`raw.json`: 0 polled pages; only `/user/app-catalog` has a “last updated” line). The 9.5 px `OFF` chip is also low-contrast.
- **Screenshots:** `admin__users__390__full.png`, `admin__processes__390__full.png`, `user__app-catalog__390__full.png`
- **Expected fix:** enable a sensible interval by default on live-operational pages (processes, log center, mail queue, backup runs), display last-updated in the page head, and raise the `OFF` chip's font size/contrast.
- **Owner:** `src/ui/layout.mjs` `autoRefreshControl()`; `src/public/app.js` `initAutoRefresh()`; CSS `.auto-refresh-state`.

### P2-08 — 42 POST forms rely on client-side CSRF injection
- **Evidence:** raw HTML scan found 42 POST forms without `input[name=_csrf]` (row actions on `/admin/users`, `/user/email`, packages, domains, backups, etc.). `app.js` injects the token on DOMContentLoaded/MutationObserver; with JavaScript disabled these submits return 403.
- **Expected fix:** emit `<input type="hidden" name="_csrf" value="…">` directly inside `table()` action forms, as the automation page already does.
- **Owner:** `src/ui/components.mjs` `table()`; `src/public/app.js` injection can then remain as a safety net.
- **Note:** no missing `action` attributes were found; no CSRF failure was observed in the JS-enabled crawl.

### P2-09 — Date locale inconsistency
- **Evidence:** `/admin/users` shows “14 Nov 2026”; `/reseller/settings` shows “14 lis 2026”; charts/ranges use `2026-10-16`. `formatDate()` hard-codes `toLocaleDateString('en-GB')`.
- **Screenshots:** `admin__users__1440__full.png`, `reseller__settings__390__full.png`
- **Expected fix:** pass the active language/locale into `formatDate` and use it everywhere; unify short vs long date formats.
- **Owner:** `src/util.mjs:40–47`; callers in features.

### P2-10 — Duplicated primary CTA
- **URLs:** `/admin/users` (“Utwórz użytkownika” in page head and in the card toolbar); `/admin/user-packages` (“Create package” twice).
- **Screenshots:** `admin__users__1440__full.png`, `admin__user-packages__1440__full.png`
- **Expected fix:** keep one primary action per page; move the secondary one into an overflow menu or remove it.
- **Owner:** `src/features/user-admin.mjs` and the list-card/toolbar composition.

### P2-11 — Equal-height grid leaves dead space
- **URL:** `/user/statistics` @1440. “Usage by domain” has 2 rows but stretches to the height of the 12-row “Daily log” card, leaving ~450 px blank.
- **Screenshot:** `user__statistics__1440__full.png`
- **Expected fix:** `align-items:start` on this grid or let the short card size to content.
- **Owner:** `src/features/dashboard.mjs` statistics view; CSS grid.

### P2-12 — Help content is stale versus the new flow
- **URL:** `/user/help` @390. The “Jak postawić stronę?” steps say “wpisz domenę, wybierz certyfikat, zaznacz WordPress”; they do not mention the engine choice, subdomains or the 4 cards the user actually sees.
- **Screenshot:** `user__help__390__full.png`
- **Expected fix:** rewrite steps 1–6 to match the current wizard (domain/engine → PHP/SSL/DNS → subdomains → app) and link directly to `/user/websites/new`.
- **Owner:** `src/features/help.mjs`.

### P2-13 — Hard-coded WebDisk URL
- **URL:** `/user/webdisk` @390. Alert says `https://host:2222/webdisk/` on an HTTP server running on port 2311.
- **Screenshot:** `user__webdisk__390__full.png`
- **Expected fix:** build from `ctx.req.headers.host`/configured scheme+port; show `http` when the panel is HTTP.
- **Owner:** `src/features/webdisk.mjs:21`.

### P2-14 — Grammar/pluralization inconsistencies
- **Evidence:** “1 account(s)”, “4 mailbox(es)”, “1 instalacji” (`/user/wordpress`), “1 konta klienta” (`/reseller`), “1/0” runs/failures on automation, “Brak zdarzeń — kliknij „Odśwież logi”.” mixed punctuation.
- **Screenshots:** `admin__users__1440__full.png`, `user__email__1440__full.png`, `user__wordpress__390__full.png`, `reseller__dashboard__390__full.png`
- **Expected fix:** use a plural helper (`Intl.PluralRules`) and Polish plural forms; fix counters in automation.
- **Owner:** multiple feature files; helper in `src/util.mjs` or `src/i18n.mjs`.

### P2-15 — Mobile user dashboard is extremely long and duplicates navigation
- **URL/viewport:** `/user/dashboard` @390 = **7,122 px** (5,471 @768; 3,357 @1440). It contains 20 “Wszystkie narzędzia” tiles, 6 app tiles, 6 quick-action tiles and several summary cards; many duplicate sidebar links.
- **Screenshot:** `user__dashboard__390__full.png`
- **Expected fix:** collapse “Wszystkie narzędzia” into a disclosure or remove it (sidebar already provides it), merge “Szybkie akcje” with the hero actions, and keep 3–4 primary sections above the fold.
- **Owner:** `src/features/dashboard.mjs`; dashboard CSS.

---

## 5. Coverage details

| Area | Result |
|---|---|
| HTTP status | 186/186 page snapshots HTTP 200 |
| JS console | 0 exceptions / errors / warnings |
| Network | 0 failed assets; no 4xx assets |
| Page-level horizontal overflow | 1 snapshot: `/user/domains` @390 (105 px) |
| Internal table scroll | 28 tables / 26 snapshots @390; 8 @768; 3 @1440 |
| Tab bars scroll | 7 pages / 30 tabbed snapshots @390 (security, mail, backup center, PHP, plans, user email, user SSL) |
| Raw escaped HTML | 5 pages ×3 widths (P1-01) |
| Missing table actions | 28 verified missing buttons (P1-02) |
| Empty selects | 2 pages (PHP, log center) |
| Forms missing action attr | 0 |
| Server-side POST forms without CSRF | 42 (JS injects; P2-08) |
| Broken images | 0 |
| Dead sample links | 0/160 sampled page links; 2 sidebar links 404 |
| Duplicate IDs | 0 |
| Undefined/NaN/[object Object] | 0 |
| Overlaps | none confirmed; detector hits on closed `<details>` forms were false positives |
| Top page heights @390 | processes 15,194; databases 8,051; user dashboard 7,122; php extensions 4,735; reseller dashboard 4,013; automation 3,426 |

---

## 6. What is already good

1. **Clean, consistent shell.** The sidebar/topbar hierarchy is readable; the mobile drawer opens with a scrim and close button; breadcrumbs stay on one line; the sticky topbar has `scrollWidth == clientWidth` at 390. I found no sidebar/topbar breakage in the final snapshot.
2. **Login experience.** The split-screen login at 1440 and the compact 390 version are both well balanced; demo-account chips are clear; the page fits without overflow.
3. **System health.** 186 page snapshots at 3 widths produced **0** JavaScript exceptions, **0** failed assets and **0** HTTP errors. That is a strong baseline for a panel of this size.
4. **Escaping is otherwise correct.** I did not find a single broken table cell, form value or page title; only the five `alert()` call sites in P1-01 are affected.
5. **Form behaviour.** Every form has an `action`; visible POST forms receive a CSRF token after `app.js`; the new submit guard adds `aria-busy`, disables the clicked submit and prevents double submits. The 42 raw-HTML gaps are a progressive-enhancement issue, not a failure in the normal browser flow.
6. **Components and tokens.** Cards, tables, badges, progress bars, tabs, empty states and the app tiles share one visual language. Focus-visible rings, ARIA roles/labels, live regions and the skip link are present; the skip link is correctly translated off-screen until focus.
7. **New provisioning/automation features are well presented.** The engine picker, subdomain editor and app choice in the expanded website flow are a clear improvement; the Automation screen has a readable job table, real status badges and explanatory empty states; the App Catalog and Reseller dashboards are visually strong.
8. **No broken data rendering.** No `undefined`, `NaN`, `[object Object]` or duplicate-ID problems were found in any of the 186 snapshots.

---

## 7. Method and exact commands

### 7.1 Frozen snapshot

```bash
cd /Users/lukasz/Downloads/OpenAdmin
# snapshot recorded 2026-11-14T18:58:56Z (19:58:56 CET)
git diff | shasum -a 256
# d0758f81e21569310cc2b6ee81c80fecd2170e5b8c2e9c01c8ae6c8ad55cade7
```

No `src` file was modified after the freeze during the final crawl (checked with `find src -newermt "2026-11-14 19:58:56"`).

### 7.2 Isolated demo server

```bash
OA_DEMO=1 OA_DATA_DIR=/tmp/visual-audit-final/data OA_PORT=2311 \
  node src/server.mjs
```

The server was started and stopped by the same supervised shell; it was **never** pointed at `/var/lib/openadmin` and no deployment command was run.

### 7.3 Crawl / screenshots

```bash
node tools/visual-audit.mjs \
  --base http://127.0.0.1:2311 \
  --out /tmp/visual-audit-final
```

The harness logs in through the real login form as `demoadmin/demo`, `demoreseller/demo` and `demouser/demo`, sets a CDP device viewport, disables cache, captures full-page + viewport screenshots, collects DOM metrics, console/network events, and performs a server-side HTML form scan plus a sampled link check. The script is read-only with respect to `src`.

### 7.4 Sidebar dead-link probe

```bash
curl -s -c /tmp/visual-audit-final/probe.cookies \
  -o /dev/null -X POST -d 'username=demoadmin&password=demo' \
  http://127.0.0.1:2311/login

for p in /admin/netdata /admin/rspamd /admin/automation; do
  printf '%s %s\n' \
    "$(curl -s -b /tmp/visual-audit-final/probe.cookies -o /dev/null -w '%{http_code}' http://127.0.0.1:2311$p)" \
    "$p"
done
# 404 /admin/netdata
# 404 /admin/rspamd
# 200 /admin/automation
```

### 7.5 404 screenshots

```bash
COOKIE=$(awk '$6=="OA_SESSION"{print $6"="$7}' /tmp/visual-audit-final/probe.cookies)

node tools/shot.mjs \
  http://127.0.0.1:2311/admin/netdata \
  /tmp/visual-audit-final/shots/admin__netdata-404__1440__full.png \
  --cookie "$COOKIE" --size 1440x1000 --full

node tools/shot.mjs \
  http://127.0.0.1:2311/admin/rspamd \
  /tmp/visual-audit-final/shots/admin__rspamd-404__1440__full.png \
  --cookie "$COOKIE" --size 1440x1000 --full
```

### 7.6 Cleanup

```bash
kill -TERM <server-pid>
rm -rf /tmp/visual-audit-final/chrome-profile
```

The final HTML/screenshot artifacts are retained under `/tmp/visual-audit-final/` for review. Only the ephemeral Chrome profile was removed.

---

## 8. Evidence map

| Artifact | Path |
|---|---|
| Full raw metrics | `/tmp/visual-audit-final/raw.json` |
| Audit log | `/tmp/visual-audit-final/logs/audit.log` |
| Server log | `/tmp/visual-audit-final/logs/server.log` |
| Screenshots (377: 375 crawl + 2 404 probes) | `/tmp/visual-audit-final/shots/` |
| Source snapshot hash | `/tmp/visual-audit-final/src-diff.sha256` |
| Key file hashes | `/tmp/visual-audit-final/key-files.sha256` |
| Snapshot time | `/tmp/visual-audit-final/snapshot-at.txt` |
| Audit harness (new, non-app) | `/Users/lukasz/Downloads/OpenAdmin/tools/visual-audit.mjs` |

### Reproducibility caveat

- Only GET navigation was exercised. Success/validation flash states, destructive confirmations, file uploads, checkout-style multistep submissions and dark-mode rendering were not part of this pass.
- The demo dataset includes 112 databases (likely test pollution). The database page’s missing pagination is still a real issue for accounts with many databases, but its exact row count is demo-specific.
- Full-page screenshots at 390 can be very tall; the longest (`admin/processes` 15,194 px) is preserved without truncation.
- The repository is on a working-tree snapshot, not `HEAD`; the report intentionally describes the frozen working tree.


---

## Post-fix verification — 2026-11-14 20:33 CET

Re-ran the same crawl against the integrated tree after the shell, feature and
provisioning fixes:

- **186 page snapshots / 72 route variants / 390-768-1440 px**: **0** HTTP errors,
  **0** JavaScript exceptions, **0** failed assets, **0** page-level horizontal
  overflow, **0** duplicate IDs, **0** POST forms without a CSRF token after shell initialization,
  **0** escaped form markup.
- **154/154 tests** pass locally and on the Debian container.
- P1-01: alerts now render safe inline fragments; no literal `<strong>`/`<code>`
  text in browser output.
- P1-02: all 28 table actions render buttons without a confirm string.
- P1-03/P1-04: mobile tables pin the action column; service actions wrap.
- P1-05: `/user/websites/new` is a real four-step wizard with indicator,
  next/back, validation and no-JS fallback.
- P1-06: core add-domain/edit/reseller flows translated; remaining brand names
  (`Let's Encrypt`, engine names) intentionally stay untranslated.
- P1-07: `--muted` now `#596b7e` (5.48:1 on white).
- P2-01/02/03/04/05/06/08/09/12/13: nav links, automation discovery, tab
  affordance, empty selects, queue action, process/database pagination, CSRF,
  date locale, help copy and WebDisk URL are fixed.

Artifacts: `/tmp/visual-audit-current/raw.json` and
`/tmp/visual-audit-current/shots/`.
