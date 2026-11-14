// Web server abstraction: Nginx, Apache HTTP Server, OpenLiteSpeed and
// LiteSpeed Enterprise. Generates real vhost configuration files, validates
// them and (on Linux, as root) deploys and reloads the service.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { config } from './config.mjs';
import { all, get, setting, setSetting } from './db.mjs';
import { systemProvider, providerExtras } from './providers/index.mjs';
import { activeCert } from './ssl.mjs';
import { safeJson } from './util.mjs';
import { deployPools } from './phpfpm.mjs';

export const SERVERS = {
  nginx: {
    id: 'nginx',
    label: 'Nginx',
    service: 'nginx',
    binaries: ['nginx'],
    availableDir: '/etc/nginx/sites-available',
    enabledDir: '/etc/nginx/sites-enabled',
    ext: '.conf',
    kind: 'nginx',
  },
  apache: {
    id: 'apache',
    label: 'Apache HTTP Server',
    service: 'httpd',
    binaries: ['apache2', 'httpd', 'apachectl'],
    availableDir: '/etc/apache2/sites-available',
    enabledDir: '/etc/apache2/sites-enabled',
    ext: '.conf',
    kind: 'apache',
  },
  openlitespeed: {
    id: 'openlitespeed',
    label: 'OpenLiteSpeed',
    service: 'openlitespeed',
    binaries: ['openlitespeed', 'lswsctrl', 'lshttpd'],
    availableDir: '/usr/local/lsws/conf/vhosts',
    enabledDir: '/usr/local/lsws/conf/vhosts',
    ext: '.conf',
    kind: 'litespeed',
  },
  litespeed: {
    id: 'litespeed',
    label: 'LiteSpeed Enterprise',
    service: 'litespeed',
    binaries: ['litespeed', 'lshttpd', 'lswsctrl'],
    availableDir: '/usr/local/lsws/conf/vhosts',
    enabledDir: '/usr/local/lsws/conf/vhosts',
    ext: '.conf',
    kind: 'litespeed',
  },
};

export function activeServer() {
  const id = setting('web_server', 'nginx');
  return SERVERS[id] || SERVERS.nginx;
}

export function serverForDomain(domain) {
  const override = setting(`web_server:${domain}`, '');
  return SERVERS[override] || activeServer();
}

export function stagingDir(server) {
  const dir = path.join(config.dataDir, 'webserver', server.id);
  fs.mkdirSync(path.join(dir, 'sites'), { recursive: true });
  return dir;
}

/** Detect the four stacks from the host provider. */
export function detect() {
  const extras = providerExtras();
  const out = {};
  for (const server of Object.values(SERVERS)) {
    const bins = extras.binaries(server.binaries);
    const found = bins.find((b) => b.exists);
    const svc = get('SELECT * FROM services WHERE name = ?', server.service);
    out[server.id] = {
      ...server,
      installed: !!found,
      binary: found || null,
      candidates: bins,
      service: svc || null,
      enterpriseLicense: server.id === 'litespeed' ? setting('litespeed_license', '') : null,
    };
  }
  return out;
}

function docroot(domain, username) {
  return `/home/${username}/domains/${domain}/public_html`;
}

function phpSocket(username) {
  return `/run/php/php-fpm-${username}.sock`;
}

/** Subdomains, pointers and redirects attached to one domain. */
export function extrasFor(domain) {
  const d = all('SELECT * FROM domains WHERE name = ?', domain)[0];
  if (!d) return { subdomains: [], pointers: [], redirects: [] };
  return {
    subdomains: all('SELECT * FROM subdomains WHERE domain_id = ? ORDER BY name', d.id),
    pointers: all("SELECT * FROM dns_records WHERE domain_id = ? AND type = 'POINTER'", d.id).map((r) => r.value),
    redirects: all('SELECT * FROM redirects WHERE domain_id = ? ORDER BY id', d.id),
  };
}

function nginxRedirects(redirects) {
  return redirects.map((r) => `    location = ${r.from_path} { return ${r.type} ${r.to_url}; }`).join('\n');
}

function siteSettings(domain, username) {
  const mime = safeJson(setting(`user:${username}:mime-types`, '[]'), []);
  const handlers = safeJson(setting(`user:${username}:handlers`, '[]'), []);
  const hotlink = safeJson(setting(`hotlink:${username}`, '{}'), {});
  const protectedDirs = safeJson(setting(`protected:${username}`, '[]'), []).filter((p) => p.domain === domain);
  const custom = setting(`httpd:${domain}`, '');
  const apps = all('SELECT * FROM hosted_apps WHERE domain = ? ORDER BY port', domain);
  const nextcloud = all("SELECT * FROM app_installs WHERE domain = ? AND type = 'nextcloud' AND status = 'active'", domain);
  const errors = {};
  for (const code of ['400', '401', '403', '404', '500', '503']) {
    const page = setting(`errpage:${domain}:${code}`, '');
    if (page) errors[code] = `/error-${code}.html`;
  }
  return { mime, handlers, hotlink, protectedDirs, custom, errors, apps, nextcloud };
}

function nginxSiteExtras(domain, username, root) {
  const s = siteSettings(domain, username);
  const out = [];
  for (const app of s.nextcloud || []) {
    const base = app.path === '/' ? '' : app.path;
    if (!base) {
      out.push(`    location ~ ^/(index\.php)(/.*)?$ {
        include fastcgi_params;
        fastcgi_split_path_info ^/(index\.php)(/.*)$;
        fastcgi_param PATH_INFO $fastcgi_path_info;
        fastcgi_param SCRIPT_FILENAME ${root}/index.php;
        fastcgi_pass unix:${phpSocket(username)};
    }`);
      continue;
    }
    out.push(`    location ~ ^${base}/(.+\\.php)(/.*)?$ {
        include fastcgi_params;
        fastcgi_split_path_info ^${base}/(.+?\\.php)(/.*)$;
        fastcgi_param PATH_INFO $fastcgi_path_info;
        fastcgi_param SCRIPT_FILENAME ${root}${base}/index.php;
        fastcgi_pass unix:${phpSocket(username)};
    }`);
    const safe = `${base}`.replace(/[^a-z0-9]/gi, '_');
    out.push(`    location ${base}/ { try_files $uri $uri/ @oa_nc${safe}; }`);
    out.push(`    location @oa_nc${safe} { rewrite ^${base}(/.*)$ ${base}/index.php$1 last; }`);
  }
  for (const [code, target] of Object.entries(s.errors)) out.push(`    error_page ${code} ${target};`);
  if (s.hotlink[domain]) {
    const allowed = (s.hotlink._allowed || []).join(' ');
    out.push(`    location ~* \\.(jpg|jpeg|png|gif|webp|mp4|zip)$ {
        valid_referers none blocked server_names ${allowed};
        if ($invalid_referer) { return 403; }
    }`);
  }
  for (const p of s.protectedDirs) {
    out.push(`    location ^~ ${p.path} {
        auth_basic "Restricted";
        auth_basic_user_file ${root}/.htpasswd;
    }`);
  }
  if (s.mime.length) {
    out.push(`    types { ${s.mime.map((m) => `${m.value} ${String(m.key).replace(/^\./, '')};`).join(' ')} }`);
  }
  for (const app of s.apps || []) {
    out.push(`    location ${app.path_prefix} {
        proxy_pass http://127.0.0.1:${app.port};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }`);
  }
  if (s.custom) out.push(`    # Custom HTTPD configuration\n${s.custom.split('\n').map((l) => '    ' + l).join('\n')}`);
  return out.join('\n');
}

function apacheSiteExtras(domain, username, root) {
  const s = siteSettings(domain, username);
  const out = [];
  for (const app of s.nextcloud || []) {
    const base = app.path === '/' ? '' : app.path;
    if (!base) {
      out.push(`    location ~ ^/(index\.php)(/.*)?$ {
        include fastcgi_params;
        fastcgi_split_path_info ^/(index\.php)(/.*)$;
        fastcgi_param PATH_INFO $fastcgi_path_info;
        fastcgi_param SCRIPT_FILENAME ${root}/index.php;
        fastcgi_pass unix:${phpSocket(username)};
    }`);
      continue;
    }
    out.push(`    <Directory ${root}${base}>`);
    out.push(`        FallbackResource ${base}/index.php`);
    out.push('    </Directory>');
  }
  for (const [code, target] of Object.entries(s.errors)) out.push(`    ErrorDocument ${code} ${target}`);
  for (const m of s.mime) out.push(`    AddType ${m.value} ${m.key}`);
  for (const h of s.handlers) out.push(`    AddHandler ${h.value} ${h.key}`);
  if (s.hotlink[domain]) {
    out.push(`    SetEnvIfNoCase Referer "^https?://(www\\.)?${domain.replace(/\./g, '\\.')}" local_ref=1`);
    out.push(`    <FilesMatch "\\.(jpg|jpeg|png|gif|webp|mp4|zip)$">`);
    out.push('        Order Allow,Deny');
    out.push('        Allow from env=local_ref');
    out.push('    </FilesMatch>');
  }
  for (const p of s.protectedDirs) {
    out.push(`    <Directory ${root}${p.path}>`);
    out.push('        AuthType Basic');
    out.push('        AuthName "Restricted"');
    out.push(`        AuthUserFile ${root}/.htpasswd`);
    out.push('        Require valid-user');
    out.push('    </Directory>');
  }
  for (const app of s.apps || []) {
    out.push(`    ProxyPass ${app.path_prefix} http://127.0.0.1:${app.port}/`);
    out.push(`    ProxyPassReverse ${app.path_prefix} http://127.0.0.1:${app.port}/`);
  }
  if (s.custom) out.push(...s.custom.split('\n'));
  return out.join('\n');
}

function nginxAliasBlocks(domain, root, extras) {
  const blocks = [];
  for (const sub of extras.subdomains) {
    blocks.push(`server {
    listen 80;
    server_name ${sub.name}.${domain};
    root ${sub.docroot || `${root}/${sub.name}`};
    index index.php index.html;
    location / { try_files $uri $uri/ /index.php?$args; }
    location ~ \\.php$ { include fastcgi_params; fastcgi_pass unix:/run/php/php-fpm-${sub.username}.sock; fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name; }
}`);
  }
  for (const alias of extras.pointers) {
    blocks.push(`server {
    listen 80;
    server_name ${alias};
    root ${root};
    index index.php index.html;
    location / { try_files $uri $uri/ /index.php?$args; }
}`);
  }
  return blocks.join('\n');
}

/* -------------------------------------------------------------- generators */
export function renderNginx(d, { phpHandler = 'php-fpm' } = {}) {
  const root = docroot(d.name, d.username);
  const tls = activeCert(d.name);
  const php = phpHandler === 'proxy'
    ? `    location ~ \\.php$ {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }`
    : `    location ~ \\.php$ {
        include fastcgi_params;
        fastcgi_pass unix:${phpSocket(d.username)};
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
    }`;
  const tlsBlock = tls ? `
server {
    listen 443 ssl http2;
    server_name ${d.name} www.${d.name};
    root ${root};
    ssl_certificate     ${tls.webPaths.cert};
    ssl_certificate_key ${tls.webPaths.key};
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;
    index index.php index.html;
    location / { try_files $uri $uri/ /index.php?$args; }
${php}
    location ~ /\.ht { deny all; }
${nginxRedirects(extrasFor(d.name).redirects)}
${nginxSiteExtras(d.name, d.username, root)}
}
` : '';
  return `# OpenAdmin — Nginx vhost for ${d.name}
# generated ${new Date().toISOString()}
server {
    listen 80;
    server_name ${d.name} www.${d.name};
    root ${root};
    index index.php index.html index.htm;

    access_log /var/log/nginx/${d.name}.access.log;
    error_log  /var/log/nginx/${d.name}.error.log;

    location / {
        try_files $uri $uri/ /index.php?$args;
    }

${php}

    location ~ /\\.ht {
        deny all;
    }

    location ~* \\.(js|css|png|jpg|jpeg|gif|ico|svg|webp|woff2)$ {
        expires 30d;
        access_log off;
    }
${nginxRedirects(extrasFor(d.name).redirects)}
${nginxSiteExtras(d.name, d.username, root)}
}
${nginxAliasBlocks(d.name, root, extrasFor(d.name))}
${tlsBlock}`;
}

export function renderApache(d, { phpHandler = 'php-fpm' } = {}) {
  const root = docroot(d.name, d.username);
  const tls = activeCert(d.name);
  const php = phpHandler === 'proxy'
    ? `    ProxyPassMatch "^/(.*\\.php(/.*)?)$" "http://127.0.0.1:8080/$1"`
    : `    <FilesMatch \\.php$>
        SetHandler "proxy:unix:${phpSocket(d.username)}|fcgi://localhost"
    </FilesMatch>`;
  return `# OpenAdmin — Apache vhost for ${d.name}
# generated ${new Date().toISOString()}
<VirtualHost *:80>
    ServerName ${d.name}
    ServerAlias www.${d.name}
    DocumentRoot ${root}

    ErrorLog  /var/log/apache2/${d.name}.error.log
    CustomLog /var/log/apache2/${d.name}.access.log combined

    <Directory ${root}>
        Options -Indexes +FollowSymLinks
        AllowOverride All
        Require all granted
    </Directory>

${php}
${extrasFor(d.name).redirects.map((r) => `    Redirect ${r.type} ${r.from_path} ${r.to_url}`).join('\n')}
${apacheSiteExtras(d.name, d.username, root)}
</VirtualHost>
${extrasFor(d.name).subdomains.map((sub) => `<VirtualHost *:80>
    ServerName ${sub.name}.${d.name}
    DocumentRoot ${sub.docroot || `${root}/${sub.name}`}
    <Directory ${sub.docroot || `${root}/${sub.name}`}>
        Options -Indexes +FollowSymLinks
        AllowOverride All
        Require all granted
    </Directory>
</VirtualHost>`).join('\n')}
${extrasFor(d.name).pointers.map((alias) => `<VirtualHost *:80>
    ServerName ${alias}
    DocumentRoot ${root}
    <Directory ${root}>
        Options -Indexes +FollowSymLinks
        AllowOverride All
        Require all granted
    </Directory>
</VirtualHost>`).join('\n')}
${tls ? `<IfModule mod_ssl.c>
<VirtualHost *:443>
    ServerName ${d.name}
    ServerAlias www.${d.name}
    DocumentRoot ${root}
    SSLEngine on
    SSLCertificateFile ${tls.webPaths.cert}
    SSLCertificateKeyFile ${tls.webPaths.key}
    <Directory ${root}>
        Options -Indexes +FollowSymLinks
        AllowOverride All
        Require all granted
    </Directory>
${php}
</VirtualHost>
</IfModule>` : ''}
`;
}

export function renderLiteSpeed(d) {
  const root = docroot(d.name, d.username);
  const tls = activeCert(d.name);
  return `# OpenAdmin — OpenLiteSpeed vhost for ${d.name}
docRoot                   ${root}
vhDomain                  ${d.name}, www.${d.name}
enableGzip                1
index  {
  useServer               0
  indexFiles              index.php, index.html
}
errorlog $SERVER_ROOT/logs/${d.name}.error.log {
  logLevel                ERROR
  rollingSize             10M
}
accesslog $SERVER_ROOT/logs/${d.name}.access.log {
  logFormat               %h %l %u %t "%r" %>s %b
  rollingSize             10M
}
${tls ? `vhssl  {
  keyFile                 ${tls.webPaths.key}
  certFile                ${tls.webPaths.cert}
  certChain               1
}
` : ''}scripthandler  {
  add                     lsapi:lsphp php
}
rewrite  {
  enable                  1
  rules                   <<<END_rules
RewriteEngine On
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d
RewriteRule ^(.*)$ /index.php?$1 [L,QSA]
END_rules
}
`;
}

function deployLiteSpeed(server, dir) {
  const sites = fs.readdirSync(path.join(dir, 'sites')).filter((f) => f.endsWith('.conf'));
  const domains = sites.map((f) => f.replace(/\.conf$/, ''));
  const containers = [];
  for (const f of sites) {
    const domain = f.replace(/\.conf$/, '');
    const vhdir = path.join(server.availableDir, domain);
    fs.mkdirSync(vhdir, { recursive: true });
    fs.copyFileSync(path.join(dir, 'sites', f), path.join(vhdir, 'vhconf.conf'));
    const d = get('SELECT * FROM domains WHERE name = ?', domain);
    containers.push(`virtualhost ${domain} {
  vhRoot                  ${docroot(domain, d?.username || '')}/
  configFile              $SERVER_ROOT/conf/vhosts/${domain}/vhconf.conf
  allowSymbolLink         1
  enableScript            1
  restrained              1
}`);
  }
  stopUnit('nginx');
  stopUnit('apache2');
  stopUnit('lsws');
  const confPath = '/usr/local/lsws/conf/httpd_config.conf';
  let conf = fs.readFileSync(confPath, 'utf8');
  conf = conf.replace(/# BEGIN OPENADMIN[\s\S]*?# END OPENADMIN\n?/g, '');
  const sslDomains = domains.filter((d) => activeCert(d));
  const sslMaps = sslDomains.map((d) => `  map                     ${d} ${d}`).join('\n');
  const firstCert = sslDomains[0] ? activeCert(sslDomains[0]) : null;
  const sslListener = sslMaps ? `listener SSL {
  address                 *:443
  secure                  1
  keyFile                 ${firstCert.webPaths.key}
  certFile                ${firstCert.webPaths.cert}
${sslMaps}
}
` : '';
  conf += `\n# BEGIN OPENADMIN\n${containers.join('\n')}\n${sslListener}# END OPENADMIN\n`;
  // Add/refresh listener maps inside the Default listener block.
  const marker = /listener\s+Default\s*\{/i.exec(conf);
  if (marker) {
    const open = conf.indexOf('{', marker.index);
    let depth = 0;
    let close = -1;
    for (let i = open; i < conf.length; i++) {
      if (conf[i] === '{') depth++;
      if (conf[i] === '}') { depth--; if (depth === 0) { close = i; break; } }
    }
    if (close !== -1) {
      let block = conf.slice(open + 1, close);
      block = block.split('\n').filter((line) => !/^\s*map\s+\S+\s+(openadmin_|[a-z0-9.-]+)\s*$/.test(line) || !domains.some((d) => line.trim().split(/\s+/)[1] === d)).join('\n');
      const maps = domains.map((d) => `  map                     ${d} ${d}`).join('\n');
      block = block.replace(/address\s+\*:8088\b/, 'address *:80');
      conf = conf.slice(0, open + 1) + '\n' + maps + '\n' + block + '\n' + conf.slice(close);
    }
  }
  fs.writeFileSync(confPath, conf, { mode: 0o644 });
  const test = spawnSync('/usr/local/lsws/bin/lshttpd', ['-t'], { encoding: 'utf8', timeout: 20000 });
  const testText = `${test.stdout || ''}${test.stderr || ''}`.trim();
  if (test.status !== 0 && (/\[ERROR\]/.test(testText) || !/\[WARN\]/.test(testText))) {
    return { ok: false, output: `OLS config test failed: ${testText.slice(0, 800)}` };
  }
  const reload = spawnSync('/usr/local/lsws/bin/lswsctrl', ['restart'], { encoding: 'utf8', timeout: 30000 });
  return { ok: reload.status === 0, output: `deployed ${domains.length} OLS vhost(s); ${(reload.stdout || reload.stderr || '').trim()}` };
}

/** Generate every domain's config for the selected server. */
export function generateAll(serverId = activeServer().id) {
  const domains = all('SELECT * FROM domains ORDER BY name');
  const phpHandler = setting('php_handler', 'php-fpm');
  const written = [];
  const byServer = {};
  for (const d of domains) {
    const server = SERVERS[setting(`web_server:${d.name}`, '')] || SERVERS[serverId] || activeServer();
    const dir = stagingDir(server);
    let main;
    let extra = null;
    if (server.kind === 'nginx') main = renderNginx(d, { phpHandler });
    else if (server.kind === 'apache') main = renderApache(d, { phpHandler });
    else {
      main = renderLiteSpeed(d);
    }
    const file = path.join(dir, 'sites', `${d.name}${server.ext}`);
    fs.writeFileSync(file, main, 'utf8');
    written.push({ domain: d.name, server: server.id, file, bytes: Buffer.byteLength(main) });
    byServer[server.id] = (byServer[server.id] || 0) + 1;
    if (extra) {
      const sub = path.join(dir, 'sites', d.name, 'vhconf.conf');
      fs.mkdirSync(path.dirname(sub), { recursive: true });
      fs.writeFileSync(sub, extra, 'utf8');
      written.push({ domain: d.name, server: server.id, file: sub, bytes: Buffer.byteLength(extra) });
    }
  }
  for (const id of Object.keys(SERVERS)) {
    const dir = stagingDir(SERVERS[id]);
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ server: id, generatedAt: new Date().toISOString(), files: written.filter((w) => w.server === id) }, null, 2));
  }
  setSetting('webconfig_generated_at', new Date().toISOString());
  setSetting('webconfig_server', serverId);
  return { written, byServer, total: written.length };
}

/** Structural validation that runs everywhere, plus the real binary when installed. */
export function validate(serverId = activeServer().id) {
  const server = SERVERS[serverId] || activeServer();
  const dir = stagingDir(server);
  const issues = [];
  const files = fs.existsSync(path.join(dir, 'sites'))
    ? fs.readdirSync(path.join(dir, 'sites')).filter((f) => f.endsWith('.conf'))
    : [];
  if (!files.length) issues.push('No configuration files generated yet.');
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, 'sites', f), 'utf8');
    if (server.kind === 'nginx') {
      const open = (text.match(/{/g) || []).length;
      const close = (text.match(/}/g) || []).length;
      if (open !== close) issues.push(`${f}: unbalanced braces (${open} open, ${close} close)`);
      if (!/server_name\s+\S+/.test(text)) issues.push(`${f}: missing server_name`);
      if (!/root\s+\//.test(text)) issues.push(`${f}: missing document root`);
    } else if (server.kind === 'apache') {
      if (!/<VirtualHost[^>]*>/.test(text)) issues.push(`${f}: missing <VirtualHost>`);
      if (!/DocumentRoot\s+\//.test(text)) issues.push(`${f}: missing DocumentRoot`);
      if ((text.match(/<VirtualHost/g) || []).length !== (text.match(/<\/VirtualHost>/g) || []).length) issues.push(`${f}: unbalanced VirtualHost tags`);
    } else {
      if (!/docRoot\s+\//.test(text)) issues.push(`${f}: missing docRoot`);
      if ((text.match(/{/g) || []).length !== (text.match(/}/g) || []).length) issues.push(`${f}: unbalanced braces`);
    }
  }
  let binaryCheck = null;
  const detected = detect()[server.id];
  if (detected?.installed) {
    const bin = detected.binary.path;
    const primary = files.find((f) => f.endsWith('.conf'));
    if (primary) {
      const target = path.join(dir, 'sites', primary);
      binaryCheck = runCheck(bin, server.kind, target);
    }
  }
  return { server, files: files.length, issues, binaryCheck, ok: issues.length === 0 };
}

function liveCheck(server) {
  const cmds = {
    nginx: ['nginx', ['-t']],
    apache: ['apachectl', ['configtest']],
    openlitespeed: ['/usr/local/lsws/bin/lshttpd', ['-t']],
    litespeed: ['/usr/local/lsws/bin/lshttpd', ['-t']],
  };
  const entry = cmds[server.id];
  if (!entry) return { ok: true, output: 'no live check' };
  const r = spawnSync(entry[0], entry[1], { encoding: 'utf8', timeout: 20000 });
  return { ok: r.status === 0, output: `${r.stdout || ''}${r.stderr || ''}`.trim().slice(0, 1500) };
}

function runCheck(bin, kind, file) {
  let args = [];
  if (kind === 'nginx') args = ['-t', '-c', file];
  else if (kind === 'apache') args = [bin.endsWith('apachectl') ? '-t' : '-t', '-f', file];
  else args = ['-t'];
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 15000 });
  return { ok: r.status === 0, output: `${r.stdout || ''}${r.stderr || ''}`.trim().slice(0, 1200) };
}

/** Deploy generated files to the real system directories (Linux + root). */
function stopUnit(unit) {
  spawnSync('systemctl', ['stop', unit], { encoding: 'utf8', timeout: 30000 });
  for (let i = 0; i < 40; i++) {
    const active = spawnSync('systemctl', ['is-active', '--quiet', unit], { encoding: 'utf8' });
    if (active.status !== 0) return true;
    spawnSync('sleep', ['0.25'], { encoding: 'utf8' });
  }
  spawnSync('sh', ['-c', `pkill -x ${unit} 2>/dev/null`], { encoding: 'utf8' });
  spawnSync('sleep', ['1'], { encoding: 'utf8' });
  return spawnSync('systemctl', ['is-active', '--quiet', unit], { encoding: 'utf8' }).status !== 0;
}

function waitPortsFree(ports, tries = 80) {
  for (let i = 0; i < tries; i++) {
    const ss = spawnSync('ss', ['-lnt'], { encoding: 'utf8' });
    const busy = (ss.stdout || '').split('\n').some((line) => ports.some((p) => new RegExp(`:${p}\\b`).test(line)));
    if (!busy) return true;
    spawnSync('sleep', ['0.25'], { encoding: 'utf8' });
  }
  return false;
}

export function deploy(serverId = activeServer().id) {
  const server = SERVERS[serverId] || activeServer();
  const dir = stagingDir(server);
  if (systemProvider().id !== 'linux') {
    return { ok: true, simulated: true, output: `Configuration generated in ${dir} (sandbox provider does not write system paths)` };
  }
  if (process.getuid && process.getuid() !== 0) {
    return { ok: false, output: 'Root privileges are required to deploy web server configuration' };
  }
  // Certificates referenced by the vhosts live under /etc/openadmin/ssl.
  const sslRoot = path.join(config.dataDir, 'ssl');
  if (fs.existsSync(sslRoot)) {
    for (const domain of fs.readdirSync(sslRoot)) {
      const src = path.join(sslRoot, domain);
      if (!fs.statSync(src).isDirectory()) continue;
      const dest = `/etc/openadmin/ssl/${domain}`;
      fs.mkdirSync(dest, { recursive: true, mode: 0o750 });
      for (const f of ['fullchain.pem', 'privkey.pem']) {
        if (fs.existsSync(path.join(src, f))) {
          fs.copyFileSync(path.join(src, f), path.join(dest, f));
          fs.chmodSync(path.join(dest, f), 0o640);
        }
      }
    }
  }
  const pools = deployPools();
  if (server.id === 'apache') {
    spawnSync('sh', ['-c', 'a2enmod proxy_fcgi proxy proxy_http ssl rewrite headers 2>/dev/null'], { encoding: 'utf8', timeout: 20000 });
  }
  if (server.kind === 'litespeed') {
    return deployLiteSpeed(server, dir);
  }
  const sites = fs.readdirSync(path.join(dir, 'sites')).filter((f) => f.endsWith('.conf'));
  let count = 0;
  for (const f of sites) {
    const dest = path.join(server.availableDir, f);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(dir, 'sites', f), dest);
    const enabled = path.join(server.enabledDir, f);
    if (server.enabledDir !== server.availableDir) {
      fs.mkdirSync(path.dirname(enabled), { recursive: true });
      try { fs.unlinkSync(enabled); } catch { /* not there */ }
      fs.symlinkSync(dest, enabled);
    }
    count++;
  }
  const test = validate(serverId);
  if (!test.ok) return { ok: false, output: `Validation failed: ${test.issues.join('; ')}` };
  const live = liveCheck(server);
  if (!live.ok) return { ok: false, output: `Live configuration check failed: ${live.output}` };
  if (server.id === 'nginx' || server.id === 'apache') {
    const other = server.id === 'nginx' ? 'apache2' : 'nginx';
    stopUnit(other);
    stopUnit('lsws');
    spawnSync('/usr/local/lsws/bin/lswsctrl', ['stop'], { encoding: 'utf8', timeout: 20000 });
    waitPortsFree([80, 443]);
  }
  const reload = systemProvider().restartService(server.service);
  return {
    ok: reload.ok,
    output: `deployed ${count} vhost(s); ${reload.output}${pools.count ? `; ${pools.output}` : ''}`,
    pools,
  };
}
