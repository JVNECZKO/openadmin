# OpenAdmin landing page

The marketing site for **openadmin.live** — English at **/** and Polish at **/pl/**.
Fully static, no runtime dependencies, no external requests, no trackers.

## Structure

| Path | Purpose |
|---|---|
| **content/en.mjs**, **content/pl.mjs** | All copy, in both languages. This is the source of truth. |
| **content/sync.mjs** | Writes **content/*.json**, which the Python builder consumes. |
| **build.py** | Renders both pages, 404, sitemap, robots and .htaccess; copies assets and the source archive. |
| **assets/styles.css** | The design system: dark ink, azure gradient, Inter Tight + Instrument Serif + JetBrains Mono. |
| **assets/app.js** | Menu, tabs, copy buttons, scroll reveals, card spotlight. No libraries. |
| **assets/shots/** | 1440 px and 900 px WebP captures of the panel. |
| **assets/fonts/** | Self-hosted WOFF2 subsets (latin + latin-ext) for Polish diacritics. |
| **download/** | The generated openadmin-1.0.0.tar.gz source archive. |
| **dist/** | Build output. Deploy it; do not hand-edit it. |

## Build

Requires Node.js for content syncing and Python 3 for rendering.

    ./build.sh

Or step by step:

    node content/sync.mjs
    python3 build.py

The build appends a content hash to the CSS and JS query strings, so a one-year
cache is safe. It uses **git archive** to create the downloadable source tarball
when **download/openadmin-1.0.0.tar.gz** is missing.

## Deploy

The site is hosted on DirectAdmin shared hosting and proxied through Cloudflare.

    SSHPASS='…' rsync -az --delete --exclude cgi-bin \
      --chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r \
      -e "sshpass -e ssh -o StrictHostKeyChecking=no" \
      dist/ USER@HOST:domains/openadmin.live/public_html/

**--exclude cgi-bin** keeps the hosting account's cgi-bin directory.
**--chmod** matters: the web server runs as another user and cannot read 0600 files.

### Cloudflare

- Apex A record → origin IP, proxied.
- www CNAME → openadmin.live, proxied; the origin .htaccess redirects www to the apex.
- SSL/TLS: **Full** (the origin serves the host certificate); **Always Use HTTPS** on;
  TLS 1.3 on; Automatic HTTPS Rewrites on.
- Security headers and canonical redirects live in **dist/.htaccess**.

## Notes

- The page is self-contained: no Google Fonts, no CDN, no analytics.
- Screenshots are real captures from the app. The dashboard hostname was set to
  **server01.openadmin.live** for the hero; the UI is otherwise untouched.
- **content/en.mjs** is the English default. Keep both languages in sync when editing.
