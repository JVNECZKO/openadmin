# Frontend recon: how the DirectAdmin surface was recovered

OpenAdmin's compatibility layer was derived from the public **Live Demo** of DirectAdmin
(<https://demo.directadmin.com:2222/>) — a shipped frontend artifact — rather than from private code.
This note records what was observed, with REA evidence identifiers, and what remains unknown.

## Target

| | |
|---|---|
| Origin | `https://demo.directadmin.com:2222/` (redirects to `/evo/`) |
| Skin | Evolution (Vue 3 SPA), bundled by Vite |
| Entry | `/evo/index.DS_2EaAs.js` + 172 chunk files |
| Local capture | `recon/index.js`, `recon/evo/*.js` (ignored by git; proprietary vendor code is not redistributed) |
| Login routes | `/`, `/login`, `/login/account-disabled`, `/login/license-expired`, `/login/lost-password` |

The demo credentials published on <https://directadmin.com/demo.php> are `demouser` / `demoreseller` /
`demoadmin`, all with password `demo`. They were used only to observe navigation and API behaviour.

## Method (REA)

```text
analyze_javascript_application recon/evo
  detail: summary → javascript-routes summary
analyze_javascript_application recon
  source_paths: ["index.js"] → javascript-routes routes
```

Evidence:

| Evidence | Scope | Result |
|---|---|---|
| `ev_851657e87b674ffc39951593c3cbd468b3af24ec57e7aa7f0bbdc6700e3441bc` | 172 Evolution chunks | graph retained; 171 sources complete, 1 resource-limited (`utils.BS_n5Z5x.js` exceeded the 8 MiB fact ceiling) |
| `ev_9ed2a44c0c0c7f83d9166541e869d1bed978a23becea5e0fa5861e35d4fc799e` | `index.js` only | 4 static route candidates |
| `ev_15f051f0d1307a18d1c7e7917d7b5354cdc6bea6769c63ee1d8b3f831c6443c8` | routes view | `/login`, `/login/account-disabled`, `/login/license-expired`, `/login/lost-password` |
| `tools/extract-routes.mjs` | all 173 sources | **119 routes, 115 titles, 93 commands** written to `src/compat/manifest.json` |

The four login routes were the only routes visible to the static route detector in `index.js`; the
application route table lives in `utils.BS_n5Z5x.js` and is encoded as nested route objects with
template-literal paths. `tools/extract-routes.mjs` extracts those objects, their aliases (which carry
the canonical `/user/…`, `/admin/…`, `/reseller/…` URLs), titles and command bindings. That manifest
is what the compatibility layer in `src/routes/compat.mjs` serves and what the test suite crawls.

Limitations reported by REA and respected here:

- JavaScript was parsed as inert text; the bundle was **never executed**.
- Routes are static candidates: reachability, permission checks and server-only routes are unverified.
- Alias expansion was conservatively bounded, and one chunk could not be fully retained.
- No complete application route denominator exists, so absence of a route in evidence is not proof of absence.

## Command inventory

A string scan of the retained graph yields **110 `CMD_*` identifiers**, which is the primary source for
[COMPATIBILITY.md](COMPATIBILITY.md):

```text
CMD_ACCOUNT_ADMIN … CMD_USER_STATS   (110 names, see docs/directadmin-commands.txt)
```

Grouping inferred from the names and from the SPA's navigation labels:

| Group | Representative commands |
|---|---|
| Accounts | `CMD_ACCOUNT_USER`, `CMD_ACCOUNT_RESELLER`, `CMD_MODIFY_USER`, `CMD_MOVE_USERS` |
| Domains / DNS | `CMD_DOMAIN`, `CMD_SUBDOMAIN`, `CMD_DNS_CONTROL`, `CMD_DOMAIN_POINTER` |
| Email | `CMD_EMAIL_POP`, `CMD_EMAIL_FORWARDER`, `CMD_EMAIL_AUTORESPONDER`, `CMD_EMAIL_CATCH_ALL` |
| Files / FTP / DB | `CMD_FILE_MANAGER`, `CMD_FTP`, `CMD_DB`, `CMD_DB_USER_CREATE` |
| Security | `CMD_SSL`, `CMD_LOGIN_KEYS`, `CMD_SSH_KEYS`, `CMD_BRUTE_FORCE_MONITOR` |
| Server | `CMD_SYSTEM_INFO`, `CMD_SHOW_SERVICES`, `CMD_PROCESS_MONITOR`, `CMD_LICENSE` |
| Packages | `CMD_MANAGE_USER_PACKAGES`, `CMD_MANAGE_RESELLER_PACKAGES` |

## API convention (observed)

An unauthenticated `GET /CMD_API_DOMAIN` returned HTTP 200 with:

```text
error=1&text=Called%20CMD%5FDOMAIN%20or%20CMD%5FAPI%5FDOMAIN%20without%20any%20variables%2E&details=
```

That confirms the two conventions OpenAdmin implements:

1. `CMD_*` and `CMD_API_*` are aliases for the same handler.
2. Failures are HTTP 200 with `error=1&text=…&details=…`; list results use `list[]=…`.

## What was deliberately not copied

No DirectAdmin HTML templates, CSS, icons, JavaScript or binaries are redistributed. The OpenAdmin UI is
an original implementation of the same **information architecture** (groups, page names, task order)
with an original design system. Command names are used as a functional interface for interoperability;
they are not copyrightable expression and are required for third-party integrations to work.

## Reproducing

```bash
mkdir -p recon && cd recon
curl -skL https://demo.directadmin.com:2222/evo/index.DS_2EaAs.js -o index.js
grep -oE '(chunks|assets)/[A-Za-z0-9_.-]+\.js' index.js | sort -u > js.txt
mkdir -p evo && cat js.txt | xargs -P 12 -I{} sh -c \
  'curl -skL "https://demo.directadmin.com:2222/evo/{}" -o "evo/$(basename {})"'
grep -rhoE 'CMD_[A-Z0-9_]+' evo | sort -u > cmd_list.txt
# then run REA against ./recon as shown above
```

Only use this material for interoperability research you are authorised to perform, and respect
DirectAdmin's terms of service when accessing their demo.
