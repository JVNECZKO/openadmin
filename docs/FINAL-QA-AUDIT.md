# OpenAdmin — FINAL QA audit

**Date:** 14 November 2026, 23:31 CET (22:31 UTC)
**Audited snapshot:** frozen working tree, `src/` aggregate SHA-256 `4db91ead404201915b673f9b192223ebe27521a52985566f79ad72a454c1c31c`
**Git HEAD:** `06614f9590b596806f15b767ae2651cb006c4022` (60 files modified in the working tree; the hash above identifies the audited state)
**Environment:** isolated demo server, `OA_DEMO=1`, fresh `OA_DATA_DIR`, sandbox provider, dynamic loopback port, `OA_MAX_UPLOAD_MB=16`, no configured trusted proxies
**Browser:** Google Chrome headless, 390/768/1280/1920 px, explicit light **and** dark themes
**axe-core:** 4.11.1, loaded from a local `node_modules/axe-core` installation — nothing installed
**Constraint:** `src/` was not edited by this audit. All test mutations happened inside the throw-away demo data directory.
**Artifacts:** [results.json](qa-final/results.json) · [run-report.md](qa-final/run-report.md) · [tests.log](qa-final/tests.log) · [screenshots](qa-final/screenshots)

---

## 1. Executive summary

**Verdict: PASS — no P0/P1/P2 residual defect was found on the frozen snapshot.**

All previously reported residuals are fixed and were re-measured in this run:

| # | Previously reported | Final result |
|---|---|---|
| 1 | Login hardcoded English | **PASS** — `?lang=pl`, `Accept-Language: pl`, `oa_lang=pl` all render PL; `?lang=en` overrides a PL header |
| 2 | Light `.badge-ok` contrast 4.49:1 | **PASS** — `#147a39` on `#e8f6ed` = **4.86:1** |
| 3 | Dark `.btn-primary` contrast 3.48:1 | **PASS** — white on `#0d6fae` = **5.38:1** |
| 4 | 1280 px service names wrapped | **PASS** — 12 names, 0 narrower than 80 px, 0 wrapped |
| 5 | `/admin/templates` showed `[object Object]` | **PASS** — all three rows render correctly |
| 6 | 254 unlabeled controls | **PASS** — **0** missing accessible names across 128 pages |

**Counts**

| Result | Value |
|---|---:|
| Automated checks | **54 pass / 0 fail / 0 warn / 0 skip** |
| Route/width snapshots | **346** (128 @390, 45 @768, 128 @1280, 45 @1920, including login) |
| Route snapshots with findings | **0** |
| Security negative checks | **14/14 pass** |
| Dashboard/list/DB counter checks | **7/7 pass** |
| axe page runs | **27** (19 light + 8 dark) |
| axe violations (any impact) | **0** |
| Form-label check | **0 missing** across 128 light-theme pages |
| JS console errors / failed requests | **0 / 0** |
| Horizontal overflow | **0 / 346** route-width combinations |
| Duplicate IDs / broken ARIA refs | **0 / 0** |
| Forbidden text (`undefined`, `null`, `Nothing here yet`, `Brak:`, `[object Object]`) | **0** |
| Dark-theme snapshots | **10/10 pass** |
| Full test suite | **301 tests / 301 pass / 0 fail** (20.5 s) |
| Audit wall time | 131 s |

The only non-blocking hardening note is an internal `sh -c` invocation in `src/apps.mjs` used by a numeric loopback port probe (no form data); see §8.

---

## 2. Fix verification (targeted)

### 2.1 Login locale (server-side PL/EN)

| Case | Expected | Result |
|---|---|---|
| `GET /login?lang=pl` | PL copy, `lang="pl"`, `oa_lang=pl` cookie | **PASS** |
| `GET /login` + `Accept-Language: pl-PL,pl;q=0.9` | PL copy, `lang="pl"` | **PASS** |
| `GET /login` + `Cookie: oa_lang=pl` | PL copy, `lang="pl"` | **PASS** |
| `GET /login?lang=en` + PL `Accept-Language` | EN copy, `lang="en"` (query wins) | **PASS** |

Implementation lives in `src/routes/auth.mjs:20-42` and `src/ui/layout.mjs:369-470`; both the initial page and the failed-login render path receive the locale. Screenshot: [light-login-1280.png](qa-final/screenshots/light-login-1280.png).

### 2.2 Contrast tokens

| Theme / element | Measured colours | Ratio | Required | Result |
|---|---|---|---:|---:|---|
| Light `.badge-ok` | `#147a39` on `#e8f6ed` | **4.86:1** | 4.5:1 | **PASS** |
| Dark `.btn-primary` | `#ffffff` on `#0d6fae` | **5.38:1** | 4.5:1 | **PASS** |

Both the targeted computed-style checks and axe-core report zero violations. The dark override is now consistent at `src/public/app.css:1265-1266` and `:2037-2038`. Screenshots: [admin light](qa-final/screenshots/admin_admin_settings-1280.png), [admin dark](qa-final/screenshots/dark-admin_admin_settings-1280.png), [dark user app catalogue](qa-final/screenshots/dark-user_user_app-catalog-1280.png).

### 2.3 1280 px service card

`layout/admin-service-names`: **12 service names**, all ≥80 px wide, no wrapped name. Screenshot: [admin-service-names-1280.png](qa-final/screenshots/admin-service-names-1280.png).

### 2.4 Templates and form labels

- `/admin/templates` renders `header.html`, `footer.html`, `login.html`; no `[object Object]`. Screenshot: [admin-templates-fixed-1280.png](qa-final/screenshots/admin-templates-fixed-1280.png).
- Form-label check: **0** missing accessible names across 128 pages; axe reports no `label` or `select-name` violations. `src/ui/a11y.mjs` supplies ids/aria-labels where markup lacked them.

---

## 3. Pass/fail matrix

### 3.1 Functional, UX and accessibility

| Area | Check | Result | Evidence |
|---|---|---|---|
| Environment | Isolated demo server, fresh port/data dir | **PASS** | `http://127.0.0.1:62509`, `/tmp/qa-final-run6/data` |
| Routing | Admin 65 / reseller 23 / user 39 nav routes at 390 & 1280 | **PASS** | 0 non-200, 0 failed requests |
| Routing | Critical routes at 768 & 1920 | **PASS** | 45 snapshots per width |
| Runtime | JS console errors / exceptions | **PASS** | 0 |
| Runtime | Failed HTTP requests (incl. 5xx) | **PASS** | 0 |
| Layout | Horizontal overflow | **PASS** | 0 / 346 route-width combinations |
| Layout | Forbidden text / `[object Object]` | **PASS** | 0 |
| Accessibility | Missing form labels / weak names | **PASS** | 0 / 128 pages |
| Accessibility | Duplicate IDs | **PASS** | 0 |
| Accessibility | Broken ARIA references | **PASS** | 0 |
| Accessibility | axe WCAG 2.0/2.1 A+AA | **PASS** | 0 violations on 27 page-runs |
| Themes | Explicit light theme | **PASS** | mode `""`, white body |
| Themes | Dark mode at 1280/390 | **PASS** | 10/10 mode, background, overflow, console |
| i18n | Login locale query/header/cookie | **PASS** | 4/4 cases |
| Context | Admin opening `/user` without subject | **PASS** | explicit notice, no mixed-data banner, identity stays admin |
| Context | Impersonation banner | **PASS** | actor `admin`, subject `demouser`, read-only, exit button |
| Context | Read-only preview write | **PASS** | POST `/user/login-keys/create` → 403; row count unchanged |
| Context | Stop impersonation | **PASS** | 302 → `/admin`, actor session restored |
| Catalogue | installed=1, installed=0, search-empty, `#app-wordpress` | **PASS** | exactly one state at a time; anchored card focused |
| Content | `/admin/templates` table | **PASS** | three rows, no `[object Object]` |
| Counters | Admin 3/2/5; reseller 1/2; user email 4/50; DBs 1/10; API 4/2; services 7/7; catalogue 0 | **PASS** | all match DB |
| i18n | Forbidden production placeholders | **PASS** | 0 |

### 3.2 Screenshots

![Admin dashboard — light](qa-final/screenshots/admin_admin-1280.png)
![Admin dashboard — dark](qa-final/screenshots/dark-admin_admin-1280.png)
![Login — light](qa-final/screenshots/light-login-1280.png)
![Login — dark](qa-final/screenshots/dark-login_login-1280.png)

Additional states: [admin 390](qa-final/screenshots/admin_admin-390.png), [user 1280](qa-final/screenshots/user_user-1280.png), [user 390](qa-final/screenshots/user_user-390.png), [reseller](qa-final/screenshots/reseller_reseller-1280.png), [templates](qa-final/screenshots/admin-templates-fixed-1280.png), [service card](qa-final/screenshots/admin-service-names-1280.png), [admin `/user` notice](qa-final/screenshots/admin-user-view-notice-1280.png), [impersonation banner](qa-final/screenshots/impersonation-banner-1280.png), [catalogue installed=1](qa-final/screenshots/demouser-catalogue-installed-390.png), [catalogue installed=0](qa-final/screenshots/qauserb-catalogue-installed-390.png), [admin create wizard](qa-final/screenshots/admin_admin_users_create-1280.png).

Full 65-shot set: `/tmp/qa-final-run6/shots/` (ephemeral). The 20 representative files are copied under `docs/qa-final/screenshots/`.

---

## 4. Security negative checks (P0/P1)

Non-destructive, isolated demo.

| ID | Check | Result | Evidence |
|---|---|---|---|
| SEC-001 | Reseller A cannot read/write/delete reseller B DNS; user cross-scope denied | **PASS** | A sees own 3 domains, not `qa-b.example`; GET/POST/DELETE foreign → 404/404/404; B own GET → 200 |
| SEC-002 | Symlink file/dir and hardlink cannot escape tenant home | **PASS** | download 403, upload symlink 403, symlink dir 403, hardlink 403; outside file unchanged; unsafe link listed |
| SEC-003 | No form data reaches `sh -c` in installer modules | **PASS** | installer modules use argv; only static numeric-port `sh -c` in `apps.mjs` (P3 note) |
| SEC-004 | Login-key command allowlist deny-by-default | **PASS** | `CMD_API_DOMAIN` → `error=0`; `CMD_API_POP` → `error=1`; `/api/v1/email` → 401 |
| SEC-005 | Unsigned update refused; signature enforcement | **PASS** | unsigned → `unsigned`; valid Ed25519 → ok; forged signature → `invalid_signature` |
| SEC-019 | MCP tenant scope A/B/user; admin tools hidden | **PASS** | 0 admin-only tools leaked; `get_health` denied; domains/backups scoped |
| SEC-006 | X-Forwarded-For trust | **PASS** | spoofed XFF login audited as socket `127.0.0.1`; proxy chain only when explicitly trusted |
| SEC-007 | Session cookie flags | **PASS** | `HttpOnly`, `SameSite=Lax`, `Path=/` |
| SEC-008 | Password policy enforced centrally | **PASS** | weak password rejected, 0 rows created |
| SEC-009 | REST Basic Auth shares rate limiter | **PASS** | after 9 failures correct password still 401 |
| SEC-011 | SSO nonce one-time and session-bound | **PASS** | first ok; replay `reused`; wrong session `session_mismatch`; correct session succeeds |
| OA-031 | Upload honours configured limit | **PASS** | 13 MiB upload accepted; declared over-limit body → 413; UI/config show 16 MB |
| OA-032 | Backup job idempotency | **PASS** | two concurrent runs → one operation job, same id |
| SEC-020/023 | Support/reset tokens one-time (suite) | **PASS** | covered by 301/301 tests |

> Live PHP SSO replay is not possible in the sandbox (phpMyAdmin/PHP not installed). Nonce replay/TTL/session binding was exercised directly against `src/secrets.mjs` with a real DB row; the HTTP hand-off is covered by `tests/sso-context.test.mjs`.

---

## 5. Full test suite (frozen tree)

Command:

```bash
cd /Users/lukasz/Downloads/OpenAdmin
node --test --test-timeout=120000 tests/
```

Result: **301 tests, 301 pass, 0 fail, 0 skipped, 20.5 s**. Log: [tests.log](qa-final/tests.log). There is no failing test/assertion on this snapshot.

---

## 6. Exact commands and reproduction

```bash
cd /Users/lukasz/Downloads/OpenAdmin

# frozen snapshot identity
find src -type f -print0 | sort -z | xargs -0 shasum -a 256 | shasum -a 256
# 4db91ead404201915b673f9b192223ebe27521a52985566f79ad72a454c1c31c

# full suite
node --test --test-timeout=120000 tests/ | tee docs/qa-final/tests.log

# full E2E / visual / security audit (starts its own isolated demo)
node tools/qa-final.mjs --out /tmp/qa-final-run6
```

`tools/qa-final.mjs` starts a fresh server with `OA_DEMO=1`, a new data dir on a free port, `OA_ADMIN_USER=admin`, `OA_MAX_UPLOAD_MB=16`, a unique IMAP port, and no `OA_TRUSTED_PROXIES`. It logs in through the real `/login` form as admin, `demoreseller/demo` and `demouser/demo`, forces light theme for the main sweep and dark theme for a separate pass, sweeps 65 admin + 23 reseller + 39 user nav routes, runs axe-core from the local installation, then performs the negative security matrix over HTTP and at module level. It never edits `src/` or touches the host panel.

Existing instance:

```bash
node tools/qa-final.mjs --base http://127.0.0.1:2222 --admin-pass '…' \
  [--data-dir /var/lib/openadmin] [--skip-security] [--skip-visual]
```

---

## 7. Definition of Done mapping

| DoD item | Status | Note |
|---|---|---|
| Correct role and explicitly selected account | **PASS** | admin/reseller/user identity; admin `/user` notice; impersonation subject |
| Negative cross-tenant test per object type | **PASS** | SEC-001 matrix, MCP matrix, backup ownership |
| No path leaves tenant root (incl. symlink) | **PASS** | SEC-002 live symlink/hardlink |
| No user data in `sh -c` | **PASS** | SEC-003 installer scan; numeric-port probe is P3 hardening |
| Cookies/tokens contract; login-key scope | **PASS** | SEC-004, SEC-007, SEC-011 |
| Login PL/EN from query/header/cookie | **PASS** | 4/4 locale cases |
| Keyboard + axe without critical violations | **PASS** | 0 axe violations / 27 runs; 0 missing labels |
| 390, 768, 1280, 1920 px | **PASS** | 346 snapshots, 0 overflow |
| Loading/empty/error/stale/partial states | **PASS (audited surfaces)** | app catalogue, counters, impersonation read-only; not every module re-rendered |
| Server validation, audit, idempotency | **PASS** | password policy, CSRF, backup idempotency |
| Long process is a job with retry/result | **PASS** | backup double-run creates one durable operation |
| Dashboard counter equals list/API/DB | **PASS** | 7/7 count checks |
| Missing data is not shown as zero | **PASS (suite)** | `metrics-truth.test.mjs`; dashboard meters matched DB |
| Success only after system confirmation | **PASS (suite)** | jobs/restore and automation tests |
| Documentation + E2E in the same change | **PASS** | this document and `tools/qa-final.mjs` |

---

## 8. Residual issues

**P0 / P1 / P2: none.**

Non-blocking hardening note (P3):

- `src/apps.mjs` `portOpen(port)` still calls `spawnSync('sh', ['-c', 'curl … ${port} …'])` for an internal numeric loopback port. No request/form data reaches it, so SEC-003 is not violated, but replacing it with an argv `curl` call or an `http` probe would remove the last shell-string invocation from the app.
- Full linguistic review of every module is broader than this automated gate; the audited login flow and scanned pages contain no forbidden placeholders, but “100% translated” is not re-proven for every one of the 127 routes.

### Limitations

- Audited provider is `sandbox`, not a live Proxmox/Linux panel. No reboot, DNS, SSL, real MariaDB or real mail delivery was performed.
- phpMyAdmin/PHP are not installed in the sandbox; SSO replay is verified at module level + suite, not by a live PHP redirect.
- Upload test used `OA_MAX_UPLOAD_MB=16` to keep the payload small; it exceeds the old 12 MB cap and exercises the same body-limit path as 64 MB.
- Dark theme was snapshot-verified on 10 key pages (1280/390); all 65 routes were not duplicated in dark.
- Screenshot review is broad but not a substitute for a human design review of every card.

---

## 9. Files

| Path | Contents |
|---|---|
| [tools/qa-final.mjs](../tools/qa-final.mjs) | reproducible E2E/visual/security harness |
| [docs/qa-final/results.json](qa-final/results.json) | full machine-readable run (346 route records, all checks, axe evidence) |
| [docs/qa-final/run-report.md](qa-final/run-report.md) | generated per-check report |
| [docs/qa-final/tests.log](qa-final/tests.log) | full `node --test` output |
| [docs/qa-final/screenshots](qa-final/screenshots) | 20 representative evidence screenshots |

---

## 12. Post-audit hardening (goal round 1)

After the frozen audit, the following hardening landed and was verified by the browser smoke plus the full suite:

- **CSP:** every HTML response now gets a fresh script nonce; `script-src` no longer contains `unsafe-inline`; all legacy inline `onclick`/`onchange` handlers were replaced by delegated `data-confirm` / `data-auto-submit` handlers. Browser smoke: 0 CSP violations and 0 scripts without a nonce.
- **Webmail sessions:** tokens are stored as SHA-256 hashes, not raw values; legacy rows migrate on first use; the cookie is HttpOnly/SameSite=Strict and Secure over HTTPS.
- **Impersonation:** an explicit, audited “Włącz tryb zapisu” action escalates a read-only preview; the default remains read-only.
- **Database onboarding:** password is optional and auto-generated with one-time credential display; the live `klient1` flow was re-tested and the temporary database removed.
- **Test suite:** 301/301 passing, including a CSP regression test. Commits: `fca90d0`, `8e9f30d`, `5b1b5fd`.

---

## 13. Goal round 2 — bulk operations and mail onboarding

- **Bulk actions (OA-030):** `/admin/bulk` and `/reseller/bulk` support scoped selection of users/domains, signed preview tokens, per-object permission revalidation, suspend/activate/package/backup/SSL/PHP/message actions, durable backup/ACME jobs, partial-failure reports and idempotent replay. Admin accounts and foreign tenants are blocked.
- **Mail onboarding (OA user QoL):** mailbox setup guide at `/user/email/setup` with IMAP/SMTP settings, autoconfig URL, optional QR, SPF/DMARC/DKIM zone health and an IMAP/SMTP port probe. Existing public autoconfig remains the single source for mail clients.
- **Deployment:** both changes are live on the panel; bulk and setup pages return HTTP 200 for the intended roles.
- **Tests:** 301/301 passing (`node --test tests/*.test.mjs`). Commit `667eff7`.

- **Session rotation:** password changes and 2FA enable/disable reissue the panel session token/CSRF; read-only previews are never rotated so the actor cookie stays valid.


---

## 14. Goal round 3 — suspension lifecycle and client 360°

- Temporary suspensions now store a reason and an optional `suspended_until`; the durable scheduler automatically unsuspends expired accounts and writes an audit entry (`system/user.auto_unsuspend`).
- The reseller/admin account page shows a single client-360 card: mailboxes, databases, installed applications and recent tickets, scoped to that client.
- Tests: 301/301 passing. Live deployment follows the same source tree.


- **Statistics:** `/user/statistics` now breaks disk down into files/poczta/bazy/backupy, shows the measurement timestamp/source, 80/90/100% alerts, a 30-day transfer forecast, and CSV/JSON export. Tested in the smoke suite.
