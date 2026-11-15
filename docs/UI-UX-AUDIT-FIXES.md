# UI/UX audit fixes — 2026-11-15

Base report: `AUDYT_UI_UX_OPENADMIN_2026-11-15.md`.

## Mobile data surfaces

- Added a `responsive-table` contract: below 760 px every row becomes a card
  with visible labels (`data-label`), full-width details and 44–48 px actions.
  Applied to Health, Automation jobs/runs, statistics, backup tables and the
  Files list.
- Added a shared row menu (`.more-menu`): one primary action, secondary actions
  with text labels, destructive actions separated and confirmed.
- Health, Automation, statistics, domain list, backup tabs and Files were
  re-checked at 390 px; touch targets below 44 px are now caught by QA.
- Backup tabs were shortened to `Lokalizacje · Zadania · Historia · Operacje`.
- File manager: one “Nowy” menu, upload, labelled overflow actions, count below
  the breadcrumb and a responsive list.
- App logs now show the last 40 matching lines with search and download.
- Domain list uses cards; existing paths wrap instead of clipping.

## Dashboards and wizard

- Admin dashboard: removed duplicate hero heading, secondary hero CTAs and the
  bottom tool grid; services are a 3-number summary; activity is capped at 5.
- User dashboard: removed Quick actions and All tools, capped recommendations to
  3 apps, hid completed onboarding, capped activity at 5.
- Reseller dashboard: one primary “Dodaj klienta” action, no duplicate quick tile
  grid.
- Account wizard now says the real `Krok 1 z 5`; step count is asserted in tests.
  Mobile shows only the active step; desktop labels wrap instead of ellipsis.
- Domain wizard defaults to recommended configuration; engine/PHP/SSL are under
  “Opcje zaawansowane”, and the existing-domain list uses cards.

## Language and forms

- Login is Polish by default for a Polish panel; the client locale layer respects
  the document language instead of overriding it with the browser language.
- 2FA, account menu, automation, DNS, web apps, databases, backup and error pages
  use Polish labels; the automation technical footer is collapsed.
- Database prefix is a fixed input-group segment; server settings use read-only
  values and Polish sections; backup destination fields hide when not applicable.
- QA now checks clipped text and mobile touch targets for key routes in addition
  to document overflow.

## Verification

- `node --test`: 305/305.
- `node tools/qa-final.mjs`: 54/54, 350 routes, 0 route issues, 14/14 security,
  27 axe pages, 7/7 counters, 65 screenshots.
- Screenshots: light/dark demo at 390 and 1280 in `/tmp/oa-ui-qa6/shots`.

## Final verification

- Implementation commit: `817f31a`.
- `node --test`: 305/305.
- `node tools/qa-final.mjs`: 54/54 checks, 350 routes with **0 issues**, no
  horizontal overflow, no clipped key-page text, no touch target under 44 px on
  audited mobile routes, 14/14 security, 27 axe pages, 65 screenshots.
- Live: `https://192.168.3.240:2222`, build `1.0.0+817f31a7b9ce`; login renders
  in Polish; admin/user dashboards show the slimmed layouts.

Residual: the historical CSS file still contains some older duplicate component
blocks (the newest responsive/action/table rules are authoritative and passed QA);
advanced feature screens outside the audited core may still contain technical
English labels. These are not hidden by the UI changes.

## Final width sweep

- QA run at **390 / 768 / 1024 / 1280 / 1440 px**: 54/54 checks, **395
  route/width combinations**, 0 route issues, 0 overflow, 0 clipped key-page
  text, 0 mobile touch targets below 44 px, 14/14 security, 27 axe pages,
  65 screenshots.
- Login is Polish by default; dashboard onboarding owns the only primary CTA on
  a new user account; `.quick-grid` no longer has contradictory mobile rules.

## CSS consolidation

- Consolidated all duplicate top-level component selectors into one declaration
  per selector (card, card head/body, stat grid/card/icon/value/label/sub, quick
  grid/tile, table wrap/data table, buttons and variants, shell/nav, forms and
  remaining exact duplicates). The audit's duplicate list is now resolved at the
  top level; media-query overrides remain intentionally responsive.
- Restored `.only-mobile.icon-btn` specificity so the sidebar close control is
  hidden on desktop and visible only at mobile widths.
- Ran the full QA at 390/768/1024/1280/1440 px after consolidation: 0 route
  issues, no overflow, no clipped text, no undersized touch targets.
