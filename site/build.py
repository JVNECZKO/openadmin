#!/usr/bin/env python3
"""Build the static OpenAdmin landing page (EN default, PL under /pl/)."""
import json
import html
import re
import shutil
import hashlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist"
SITE = "https://openadmin.live"
VERSION = "1.1.0"
GITHUB_URL = "https://github.com/JVNECZKO/openadmin"
DOWNLOAD_PATH = "/openadmin-1.1.0.tar.gz?v=1.1.0"
ASSET_VER = hashlib.sha256((ROOT / "assets" / "styles.css").read_bytes() + (ROOT / "assets" / "app.js").read_bytes()).hexdigest()[:10]
SHOT_VER = hashlib.sha256((ROOT / "assets" / "shots" / "mariadb-1440.webp").read_bytes() + (ROOT / "assets" / "shots" / "dashboard-1440.webp").read_bytes() + (ROOT / "assets" / "og.jpg").read_bytes()).hexdigest()[:8]

EN = json.loads((ROOT / "content" / "en.json").read_text())
PL = json.loads((ROOT / "content" / "pl.json").read_text())


def esc(value):
    return html.escape(str(value), quote=True)


def attr(value):
    return esc(value).replace("'", "&#39;")


def strip_tags(value):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", str(value))).strip()


ICONS = {
    "layers": '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3 3 7.5l9 4.5 9-4.5L12 3Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="m3 12 9 4.5 9-4.5M3 16.5 12 21l9-4.5" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    "package": '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m12 3 7.5 4.3v9.4L12 21l-7.5-4.3V7.3L12 3Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="m4.7 7.4 7.3 4.2 7.3-4.2M12 11.6V21" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    "terminal": '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3" stroke="currentColor" stroke-width="1.6"/><path d="m7 9 3 3-3 3M13 15h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    "server": '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="4" width="18" height="7" rx="2" stroke="currentColor" stroke-width="1.6"/><rect x="3" y="13" width="18" height="7" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M7 7.5h.01M7 16.5h.01" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
    "mail": '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3" stroke="currentColor" stroke-width="1.6"/><path d="m4 8 8 5 8-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    "shield": '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3 4.5 6v5.4c0 4.4 3.1 7.7 7.5 9.6 4.4-1.9 7.5-5.2 7.5-9.6V6L12 3Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="m9 12 2 2 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    "folder": '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5v-10Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    "database": '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><ellipse cx="12" cy="6" rx="7.5" ry="3" stroke="currentColor" stroke-width="1.6"/><path d="M4.5 6v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6M4.5 12v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6" stroke="currentColor" stroke-width="1.6"/></svg>',
    "route": '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="6" cy="18" r="2.5" stroke="currentColor" stroke-width="1.6"/><circle cx="18" cy="6" r="2.5" stroke="currentColor" stroke-width="1.6"/><path d="M8.5 18h4a3 3 0 0 0 3-3V9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    "arrow": '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    "download": '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3v12m0 0 4.5-4.5M12 15l-4.5-4.5M4 20h16" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    "check": '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m5 12.5 4.2 4.2L19 6.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    "copy": '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2.5" stroke="currentColor" stroke-width="1.6"/><path d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8" stroke="currentColor" stroke-width="1.6"/></svg>',
    "close": '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    "menu": '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
    "spark": '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
    "lock": '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="4.5" y="10" width="15" height="10" rx="2.5" stroke="currentColor" stroke-width="1.6"/><path d="M8 10V7.5a4 4 0 0 1 8 0V10" stroke="currentColor" stroke-width="1.6"/></svg>',
    "github": '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>',
}

GRADIENT_DEFS = '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs><linearGradient id="oa-grad" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse"><stop stop-color="#62d0ff"/><stop offset=".52" stop-color="#0a6daa"/><stop offset="1" stop-color="#0b3f69"/></linearGradient></defs></svg>'


def logo_mark(cls="mark"):
    return (
        '<svg class="' + cls + '" viewBox="0 0 32 32" fill="none" aria-hidden="true">'
        '<rect width="32" height="32" rx="9" fill="url(#oa-grad)"/>'
        '<path d="M16 8.2 23.2 22h-3.4l-1.2-2.7h-5.2L12.2 22H8.8L16 8.2Zm0 5.1-1.15 2.8h2.3L16 13.3Z" fill="#fff" fill-opacity=".98"/></svg>'
    )


def head(c):
    path = "/" if c["lang"] == "en" else "/pl/"
    other_locale = "pl_PL" if c["lang"] == "en" else "en_US"
    pl_font_preloads = (
        '<link rel="preload" href="/assets/fonts/inter-tight-latin-ext.woff2" as="font" type="font/woff2" crossorigin>\n'
        '<link rel="preload" href="/assets/fonts/instrument-serif-italic-latin-ext.woff2" as="font" type="font/woff2" crossorigin>'
    ) if c["lang"] == "pl" else ""
    return f'''<!doctype html>
<html lang="{c["lang"]}" class="no-js">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{esc(c["meta"]["title"])}</title>
<meta name="description" content="{attr(c["meta"]["description"])}">
<link rel="canonical" href="{SITE}{path}">
<link rel="alternate" hreflang="en" href="{SITE}/">
<link rel="alternate" hreflang="pl" href="{SITE}/pl/">
<link rel="alternate" hreflang="x-default" href="{SITE}/">
<meta property="og:type" content="website">
<meta property="og:site_name" content="OpenAdmin">
<meta property="og:title" content="{attr(c["meta"]["ogTitle"])}">
<meta property="og:description" content="{attr(c["meta"]["ogDescription"])}">
<meta property="og:url" content="{SITE}{path}">
<meta property="og:image" content="{SITE}/assets/og.jpg?v={SHOT_VER}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="OpenAdmin — a free, open-source hosting control panel">
<meta property="og:locale" content="{c["ogLocale"]}">
<meta property="og:locale:alternate" content="{other_locale}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{attr(c["meta"]["ogTitle"])}">
<meta name="twitter:description" content="{attr(c["meta"]["ogDescription"])}">
<meta name="twitter:image" content="{SITE}/assets/og.jpg?v={SHOT_VER}">
<meta name="twitter:image:alt" content="OpenAdmin — a free, open-source hosting control panel">
<meta name="theme-color" content="#05070d">
<meta name="color-scheme" content="dark">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="icon" type="image/png" sizes="32x32" href="/assets/favicon-32.png">
<link rel="apple-touch-icon" href="/assets/favicon-180.png">
<link rel="preload" href="/assets/fonts/inter-tight-latin.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/assets/fonts/instrument-serif-italic-latin.woff2" as="font" type="font/woff2" crossorigin>
{pl_font_preloads}
<link rel="stylesheet" href="/assets/styles.css?v={ASSET_VER}">
<script>document.documentElement.classList.remove("no-js");document.documentElement.classList.add("js");</script>
</head>'''


def nav(c):
    other = {"href": "/pl/", "label": "Polski"} if c["lang"] == "en" else {"href": "/", "label": "English"}
    links = "".join(f'<a href="{l["href"]}">{l["label"]}</a>' for l in c["nav"]["links"])
    mobile_links = "".join(f'<a href="{l["href"]}">{l["label"]}</a>' for l in c["nav"]["links"])
    return f'''<header class="site-header" id="site-header">
  <div class="container nav-shell">
    <a class="brand" href="/" aria-label="OpenAdmin">
      {logo_mark("brand-mark")}
      <span class="brand-name">OpenAdmin</span>
      <span class="brand-tag">v{VERSION}</span>
    </a>
    <nav class="nav-links" aria-label="{attr(c["nav"]["primaryLabel"])}">{links}</nav>
    <div class="nav-actions">
      <a class="github-link" href="{GITHUB_URL}" target="_blank" rel="noopener noreferrer" aria-label="{attr(c["a11y"]["github"])}" title="GitHub">{ICONS["github"]}</a>
      <div class="lang-switch" role="group" aria-label="{attr(c["nav"]["langAria"])}">
        <a href="/" class="{"is-active" if c["lang"] == "en" else ""}" hreflang="en" lang="en">EN</a>
        <a href="/pl/" class="{"is-active" if c["lang"] == "pl" else ""}" hreflang="pl" lang="pl">PL</a>
      </div>
      <a class="btn btn-small btn-primary nav-cta" href="#install">{c["nav"]["cta"]}</a>
      <button class="menu-toggle" type="button" data-open-label="{attr(c["a11y"]["openMenu"])}" data-close-label="{attr(c["a11y"]["closeMenu"])}" aria-label="{attr(c["a11y"]["openMenu"])}" aria-expanded="false" aria-controls="mobile-menu">
        <span class="menu-icon-open">{ICONS["menu"]}</span>
        <span class="menu-icon-close">{ICONS["close"]}</span>
      </button>
    </div>
  </div>
  <div class="mobile-menu" id="mobile-menu" hidden>
    <nav class="mobile-nav" aria-label="{attr(c["nav"]["mobileLabel"])}">
      {mobile_links}
      <a class="btn btn-primary" href="#install">{c["nav"]["cta"]}</a>
      <a class="mobile-github" href="{GITHUB_URL}" target="_blank" rel="noopener noreferrer">{ICONS["github"]}<span>GitHub</span><span class="ext">↗</span></a>
      <a class="mobile-lang" href="{other["href"]}">{other["label"]}</a>
    </nav>
  </div>
</header>'''


def hero_visual(c):
    return f'''<div class="hero-visual reveal" style="--d:.45s">
  <div class="hero-glow" aria-hidden="true"></div>
  <div class="hero-chips" aria-hidden="true">
    <span class="chip chip-a">{ICONS["spark"]}<b>0</b> {c["hero"]["chipLabels"][0]}</span>
    <span class="chip chip-b">{ICONS["shield"]}<b>110</b> {c["hero"]["chipLabels"][1]}</span>
    <span class="chip chip-c">{ICONS["lock"]}<b>AGPL</b> {c["hero"]["chipLabels"][2]}</span>
  </div>
  <figure class="browser browser-hero" id="hero-frame">
    <div class="browser-bar">
      <span class="browser-dots"><i></i><i></i><i></i></span>
      <span class="browser-url"><span class="url-lock">{ICONS["lock"]}</span>{c["hero"]["frame"]["url"]}</span>
      <span class="browser-live"><i></i>{"na żywo" if c["lang"] == "pl" else "live"}</span>
    </div>
    <div class="browser-screen">
      <img src="/assets/shots/dashboard-1440.webp?v={SHOT_VER}" srcset="/assets/shots/dashboard-900.webp?v={SHOT_VER} 900w, /assets/shots/dashboard-1440.webp?v={SHOT_VER} 1440w" sizes="(min-width: 1100px) 1100px, 92vw" width="1440" height="1150" alt="{attr(c["hero"]["frame"]["alt"])}" fetchpriority="high" decoding="async">
    </div>
  </figure>
  <p class="hero-caption"><span class="status-dot"></span>{c["hero"]["frame"]["caption"]}</p>
</div>'''


def hero(c):
    stats = "".join(f'<div class="stat"><strong>{s["value"]}</strong><span>{s["label"]}</span></div>' for s in c["hero"]["stats"])
    micro = "".join(f'<li>{ICONS["check"]}{m}</li>' for m in c["hero"]["micro"])
    return f'''<section class="hero" id="top">
  <div class="hero-bg" aria-hidden="true"><div class="aurora a1"></div><div class="aurora a2"></div><div class="hero-grid"></div></div>
  <div class="container hero-inner">
    <a class="eyebrow-pill reveal" href="#features"><span class="pill-dot"></span>{c["hero"]["eyebrow"]}<span class="pill-arrow">{ICONS["arrow"]}</span></a>
    <h1 class="hero-title reveal" style="--d:.06s">{c["hero"]["titleBefore"]} <span class="serif-accent">{c["hero"]["titleAccent"]}</span>{c["hero"]["titleAfter"]}</h1>
    <p class="hero-lead reveal" style="--d:.14s">{c["hero"]["lead"]}</p>
    <div class="hero-actions reveal" style="--d:.22s">
      <a class="btn btn-primary btn-lg" href="#install">{c["hero"]["primary"]}{ICONS["arrow"]}</a>
      <a class="btn btn-ghost btn-lg" href="#screenshots">{c["hero"]["secondary"]}</a>
    </div>
    <ul class="hero-micro reveal" style="--d:.3s">{micro}</ul>
    {hero_visual(c)}
  </div>
  <div class="container"><div class="stat-band reveal">{stats}</div></div>
</section>'''


def tech(c):
    items = c["tech"]["items"]
    first = "".join(f'<span>{x}</span><i>·</i>' for x in items)
    second = "".join(f'<span aria-hidden="true">{x}</span><i aria-hidden="true">·</i>' for x in items)
    return f'''<section class="tech-strip" aria-label="{attr(c["tech"]["label"])}">
  <div class="container tech-head"><span class="tech-label">{c["tech"]["label"]}</span><span class="tech-line"></span></div>
  <div class="marquee" role="presentation"><div class="marquee-track">{first}{second}</div></div>
</section>'''


def feature_visual(kind, lang):
    pl = lang == "pl"
    if kind == "levels":
        if pl:
            return '''<div class="viz levels-viz" aria-hidden="true">
    <div class="level-switch"><span class="on">Administrator</span><span>Reseller</span><span>Użytkownik</span></div>
    <div class="level-rows">
      <div class="level-row"><span class="lv-badge">A</span><div><b>Administrator</b><small>Serwer · Pakiety · Audyt</small></div><span class="lv-count">wszystko</span></div>
      <div class="level-row"><span class="lv-badge">R</span><div><b>Reseller</b><small>Użytkownicy · Własne pakiety · IP</small></div><span class="lv-count">12</span></div>
      <div class="level-row"><span class="lv-badge">U</span><div><b>Użytkownik</b><small>Domeny · Poczta · Pliki</small></div><span class="lv-count">48</span></div>
    </div>
  </div>'''
        return '''<div class="viz levels-viz" aria-hidden="true">
    <div class="level-switch"><span class="on">Admin</span><span>Reseller</span><span>User</span></div>
    <div class="level-rows">
      <div class="level-row"><span class="lv-badge">A</span><div><b>Admin</b><small>Server · Packages · Audit</small></div><span class="lv-count">all</span></div>
      <div class="level-row"><span class="lv-badge">R</span><div><b>Reseller</b><small>Users · Own packages · IPs</small></div><span class="lv-count">12</span></div>
      <div class="level-row"><span class="lv-badge">U</span><div><b>User</b><small>Domains · Mail · Files</small></div><span class="lv-count">48</span></div>
    </div>
  </div>'''
    if kind == "deps":
        comment = "// bez zależności" if pl else "// no dependencies"
        lock = "bez lockfile’a" if pl else "no lockfile"
        addons = "bez natywnych dodatków" if pl else "no native addons"
        return '''<div class="viz deps-viz" aria-hidden="true">
    <div class="mini-code">
      <div class="mini-bar"><span></span><span></span><span></span><em>package.json</em></div>
      <pre><code><span class="tok-dim">''' + comment + '''</span>
{
  <span class="tok-key">"engines"</span>: { <span class="tok-key">"node"</span>: <span class="tok-str">"&gt;=22.5.0"</span> },
  <span class="tok-key">"dependencies"</span>: <span class="tok-acc">{}</span>
}</code></pre>
    </div>
    <div class="deps-badges"><span>''' + ICONS["check"] + ''' ''' + lock + '''</span><span>''' + ICONS["check"] + ''' ''' + addons + '''</span></div>
  </div>'''
    if kind == "api":
        return '''<div class="viz api-viz" aria-hidden="true">
    <div class="mini-code terminal">
      <div class="mini-bar"><span></span><span></span><span></span><em>curl</em></div>
      <pre><code><span class="tok-prompt">$</span> curl -u demo:demo \\
  <span class="tok-dim">/CMD_API_DOMAIN</span>

<span class="tok-out">error=0&amp;text=Domains&amp;</span>
<span class="tok-out">list[]=example.com&amp;</span>
<span class="tok-out">list[]=demo-site.org</span></code></pre>
    </div>
    <div class="api-pills"><span>CMD_API</span><span>REST</span><span>OpenAPI 3</span></div>
  </div>'''
    if kind == "servers":
        detected = "wykryty" if pl else "detected"
        generate = "wygeneruj" if pl else "generate"
        return '''<div class="viz servers-viz" aria-hidden="true">
    <div class="server-row"><span class="s-dot on"></span><b>Nginx</b><em>nginx -t</em><span class="s-tag">''' + detected + '''</span></div>
    <div class="server-row"><span class="s-dot on"></span><b>Apache</b><em>apachectl configtest</em><span class="s-tag">''' + detected + '''</span></div>
    <div class="server-row"><span class="s-dot"></span><b>OpenLiteSpeed</b><em>lswsctrl</em><span class="s-tag quiet">''' + generate + '''</span></div>
    <div class="server-row"><span class="s-dot"></span><b>LiteSpeed Ent.</b><em>lshttpd</em><span class="s-tag quiet">''' + generate + '''</span></div>
  </div>'''
    if kind == "mail":
        foot = "podpis DKIM · IMAP4rev1" if pl else "DKIM signed · IMAP4rev1"
        return '''<div class="viz mail-viz" aria-hidden="true">
    <div class="flow"><span class="flow-node">SMTP</span><i>→</i><span class="flow-node">Exim</span><i>→</i><span class="flow-node">Dovecot</span></div>
    <div class="flow"><span class="flow-node">MX</span><i>→</i><span class="flow-node">Maildir</span><i>→</i><span class="flow-node acc">Webmail</span></div>
    <div class="mail-foot"><span class="status-dot"></span>''' + foot + '''</div>
  </div>'''
    if kind == "security":
        recovery = "TOTP + kody zapasowe" if pl else "TOTP + recovery"
        csrf = "CSRF / żądanie" if pl else "CSRF / request"
        audit = "dziennik audytu" if pl else "audit log"
        return '''<div class="viz sec-viz" aria-hidden="true">
    <span>''' + ICONS["check"] + ''' scrypt N=16384</span>
    <span>''' + ICONS["check"] + ''' ''' + recovery + '''</span>
    <span>''' + ICONS["check"] + ''' ''' + csrf + '''</span>
    <span>''' + ICONS["check"] + ''' ''' + audit + '''</span>
  </div>'''
    if kind == "files":
        return '''<div class="viz files-viz" aria-hidden="true">
    <pre><code>domains/example.com/
├── public_html/
├── ssl.key
└── dns/example.com.db
backups/2026-11-14.tar.gz</code></pre>
  </div>'''
    return ""


def features(c):
    cards = []
    for i, card in enumerate(c["features"]["cards"]):
        cards.append(f'''<article class="bento-card span-{card["span"]} reveal" style="--d:{(i % 3) * 0.06}s">
        <div class="card-top"><span class="card-icon">{ICONS[card["icon"]]}</span><span class="card-kicker">{card["kicker"]}</span></div>
        <h3>{card["title"]}</h3>
        <p>{card["body"]}</p>
        {feature_visual(card["visual"], c["lang"])}
      </article>''')
    return f'''<section class="section features" id="features">
  <div class="container">
    <div class="section-head">
      <span class="eyebrow">{c["features"]["eyebrow"]}</span>
      <h2 class="section-title">{c["features"]["title"]}</h2>
      <p class="section-lead">{c["features"]["lead"]}</p>
    </div>
    <div class="bento">{''.join(cards)}</div>
  </div>
</section>'''


def screenshots(c):
    tabs = []
    for i, t in enumerate(c["shots"]["tabs"]):
        tabs.append(f'''<button class="shot-tab{' is-active' if i == 0 else ''}" type="button" role="tab" id="tab-{c["code"]}-{t["id"]}" aria-selected="{'true' if i == 0 else 'false'}" aria-controls="panel-{c["code"]}-{t["id"]}" tabindex="{0 if i == 0 else -1}">
        <span class="tab-num">0{i + 1}</span><span>{t["label"]}</span>
      </button>''')
    panels = []
    for i, t in enumerate(c["shots"]["tabs"]):
        panels.append(f'''<div class="shot-panel{' is-active' if i == 0 else ''}" id="panel-{c["code"]}-{t["id"]}" role="tabpanel" aria-labelledby="tab-{c["code"]}-{t["id"]}"{' hidden' if i > 0 else ''}>
        <figure class="browser browser-shot">
          <div class="browser-bar">
            <span class="browser-dots"><i></i><i></i><i></i></span>
            <span class="browser-url"><span class="url-lock">{ICONS["lock"]}</span>openadmin.live:2222/{t["id"]}</span>
            <span class="browser-live"><i></i>{"na żywo" if c["lang"] == "pl" else "live"}</span>
          </div>
          <div class="browser-screen"><img src="/assets/shots/{t["image"]}-1440.webp?v={SHOT_VER}" srcset="/assets/shots/{t["image"]}-900.webp?v={SHOT_VER} 900w, /assets/shots/{t["image"]}-1440.webp?v={SHOT_VER} 1440w" sizes="(min-width: 1100px) 1120px, 92vw" width="1440" height="1150" alt="{attr(t["alt"])}" loading="lazy" decoding="async"></div>
        </figure>
        <div class="shot-caption"><div><span class="eyebrow small">{t["kicker"]}</span><h3>{t["title"]}</h3></div><p>{t["body"]}</p></div>
      </div>''')
    return f'''<section class="section shots" id="screenshots">
  <div class="container">
    <div class="section-head split">
      <div><span class="eyebrow">{c["shots"]["eyebrow"]}</span><h2 class="section-title">{c["shots"]["title"]}</h2></div>
      <p class="section-lead">{c["shots"]["lead"]}</p>
    </div>
    <div class="shot-tabs" role="tablist" aria-label="{attr(c["shots"]["title"])}">{''.join(tabs)}</div>
    <div class="shot-stage">{''.join(panels)}</div>
    <p class="shots-note">{ICONS["spark"]}{c["shots"]["note"]}</p>
  </div>
</section>'''


def manifesto(c):
    principles = "".join(f'''<div class="principle reveal" style="--d:{0.1 + i * 0.06}s"><span class="principle-num">0{i + 1}</span><h3>{p["title"]}</h3><p>{p["body"]}</p></div>''' for i, p in enumerate(c["manifesto"]["principles"]))
    return f'''<section class="manifesto" aria-label="{attr(c["manifesto"]["eyebrow"])}">
  <div class="manifesto-bg" aria-hidden="true"></div>
  <div class="container">
    <span class="eyebrow center">{c["manifesto"]["eyebrow"]}</span>
    <blockquote class="manifesto-quote reveal">“{c["manifesto"]["quote"]}”</blockquote>
    <p class="manifesto-body reveal" style="--d:.08s">{c["manifesto"]["body"]}</p>
    <div class="principle-grid">{principles}</div>
  </div>
</section>'''


def compare(c):
    rows = []
    for r in c["compare"]["rows"]:
        rows.append(f'''<tr><th scope="row">{r["label"]}</th><td class="open-col" data-label="{attr(c["compare"]["columns"]["open"])}"><span class="cell-check">{ICONS["check"]}</span><strong>{r["open"]}</strong></td><td data-label="{attr(c["compare"]["columns"]["other"])}"><span class="cell-neutral"></span>{r["other"]}</td></tr>''')
    return f'''<section class="section compare" id="compare">
  <div class="container">
    <div class="section-head split">
      <div><span class="eyebrow">{c["compare"]["eyebrow"]}</span><h2 class="section-title">{c["compare"]["title"]}</h2></div>
      <p class="section-lead">{c["compare"]["lead"]}</p>
    </div>
    <div class="compare-wrap reveal">
      <table class="compare-table">
        <caption class="sr-only">{c["compare"]["title"]}</caption>
        <thead><tr><th scope="col"> </th><th scope="col" class="open-col"><span class="table-mark">{logo_mark("table-logo")}</span>{c["compare"]["columns"]["open"]}</th><th scope="col">{c["compare"]["columns"]["other"]}</th></tr></thead>
        <tbody>{''.join(rows)}</tbody>
      </table>
    </div>
    <p class="compare-note">{ICONS["spark"]}<span>{c["compare"]["note"]}</span></p>
  </div>
</section>'''


def inside(c):
    points = "".join(f'''<div class="inside-point reveal" style="--d:{i * 0.05}s"><span class="card-icon">{ICONS[p["icon"]]}</span><div><h3>{p["title"]}</h3><p>{p["body"]}</p></div></div>''' for i, p in enumerate(c["inside"]["points"]))
    specs = "".join(f'''<div class="spec-row"><span>{s["k"]}</span><b>{s["v"]}</b></div>''' for s in c["inside"]["specs"])
    tree = "\n".join(esc(line) for line in c["inside"]["tree"])
    return f'''<section class="section inside" id="inside">
  <div class="container">
    <div class="section-head">
      <span class="eyebrow">{c["inside"]["eyebrow"]}</span>
      <h2 class="section-title">{c["inside"]["title"]}</h2>
      <p class="section-lead">{c["inside"]["lead"]}</p>
    </div>
    <div class="inside-grid">
      <div class="inside-points">{points}</div>
      <div class="inside-terminal reveal" style="--d:.1s">
        <div class="term-bar"><span class="browser-dots"><i></i><i></i><i></i></span><em>{c["inside"]["specLabel"]}</em><span class="term-badge">{"tylko odczyt" if c["lang"] == "pl" else "read-only"}</span></div>
        <pre class="term-tree"><code>{tree}</code></pre>
        <div class="spec-grid">{specs}</div>
      </div>
    </div>
  </div>
</section>'''


def install(c):
    tabs = []
    panels = []
    for i, t in enumerate(c["install"]["tabs"]):
        tabs.append(f'''<button class="install-tab{' is-active' if i == 0 else ''}" type="button" role="tab" id="itab-{c["code"]}-{t["id"]}" aria-selected="{'true' if i == 0 else 'false'}" aria-controls="ipanel-{c["code"]}-{t["id"]}" tabindex="{0 if i == 0 else -1}">{t["label"]}</button>''')
        accounts = ""
        if t["accounts"]:
            rows = "".join(f'''<div class="account-row"><span>{a["level"]}</span><code>{a["user"]}</code><code>{a["pass"]}</code></div>''' for a in t["accounts"])
            accounts = f'''<div class="accounts"><div class="account-head"><span>{c["install"]["accountLevel"]}</span><span>{c["install"]["accountUser"]}</span><span>{c["install"]["accountPass"]}</span></div>{rows}</div>'''
        panels.append(f'''<div class="install-panel{' is-active' if i == 0 else ''}" id="ipanel-{c["code"]}-{t["id"]}" role="tabpanel" aria-labelledby="itab-{c["code"]}-{t["id"]}"{' hidden' if i > 0 else ''}>
          <div class="install-copy"><h3>{t["title"]}</h3><p>{t["body"]}</p></div>
          <div class="code-block">
            <div class="code-head"><span class="code-dots"><i></i><i></i><i></i></span><span>bash</span><button class="copy-btn" type="button" data-copy="code-{c["code"]}-{t["id"]}" data-copied-label="{attr(c["install"]["copied"])}" aria-label="{attr(c["install"]["copy"])}">{ICONS["copy"]}<span>{c["install"]["copy"]}</span></button></div>
            <pre><code id="code-{c["code"]}-{t["id"]}">{esc(t["code"])}</code></pre>
          </div>
          <p class="code-note">{t["note"]}</p>
          {accounts}
        </div>''')
    return f'''<section class="section install" id="install">
  <div class="container">
    <div class="section-head">
      <span class="eyebrow">{c["install"]["eyebrow"]}</span>
      <h2 class="section-title">{c["install"]["title"]}</h2>
      <p class="section-lead">{c["install"]["lead"]}</p>
    </div>
    <div class="install-grid">
      <aside class="install-aside reveal">
        <a class="download-card" href="{DOWNLOAD_PATH}" download>
          <span class="download-icon">{ICONS["download"]}</span>
          <span><b>{c["install"]["download"]["label"]}</b><small>{c["install"]["download"]["meta"]}</small></span>
          <span class="download-arrow">{ICONS["arrow"]}</span>
        </a>
        <div class="install-facts">
          {''.join(f'<div><span>{f["label"]}</span><b>{f["value"]}</b></div>' for f in c["install"]["facts"])}
        </div>
        <p class="aside-note">{c["install"]["asideNote"]}</p>
      </aside>
      <div class="install-card reveal" style="--d:.08s">
        <div class="install-tabs" role="tablist" aria-label="{attr(c["install"]["title"])}">{''.join(tabs)}</div>
        {''.join(panels)}
      </div>
    </div>
  </div>
</section>'''


def pricing(c):
    feats = "".join(f'<li>{ICONS["check"]}<span>{f}</span></li>' for f in c["pricing"]["features"])
    return f'''<section class="section pricing" id="pricing">
  <div class="pricing-glow" aria-hidden="true"></div>
  <div class="container">
    <div class="section-head centered">
      <span class="eyebrow center">{c["pricing"]["eyebrow"]}</span>
      <h2 class="section-title">{c["pricing"]["title"]}</h2>
      <p class="section-lead">{c["pricing"]["lead"]}</p>
    </div>
    <div class="price-card reveal">
      <div class="price-top">
        <div><span class="price-badge">{ICONS["spark"]}{c["pricing"]["badge"]}</span><h3>{c["pricing"]["plan"]}</h3></div>
        <div class="price-figure"><strong>{c["pricing"]["price"]}</strong><span>{c["pricing"]["per"]}</span></div>
      </div>
      <ul class="price-features">{feats}</ul>
      <div class="price-actions">
        <a class="btn btn-primary btn-lg" href="{DOWNLOAD_PATH}" download>{ICONS["download"]}{c["pricing"]["cta"]}</a>
        <span class="price-note">{c["pricing"]["note"]}</span>
      </div>
    </div>
  </div>
</section>'''


def faq(c):
    items = "".join(f'''<details class="faq-item"{' open' if i == 0 else ''}>
        <summary><span class="faq-q">{f["q"]}</span><span class="faq-plus" aria-hidden="true"></span></summary>
        <div class="faq-a"><p>{f["a"]}</p></div>
      </details>''' for i, f in enumerate(c["faq"]["items"]))
    return f'''<section class="section faq" id="faq">
  <div class="container faq-grid">
    <div class="faq-intro">
      <span class="eyebrow">{c["faq"]["eyebrow"]}</span>
      <h2 class="section-title">{c["faq"]["title"]}</h2>
      <p class="section-lead">{c["faq"]["lead"]}</p>
      <a class="text-link" href="{DOWNLOAD_PATH}" download>{ICONS["download"]}{c["install"]["download"]["label"]}<span>{ICONS["arrow"]}</span></a>
    </div>
    <div class="faq-list">{items}</div>
  </div>
</section>'''


def final_cta(c):
    return f'''<section class="final" aria-label="{attr(c["finalCta"]["eyebrow"])}">
  <div class="container">
    <div class="final-card reveal">
      <div class="final-grid" aria-hidden="true"></div>
      <div class="final-logo" aria-hidden="true">{logo_mark("final-mark")}</div>
      <span class="eyebrow center">{c["finalCta"]["eyebrow"]}</span>
      <h2>{c["finalCta"]["title"]}</h2>
      <p>{c["finalCta"]["lead"]}</p>
      <div class="hero-actions">
        <a class="btn btn-light btn-lg" href="{DOWNLOAD_PATH}" download>{ICONS["download"]}{c["finalCta"]["primary"]}</a>
        <a class="btn btn-outline btn-lg" href="#install">{c["finalCta"]["secondary"]}{ICONS["arrow"]}</a>
      </div>
      <span class="final-micro">{c["finalCta"]["micro"]}</span>
      <a class="final-github" href="{GITHUB_URL}" target="_blank" rel="noopener noreferrer">{ICONS["github"]}{c["finalCta"]["github"]}<span>↗</span></a>
    </div>
  </div>
</section>'''


def footer(c):
    groups = ""
    for g in c["footer"]["groups"]:
        links = ""
        for l in g["links"]:
            ext = ' rel="noopener noreferrer" target="_blank"' if l.get("external") else ""
            mark = '<span class="ext">↗</span>' if l.get("external") else ""
            links += f'<li><a href="{l["href"]}"{ext}>{l["label"]}{mark}</a></li>'
        groups += f'<div class="footer-col"><h3>{g["title"]}</h3><ul>{links}</ul></div>'
    return f'''<footer class="site-footer">
  <div class="container footer-grid">
    <div class="footer-brand">
      <a class="brand" href="/" aria-label="OpenAdmin">{logo_mark("brand-mark")}<span class="brand-name">OpenAdmin</span></a>
      <p>{c["footer"]["tagline"]}</p>
      <div class="footer-lang"><span>{c["footer"]["langLabel"]}</span><a href="/" class="{"is-active" if c["lang"] == "en" else ""}" hreflang="en">EN</a><a href="/pl/" class="{"is-active" if c["lang"] == "pl" else ""}" hreflang="pl">PL</a></div>
    </div>
    {groups}
  </div>
  <div class="container footer-bottom"><p class="footer-legal">{c["footer"]["legal"]}</p><p class="footer-rights">{c["footer"]["rights"]}</p></div>
  <div class="footer-word" aria-hidden="true">OpenAdmin</div>
</footer>'''


def structured_data(c):
    ld = {
        "@context": "https://schema.org",
        "@graph": [
            {
                "@type": "SoftwareApplication",
                "name": "OpenAdmin",
                "applicationCategory": "BusinessApplication",
                "operatingSystem": "Linux, macOS",
                "url": SITE + "/",
                "downloadUrl": SITE + DOWNLOAD_PATH,
                "softwareVersion": VERSION,
                "license": "https://www.gnu.org/licenses/agpl-3.0.html",
                "offers": {"@type": "Offer", "price": "0", "priceCurrency": "EUR"},
                "description": strip_tags(c["meta"]["description"]),
                "inLanguage": c["lang"],
                "sameAs": [GITHUB_URL],
            },
            {
                "@type": "FAQPage",
                "mainEntity": [
                    {
                        "@type": "Question",
                        "name": strip_tags(f["q"]),
                        "acceptedAnswer": {"@type": "Answer", "text": strip_tags(f["a"])},
                    }
                    for f in c["faq"]["items"]
                ],
            },
        ],
    }
    return '<script type="application/ld+json">' + json.dumps(ld, ensure_ascii=False).replace("<", "\\u003c") + '</script>\n<script src="/assets/app.js?v=' + ASSET_VER + '" defer></script>'


def page(c):
    return "\n".join([
        head(c),
        f'<body class="lang-{c["lang"]}">',
        GRADIENT_DEFS,
        f'<a class="skip-link" href="#main">{c["a11y"]["skip"]}</a>',
        nav(c),
        '<main id="main">',
        hero(c),
        tech(c),
        features(c),
        screenshots(c),
        manifesto(c),
        compare(c),
        inside(c),
        install(c),
        pricing(c),
        faq(c),
        final_cta(c),
        '</main>',
        footer(c),
        structured_data(c),
        '</body>',
        '</html>',
    ])


NOT_FOUND = '''<!doctype html>
<html lang="en" class="no-js"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Page not found — OpenAdmin</title><link rel="icon" href="/assets/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/assets/styles.css"></head>
<body class="lang-en"><main class="notfound"><div class="container"><span class="eyebrow">404</span><h1>This page has left the server.</h1><p>The address you followed does not exist. The panel, however, is very real.</p><div class="hero-actions"><a class="btn btn-primary" href="/">Back to the homepage</a><a class="btn btn-ghost" href="/pl/">Wersja polska</a></div></div></main></body></html>'''

ROBOTS = f'''User-agent: *
Allow: /
Sitemap: {SITE}/sitemap.xml
'''

SITEMAP = f'''<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
  <url><loc>{SITE}/</loc><xhtml:link rel="alternate" hreflang="en" href="{SITE}/"/><xhtml:link rel="alternate" hreflang="pl" href="{SITE}/pl/"/><changefreq>monthly</changefreq><priority>1.0</priority></url>
  <url><loc>{SITE}/pl/</loc><xhtml:link rel="alternate" hreflang="en" href="{SITE}/"/><xhtml:link rel="alternate" hreflang="pl" href="{SITE}/pl/"/><changefreq>monthly</changefreq><priority>0.9</priority></url>
</urlset>
'''

HTACCESS = r'''# OpenAdmin landing page — static hosting
Options -Indexes
DirectoryIndex index.html
AddDefaultCharset UTF-8
ErrorDocument 404 /404.html

<IfModule mod_rewrite.c>
  RewriteEngine On
  # Canonical archive URL: bypass the pre-release cached object.
  RewriteCond %{QUERY_STRING} ^$
  RewriteRule ^openadmin-1\.0\.0\.tar\.gz$ /openadmin-1.1.0.tar.gz [R=301,L]
  RewriteRule ^openadmin-1\.1\.0\.tar\.gz$ /openadmin-1.1.0.tar.gz?v=1.1.0 [R=301,L]
  # Canonical host: send www to the apex domain.
  RewriteCond %{HTTP_HOST} ^www\.openadmin\.live$ [NC]
  RewriteRule ^ https://openadmin.live%{REQUEST_URI} [R=301,L]
  RewriteRule ^pl$ /pl/ [R=301,L]
</IfModule>

<IfModule mod_headers.c>
  Header always set X-Content-Type-Options "nosniff"
  Header always set X-Frame-Options "SAMEORIGIN"
  Header always set Referrer-Policy "strict-origin-when-cross-origin"
  Header always set Permissions-Policy "camera=(), microphone=(), geolocation=()"
  Header always set Strict-Transport-Security "max-age=31536000; includeSubDomains"
  Header always set Content-Security-Policy "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'"
</IfModule>

<IfModule mod_deflate.c>
  AddOutputFilterByType DEFLATE text/html text/css text/plain text/xml application/javascript application/json image/svg+xml
</IfModule>

<IfModule mod_expires.c>
  ExpiresActive On
  ExpiresByType text/css "access plus 1 year"
  ExpiresByType application/javascript "access plus 1 year"
  ExpiresByType font/woff2 "access plus 1 year"
  ExpiresByType image/webp "access plus 1 month"
  ExpiresByType image/png "access plus 1 month"
  ExpiresByType image/jpeg "access plus 1 month"
  ExpiresByType image/svg+xml "access plus 1 month"
  ExpiresByType text/html "access plus 1 hour"
</IfModule>
'''


def main():
    DIST.mkdir(exist_ok=True)
    (DIST / "pl").mkdir(exist_ok=True)
    (DIST / "index.html").write_text(page(EN), encoding="utf-8")
    (DIST / "pl" / "index.html").write_text(page(PL), encoding="utf-8")
    (DIST / "404.html").write_text(NOT_FOUND, encoding="utf-8")
    (DIST / "robots.txt").write_text(ROBOTS, encoding="utf-8")
    (DIST / "sitemap.xml").write_text(SITEMAP, encoding="utf-8")
    (DIST / ".htaccess").write_text(HTACCESS, encoding="utf-8")

    assets_src = ROOT / "assets"
    assets_dst = DIST / "assets"
    if assets_dst.exists():
        shutil.rmtree(assets_dst)
    shutil.copytree(assets_src, assets_dst)

    archive = ROOT / "download" / "openadmin-1.1.0.tar.gz"
    if not archive.exists():
        import subprocess
        archive.parent.mkdir(exist_ok=True)
        try:
            subprocess.run([
                "git", "-C", str(ROOT.parent), "archive", "--format=tar.gz",
                "--prefix=openadmin-1.1.0/", "-o", str(archive), "HEAD",
            ], check=True)
            print("generated source archive from git HEAD")
        except Exception as exc:
            print("warning: could not generate source archive:", exc)
    if archive.exists():
        shutil.copy2(archive, DIST / archive.name)
    else:
        print("warning: missing source archive")

    en_size = (DIST / "index.html").stat().st_size
    pl_size = (DIST / "pl" / "index.html").stat().st_size
    print(f"built en ({en_size} bytes) + pl ({pl_size} bytes)")


if __name__ == "__main__":
    main()
