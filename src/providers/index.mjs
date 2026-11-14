// System provider boundary.
//
// The panel is deliberately split from the machine: every privileged operation
// goes through this interface. `sandbox` models the operation so the panel can
// be evaluated anywhere; `linux` talks to systemd and the filesystem on a real
// server. Adding a distribution means adding one provider, not editing pages.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { config } from '../config.mjs';
import { userHome } from '../paths.mjs';

const UNIT = {
  httpd: 'apache2', nginx: 'nginx', exim: 'exim4', dovecot: 'dovecot',
  mysqld: 'mariadb', bind: 'named', proftpd: 'proftpd',
  openlitespeed: 'lsws', litespeed: 'lsws',
  redis: 'redis-server', cron: 'cron',
};

function phpFpmUnitName() {
  try {
    const versions = fs.readdirSync('/etc/php').filter((v) => /^\d+\.\d+$/.test(v) && fs.existsSync(`/etc/php/${v}/fpm`));
    versions.sort((a, b) => Number(b.replace('.', '')) - Number(a.replace('.', '')));
    if (versions[0]) return `php${versions[0]}-fpm`;
  } catch { /* no php */ }
  return 'php8.2-fpm';
}

function run(cmd, args, timeout = 15000) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout });
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
    error: r.error?.message || '',
  };
}

const sandbox = {
  id: 'sandbox',
  label: 'Sandbox provider (safe simulation)',
  // Service state is persisted by the caller; the provider only reports what it did.
  restartService(name) {
    return { ok: true, output: `${name} restarted in sandbox mode`, simulated: true };
  },
  startService(name) {
    return { ok: true, output: `${name} started in sandbox mode`, simulated: true };
  },
  stopService(name) {
    return { ok: true, output: `${name} stopped in sandbox mode`, simulated: true };
  },
  serviceStatus() {
    return { ok: true, status: null, simulated: true };
  },
  systemInfo() {
    const total = os.totalmem();
    const free = os.freemem();
    return {
      simulated: true,
      hostname: os.hostname(),
      os: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      cpuModel: os.cpus()[0]?.model || 'unknown',
      cpuCount: os.cpus().length,
      memoryTotalMb: Math.round(total / 1024 / 1024),
      memoryFreeMb: Math.round(free / 1024 / 1024),
      uptimeSeconds: Math.round(os.uptime()),
      load: os.loadavg(),
    };
  },
  createHome() {
    return { ok: true, simulated: true };
  },
  createUser(username) {
    try { fs.mkdirSync(userHome(username), { recursive: true, mode: 0o711 }); return { ok: true, simulated: true, output: `Sandbox home for ${username}` }; } catch (e) { return { ok: false, output: e.message }; }
  },
  deleteUser(username) {
    try { fs.rmSync(userHome(username), { recursive: true, force: true }); return { ok: true, simulated: true, output: `Sandbox home for ${username} removed` }; } catch (e) { return { ok: false, output: e.message }; }
  },
  chownUser() { return { ok: true, simulated: true, output: 'Ownership is inherited in sandbox mode' }; },
  setSystemPassword() {
    return { ok: true, simulated: true, output: 'System password unchanged in sandbox (FTP registry updated)' };
  },
  createFtpUser(username, home, password) {
    const dir = path.join(config.dataDir, 'ftp');
    fs.mkdirSync(dir, { recursive: true });
    const hash = spawnSync('openssl', ['passwd', '-6', password], { encoding: 'utf8' });
    const line = `${username}:${(hash.stdout || '').trim() || '{PLAIN}' + password}:${home}\n`;
    const file = path.join(dir, 'passwd');
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter((l) => l && !l.startsWith(username + ':')) : [];
    fs.writeFileSync(file, current.join('\n') + (current.length ? '\n' : '') + line, { mode: 0o600 });
    return { ok: true, simulated: true, output: `FTP account ${username} written to ${file}` };
  },
  deleteFtpUser(username) {
    const file = path.join(config.dataDir, 'ftp', 'passwd');
    if (fs.existsSync(file)) {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l && !l.startsWith(username + ':'));
      fs.writeFileSync(file, lines.join('\n') + (lines.length ? '\n' : ''), { mode: 0o600 });
    }
    return { ok: true, simulated: true, output: `FTP account ${username} removed` };
  },
  removeSshKey(username, publicKey) {
    const file = path.join(userHome(username), '.ssh', 'authorized_keys');
    if (fs.existsSync(file)) {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() && l.trim() !== publicKey.trim());
      fs.writeFileSync(file, lines.join('\n') + (lines.length ? '\n' : ''), { mode: 0o600 });
    }
    return { ok: true, simulated: true, output: 'Key removed from the sandbox home' };
  },
  installSshKey(username, publicKey) {
    const home = userHome(username);
    try {
      fs.mkdirSync(path.join(home, '.ssh'), { recursive: true, mode: 0o700 });
      fs.appendFileSync(path.join(home, '.ssh', 'authorized_keys'), publicKey.trim() + '\n', { mode: 0o600 });
      return { ok: true, simulated: true, output: 'Key installed in the sandbox home' };
    } catch (e) { return { ok: false, output: e.message }; }
  },
  reloadWeb() {
    return { ok: true, output: 'vhosts reloaded in sandbox mode', simulated: true };
  },
  reboot() {
    return { ok: true, output: 'Reboot simulated by the sandbox provider', simulated: true };
  },
  readAccessLog() {
    return null;
  },
  processes() {
    const args = process.platform === 'darwin'
      ? ['-axo', 'pid,user,%cpu,%mem,command']
      : ['-eo', 'pid,user,%cpu,%mem,args'];
    const r = spawnSync('ps', args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 15000 });
    if (r.status !== 0) return { ok: false, error: (r.stderr || r.error?.message || 'ps failed').trim(), rows: [] };
    const rows = r.stdout.split('\n').slice(1).filter(Boolean).map((line) => {
      const m = /^\s*(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(.*)$/.exec(line);
      return m ? { pid: Number(m[1]), user: m[2], cpu: Number(m[3]), mem: Number(m[4]), command: m[5] } : null;
    }).filter(Boolean).slice(0, 250);
    return { ok: true, simulated: true, rows, host: true };
  },
  startApp() { return { ok: true, simulated: true, output: 'Application start simulated' }; },
  stopApp() { return { ok: true, simulated: true, output: 'Application stop simulated' }; },
  appStatus() { return { ok: true, simulated: true, status: null }; },
};

const linux = {
  id: 'linux',
  label: 'Linux provider (systemd)',
  restartService(name) {
    return systemctl(name, 'restart');
  },
  startService(name) {
    return systemctl(name, 'start');
  },
  stopService(name) {
    return systemctl(name, 'stop');
  },
  serviceStatus(name) {
    const unit = name === 'php-fpm' ? phpFpmUnitName() : UNIT[name];
    if (!unit) return { ok: false, status: null };
    const r = run('systemctl', ['is-active', unit]);
    return { ok: true, status: r.stdout === 'active' ? 'running' : 'stopped', raw: r.stdout };
  },
  systemInfo() {
    const mem = fs.existsSync('/proc/meminfo')
      ? Object.fromEntries(fs.readFileSync('/proc/meminfo', 'utf8').split('\n').filter(Boolean).map((l) => {
        const [k, v] = l.split(':');
        return [k.trim(), Number.parseInt(v, 10) * 1024];
      }))
      : {};
    return {
      simulated: false,
      hostname: os.hostname(),
      os: fs.existsSync('/etc/os-release')
        ? (fs.readFileSync('/etc/os-release', 'utf8').match(/^PRETTY_NAME="?([^"\n]+)"?/m)?.[1] || `${os.type()} ${os.release()}`)
        : `${os.type()} ${os.release()}`,
      arch: os.arch(),
      cpuModel: os.cpus()[0]?.model || 'unknown',
      cpuCount: os.cpus().length,
      memoryTotalMb: Math.round((mem.MemTotal || os.totalmem()) / 1024 / 1024),
      memoryFreeMb: Math.round((mem.MemAvailable || os.freemem()) / 1024 / 1024),
      uptimeSeconds: Math.round(os.uptime()),
      load: os.loadavg(),
      disk: diskUsage('/'),
    };
  },
  createHome(username) {
    const home = `/home/${username}`;
    try {
      fs.mkdirSync(home, { recursive: true, mode: 0o711 });
      return { ok: true, path: home };
    } catch (e) {
      return { ok: false, output: e.message };
    }
  },
  chownUser(username) {
    if (process.getuid && process.getuid() !== 0) return { ok: false, output: 'Root privileges are required' };
    const r = run('chown', ['-R', `${username}:${username}`, userHome(username)]);
    return { ok: r.ok, output: r.ok ? `Ownership set for ${username}` : (r.stderr || r.error) };
  },
  createUser(username, home) {
    if (process.getuid && process.getuid() !== 0) return { ok: false, output: 'Root privileges are required to create system users' };
    const exists = run('id', ['-u', username]);
    if (exists.ok) return { ok: true, output: 'System user exists', existing: true };
    const r = run('useradd', ['-m', '-d', home, '-s', '/bin/bash', username]);
    return { ok: r.ok, output: r.ok ? `System user ${username} created` : (r.stderr || r.error) };
  },
  deleteUser(username) {
    if (process.getuid && process.getuid() !== 0) return { ok: false, output: 'Root privileges are required' };
    const r = run('userdel', ['-r', username]);
    return { ok: r.ok, output: r.ok ? `System user ${username} removed` : (r.stderr || r.error) };
  },
  setSystemPassword(username, password) {
    if (process.getuid && process.getuid() !== 0) return { ok: false, output: 'Root privileges are required' };
    const r = spawnSync('chpasswd', [], { input: `${username}:${password}\n`, encoding: 'utf8' });
    return { ok: r.status === 0, output: r.status === 0 ? 'Password set' : (r.stderr || '').trim() };
  },
  createFtpUser(username, home, password, shell = '/usr/sbin/nologin') {
    if (process.getuid && process.getuid() !== 0) return { ok: false, output: 'Root privileges are required' };
    // FTP logins share the owning account's uid/gid so they can write the same files.
    const owner = path.basename(home);
    const uid = run('id', ['-u', owner]);
    const gid = run('id', ['-g', owner]);
    if (!run('id', ['-u', username]).ok) {
      const args = ['-d', home, '-s', shell, '-M'];
      if (uid.ok) args.push('-o', '-u', uid.stdout);
      if (gid.ok) args.push('-g', gid.stdout);
      args.push(username);
      const add = run('useradd', args);
      if (!add.ok) return { ok: false, output: add.stderr || add.error };
    }
    const pw = spawnSync('chpasswd', [], { input: `${username}:${password}\n`, encoding: 'utf8' });
    if (pw.status !== 0) return { ok: false, output: (pw.stderr || '').trim() };
    // ProFTPD refuses nologin shells unless explicitly allowed.
    try {
      fs.mkdirSync('/etc/proftpd/conf.d', { recursive: true });
      fs.writeFileSync('/etc/proftpd/conf.d/openadmin.conf',
        '# Generated by OpenAdmin\nRequireValidShell off\nDefaultRoot ~\n', { mode: 0o644 });
      spawnSync('systemctl', ['reload-or-restart', 'proftpd'], { encoding: 'utf8', timeout: 20000 });
    } catch { /* proftpd may not be installed */ }
    return { ok: true, output: `FTP user ${username} ready` };
  },
  deleteFtpUser(username) {
    if (process.getuid && process.getuid() !== 0) return { ok: false, output: 'Root privileges are required' };
    run('userdel', [username]);
    return { ok: true, output: `FTP user ${username} removed` };
  },
  removeSshKey(username, publicKey) {
    const home = process.getuid && process.getuid() === 0 ? `/home/${username}` : userHome(username);
    const file = path.join(home, '.ssh', 'authorized_keys');
    try {
      if (!fs.existsSync(file)) return { ok: true, output: 'No authorized_keys file' };
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() && l.trim() !== publicKey.trim());
      fs.writeFileSync(file, lines.join('\n') + (lines.length ? '\n' : ''), { mode: 0o600 });
      return { ok: true, output: 'Key removed' };
    } catch (e) { return { ok: false, output: e.message }; }
  },
  installSshKey(username, publicKey) {
    const home = process.getuid && process.getuid() === 0 ? `/home/${username}` : userHome(username);
    try {
      fs.mkdirSync(path.join(home, '.ssh'), { recursive: true, mode: 0o700 });
      const file = path.join(home, '.ssh', 'authorized_keys');
      const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      if (!current.split('\n').some((l) => l.trim() === publicKey.trim())) {
        fs.appendFileSync(file, publicKey.trim() + '\n', { mode: 0o600 });
      }
      return { ok: true, output: `Key installed in ${file}` };
    } catch (e) {
      return { ok: false, output: e.message };
    }
  },
  reloadWeb() {
    if (process.getuid && process.getuid() !== 0) return { ok: false, output: 'Root privileges required' };
    const apache = run('systemctl', ['reload', 'apache2']);
    if (apache.ok) return { ok: true, output: 'apache2 reloaded' };
    const nginx = run('systemctl', ['reload', 'nginx']);
    return { ok: nginx.ok, output: nginx.ok ? 'nginx reloaded' : (nginx.stderr || apache.stderr) };
  },
  reboot() {
    if (process.getuid && process.getuid() !== 0) return { ok: false, output: 'Root privileges required to reboot' };
    const r = run('systemctl', ['reboot']);
    return { ok: r.ok, output: r.ok ? 'Reboot scheduled' : (r.stderr || r.error), simulated: false };
  },
  processes() {
    const r = spawnSync('ps', ['-eo', 'pid,user,%cpu,%mem,args'], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 15000 });
    if (r.status !== 0) return { ok: false, error: (r.stderr || r.error?.message || 'ps failed').trim(), rows: [] };
    const rows = r.stdout.split('\n').slice(1).filter(Boolean).map((line) => {
      const m = /^\s*(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(.*)$/.exec(line);
      return m ? { pid: Number(m[1]), user: m[2], cpu: Number(m[3]), mem: Number(m[4]), command: m[5] } : null;
    }).filter(Boolean).slice(0, 250);
    return { ok: true, simulated: false, rows };
  },
  startApp(unit) {
    if (process.getuid && process.getuid() !== 0) return { ok: false, output: 'Root privileges are required' };
    const r = run('systemctl', ['start', unit]);
    return { ok: r.ok, output: r.ok ? `${unit} started` : (r.stderr || r.error) };
  },
  stopApp(unit) {
    if (process.getuid && process.getuid() !== 0) return { ok: false, output: 'Root privileges are required' };
    const r = run('systemctl', ['stop', unit]);
    return { ok: r.ok, output: r.ok ? `${unit} stopped` : (r.stderr || r.error) };
  },
  appStatus(unit) {
    const r = run('systemctl', ['is-active', unit]);
    return { ok: true, status: r.stdout === 'active' ? 'running' : 'stopped', simulated: false };
  },
  readAccessLog(domain) {
    const candidates = [`/var/log/nginx/${domain}.access.log`, `/var/log/apache2/${domain}.access.log`, `/var/log/httpd/${domain}.access.log`];
    const file = candidates.find((f) => fs.existsSync(f));
    if (!file) return null;
    try {
      const text = fs.readFileSync(file, 'utf8').slice(-4 * 1024 * 1024);
      const lines = text.split('\n').filter(Boolean);
      let bytes = 0;
      for (const line of lines) {
        const m = line.match(/"\s+(\d{3})\s+(\d+|-)/);
        if (m && m[2] !== '-') bytes += Number(m[2]) || 0;
      }
      return { bytes, requests: lines.length, file };
    } catch {
      return null;
    }
  },
};

function systemctl(name, action) {
  const unit = name === 'php-fpm' ? phpFpmUnitName() : UNIT[name];
  if (!unit) return { ok: false, output: `No systemd unit mapped for ${name}` };
  if (process.getuid && process.getuid() !== 0) {
    return { ok: false, output: 'Root privileges are required to control services' };
  }
  const r = run('systemctl', [action, unit]);
  return { ok: r.ok, output: r.ok ? `${unit} ${action}ed` : (r.stderr || r.error), status: r.status };
}

function diskUsage(mount) {
  try {
    const st = fs.statfsSync(mount);
    return { totalMb: Math.round((st.blocks * st.bsize) / 1024 / 1024), freeMb: Math.round((st.bavail * st.bsize) / 1024 / 1024) };
  } catch {
    return null;
  }
}

export function systemProvider() {
  return config.provider === 'linux' ? linux : sandbox;
}

export function providerInfo() {
  const p = systemProvider();
  return { id: p.id, label: p.label };
}

/* ---------------------------------------------------------------- extras */
function firstLine(s) { return String(s || '').split('\n')[0].trim(); }

const extra = {
  sandbox: {
    packages() {
      return { ok: true, simulated: true, packages: [] };
    },
    perlModules() {
      return { ok: false, simulated: true, packages: [], error: 'Perl inventory requires the Linux provider' };
    },
    binaries(names) {
      return names.map((n) => ({ name: n, path: '', exists: false, version: '' }));
    },
    runImapsync() {
      return { ok: false, simulated: true, output: 'imapsync is not installed in sandbox mode' };
    },
  },
  linux: {
    packages() {
      const dpkg = run('dpkg-query', ['-W', '-f=${Package}\t${Version}\t${Status}\n']);
      if (dpkg.ok) {
        const packages = dpkg.stdout.split('\n').filter(Boolean).map((line) => {
          const [name, version, status] = line.split('\t');
          return { name, version, status: /installed$/.test(status || '') ? 'installed' : 'removed' };
        }).filter((p) => p.status === 'installed');
        return { ok: true, simulated: false, packages };
      }
      const rpm = run('rpm', ['-qa', '--qf', '%{NAME}\t%{VERSION}-%{RELEASE}\n']);
      if (rpm.ok) {
        return { ok: true, simulated: false, packages: rpm.stdout.split('\n').filter(Boolean).map((l) => { const [name, version] = l.split('\t'); return { name, version, status: 'installed' }; }) };
      }
      return { ok: false, simulated: false, packages: [], error: 'Neither dpkg-query nor rpm is available' };
    },
    perlModules() {
      const r = run('perl', ['-MExtUtils::Installed', '-e', 'my $i=ExtUtils::Installed->new(); print join("\\n", map { $_."\\t".$i->version($_) } sort $i->modules());'], 20000);
      if (!r.ok) return { ok: false, simulated: false, packages: [], error: firstLine(r.stderr) || 'perl not installed' };
      const packages = r.stdout.split('\n').filter(Boolean).map((l) => { const [name, version] = l.split('\t'); return { name, version: version || '—' }; });
      return { ok: true, simulated: false, packages };
    },
    binaries(names) {
      return names.map((n) => {
        const which = run('sh', ['-c', `command -v ${n} 2>/dev/null`]);
        if (!which.ok || !which.stdout) return { name: n, path: '', exists: false, version: '' };
        const v = run(n, ['--version']);
        return { name: n, path: which.stdout, exists: true, version: firstLine(v.stdout || v.stderr) };
      });
    },
    runImapsync(args) {
      const r = run('imapsync', args, 120000);
      return { ok: r.ok, simulated: false, output: firstLine(r.stderr) || firstLine(r.stdout) || r.error };
    },
  },
};

const base = { sandbox, linux };
for (const id of Object.keys(base)) Object.assign(base[id], extra[id]);

export function providerExtras() {
  return config.provider === 'linux' ? linux : sandbox;
}
