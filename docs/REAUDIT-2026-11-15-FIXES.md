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

## Live operational completion (2026-11-15)

- Enabled a daily backup job (`03:00 Europe/Warsaw`) with a real SFTP destination on
  the Proxmox host, using a dedicated restricted `sftp-server` key stored encrypted by
  the panel. A full server backup completed: 272.7 MB, SHA-256
  `5d6a45298bcb57dea7a7818bc5d31cff994a4cd7561c6e12d7c40cfa1ddd8711`; the remote copy
  has the same digest and the restore preview opened the archive successfully.
- The Exim queue is empty; the 13 frozen notification bounces were removed after fixing
  the unrouteable recipient handling.
- Live build descriptor now resolves to the deployed commit through `build-info.json`.

## Host hardening performed live

- Added a dedicated operator Ed25519 key to the container and switched sshd to
  `PasswordAuthentication no`, `KbdInteractiveAuthentication no`,
  `PermitRootLogin prohibit-password`; `sshd -t` passed, key login works and password
  login is rejected. Proxmox console access remains available as recovery.
- The backup target uses a separate restricted `sftp-server` key; it cannot open a
  shell. The panel stores it encrypted (`v2` secret format) and materializes it only
  for the duration of the SFTP transfer.

## Security posture after live hardening

- Security Center now reflects all sshd drop-ins and actual `authorized_keys`, not only
  its legacy managed file.
- Live posture moved from 17% to **83% (5/6)**: firewall, key-only SSH, root key,
  fork-bomb limits and SMTP egress restrictions pass. Only ModSecurity/WAF is
  unavailable on this nginx host.
- A daily offsite SFTP backup with a dedicated key completed; the remote archive
  SHA-256 matches the local archive and the restore preview reads all homes and the
  panel database snapshot.

## Final verification for this iteration

- `node --test tests/*.test.mjs`: **305/305 pass**, no EADDRINUSE/no-table warnings.
- `node tools/qa-final.mjs`: **54/54 checks**, 350 route-width snapshots, 14/14
  security checks, 27 axe pages with 0 serious/critical, 7/7 counter checks.
- Live build: commit `1d52b45…`; phpMyAdmin SSO reaches the database UI; Roundcube
  health is 200; Exim queue is 0; Security Center reports 83% (5/6).
- Offsite backup completed (272.7 MB, identical SHA-256); restore preview reads the
  archive. The full transactional restore path is covered by `tests/jobs-restore`.

## Still requiring operator input

- Admin TOTP enrolment (needs the user's authenticator; enabling it silently would
  lock the account out).
- A publicly trusted TLS certificate for a real panel hostname.
- Public SPF/DKIM/DMARC for real mail domains and a pinned release-signing key.
- ModSecurity/WAF (host lacks the module) and remaining mixed-language advanced
  feature pages outside navigation/automation.
