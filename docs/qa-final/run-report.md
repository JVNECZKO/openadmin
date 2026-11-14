# OpenAdmin QA final — automated run

- Generated: 2026-11-14T22:31:39.814Z
- Base: http://127.0.0.1:62509 (isolated demo server)
- Node: v26.11.1; Chrome: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
- axe-core: 4.11.1 (/Users/lukasz/Desktop/Rebrand_v2/node_modules/axe-core/axe.min.js)
- Duration: 131.1s

## Check matrix

| Area | Check | Status | Detail |
|---|---|---|---|
| env | isolated-server | PASS | demo server on http://127.0.0.1:62509 with fresh data dir |
| a11y | axe-core | PASS | axe-core 4.11.1 loaded locally (no install) |
| i18n | login-locale | PASS | query-pl:pl/pl · header-pl:pl/pl · cookie-pl:pl/pl · query-en-over-header-pl:en/en |
| setup | reseller-b | PASS | reseller B scope domains: qa-b.example |
| security | SEC-001-reseller-ab | PASS | A sees [example.com,reseller-demo.local,demo-site.org] B sees [qa-b.example]; foreign read/write/delete=404/404/404; user foreign=404; B own=200 |
| security | SEC-002-symlink-hardlink | PASS | download=403 uploadLink=403 uploadDir=403 uploadHard=403 outsideIntact=true listedUnsafe=true |
| security | SEC-003-no-sh-c | PASS | installer modules use argv only; apps.mjs port probe still uses sh -c for an internal numeric port (P2 hardening) |
| security | SEC-004-login-key-scope | PASS | allowed=200/true deniedCMD=200/true deniedAPI=401 |
| security | SEC-005-unsigned-update | PASS | unsigned=unsigned signedGood=true signedBad=invalid_signature |
| security | SEC-019-mcp-scope | PASS | admin-only leaked=0; health reseller/user=true/true; resellerDomains=[example.com,reseller-demo.local,demo-site.org]; userDomains=[example.com,demo-site.org]; userBackups=2 |
| security | SEC-006-xff-trust | PASS | spoofed XFF login audit ip=127.0.0.1 (expected socket 127.0.0.1) |
| security | SEC-009-basic-rate-limit | PASS | created=true (302) after 9 failures correct password -> 401 (expected 401) |
| security | SEC-008-password-policy | PASS | weak password -> HTTP 200; user rows=0 |
| security | SEC-011-sso-replay | PASS | first=true replay=reused mismatch=session_mismatch correctSessionAfterMismatch=true |
| security | SEC-007-cookie-flags | PASS | login cookies: OA_SESSION=a9c20118793812e571774583915327e2d32beb00d34a88829af2206ec15ec4cf; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400 |
| security | OA-031-upload-limit | PASS | ui/config shows 16MB=true; 13MiB upload=200; oversized declared body=413 (expected 413) |
| security | OA-032-backup-idempotency | PASS | two concurrent run clicks -> operation jobs=1, ids=1/1 |
| security | SEC-006-proxy-chain | PASS | untrusted=203.0.113.5 trusted=198.51.100.7 other=203.0.113.5 |
| theme | light-mode | PASS | explicit light theme -> mode="" body=rgb(255, 255, 255) |
| routes | admin-nav | PASS | 65 routes discovered for admin |
| routes | admin-walk | PASS | walked 65 routes at 1280/390 |
| routes | reseller-nav | PASS | 23 routes discovered for reseller |
| routes | reseller-walk | PASS | walked 23 routes at 1280/390 |
| routes | user-nav | PASS | 39 routes discovered for user |
| routes | user-walk | PASS | walked 39 routes at 1280/390 |
| catalogue | demouser-states | PASS | tiles=6 installed=1/1 installedState= noResultsKind=search hashTarget=true |
| catalogue | qauserb-states | PASS | tiles=6 installed=0/0 installedState=installed noResultsKind=search hashTarget=true |
| context | admin-user-view | PASS | explicit notice shown, no impersonation banner |
| context | impersonation-banner | PASS | actor=admin subject=demouser readOnly=1 exit=true |
| context | preview-read-only | PASS | write under preview -> HTTP 403; login_keys 0->0 |
| context | stop-impersonation | PASS | stop -> HTTP 302 /admin?flash=Zako%C5%84czono%20podgl%C4%85d%20konta%20demouser |
| content | admin-templates | PASS | table renders header.html/footer.html/login.html without [object Object] |
| layout | admin-service-names | PASS | 12 service names; 0 narrower than 80px or wrapped |
| theme | light-badge-contrast | PASS | .badge-ok rgb(20, 122, 57) on rgb(232, 246, 237) = 4.86:1 |
| theme | dark-primary-contrast | PASS | .btn-primary rgb(255, 255, 255) on rgb(13, 111, 174) = 5.38:1 |
| theme | dark-mode | PASS | 10 dark-theme page snapshots; 0 failed mode/background/overflow/console checks |
| a11y | form-labels | PASS | 0 unlabeled/weakly labelled control(s) across 128 audited pages |
| a11y | duplicate-ids | PASS | 0 duplicate id(s) across audited pages |
| a11y | aria-references | PASS | 0 broken aria-labelledby/describedby/controls reference(s) |
| a11y | axe-serious | PASS | 0 serious/critical violation group(s) on 27 page(s) |
| a11y | axe-runtime | PASS | 0 page(s) failed to run axe |
| counts | admin-dashboard-vs-db | PASS | dashboard 3/2/5 users/resellers/domains vs DB 3/2/5 |
| counts | services-dashboard-vs-page | PASS | dashboard "7/7 oczekiwanych usług działa" vs services page "7 z 7 oczekiwanych działa" |
| counts | reseller-dashboard-vs-db | PASS | dashboard 1 clients/2 domains vs DB 1/2 |
| counts | user-email-meter-vs-db | PASS | meter 4/50 vs DB 4 |
| counts | user-databases-meter-vs-db | PASS | meter 1/10 vs DB 1 |
| counts | user-api-list-vs-db | PASS | API email/domains 4/2 vs DB 4/2 |
| counts | catalogue-counter-vs-db | PASS | qauserb catalogue installed chip=0 vs DB=0 |
| routes | http-status | PASS | 0/346 route/width checks returned >=400 |
| layout | horizontal-overflow | PASS | 0/346 route/width combinations overflow horizontally |
| runtime | console-errors | PASS | 0 unique JS console error(s) |
| runtime | failed-5xx | PASS | 0 failed 5xx request(s) |
| i18n | forbidden-texts | PASS | 0 forbidden text occurrence(s) |
| layout | width-coverage | PASS | audited routes per width: {"390":128,"768":45,"1280":128,"1920":45} |

## Security checks

| Check | Status | Detail |
|---|---|---|
| SEC-001-reseller-ab | PASS | A sees [example.com,reseller-demo.local,demo-site.org] B sees [qa-b.example]; foreign read/write/delete=404/404/404; user foreign=404; B own=200 |
| SEC-002-symlink-hardlink | PASS | download=403 uploadLink=403 uploadDir=403 uploadHard=403 outsideIntact=true listedUnsafe=true |
| SEC-003-no-sh-c | PASS | installer modules use argv only; apps.mjs port probe still uses sh -c for an internal numeric port (P2 hardening) |
| SEC-004-login-key-scope | PASS | allowed=200/true deniedCMD=200/true deniedAPI=401 |
| SEC-005-unsigned-update | PASS | unsigned=unsigned signedGood=true signedBad=invalid_signature |
| SEC-019-mcp-scope | PASS | admin-only leaked=0; health reseller/user=true/true; resellerDomains=[example.com,reseller-demo.local,demo-site.org]; userDomains=[example.com,demo-site.org]; userBackups=2 |
| SEC-006-xff-trust | PASS | spoofed XFF login audit ip=127.0.0.1 (expected socket 127.0.0.1) |
| SEC-009-basic-rate-limit | PASS | created=true (302) after 9 failures correct password -> 401 (expected 401) |
| SEC-008-password-policy | PASS | weak password -> HTTP 200; user rows=0 |
| SEC-011-sso-replay | PASS | first=true replay=reused mismatch=session_mismatch correctSessionAfterMismatch=true |
| SEC-007-cookie-flags | PASS | login cookies: OA_SESSION=a9c20118793812e571774583915327e2d32beb00d34a88829af2206ec15ec4cf; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400 |
| OA-031-upload-limit | PASS | ui/config shows 16MB=true; 13MiB upload=200; oversized declared body=413 (expected 413) |
| OA-032-backup-idempotency | PASS | two concurrent run clicks -> operation jobs=1, ids=1/1 |
| SEC-006-proxy-chain | PASS | untrusted=203.0.113.5 trusted=198.51.100.7 other=203.0.113.5 |

## Routes with issues


## Screenshots

- light-login-1280: shots/light-login-1280.png
- login-390: shots/login-390.png
- login-1280: shots/login-1280.png
- admin_admin-1280: shots/admin_admin-1280.png
- admin_admin_users_create-1280: shots/admin_admin_users_create-1280.png
- admin_admin_settings-1280: shots/admin_admin_settings-1280.png
- admin_admin_security-1280: shots/admin_admin_security-1280.png
- admin_admin_health-1280: shots/admin_admin_health-1280.png
- admin_admin_automation-1280: shots/admin_admin_automation-1280.png
- admin_admin_backup-center-1280: shots/admin_admin_backup-center-1280.png
- admin_admin_web-apps-1280: shots/admin_admin_web-apps-1280.png
- admin_help-1280: shots/admin_help-1280.png
- admin_admin-390: shots/admin_admin-390.png
- admin_admin_users_create-390: shots/admin_admin_users_create-390.png
- admin_admin_settings-390: shots/admin_admin_settings-390.png
- admin_admin_security-390: shots/admin_admin_security-390.png
- admin_admin_health-390: shots/admin_admin_health-390.png
- admin_admin_automation-390: shots/admin_admin_automation-390.png
- admin_admin_backup-center-390: shots/admin_admin_backup-center-390.png
- admin_admin_web-apps-390: shots/admin_admin_web-apps-390.png
- admin_help-390: shots/admin_help-390.png
- reseller_reseller-1280: shots/reseller_reseller-1280.png
- reseller_reseller_users_create-1280: shots/reseller_reseller_users_create-1280.png
- reseller_reseller_domains-1280: shots/reseller_reseller_domains-1280.png
- reseller_reseller_packages_create-1280: shots/reseller_reseller_packages_create-1280.png
- reseller_help-1280: shots/reseller_help-1280.png
- reseller_reseller-390: shots/reseller_reseller-390.png
- reseller_reseller_users_create-390: shots/reseller_reseller_users_create-390.png
- reseller_reseller_domains-390: shots/reseller_reseller_domains-390.png
- reseller_reseller_packages_create-390: shots/reseller_reseller_packages_create-390.png
- reseller_help-390: shots/reseller_help-390.png
- user_user-1280: shots/user_user-1280.png
- user_user_domains_create-1280: shots/user_user_domains_create-1280.png
- user_user_email-1280: shots/user_user_email-1280.png
- user_user_email_new-1280: shots/user_user_email_new-1280.png
- user_user_databases_create-1280: shots/user_user_databases_create-1280.png
- user_user_files-1280: shots/user_user_files-1280.png
- user_user_statistics-1280: shots/user_user_statistics-1280.png
- user_user_app-catalog-1280: shots/user_user_app-catalog-1280.png
- user_help-1280: shots/user_help-1280.png
- user_user-390: shots/user_user-390.png
- user_user_domains_create-390: shots/user_user_domains_create-390.png
- user_user_email-390: shots/user_user_email-390.png
- user_user_email_new-390: shots/user_user_email_new-390.png
- user_user_databases_create-390: shots/user_user_databases_create-390.png
- user_user_files-390: shots/user_user_files-390.png
- user_user_statistics-390: shots/user_user_statistics-390.png
- user_user_app-catalog-390: shots/user_user_app-catalog-390.png
- user_help-390: shots/user_help-390.png
- demouser-catalogue-installed-390: shots/demouser-catalogue-installed-390.png
- qauserb-catalogue-installed-390: shots/qauserb-catalogue-installed-390.png
- admin-user-view-notice-1280: shots/admin-user-view-notice-1280.png
- impersonation-banner-1280: shots/impersonation-banner-1280.png
- admin-templates-fixed-1280: shots/admin-templates-fixed-1280.png
- admin-service-names-1280: shots/admin-service-names-1280.png
- dark-admin_admin-1280: shots/dark-admin_admin-1280.png
- dark-admin_admin_users_create-1280: shots/dark-admin_admin_users_create-1280.png
- dark-admin_admin_settings-1280: shots/dark-admin_admin_settings-1280.png
- dark-reseller_reseller-1280: shots/dark-reseller_reseller-1280.png
- dark-user_user-1280: shots/dark-user_user-1280.png
- dark-user_user_app-catalog-1280: shots/dark-user_user_app-catalog-1280.png
- dark-user_user_files-1280: shots/dark-user_user_files-1280.png
- dark-login_login-1280: shots/dark-login_login-1280.png
- dark-admin_admin-390: shots/dark-admin_admin-390.png
- dark-user_user-390: shots/dark-user_user-390.png

## Counts

- admin-dashboard-vs-db: PASS — dashboard 3/2/5 users/resellers/domains vs DB 3/2/5
- services-dashboard-vs-page: PASS — dashboard "7/7 oczekiwanych usług działa" vs services page "7 z 7 oczekiwanych działa"
- reseller-dashboard-vs-db: PASS — dashboard 1 clients/2 domains vs DB 1/2
- user-email-meter-vs-db: PASS — meter 4/50 vs DB 4
- user-databases-meter-vs-db: PASS — meter 1/10 vs DB 1
- user-api-list-vs-db: PASS — API email/domains 4/2 vs DB 4/2
- catalogue-counter-vs-db: PASS — qauserb catalogue installed chip=0 vs DB=0

## Axe violations

- login /login: 0 serious (0 total)
- admin /admin: 0 serious (0 total)
- admin /admin/users/create: 0 serious (0 total)
- admin /admin/settings: 0 serious (0 total)
- admin /admin/security: 0 serious (0 total)
- admin /admin/health: 0 serious (0 total)
- admin /admin/backup-center: 0 serious (0 total)
- admin /help: 0 serious (0 total)
- reseller /reseller: 0 serious (0 total)
- reseller /reseller/users/create: 0 serious (0 total)
- reseller /reseller/domains: 0 serious (0 total)
- reseller /help: 0 serious (0 total)
- user /user: 0 serious (0 total)
- user /user/email: 0 serious (0 total)
- user /user/databases/create: 0 serious (0 total)
- user /user/files: 0 serious (0 total)
- user /user/statistics: 0 serious (0 total)
- user /user/app-catalog: 0 serious (0 total)
- user /help: 0 serious (0 total)
- admin /admin: 0 serious (0 total)
- admin /admin/users/create: 0 serious (0 total)
- admin /admin/settings: 0 serious (0 total)
- reseller /reseller: 0 serious (0 total)
- user /user: 0 serious (0 total)
- user /user/app-catalog: 0 serious (0 total)
- user /user/files: 0 serious (0 total)
- login /login: 0 serious (0 total)
