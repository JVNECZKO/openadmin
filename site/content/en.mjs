// OpenAdmin landing page — English copy
export default {
  code: "en",
  lang: "en",
  ogLocale: "en_US",
  meta: {
    title: "OpenAdmin — the free, open-source hosting control panel",
    description:
      "Free, DirectAdmin-compatible hosting control panel for real servers. Four web servers, mail, DNS, backups and a 110-command API. AGPL-3.0.",
    ogTitle: "Your server. Your panel. Your rules.",
    ogDescription:
      "OpenAdmin is the free, open-source hosting control panel you can actually own. DirectAdmin-compatible, unlimited and auditable.",
  },
  nav: {
    links: [
      { href: "#features", label: "Features" },
      { href: "#screenshots", label: "Screenshots" },
      { href: "#inside", label: "Inside" },
      { href: "#install", label: "Install" },
      { href: "#compare", label: "Compare" },
      { href: "#faq", label: "FAQ" },
    ],
    cta: "Get OpenAdmin",
    primaryLabel: "Primary",
    mobileLabel: "Mobile",
    menu: "Menu",
    close: "Close menu",
    langAria: "Language",
  },
  hero: {
    eyebrow: "Free & open source · AGPL-3.0 · v1.0",
    titleBefore: "The hosting panel you can",
    titleAccent: "actually own",
    titleAfter: ".",
    lead:
      "OpenAdmin is a free, DirectAdmin-compatible control panel built for real servers. Three levels, four web servers, mail, DNS, backups and a 110-command API — with no licence keys and no npm dependencies.",
    primary: "Install in minutes",
    secondary: "Explore the panel",
    micro: ["Node.js ≥ 22.5", "Zero telemetry", "No npm install"],
    stats: [
      { value: "4", label: "web servers, one UI" },
      { value: "110", label: "CMD_API commands" },
      { value: "0", label: "licence fees" },
      { value: "0", label: "npm dependencies" },
    ],
    frame: {
      url: "openadmin.live:2222",
      alt: "The OpenAdmin dashboard showing domains, email accounts, bandwidth and usage limits",
      caption: "The admin dashboard — live data, real system artefacts.",
    },
    chipLabels: ["npm dependencies", "API commands", "licensed"],
  },
  tech: {
    label: "Plays nicely with the stack you already run",
    items: [
      "Nginx", "Apache", "OpenLiteSpeed", "LiteSpeed", "MariaDB", "BIND",
      "Dovecot", "Exim", "WordPress", "phpMyAdmin", "Roundcube", "Nextcloud",
    ],
  },
  features: {
    eyebrow: "What’s inside",
    title: "A complete panel, not a demo.",
    lead:
      "Every screen writes real files: BIND zones, Maildirs, vhosts, crontabs and TLS certificates. The panel is the product — nothing is held back for a paid tier.",
    cards: [
      {
        id: "levels",
        span: "lg",
        icon: "layers",
        kicker: "Access model",
        title: "Three levels. One login.",
        body:
          "Admin ⊃ Reseller ⊃ User, with package limits enforced in both the UI and the API. Switch level from the sidebar without a second account or a second panel.",
        visual: "levels",
      },
      {
        id: "deps",
        span: "md",
        icon: "package",
        kicker: "Supply chain",
        title: "Zero npm dependencies.",
        body:
          "Only Node.js built-ins: <code>node:http</code>, <code>node:sqlite</code>, <code>node:crypto</code>. Nothing to audit but our own code.",
        visual: "deps",
      },
      {
        id: "api",
        span: "md",
        icon: "terminal",
        kicker: "Compatibility",
        title: "DirectAdmin DNA.",
        body:
          "All 110 published <code>CMD_API_*</code> commands answer in the familiar <code>error=0&amp;list[]</code> format. Your billing and provisioning scripts already speak it.",
        visual: "api",
      },
      {
        id: "servers",
        span: "lg",
        icon: "server",
        kicker: "Web stack",
        title: "Four web servers, one screen.",
        body:
          "Nginx, Apache, OpenLiteSpeed and LiteSpeed Enterprise. Detect the stack, generate a vhost, validate it, deploy and reload — no hand-written config required.",
        visual: "servers",
      },
      {
        id: "mail",
        span: "sm",
        icon: "mail",
        kicker: "Mail",
        title: "Mail that leaves the server.",
        body:
          "Mailboxes, quotas, forwarders, autoresponders, catch-all, spam filters, webmail, IMAP and real MX delivery.",
        visual: "mail",
      },
      {
        id: "security",
        span: "sm",
        icon: "shield",
        kicker: "Security",
        title: "Safe by default.",
        body:
          "scrypt passwords, TOTP two-factor, CSRF tokens, login throttling, a jailed file manager and a complete audit log.",
        visual: "security",
      },
      {
        id: "files",
        span: "sm",
        icon: "folder",
        kicker: "Ownership",
        title: "Own everything.",
        body:
          "BIND zone files, tar.gz backups, OpenSSL certificates, crontabs and systemd units. Ordinary files, not a proprietary database.",
        visual: "files",
      },
    ],
  },
  shots: {
    eyebrow: "Look inside",
    title: "Real screens. Real work.",
    lead:
      "These are actual captures of the panel, not concept art. Pick a tab and see what your day looks like.",
    note: "Captured at 1440 × 1150 from the running app. Light and dark skins included.",
    tabs: [
      {
        id: "dashboard",
        label: "Dashboard",
        kicker: "User level",
        title: "The morning check-in",
        body:
          "Services, usage, domains and tickets on one screen. Limits come from the account’s package, not a hard-coded menu.",
        image: "dashboard",
        alt: "OpenAdmin user dashboard with bandwidth chart, domain list and account limits",
      },
      {
        id: "admin",
        label: "Admin",
        kicker: "Admin level",
        title: "The whole server, at a glance",
        body:
          "Users, resellers, services, bandwidth and open tickets. Reboot, inspect logs or impersonate an account without leaving the panel.",
        image: "admin",
        alt: "OpenAdmin admin dashboard with server overview and service status",
      },
      {
        id: "email",
        label: "Email",
        kicker: "Mail",
        title: "From mailbox to webmail",
        body:
          "Create mailboxes with quotas, wire up forwarders and autoresponders, then open the built-in webmail with one click.",
        image: "email",
        alt: "OpenAdmin email management screen with mailboxes and quotas",
      },
      {
        id: "webserver",
        label: "Web server",
        kicker: "Infrastructure",
        title: "Four stacks, generated correctly",
        body:
          "Detect what is installed, generate a per-domain vhost, validate braces and directives, then deploy and reload the service.",
        image: "webserver",
        alt: "OpenAdmin web server screen showing Nginx, Apache and LiteSpeed options",
      },
      {
        id: "mariadb",
        label: "MariaDB",
        kicker: "Data",
        title: "A real database, not a mock",
        body:
          "Talk to a live MariaDB server: list databases and accounts, create or drop both, and run SQL from the console.",
        image: "mariadb",
        alt: "OpenAdmin MariaDB screen with databases and SQL console",
      },
      {
        id: "files",
        label: "Files",
        kicker: "Filesystem",
        title: "A file manager with a jail",
        body:
          "Browse, upload, rename, edit inline and download archives — every path canonicalised and locked to the account home.",
        image: "files",
        alt: "OpenAdmin file manager showing the account home directory",
      },
    ],
  },
  manifesto: {
    eyebrow: "The licence is the feature",
    quote: "Nothing to buy. Nothing to activate. Nothing held back.",
    body:
      "OpenAdmin is AGPL-3.0. Run it on one server or a hundred. Read every line, fork it, patch it, ship it. There is no licence server, no account limit and no phone-home.",
    principles: [
      { title: "Free forever", body: "No trial clock, no per-seat maths, no “Pro” button." },
      { title: "Source first", body: "The panel is readable JavaScript, end to end." },
      { title: "No lock-in", body: "Your zones, mail, backups and database stay ordinary files." },
    ],
  },
  compare: {
    eyebrow: "DirectAdmin-compatible",
    title: "Same muscle memory. Different licence.",
    lead:
      "If your team knows DirectAdmin, they already know OpenAdmin: the same levels, the same panel names and the same API convention. What changes is what happens underneath.",
    columns: { open: "OpenAdmin", other: "Proprietary panels" },
    rows: [
      { label: "Licence", open: "AGPL-3.0, free forever", other: "Per-server subscription", tone: "good" },
      { label: "Accounts & domains", open: "Unlimited", other: "Often tiered", tone: "good" },
      { label: "Source code", open: "Readable JavaScript", other: "Closed", tone: "good" },
      { label: "API", open: "110 CMD_API + REST + OpenAPI", other: "Vendor-specific", tone: "good" },
      { label: "Panel data", open: "SQLite + plain files", other: "Opaque store", tone: "good" },
      { label: "Extensibility", open: "Plugins, skins, templates", other: "Vendor extensions", tone: "good" },
      { label: "Migration", open: "cPanel / DirectAdmin import", other: "Vendor tools", tone: "good" },
      { label: "Telemetry", open: "None", other: "Varies", tone: "good" },
    ],
    note:
      "OpenAdmin is an independent clean-room reimplementation. It shares the CMD_API convention, information architecture and data conventions — not code, binaries or assets. DirectAdmin is a trademark of its respective owner.",
  },
  inside: {
    eyebrow: "Inside the box",
    title: "Boring technology, on purpose.",
    lead:
      "One Node process, one SQLite file, no build step. Everything privileged goes through a provider boundary, so you can evaluate on a laptop and promote to Linux without relearning the product.",
    points: [
      {
        icon: "database",
        title: "node:sqlite",
        body:
          "WAL, transactions and indexes in one file you can copy. Backups are a file, not a vendor export.",
      },
      {
        icon: "shield",
        title: "sandbox → linux",
        body:
          "A single provider boundary owns system access. The UI never pretends a service restarted when it didn’t.",
      },
      {
        icon: "route",
        title: "119 routes",
        body:
          "Full DirectAdmin frontend route parity, with the original page titles, plus all 110 legacy CMD_* URLs.",
      },
      {
        icon: "package",
        title: "npm install not required",
        body:
          "No native addons, no lockfile drift, no supply-chain surprises. Clone it and run it.",
      },
    ],
    specLabel: "System map",
    tree: [
      "openadmin/",
      "├── src/server.mjs          HTTP · sessions · routing",
      "├── src/providers/          sandbox → linux boundary",
      "├── src/features/           one module per panel area",
      "├── src/compat/             110 CMD_API commands",
      "├── bin/openadmin.mjs       install · doctor · backup",
      "├── data/openadmin.db       one SQLite file",
      "└── install.sh              systemd · users · TLS",
    ],
    specs: [
      { k: "Runtime", v: "Node.js ≥ 22.5" },
      { k: "Dependencies", v: "0" },
      { k: "Database", v: "node:sqlite (WAL)" },
      { k: "Panel port", v: "2222" },
      { k: "Licence", v: "AGPL-3.0-or-later" },
      { k: "Telemetry", v: "None" },
    ],
  },
  install: {
    eyebrow: "Get started",
    title: "From zero to panel in one coffee.",
    lead:
      "Node.js 22.5+ is the only requirement. Try the demo on your laptop, or run the production installer on a fresh Debian, Ubuntu, Rocky or AlmaLinux server.",
    tabs: [
      {
        id: "demo",
        label: "Try the demo",
        title: "Kick the tyres on your laptop",
        body:
          "Downloads the source, starts the panel on port 2222 and seeds three demo accounts. No database server, no root, no signup.",
        code:
          "curl -fsSLO \\\n" +
          "  'https://openadmin.live/openadmin-1.1.0.tar.gz?v=1.1.0'\n" +
          "tar xzf openadmin-1.1.0.tar.gz \\\n" +
          "  && cd openadmin-1.1.0\n" +
          "OA_DEMO=1 node src/server.mjs",
        note: "Then open http://127.0.0.1:2222.",
        accounts: [
          { level: "User", user: "demouser", pass: "demo" },
          { level: "Reseller", user: "demoreseller", pass: "demo" },
          { level: "Admin", user: "demoadmin", pass: "demo" },
        ],
      },
      {
        id: "linux",
        label: "Linux install",
        title: "A hardened install in one command",
        body:
          "Creates the system user and data directory, installs Node.js if needed, writes a systemd unit and prints a generated admin password once.",
        code:
          "curl -fsSLO \\\n" +
          "  'https://openadmin.live/openadmin-1.1.0.tar.gz?v=1.1.0'\n" +
          "tar xzf openadmin-1.1.0.tar.gz \\\n" +
          "  && cd openadmin-1.1.0\n" +
          "sudo ./install.sh --port 2222",
        note:
          "Tested on Debian 12, Ubuntu 22.04+, Rocky 9 and AlmaLinux 9. Open port 2222 in your firewall.",
        accounts: [],
      },
      {
        id: "cli",
        label: "CLI",
        title: "Automate the boring parts",
        body:
          "The same operations the panel uses, available from a terminal: install, start, reset a password, create a user, back up, or run environment checks.",
        code:
          "node bin/openadmin.mjs install --demo\n" +
          "node bin/openadmin.mjs doctor\n" +
          "node bin/openadmin.mjs start\n" +
          "node bin/openadmin.mjs passwd admin --random",
        note: "Run node bin/openadmin.mjs --help for every command.",
        accounts: [],
      },
    ],
    asideNote: "Runs without root in sandbox mode. The Linux provider is where system writes happen.",
    facts: [
      { label: "Runtime", value: "Node.js ≥ 22.5" },
      { label: "Port", value: "2222" },
      { label: "Licence", value: "AGPL-3.0" },
    ],
    download: {
      label: "Download source",
      file: "openadmin-1.1.0.tar.gz",
      meta: "AGPL-3.0 · 1.1.0 · source archive",
    },
    copy: "Copy",
    copied: "Copied",
    accountLevel: "Level",
    accountUser: "Username",
    accountPass: "Password",
  },
  pricing: {
    eyebrow: "Pricing",
    title: "€0. Not a trial.",
    lead:
      "One licence: AGPL-3.0. Unlimited accounts, domains and servers. Support is the source code and the people who read it.",
    badge: "Free forever",
    plan: "OpenAdmin",
    price: "€0",
    per: "forever",
    features: [
      "Unlimited accounts, domains and servers",
      "Admin, reseller and user panels",
      "All 110 CMD_API commands",
      "Nginx, Apache, OpenLiteSpeed, LiteSpeed",
      "Mail, DNS, SSL, backups, cron, databases",
      "TOTP two-factor and audit log",
      "Full source code and updates",
      "No telemetry, no licence server",
    ],
    cta: "Download v1.1.0",
    note: "No credit card. No signup. No “contact sales”.",
  },
  faq: {
    eyebrow: "Questions",
    title: "The honest answers.",
    lead: "If something is not here, the source code is the rest of the documentation.",
    items: [
      {
        q: "Is OpenAdmin really free?",
        a: "Yes. The whole panel is AGPL-3.0-or-later. There are no licence keys, no seat limits and no feature gates. You can run it commercially, modify it and redistribute it under the same licence.",
      },
      {
        q: "Is this a DirectAdmin fork?",
        a: "No. It is an independent, clean-room reimplementation. It deliberately matches the CMD_API command surface, the panel names and the <code>/home/&lt;user&gt;/domains/…</code> conventions, but it contains no DirectAdmin code, binaries or assets.",
      },
      {
        q: "Can I install it on shared hosting?",
        a: "Not for real system administration. OpenAdmin needs a VPS or dedicated server, and root for writes to <code>/etc</code>, service reloads and system users. The default sandbox provider does run on a laptop for evaluation without root.",
      },
      {
        q: "Does it really manage mail and DNS?",
        a: "Yes, within the limits of the host: BIND zone files, Maildirs, Dovecot passwd files, Exim maps, DKIM keys, a built-in webmail and an IMAP4rev1 service. Outbound delivery still needs a working MTA on the server.",
      },
      {
        q: "What happens to my data if I leave?",
        a: "Nothing is trapped. The panel state is one SQLite file; websites, zones, mail, certificates and backups are ordinary files under the account homes. Take them with you.",
      },
      {
        q: "Does it phone home?",
        a: "No telemetry, no licence checks, no update beacons. The panel runs entirely on your server. You decide when to upgrade.",
      },
      {
        q: "Can I contribute or fork it?",
        a: "That is the point of AGPL. Read the source, open issues, send patches, or take it in your own direction. The codebase is small enough to understand in an afternoon.",
      },
    ],
  },
  finalCta: {
    eyebrow: "Ready when you are",
    title: "Your server. Your panel. Your rules.",
    lead:
      "Install OpenAdmin on a fresh VPS, or take it for a spin on your laptop. It takes a minute, and it costs nothing.",
    primary: "Get OpenAdmin",
    secondary: "Read the quick start",
    github: "View source on GitHub",
    micro: "AGPL-3.0 · Node.js ≥ 22.5 · No signup",
  },
  footer: {
    tagline:
      "A free, open-source, DirectAdmin-compatible hosting control panel. Built with Node.js and no trackers.",
    groups: [
      {
        title: "Product",
        links: [
          { label: "Features", href: "#features" },
          { label: "Screenshots", href: "#screenshots" },
          { label: "Install", href: "#install" },
          { label: "Pricing", href: "#pricing" },
          { label: "Download", href: "/openadmin-1.1.0.tar.gz?v=1.1.0" },
        ],
      },
      {
        title: "Learn",
        links: [
          { label: "Inside OpenAdmin", href: "#inside" },
          { label: "Compatibility", href: "#compare" },
          { label: "FAQ", href: "#faq" },
          { label: "GitHub", href: "https://github.com/JVNECZKO/openadmin", external: true },
          { label: "License", href: "https://www.gnu.org/licenses/agpl-3.0.html", external: true },
        ],
      },
      {
        title: "Stack",
        links: [
          { label: "Node.js", href: "https://nodejs.org", external: true },
          { label: "SQLite", href: "https://sqlite.org", external: true },
          { label: "DirectAdmin", href: "https://www.directadmin.com", external: true },
        ],
      },
    ],
    legal:
      "OpenAdmin is an independent project and is not affiliated with DirectAdmin or cPanel. Product names are trademarks of their respective owners.",
    rights: "© 2026 OpenAdmin. Free as in freedom.",
    langLabel: "Language",
  },
  a11y: {
    skip: "Skip to content",
    openMenu: "Open menu",
    closeMenu: "Close menu",
    github: "OpenAdmin on GitHub",
  },
};
