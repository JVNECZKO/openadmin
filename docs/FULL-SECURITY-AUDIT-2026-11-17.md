# Full security audit — 2026-11-17

Baseline reviewed: `72b107a`; remediated and deployed: `6509b46`.

## Scope and method

Reviewed server/auth/session code, tenant authorization, file manager and WebDAV,
API/MCP, archives and uploads, backup/restore, update/signing, outbound clients,
secrets, CSP/TLS, error handling and request lifecycle. Ran `npm audit`, the full
test suite, the 54-check QA harness at five widths, source scans for shell/SQL/file
interpolation, and read-only live checks. No destructive live probing was done.

## Findings closed

### Critical — WebDisk/WebDAV
The old implementation accepted a user-supplied `subpath` without proving it was
inside the domain root/home, then followed symlinks and hardlinks on WebDAV reads
and writes, ignored disk/inode quota and stored reversible passwords.

Now:
- WebDisk creation rejects absolute paths, `..`, NUL/control characters,
  backslashes and encoded separators; docroot/base go through the file-manager
  tenant resolver and must remain under the real home.
- Every WebDAV operation uses the same resolver; final symlinks and hardlinked
  files are rejected, PROPFIND omits unsafe children, PUT uses exclusive temp
  file + atomic rename with a second check, and WebDisk root is protected.
- PUT enforces disk and inode quota; all mutations are audited.
- WebDisk passwords are scrypt-hashed; legacy encrypted rows migrate on first
  successful login; Basic Auth is rate-limited with equal responses.

### Critical — API playground
The playground built a URL from the untrusted `Host` header and forwarded the raw
panel session cookie. Network execution is removed entirely; the page now only
points at OpenAPI/curl.

### Important
- Login `next` is parsed against a canonical internal origin and rejects
  backslashes, controls and encoded separators.
- Secure cookies are derived from `isSecureRequest()` (trusted proxy aware), not
  the process `config.https`.
- Password reset has IP/account limits, 10-minute cooldown and deduplicated open
  tickets.
- Login limiter separates per-IP and per-account thresholds; scheduler prunes
  old attempts, so one source cannot perpetually lock an account.
- API errors return a stable code and event id; stack traces/local paths are
  debug-only.
- Request bodies are read only after session auth and route matching; anonymous
  browser writes are rejected before buffering, with per-IP concurrency, size
  limits and a 30-second timeout.
- Webhooks and Multi-server use a central outbound policy: scheme/port checks,
  DNS validation before request and redirect, private/link-local/metadata
  blocking, response/time/redirect limits and explicit private-network opt-in.
- Scrypt parameters are versioned (`N=32768`), old panel hashes upgrade after
  successful login.
- Restore table identifiers are quoted; all dynamic SQL identifiers now fail
  closed instead of trusting a restored SQLite schema.

## Audit verification

- `node --test`: **311/311 pass**.
- QA: **54/54**, 395 route/width checks, 0 route issues, 14/14 security checks,
  27 axe pages, 65 screenshots.
- Live: `https://192.168.3.240:2222`, Security Center **100% (6/6)**, playground
  disabled, login/2FA functional, build identity from the deployment artifact.
- New negative tests cover WebDisk traversal, tenant/home escapes, internal and
  external symlinks, hardlinks, legacy hash migration, auth throttling, open
  redirects, Secure cookies behind a proxy, anonymous large bodies, playground
  Host abuse, reset cooldown/dedupe and outbound SSRF policy.

## Residual risk (explicit)

- `style-src 'unsafe-inline'` remains because many legacy templates use inline
  style attributes; moving them to classes/nonces is a separate presentation
  refactor.
- TLS on the development IP is self-signed (operator accepted); production needs
  a trusted certificate for a real hostname.
- Outbound DNS is checked before each request/redirect, but Node `fetch` performs
  the final resolution; a pinned-IP transport would close the remaining
  DNS-rebinding race.
- The UI audit's non-security residuals (reseller action icons, quick-action
  shortcut, long user dashboard, a few technical English strings) remain outside
  this security audit.
