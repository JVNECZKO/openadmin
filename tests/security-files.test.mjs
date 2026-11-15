// SEC-002, SEC-003, SEC-021, SEC-022 regression tests.
// Every temporary file lives below os.tmpdir(); the repository is untouched.
process.env.OA_IMAP_PORT = '0';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openadmin-security-'));
process.env.OA_DATA_DIR = dataDir;
process.env.OA_PROVIDER = 'sandbox';

const files = await import('../src/features/files.mjs');
const archive = await import('../src/core/archive-utils.mjs');
const appcatalog = await import('../src/appcatalog.mjs');
const nextcloud = await import('../src/nextcloud.mjs');
const wordpress = await import('../src/wordpress.mjs');
const importer = await import('../src/importer.mjs');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'openadmin-security-work-'));

after(() => {
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 3 });
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 });
});

function expectCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return true;
  });
}

function writeTemp(name, content) {
  const file = path.join(work, name);
  fs.writeFileSync(file, content);
  return file;
}

/* ------------------------------------------------------- tar/zip builders */
function tarHeader({ name, size = 0, type = '0', linkname = '', prefix = '', mode = type === '5' ? 0o755 : 0o644 }) {
  const block = Buffer.alloc(512);
  block.write(String(name).slice(0, 99), 0, 'utf8');
  block.write(mode.toString(8).padStart(7, '0') + '\0', 100, 'latin1');
  block.write('0000000\0', 108, 'latin1');
  block.write('0000000\0', 116, 'latin1');
  block.write(size.toString(8).padStart(11, '0') + '\0', 124, 'latin1');
  block.write('00000000000\0', 136, 'latin1');
  block.fill(0x20, 148, 156);
  block[156] = type.charCodeAt(0);
  block.write(String(linkname).slice(0, 99), 157, 'utf8');
  block.write(String(prefix).slice(0, 154), 345, 'utf8');
  block.write('ustar\0', 257, 'latin1');
  block.write('00', 263, 'latin1');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
  return block;
}

function makeTar(entries) {
  const chunks = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data || '');
    chunks.push(tarHeader({ ...entry, size: data.length }));
    if (data.length) {
      chunks.push(data);
      const pad = (512 - (data.length % 512)) % 512;
      if (pad) chunks.push(Buffer.alloc(pad));
    }
  }
  chunks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(chunks));
}

function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data || '');
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.flags || 0, 6);
    local.writeUInt16LE(entry.method || 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const localRecord = Buffer.concat([local, name, data]);
    locals.push(localRecord);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.flags || 0, 8);
    central.writeUInt16LE(entry.method || 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode === undefined ? 0o100644 : entry.mode) << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));
    offset += localRecord.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, eocd]);
}

/* ------------------------------------------------------ SEC-002: resolver */
test('SEC-002 resolver keeps every path inside the tenant home', () => {
  const home = files.homeDir('alice');
  fs.mkdirSync(path.join(home, 'docs'));
  assert.equal(files.resolveUserPath('alice', ''), home);
  assert.equal(files.resolveUserPath('alice', '/home/alice'), home);
  assert.equal(files.resolveUserPath('alice', 'docs'), path.join(home, 'docs'));
  assert.equal(files.resolveUserPath('alice', '/home/alice/docs/'), path.join(home, 'docs'));
  assert.equal(files.displayPath('alice', path.join(home, 'docs')), '/home/alice/docs');
});

test('SEC-002 resolver rejects traversal, encoded separators, wrong tenants and bad types', () => {
  files.homeDir('alice');
  for (const requested of [
    '../../etc/passwd',
    '/home/alice/../../etc/passwd',
    '/home/alice/..%2fetc',
    '/home/bob/private',
    '%2e%2e%2fetc',
    '..%5c..%5cetc',
    '%252e%252e%252fetc',
    '/home/alice/%2e%2e/x',
    'a\\b',
    'a\0b',
  ]) {
    assert.throws(() => files.resolveUserPath('alice', requested), (error) => {
      assert.ok(['PATH_TRAVERSAL', 'PATH_OUTSIDE_TENANT', 'ENCODED_SEPARATOR', 'INVALID_PATH_CHARS'].includes(error.code), `${requested}: ${error.code}`);
      assert.ok(error.status >= 400, `${requested}: status ${error.status}`);
      return true;
    }, `expected rejection for ${requested}`);
  }
  expectCode(() => files.resolveUserPath('alice', 123), 'INVALID_PATH_TYPE');
  expectCode(() => files.resolveUserPath('alice', '/home/alice/' + 'x'.repeat(300)), 'PATH_SEGMENT_TOO_LONG');
});

test('SEC-002 rejects symlinked file and directory outside the home', () => {
  const home = files.homeDir('alice');
  const outside = path.join(dataDir, 'outside-alice');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'top-secret');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(home, 'leak.txt'));
  fs.symlinkSync(outside, path.join(home, 'leak-dir'));
  expectCode(() => files.resolveUserPath('alice', '/home/alice/leak.txt'), 'SYMLINK_ESCAPE');
  expectCode(() => files.resolveUserPath('alice', '/home/alice/leak-dir/secret.txt'), 'SYMLINK_ESCAPE');
  expectCode(() => files.readTenantFile('alice', '/home/alice/leak.txt'), 'SYMLINK_ESCAPE');
  expectCode(() => files.listTenantDir('alice', '/home/alice/leak-dir'), 'SYMLINK_ESCAPE');
  const listed = files.listTenantDir('alice', '/home/alice');
  assert.equal(listed.entries.find((entry) => entry.name === 'leak.txt').unsafe, true);
  assert.equal(listed.entries.find((entry) => entry.name === 'leak-dir').unsafe, true);
});

test('SEC-002 rejects a final symlink for write, delete and rename', () => {
  const home = files.homeDir('alice');
  const outside = path.join(dataDir, 'outside-alice');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'top-secret');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(home, 'write-link.txt'));
  expectCode(() => files.writeTenantFile('alice', '/home/alice/write-link.txt', 'owned'), 'SYMLINK_BLOCKED');
  expectCode(() => files.deleteTenantPath('alice', '/home/alice', 'write-link.txt'), 'SYMLINK_BLOCKED');
  expectCode(() => files.renameTenantPath('alice', '/home/alice', 'write-link.txt', 'moved.txt'), 'SYMLINK_BLOCKED');
  assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'top-secret');
});

test('SEC-002 allows a symlink that stays inside the home', () => {
  const home = files.homeDir('alice');
  fs.mkdirSync(path.join(home, 'inside'), { recursive: true });
  fs.writeFileSync(path.join(home, 'inside', 'note.txt'), 'inside');
  fs.symlinkSync(path.join(home, 'inside'), path.join(home, 'alias'));
  assert.equal(files.readTenantFile('alice', '/home/alice/alias/note.txt').content, 'inside');
  expectCode(() => files.writeTenantFile('alice', '/home/alice/alias/new.txt', 'x', { create: true }), 'SYMLINK_BLOCKED');
});

test('SEC-002 blocks writes through a hard link to a file outside the home', () => {
  const home = files.homeDir('alice');
  const outside = path.join(dataDir, 'outside-alice');
  fs.writeFileSync(path.join(outside, 'hard.txt'), 'hard-secret');
  fs.linkSync(path.join(outside, 'hard.txt'), path.join(home, 'hard.txt'));
  assert.equal(files.readTenantFile('alice', '/home/alice/hard.txt').content, 'hard-secret');
  expectCode(() => files.writeTenantFile('alice', '/home/alice/hard.txt', 'overwritten'), 'HARDLINK_BLOCKED');
  assert.equal(fs.readFileSync(path.join(outside, 'hard.txt'), 'utf8'), 'hard-secret');
});

test('SEC-002 rejects a symlinked account home', () => {
  const target = path.join(dataDir, 'oracle-home');
  fs.mkdirSync(target, { recursive: true });
  fs.symlinkSync(target, path.join(dataDir, 'homes', 'evil'));
  expectCode(() => files.homeDir('evil'), 'HOME_SYMLINK');
});

test('file manager helpers still create, read, list, rename and delete', () => {
  const home = files.homeDir('alice');
  files.createTenantDir('alice', '/home/alice', 'docs2');
  const created = files.writeTenantFile('alice', '/home/alice/docs2/new.txt', 'one', { create: true });
  assert.equal(created.display, '/home/alice/docs2/new.txt');
  expectCode(() => files.writeTenantFile('alice', '/home/alice/docs2/new.txt', 'two', { create: true }), 'ALREADY_EXISTS');
  assert.equal(files.readTenantFile('alice', '/home/alice/docs2/new.txt').content, 'one');
  files.writeTenantFile('alice', '/home/alice/docs2/new.txt', 'two');
  assert.equal(files.readTenantFile('alice', '/home/alice/docs2/new.txt').content, 'two');
  const listing = files.listTenantDir('alice', '/home/alice/docs2');
  assert.equal(listing.entries.find((entry) => entry.name === 'new.txt').size, 3);
  files.renameTenantPath('alice', '/home/alice/docs2', 'new.txt', 'renamed.txt');
  assert.equal(fs.existsSync(path.join(home, 'docs2', 'renamed.txt')), true);
  files.deleteTenantPath('alice', '/home/alice/docs2', 'renamed.txt');
  assert.equal(fs.existsSync(path.join(home, 'docs2', 'renamed.txt')), false);
});

/* ---------------------------------------------------- SEC-022: archives */
test('archive inspection accepts a normal tar and extracts it', () => {
  const tarFile = writeTemp('benign.tar.gz', makeTar([
    { name: 'site', type: '5' },
    { name: 'site/index.html', data: '<h1>ok</h1>' },
    { name: 'site/assets', type: '5' },
    { name: 'site/assets/app.css', data: 'body{}' },
  ]));
  const inspection = archive.inspectArchive(tarFile);
  assert.equal(inspection.ok, true, inspection.error);
  assert.equal(inspection.kind, 'tar');
  assert.equal(archive.validateManifest(inspection).ok, true);
  const dest = path.join(work, 'tar-out');
  const result = archive.safeExtractArchive(tarFile, dest, { kind: 'tar' });
  assert.equal(result.ok, true, result.error);
  assert.equal(fs.readFileSync(path.join(dest, 'site', 'index.html'), 'utf8'), '<h1>ok</h1>');
});

test('SEC-022 rejects malicious tar paths, links and special entries', () => {
  const cases = [
    ['absolute.tar.gz', [{ name: '/etc/passwd', data: 'x' }], 'ARCHIVE_PATH'],
    ['traversal.tar.gz', [{ name: '../outside.txt', data: 'x' }], 'ARCHIVE_PATH'],
    ['prefix-traversal.tar.gz', [{ name: 'outside.txt', prefix: '../..', data: 'x' }], 'ARCHIVE_PATH'],
    ['symlink-absolute.tar.gz', [{ name: 'link', type: '2', linkname: '/etc/passwd' }], 'ARCHIVE_LINK'],
    ['symlink-relative.tar.gz', [{ name: 'link', type: '2', linkname: '../../etc/passwd' }], 'ARCHIVE_LINK'],
    ['hardlink.tar.gz', [{ name: 'hard', type: '1', linkname: '../../etc/passwd' }], 'ARCHIVE_HARDLINK'],
    ['fifo.tar.gz', [{ name: 'fifo', type: '6' }], 'ARCHIVE_SPECIAL'],
    ['char.tar.gz', [{ name: 'char', type: '3' }], 'ARCHIVE_SPECIAL'],
    ['block.tar.gz', [{ name: 'block', type: '4' }], 'ARCHIVE_SPECIAL'],
  ];
  for (const [name, entries, code] of cases) {
    const file = writeTemp(name, makeTar(entries));
    const inspection = archive.inspectArchive(file);
    const result = inspection.ok ? archive.validateManifest(inspection) : inspection;
    assert.equal(result.ok, false, name);
    assert.equal(result.code, code, `${name}: ${result.code} ${result.error}`);
    const dest = path.join(work, 'reject-' + name);
    const extracted = archive.safeExtractArchive(file, dest, { kind: 'tar' });
    assert.equal(extracted.ok, false, name);
    assert.equal(fs.existsSync(dest), false, `${name}: destination must not be created`);
  }
});

test('SEC-022 safe extraction never overwrites a hardlink outside the destination', () => {
  const tarFile = writeTemp('dest-hardlink.tar.gz', makeTar([{ name: 'index.html', data: 'from-archive' }]));
  const outside = path.join(work, 'outside-hardlink.txt');
  fs.writeFileSync(outside, 'outside');
  const dest = path.join(work, 'dest-hardlink');
  fs.mkdirSync(dest);
  fs.linkSync(outside, path.join(dest, 'index.html'));
  const result = archive.safeExtractArchive(tarFile, dest, { kind: 'tar', merge: true });
  assert.equal(result.ok, false);
  assert.ok(['DEST_HARDLINK', 'EXTRACT_HARDLINK'].includes(result.code), result.code);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside');
});

test('SEC-022 safe extraction never writes through a destination symlink', () => {
  const tarFile = writeTemp('dest-symlink.tar.gz', makeTar([{ name: 'index.html', data: 'x' }]));
  const outside = path.join(work, 'outside-dest');
  fs.mkdirSync(outside);
  const link = path.join(work, 'dest-link');
  fs.symlinkSync(outside, link);
  const result = archive.safeExtractArchive(tarFile, link, { kind: 'tar', merge: true });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'DEST_SYMLINK');
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('archive inspection accepts a normal zip and extracts it', () => {
  const zipFile = writeTemp('benign.zip', makeZip([
    { name: 'index.html', data: '<h1>zip</h1>' },
    { name: 'css/', mode: 0o040755 },
    { name: 'css/style.css', data: 'body{}' },
  ]));
  const inspection = archive.inspectArchive(zipFile);
  assert.equal(inspection.ok, true, inspection.error);
  assert.equal(inspection.kind, 'zip');
  const dest = path.join(work, 'zip-out');
  const result = archive.safeExtractArchive(zipFile, dest, { kind: 'zip' });
  assert.equal(result.ok, true, result.error);
  assert.equal(fs.readFileSync(path.join(dest, 'index.html'), 'utf8'), '<h1>zip</h1>');
});

test('SEC-022 rejects malicious zip paths, links and special entries', () => {
  const cases = [
    ['zip-absolute.zip', [{ name: '/etc/passwd', data: 'x' }], 'ARCHIVE_PATH'],
    ['zip-traversal.zip', [{ name: '../outside.txt', data: 'x' }], 'ARCHIVE_PATH'],
    ['zip-symlink.zip', [{ name: 'link', mode: 0o120777, data: '/etc/passwd' }], 'ARCHIVE_LINK'],
    ['zip-fifo.zip', [{ name: 'fifo', mode: 0o010644 }], 'ARCHIVE_SPECIAL'],
    ['zip-char.zip', [{ name: 'char', mode: 0o020644 }], 'ARCHIVE_SPECIAL'],
    ['zip-encrypted.zip', [{ name: 'secret.txt', data: 'x', flags: 0x0001 }], 'ARCHIVE_ENCRYPTED'],
  ];
  for (const [name, entries, code] of cases) {
    const file = writeTemp(name, makeZip(entries));
    const inspection = archive.inspectArchive(file);
    const result = inspection.ok ? archive.validateManifest(inspection) : inspection;
    assert.equal(result.ok, false, name);
    assert.equal(result.code, code, `${name}: ${result.code} ${result.error}`);
    const dest = path.join(work, 'reject-' + name);
    const extracted = archive.safeExtractArchive(file, dest, { kind: 'zip' });
    assert.equal(extracted.ok, false, name);
    assert.equal(fs.existsSync(dest), false, `${name}: destination must not be created`);
  }
});

test('SEC-022 importer detects and extracts a cPanel archive without links', () => {
  const file = writeTemp('cpmove-test.tar.gz', makeTar([
    { name: 'cpmove-test', type: '5' },
    { name: 'cpmove-test/homedir', type: '5' },
    { name: 'cpmove-test/homedir/public_html', type: '5' },
    { name: 'cpmove-test/homedir/public_html/index.html', data: 'imported' },
    { name: 'cpmove-test/dnszones', type: '5' },
    { name: 'cpmove-test/dnszones/example.test.db', data: 'example.test. IN SOA ns.example.test. root.example.test. ( 1 3600 1800 1209600 3600 )' },
  ]));
  assert.equal(importer.detectKind(file).kind, 'cpanel');
  const extracted = importer.extractArchive(file);
  assert.equal(extracted.ok, true, extracted.error);
  assert.equal(fs.readFileSync(path.join(extracted.dir, 'cpmove-test', 'homedir', 'public_html', 'index.html'), 'utf8'), 'imported');
  fs.rmSync(extracted.dir, { recursive: true, force: true });
});

test('SEC-022 importer rejects a tar containing a symlink', () => {
  const file = writeTemp('cpmove-evil.tar.gz', makeTar([
    { name: 'cpmove-evil', type: '5' },
    { name: 'cpmove-evil/homedir', type: '5' },
    { name: 'cpmove-evil/homedir/passwd', type: '2', linkname: '/etc/passwd' },
  ]));
  const result = importer.detectKind(file);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ARCHIVE_LINK');
});

/* --------------------------------- SEC-003, SEC-021: no shell / no argv secrets */
test('SEC-003 validators reject shell metacharacters in identifiers and paths', () => {
  assert.equal(appcatalog.validateAdminUser('admin; touch /tmp/pwn').ok, false);
  assert.equal(appcatalog.validateAdminUser('admin name').ok, false);
  assert.equal(appcatalog.validateAdminUser('admin').ok, true);
  assert.equal(appcatalog.validateDomain('example.com; touch /tmp/pwn').ok, false);
  assert.equal(appcatalog.validateDomain('example.com').ok, true);
  assert.equal(appcatalog.validateInstallPath('/blog/../../etc').ok, false);
  assert.equal(appcatalog.validateInstallPath('/blog%2f..').ok, false);
  assert.equal(appcatalog.validateInstallPath('/blog').ok, true);
  assert.equal(appcatalog.validateAdminPassword('short').ok, false);
  assert.equal(appcatalog.validateAdminPassword("P'; touch /tmp/pwn; #").ok, true);
  assert.equal(appcatalog.validateTitle('T; $(touch /tmp/pwn); `id`').ok, true);
  assert.equal(appcatalog.validateTitle('ok\nInjected: yes').ok, false);
  assert.equal(appcatalog.validateTitle('x'.repeat(121)).ok, false);
});

test('SEC-003 installer argv keeps metacharacters as single arguments and secrets out of argv', () => {
  const title = 'T; $(touch /tmp/openadmin-pwn); `id`';
  const password = "P'; touch /tmp/openadmin-pwn; #";
  const moodle = appcatalog.buildMoodleInvocation({
    wwwroot: 'https://example.com', dataDir: '/srv/data', dbName: 'db', dbPass: password,
    title, domain: 'example.com', adminUser: 'admin', adminPass: password, adminEmail: 'admin@example.com',
  });
  assert.ok(moodle.args.includes(`--fullname=${title}`));
  assert.equal(moodle.args.some((arg) => arg.includes(password)), false);
  assert.equal(moodle.secretArgs.includes(`--dbpass=${password}`), true);
  assert.equal(moodle.secretArgs.includes(`--adminpass=${password}`), true);

  const wrapper = appcatalog.renderPhpArgvWrapper({
    scriptPath: '/srv/app/admin/cli/install.php',
    argv: ['/srv/app/admin/cli/install.php', ...moodle.args, ...moodle.secretArgs],
  });
  assert.match(wrapper, /touch \/tmp\/openadmin-pwn/);
  assert.match(wrapper, /\\'/);
  assert.match(wrapper, /require '\/srv\/app\/admin\/cli\/install\.php';/);

  const nextcl = nextcloud.buildNextcloudInstallInvocation({
    occPath: '/home/alice/domains/example.com/public_html/occ', dbName: 'db', dbPass: password,
    adminUser: 'admin', adminPass: password, dataDir: '/home/alice/data',
  });
  assert.equal(nextcl.args.some((arg) => arg.includes(password)), false);
  assert.equal(nextcl.secretArgs.some((arg) => arg.includes(password)), true);

  const wpConfig = wordpress.buildWordPressConfigInvocation({ root: '/home/alice/domains/example.com/public_html', dbName: 'db', dbUser: 'db' });
  assert.ok(wpConfig.args.includes('--prompt=dbpass'));
  assert.equal(wpConfig.args.some((arg) => arg.includes(password)), false);
  const wpInstall = wordpress.buildWordPressInstallInvocation({
    root: '/home/alice/domains/example.com/public_html', url: 'https://example.com/',
    title, adminUser: 'admin', adminEmail: 'admin@example.com',
  });
  assert.ok(wpInstall.args.includes(`--title=${title}`));
  assert.ok(wpInstall.args.includes('--prompt=admin_password'));
  assert.equal(wpInstall.args.some((arg) => arg.includes(password)), false);
});

test('SEC-003 sources contain no shell string execution', () => {
  for (const file of ['src/appcatalog.mjs', 'src/nextcloud.mjs', 'src/wordpress.mjs']) {
    const source = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
    assert.doesNotMatch(source, /\bspawnSync\s*\(\s*['"](?:sh|bash|zsh|dash)['"]/, `${file}: shell binary`);
    assert.doesNotMatch(source, /['"]-c['"]/, `${file}: shell command string`);
    assert.doesNotMatch(source, /\bexecSync\b|\bexecFileSync\b/, `${file}: sync shell helper`);
    assert.doesNotMatch(source, /\bshell\s*:\s*true/, `${file}: shell option`);
  }
});

test('SEC-021 importer no longer puts MariaDB passwords in argv', () => {
  const mysql = { adminUser: 'root', password: 'p@ss "word"', socket: '/run/mysqld/mysqld.sock', host: '', port: 3306 };
  const defaults = importer.renderMysqlDefaults(mysql);
  assert.match(defaults, /^\[client\]/);
  assert.match(defaults, /password="p@ss \\"word\\""/);
  const args = importer.buildMysqlClientArgs(mysql, '/tmp/openadmin-client.cnf');
  assert.deepEqual(args, ['--defaults-extra-file=/tmp/openadmin-client.cnf', '--socket', '/run/mysqld/mysqld.sock']);
  assert.equal(args.some((arg) => arg.includes(mysql.password)), false);
  assert.equal(args.some((arg) => /^-p/.test(arg)), false);
  const source = fs.readFileSync(path.join(process.cwd(), 'src/importer.mjs'), 'utf8');
  assert.doesNotMatch(source, /-p\$\{|args\.push\(['"]-p/);
  assert.doesNotMatch(source, /\bspawnSync\s*\(\s*['"]sh['"]/);
});

/* ----------------------------------------------------------- SEC-024 note */
test('SEC-024 plain FTP backup is not silently accepted by the files module', () => {
  // The Backup Center lives outside this module's ownership. This assertion
  // documents that the file/FTP account manager does not create plaintext FTP
  // backup destinations; the report names the owner file for the fix.
  const source = fs.readFileSync(path.join(process.cwd(), 'src/features/files.mjs'), 'utf8');
  assert.doesNotMatch(source, /ftp:\/\//);
});
