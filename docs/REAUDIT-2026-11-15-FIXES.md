# Reaudit 2026-11-15 — code fixes

## Closed in code

- **P1-01/P1-02:** `mailQueueSnapshot()` is the shared queue adapter. Automation exposes
  `executionStatus` and `observedStatus`, the Automation page shows both, Action Center
  consumes the same queue reading, and the contract test `failed=9` asserts a critical
  state on Dashboard, Health, Action Center and Automation.
- **P1-04:** application health probes `/phpmyadmin/` and `/roundcube/` rather than `/`;
  the Admin “Open” action for phpMyAdmin now points to the database picker. The live
  phpMyAdmin hand-off was re-tested end-to-end and reaches `index.php?db=...`.
- **P1-05:** `tools/build-info.mjs` produces an immutable `build-info.json` with commit,
  build ID, deploy time and manifest hash; runtime reads it before `.git`.
- **P1-07 (partial scope):** admin/reseller navigation labels are server-side localized,
  with a regression test rejecting the listed raw English labels.
- **P1-03:** the 13 frozen Exim notifications were traced to panel mail addressed to the
  unrouteable `admin@openadmin.local`; the queue was emptied and `sendMail()` now skips
  unhosted panel-local recipients instead of generating delivery bounces.
- **P2-01:** IMAP uses a random fallback on collision, servers stop the scheduler on
  close, test workers use isolated ports, and CI test runs produce no `EADDRINUSE` or
  `no such table` warnings.
- **P2-02:** `package-lock.json`, `npm ci`, `npm audit`, build descriptor and SBOM steps
  are part of the CI workflow.

## Live operational blockers (not masked)

- **P1-06:** no external encrypted backup destination credentials were supplied, so no
  remote target or verified off-site restore drill could be completed. The UI honestly
  shows the missing destination; local backup history is retained.
- **Security posture:** disabling SSH password authentication, enabling admin 2FA and
  replacing the self-signed TLS certificate require operator-controlled credentials or
  DNS. They were not changed automatically.

## Verification

    node --test tests/*.test.mjs    # 305/305 pass, no test warnings

Live checks: `/healthz` liveness-only, build `1.0.0+eae9b3c…`, phpMyAdmin SSO reaches
the database page, Roundcube health is HTTP 200, and the Exim queue is empty.
