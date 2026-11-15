#!/usr/bin/env node
// Generate an immutable build descriptor at package/deploy time. Runtime must
// not depend on .git being present in the installation directory.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? String(r.stdout || '').trim() : '';
};
const commit = process.env.OA_COMMIT || run('git', ['rev-parse', 'HEAD']);
const commitDate = run('git', ['log', '-1', '--format=%cI']);
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile()) files.push(full);
  }
}
walk(path.join(root, 'src'));
files.sort();
const hash = crypto.createHash('sha256');
for (const file of files) {
  hash.update(path.relative(root, file).replaceAll(path.sep, '/'));
  hash.update('\0');
  hash.update(fs.readFileSync(file));
  hash.update('\0');
}
const manifestSha256 = hash.digest('hex');
const info = {
  version: pkg.version,
  buildId: commit ? `${pkg.version}+${commit.slice(0, 12)}` : `${pkg.version}+${manifestSha256.slice(0, 12)}`,
  commit: commit || 'unknown',
  commitDate: commitDate || '',
  deployedAt: new Date().toISOString(),
  manifestSha256,
  channel: process.env.OA_UPDATE_CHANNEL || 'stable',
  generatedBy: 'tools/build-info.mjs',
};
const out = path.join(root, 'build-info.json');
fs.writeFileSync(out, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o644 });
console.log(out);
