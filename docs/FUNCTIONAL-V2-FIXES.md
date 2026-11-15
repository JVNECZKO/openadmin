# Functional audit V2 — implementation report

Base audited commit: `6b5daf9`. Implementation commit: `7aeb3b5`.

## Presentation

- Removed visible `P0`/`P1`/`P2` codes from the dashboard, Action Center,
  filters/badges and Security Center. User-facing labels are now:
  `Krytyczne — działaj teraz`, `Ważne — zaplanuj naprawę`, `Zalecenie`;
  the dashboard link is `Pokaż krytyczne`. Internal enum values remain in the
  API/database only.
- Completed Polish for 2FA enrollment/disable, login 2FA challenge, account
  menu, automation job names/descriptions/statuses, DNS, web apps, databases,
  backup center and error pages.
- Technical job keys are no longer rendered on the main automation list; the
  operator sees translated names first. Backup operation stages/statuses are
  translated.
- phpMyAdmin/Roundcube logs show the last 40 matching lines, with search and a
  separate full-log download (`/admin/web-apps/:id/logs/download`).

## Diagnostics

- Health now separates three mail-DNS facts: record in the panel zone, deployed
  zone file, and public resolver visibility. For `.local` it reports
  `Nie można potwierdzić publicznie — rekord istnieje lokalnie` instead of
  `Brakuje`.
- An account without 2FA is presented as `Zalecenie`, and its source status is
  `info` rather than an active problem plus green `OK`.

## Verification

- `node --test tests/*.test.mjs`: **305/305 pass**.
- `node tools/qa-final.mjs`: **54/54**, 350 routes, 0 route issues, 14/14
  security checks, 27 axe pages, 7/7 counters, 65 screenshots.
- Live: `https://192.168.3.240:2222`, build `1.0.0+7aeb3b5e9c35`.
- Live checks: no visible P codes on dashboard/Action Center/Security; 2FA page
  and challenge are Polish; DNS health shows the local-confirmation phrase;
  automation has no audit-listed English labels; phpMyAdmin SSO still works.

## Operator note

`ADMIN-2FA-SETUP.txt` still contains the TOTP secret and unused recovery codes.
Store them in the password manager and delete the file. TLS remains the accepted
self-signed exception for this private-IP development instance.
