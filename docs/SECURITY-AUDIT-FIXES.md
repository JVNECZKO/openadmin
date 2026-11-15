# Security audit fixes — 2026-11-15

## Immediate

- **WebDisk path boundary:** `createWebdisk` normalizes `subpath`, rejects
  absolute/`..`/backslash/NUL/encoded separators, resolves the document root and
  base through the file-manager tenant resolver, requires the result to stay
  inside the real home and stores only the validated path.
- **WebDAV file safety:** every GET/HEAD/PUT/MKCOL/DELETE/MOVE/PROPFIND path
  uses `resolveUserPath`; final symlinks and files with hard links are rejected;
  PUT writes to an exclusive temporary file in the destination directory and
  atomically renames after a second resolver check; directory children with
  unsafe links are omitted from PROPFIND. WebDisk root cannot be deleted/moved.
- **WebDAV quota:** PUT checks account disk quota, inode limit and the central
  `checkDisk` preflight, caps a request at 64 MB and audits PUT/MKCOL/DELETE/MOVE.
- **Playground:** network execution removed; it no longer builds URLs from the
  `Host` header or forwards `OA_SESSION`, and the page explains the disabled
  state.

## Important

- Login `next` values are parsed against a canonical internal origin, reject
  backslashes, controls and encoded separators.
- All auth cookies receive `Secure` from `isSecureRequest()` (trusted proxy
  aware), not from `config.https`.
- WebDisk Basic Auth uses the shared limiter with per-IP and per-account
  thresholds; unknown users and wrong passwords return the same 401/429 and
  attempts are audited.
- Password reset has a per-IP limit, per-account hourly limit, 10-minute token
  cooldown and deduplicated open support ticket.
- Login limiter separates per-IP and per-account thresholds; scheduler prunes
  old attempts; a single source cannot keep renewing an account lockout.
- API errors return a stable code/event id; stack traces and local paths are
  omitted unless `OA_DEBUG=1`; 5xx messages are generic.
- Body reading happens only after session auth and route matching; anonymous
  browser writes are rejected before buffering, anonymous API/WebDisk bodies
  are limited, concurrency is capped and reads time out after 30 seconds.
- Outbound webhook/Multi-server requests use a central policy: http(s) only,
  no credentials, default ports 80/443, DNS checked before every request and
  redirect, private/link-local/metadata ranges blocked unless an admin setting
  explicitly allows private ranges; response size/time/redirect limits.
- WebDisk passwords are scrypt-hashed, legacy encrypted rows migrate on first
  successful auth, and new scrypt parameters are `N=32768` with automatic
  rehash after login for older hashes.

## Verification

- `node --test`: **311/311**.
- QA: **54/54**, 395 route/width combinations, 0 issues, 14/14 security checks.
- New negative tests cover WebDisk traversal, external/internal symlinks,
  hardlinks, legacy hash migration, auth throttling, open redirect, Secure
  cookies under a trusted proxy, anonymous large bodies, disabled playground,
  password-reset cooldown/dedupe and outbound SSRF policy.

## Residual (documented, not hidden)

- `style-src 'unsafe-inline'` remains because many templates use inline style
  attributes; a full nonce/hash migration is a separate presentation refactor.
- The development TLS certificate is self-signed (operator-accepted); production
  still needs a trusted certificate for the real hostname.
- DNS is checked before outbound fetch, but the final socket resolution is owned
  by Node fetch; a custom pinned-IP transport would close the remaining
  DNS-rebinding race.
