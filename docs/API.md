# OpenAdmin API

Two surfaces, one authorisation model:

| Surface | Prefix | Format | Typical consumer |
|---|---|---|---|
| DirectAdmin-compatible | `/CMD_API_*` | `application/x-www-form-urlencoded` | billing/provisioning modules written for DirectAdmin |
| REST | `/api/v1/*` | JSON | dashboards, scripts, CI |

## Authentication

HTTP Basic on every request:

```http
Authorization: Basic base64(username:password)
```

or a **login key** created in *User → Login Keys*:

```http
Authorization: Basic base64(username:KEYID:SECRET)
```

Keys can carry an expiry and a command allow-list. Failed browser-stored credentials never downgrade to
anonymous access: a missing or wrong credential returns `error=1` (legacy) or `401` (REST).

Session cookies also work for REST calls made by the panel's own front end, provided the
`X-CSRF-Token` header matches the session token on writes.

## Legacy responses

Success:

```text
error=0&text=Domains&list%5B%5D=example.com&list%5B%5D=demo-site.org
```

Failure:

```text
error=1&text=Permission%20denied&details=
```

`?json=yes` returns the same object as JSON.

### Implemented commands

| Command | Parameters | Result |
|---|---|---|
| `CMD_API_DOMAIN` / `CMD_API_SHOW_DOMAINS` | — | `list[]` of domain names |
| `CMD_API_POP` | `action=create\|delete`, `domain`, `user`, `passwd`, `quota` | mailbox created/deleted; no `action` lists `user@domain` |
| `CMD_API_EMAIL_FORWARDER` | — | `list[]` of forwarder sources |
| `CMD_API_DATABASES` | — | `list[]` of database names |
| `CMD_API_FTP` | — | `list[]` of FTP usernames |
| `CMD_API_CRON_JOBS` | — | `list[]` of cron commands |
| `CMD_API_DNS_CONTROL` | `domain`, `action=add`, `name`, `type`, `value`, `priority` | record added, or `nameN`/`typeN`/`valueN` fields plus `list[]` |
| `CMD_API_SHOW_USERS` | — (reseller/admin) | `list[]` of usernames |
| `CMD_API_SHOW_RESELLERS` | — (admin) | `list[]` of reseller usernames |
| `CMD_API_USER_PASSWD` | `user`, `passwd` | password changed (scope-checked) |
| `CMD_API_ACCOUNT_USER` | `username`, `passwd`, `email`, `package`, `domain` | user created |
| `CMD_API_MODIFY_USER` | `user`, `package`, `email`, `suspend=yes\|no` | user modified |
| `CMD_API_SYSTEM_INFO` | — | hostname, IP, version, license, OS, Node |
| `CMD_API_LICENSE` | — | `type=unlimited`, `expires=never` |
| `CMD_API_IP_MANAGER` | — | `list[]` of IPs |
| `CMD_API_SERVICES` | — (admin) | `list[]` of services |
| `CMD_API_SITE_BACKUP` | — (reseller/admin) | new backup filename |
| `CMD_API_STATS` | — | `day=bandwidth` entries |

## REST

Base URL `/api/v1`. All responses include `ok: true|false`.

| Method | Path | Notes |
|---|---|---|
| GET | `/me` | account, capabilities, package limits |
| GET | `/domains` | visible domains |
| POST | `/domains` | `{ "domain": "example.com", "dns": "yes" }` |
| DELETE | `/domains/{name}` | scoped delete |
| GET | `/email` | mailboxes |
| POST | `/email` | `{ "domain", "local_part", "password", "quota_mb" }` |
| DELETE | `/email/{address}` | e.g. `/email/info@example.com` |
| GET | `/dns/{domain}` | records |
| POST | `/dns/{domain}` | `{ "name", "type", "value", "priority", "ttl" }` |
| GET | `/databases` | database names and sizes |
| GET | `/users` | reseller/admin only |
| POST | `/users` | `{ "username", "email", "package", "domain" }` |
| GET | `/packages` | limits per package |
| GET | `/stats` | 30-day usage series |
| GET | `/system` | panel and host facts |
| GET | `/files?path=/home/user` | directory listing |
| POST | `/files/upload` | `{ "path", "name", "data": "<base64>" }` |
| GET | `/files/download?path=…` | file, or directory as `tar.gz` |
| GET | `/webserver` | stack detection, active server, generated vhost count (reseller/admin) |
| GET | `/openapi.json` | OpenAPI 3.0 document |

### Examples

```bash
# Who am I?
curl -s -u demouser:demo http://127.0.0.1:2222/api/v1/me | jq

# Add a DNS record
curl -s -u demouser:demo -X POST http://127.0.0.1:2222/api/v1/dns/example.com \
  -H 'Content-Type: application/json' \
  -d '{"name":"shop","type":"CNAME","value":"example.com.","ttl":3600}'

# Create a mailbox
curl -s -u demouser:demo -X POST http://127.0.0.1:2222/api/v1/email \
  -H 'Content-Type: application/json' \
  -d '{"domain":"example.com","local_part":"hello","password":"s3cret-pass"}'

# Reseller creates a user with a domain
curl -s -u demoreseller:demo -X POST http://127.0.0.1:2222/api/v1/users \
  -H 'Content-Type: application/json' \
  -d '{"username":"acme","email":"ops@acme.test","package":"default","domain":"acme.test"}'
```

## Errors

| Status | Body |
|---|---|
| 400 | `{ "ok": false, "error": "Invalid domain name" }` |
| 401 | `{ "ok": false, "error": "Authentication required" }` together with `WWW-Authenticate: Basic` |
| 403 | `{ "ok": false, "error": "Permission denied" }` |
| 404 | `{ "ok": false, "error": "Domain not found" }` |

## Limits and scoping

- Users only ever see their own rows; resellers see their own users; admins see everything.
- Package limits apply to the API exactly as to the UI (domains, mailboxes, databases, FTP, cron, SSL,
  users). Exceeding a limit returns a 4xx with a message, never a silent success.
- Uploads are capped by `OA_MAX_UPLOAD_MB` (default 256).

## Versioning

The REST surface is `v1`. The `CMD_API_*` surface is unversioned by design — it must keep the shape
third-party integrations already expect.

## Coverage

All 110 `CMD_API_*` names from the DirectAdmin frontend are registered, including the frontend aliases
`CMD_API_EMAIL_POP`, `CMD_API_DB` and `CMD_API_DOMAIN`. Mutations are implemented for domains,
mailboxes, forwarders, autoresponders, vacation messages, FTP accounts, databases, cron jobs,
subdomains, pointers, redirects, SSL and users. Read commands return live data; commands that
require parameters validate them and return the DirectAdmin error envelope when missing.
