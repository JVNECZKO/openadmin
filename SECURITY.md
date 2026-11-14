# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 1.x | Yes |
| Older | No |

## Reporting a vulnerability

Please **do not open a public issue** for an unpatched vulnerability.

Use GitHub private vulnerability reporting:

1. Open the **Security** tab of this repository.
2. Choose **Report a vulnerability**.
3. Include the affected version, a reproduction, and the impact you observed.

You will get an acknowledgement in the advisory thread. Please allow time for a fix before
public disclosure.

## Scope

In scope:

- Authentication, session handling and CSRF bypasses
- Authorisation or tenant-isolation flaws between users, resellers and admins
- Command injection, path traversal and file-manager escapes
- Unsafe handling of uploaded archives, backups or mail content
- Secrets exposure in generated configuration

Out of scope:

- Findings that require root on the server
- Denial of service through resource exhaustion on a server you control
- Missing hardening headers on third-party sites
- Issues in upstream projects such as Node.js, MariaDB, Nginx or Dovecot

## Design notes

- Passwords use scrypt with a per-password salt.
- Sessions use 256-bit tokens and server-side expiry and revocation.
- State-changing browser requests require a synchroniser CSRF token.
- Every query is scoped by permission level; privileged actions are audited.
- File-manager paths are canonicalised and jailed to the account home.
- The panel sends no telemetry and contacts no licence server.

## Secrets

The repository intentionally contains no private keys, credentials, production databases or
backups. Runtime secrets belong in the environment file created by the installer
(<code>/var/lib/openadmin/openadmin.env</code>) and must never be committed.
