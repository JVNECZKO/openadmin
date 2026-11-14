// Panel and OS update center.
//
// Applying a panel update is a durable ten-stage job:
// download -> verify -> compatibility -> backup -> staging -> dependencies ->
// migrations -> restart -> smoke -> commit/rollback. The release must ship an
// Ed25519-signed manifest; the public key is pinned out-of-band (environment
// variable or panel setting), never fetched from the update channel (SEC-005).
// Unsigned releases are refused unless an operator explicitly opts in.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { config, VERSION } from './config.mjs';
import { setting, setSetting, audit, nowIso, getDb, get, all } from './db.mjs';
import { which, isRoot } from './sys.mjs';
import {
  appendJobEventExternally,
  createJob,
  executeJobById,
  finishJobExternally,
  hashDirectory,
  jobView,
  listJobViews,
  registerJobHandler,
  safeExtractTar,
  setJobStageExternally,
  sha256File,
  stableStringify,
} from './backups.mjs';

const REPO = 'JVNECZKO/openadmin';
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export const UPDATE_STAGES = [
  { key: 'download', label: 'Download signed manifest and archive' },
  { key: 'verify', label: 'Verify signature and SHA-256' },
  { key: 'compatibility', label: 'Compatibility check' },
  { key: 'backup', label: 'Backup files and database' },
  { key: 'staging', label: 'Extract into staging' },
  { key: 'dependencies', label: 'Resolve dependencies' },
  { key: 'migrations', label: 'Syntax checks and database migrations' },
  { key: 'restart', label: 'Restart the panel' },
  { key: 'smoke', label: 'Post-restart smoke tests' },
  { key: 'commit', label: 'Commit' },
];

/* -------------------------------------------------------------------------- */
/* Versions and build diagnostics                                             */
/* -------------------------------------------------------------------------- */

export function cmp(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

function semver(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(value || '').trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), text: `${match[1]}.${match[2]}.${match[3]}` };
}

function nodeSatisfies(requirement, version = process.versions.node) {
  if (!requirement) return { ok: true, requirement: '' };
  const text = String(requirement).trim();
  const match = /^(>=|>|<=|<|=)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(text);
  if (!match) return { ok: false, error: `Unsupported Node requirement syntax: ${text}` };
  const wanted = [Number(match[2] || 0), Number(match[3] || 0), Number(match[4] || 0)];
  const actual = String(version).split('.').map(Number);
  let comparison = 0;
  for (let i = 0; i < 3; i += 1) {
    if ((actual[i] || 0) !== wanted[i]) { comparison = (actual[i] || 0) - wanted[i]; break; }
  }
  const op = match[1] || '>=';
  const ok = op === '>=' ? comparison >= 0 : op === '>' ? comparison > 0 : op === '<=' ? comparison <= 0 : op === '<' ? comparison < 0 : comparison === 0;
  return { ok, requirement: text, actual: version };
}

export function updateChannel() {
  return String(process.env.OA_UPDATE_CHANNEL || setting('update_channel', 'stable') || 'stable');
}

let assetsCache = null;

export function assetsHash() {
  if (assetsCache && Date.now() - assetsCache.at < 60000) return assetsCache.value;
  try {
    const tree = hashDirectory(path.join(config.root, 'src', 'public'));
    const value = { sha256: tree.sha256, files: tree.files, bytes: tree.bytes };
    assetsCache = { at: Date.now(), value };
    return value;
  } catch (error) {
    return { sha256: '', files: 0, bytes: 0, error: error.message };
  }
}

export function schemaInfo() {
  try {
    const rows = all("SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' ORDER BY name");
    const digest = crypto.createHash('sha256').update(stableStringify(rows)).digest('hex');
    return {
      tables: rows.filter((row) => row.type === 'table').length,
      indexes: rows.filter((row) => row.type === 'index').length,
      hash: digest.slice(0, 16),
      version: setting('db_schema_version', '1'),
    };
  } catch (error) {
    return { tables: 0, indexes: 0, hash: '', version: setting('db_schema_version', '1'), error: error.message };
  }
}

function gitInfo() {
  try {
    const commit = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: config.root, encoding: 'utf8', timeout: 5000 });
    const date = spawnSync('git', ['log', '-1', '--format=%cI'], { cwd: config.root, encoding: 'utf8', timeout: 5000 });
    return {
      commit: commit.status === 0 ? (commit.stdout || '').trim() : '',
      commitDate: date.status === 0 ? (date.stdout || '').trim() : '',
      dirty: spawnSync('git', ['status', '--porcelain'], { cwd: config.root, encoding: 'utf8', timeout: 5000 }).stdout?.trim().length > 0,
    };
  } catch {
    return { commit: '', commitDate: '', dirty: null };
  }
}

export function buildInfo() {
  const git = gitInfo();
  const assets = assetsHash();
  const schema = schemaInfo();
  let deployedAt = setting('panel_deployed_at', '');
  if (!deployedAt) {
    try { deployedAt = fs.statSync(path.join(config.root, 'src', 'server.mjs')).mtime.toISOString(); } catch { deployedAt = ''; }
  }
  const commit = process.env.OA_COMMIT || git.commit || '';
  return {
    version: VERSION,
    buildId: process.env.OA_BUILD_ID || (commit ? `${VERSION}+${commit}` : VERSION),
    commit,
    commitDate: git.commitDate || '',
    dirty: git.dirty,
    deployedAt,
    channel: updateChannel(),
    schema,
    assets,
    node: process.versions.node,
    platform: `${process.platform}/${process.arch}`,
    provider: config.provider,
    root: config.root,
    startedAt: STARTED_AT,
    updateKeys: pinnedKeyStatus(),
    lastUpdate: setting('panel_last_update', ''),
    lastUpdateVersion: setting('panel_last_update_version', ''),
  };
}

const STARTED_AT = nowIso();

export function diagnosticsText() {
  const info = buildInfo();
  const lines = [
    `OpenAdmin diagnostics`,
    `generated: ${nowIso()}`,
    `version: ${info.version}`,
    `build: ${info.buildId}`,
    `commit: ${info.commit || 'unknown'}${info.commitDate ? ` (${info.commitDate})` : ''}`,
    `deployed: ${info.deployedAt || 'unknown'}`,
    `channel: ${info.channel}`,
    `schema: v${info.schema.version}, ${info.schema.tables} tables, hash ${info.schema.hash}`,
    `assets: ${info.assets.files} files, sha256 ${info.assets.sha256}`,
    `node: ${info.node} ${info.platform}`,
    `provider: ${info.provider}`,
    `pinned update keys: ${info.updateKeys.count}${info.updateKeys.errors.length ? ` (errors: ${info.updateKeys.errors.join('; ')})` : ''}`,
    `last update: ${info.lastUpdate || 'never'}${info.lastUpdateVersion ? ` -> ${info.lastUpdateVersion}` : ''}`,
  ];
  return lines.join('\n');
}

export function updateInfo() {
  return {
    current: VERSION,
    lastPanel: setting('panel_last_update', ''),
    lastOs: setting('os_last_update', ''),
    build: buildInfo(),
    diagnostics: diagnosticsText(),
    jobs: listJobViews({ kinds: ['update.panel'], limit: 5 }),
    pending: pendingUpdateFiles().map((file) => {
      const parsed = parseJson(fs.readFileSync(file, 'utf8'), null);
      return { file: path.basename(file), jobId: parsed?.jobId, phase: parsed?.phase, version: parsed?.manifest?.version, created: parsed?.createdAt };
    }),
  };
}

function parseJson(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

/* -------------------------------------------------------------------------- */
/* Signed manifests (SHA-256 + Ed25519, pinned key)                           */
/* -------------------------------------------------------------------------- */

function parsePinnedKeyEntry(text) {
  const line = String(text || '').trim();
  if (!line) return null;
  let keyId = 'default';
  let value = line;
  const withId = /^([A-Za-z0-9_.-]{1,64})=(.{40,})$/.exec(line);
  if (withId) {
    keyId = withId[1];
    value = withId[2].trim();
  }
  try {
    if (value.includes('BEGIN PUBLIC KEY')) {
      return { keyId, key: crypto.createPublicKey(value) };
    }
    const buffer = Buffer.from(value, 'base64');
    if (buffer.length === 32) {
      return { keyId, key: crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, buffer]), format: 'der', type: 'spki' }) };
    }
    return { keyId, key: crypto.createPublicKey({ key: buffer, format: 'der', type: 'spki' }) };
  } catch (error) {
    return { keyId, error: error.message };
  }
}

export function pinnedUpdateKeys() {
  const envValue = process.env.OA_UPDATE_PUBLIC_KEY || '';
  const settingValue = setting('update_public_key', '') || '';
  const raw = envValue || settingValue;
  const source = envValue ? 'environment' : settingValue ? 'setting' : 'none';
  if (!raw) return { keys: [], errors: [], source, configured: false };
  const entries = [];
  const errors = [];
  const trimmed = String(raw).trim();
  if (trimmed.startsWith('[')) {
    const parsed = parseJson(trimmed, []);
    for (const item of Array.isArray(parsed) ? parsed : []) {
      if (typeof item === 'string') entries.push(item);
      else if (item && item.publicKey) entries.push(item.keyId ? `${item.keyId}=${item.publicKey}` : item.publicKey);
      else if (item && item.key) entries.push(item.keyId ? `${item.keyId}=${item.key}` : item.key);
    }
  } else {
    entries.push(...trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  }
  const keys = [];
  for (const entry of entries) {
    const parsed = parsePinnedKeyEntry(entry);
    if (!parsed) continue;
    if (parsed.error) { errors.push(`${parsed.keyId}: ${parsed.error}`); continue; }
    keys.push(parsed);
  }
  return { keys, errors, source, configured: keys.length > 0 };
}

export function pinnedKeyStatus() {
  const pinned = pinnedUpdateKeys();
  return {
    configured: pinned.configured,
    count: pinned.keys.length,
    source: pinned.source,
    keyIds: pinned.keys.map((entry) => entry.keyId),
    errors: pinned.errors,
    allowUnsigned: updateAllowsUnsigned(),
  };
}

function canonicalManifest(manifest) {
  const copy = { ...(manifest || {}) };
  delete copy.signature;
  return stableStringify(copy);
}

function signatureValue(manifest) {
  const signature = manifest?.signature;
  if (!signature) return null;
  if (typeof signature === 'string') return { algorithm: 'ed25519', keyId: '', value: signature.trim() };
  if (typeof signature === 'object' && signature.value) {
    return { algorithm: String(signature.algorithm || 'ed25519').toLowerCase(), keyId: String(signature.keyId || ''), value: String(signature.value).trim() };
  }
  return null;
}

export function updateAllowsUnsigned() {
  return process.env.OA_UPDATE_ALLOW_UNSIGNED === '1' || setting('update_allow_unsigned', '0') === '1';
}

/**
 * Verify a release manifest. Refuses unsigned manifests unless the operator
 * explicitly opted in; a pinned key is always required for a signed manifest.
 */
export function verifyUpdateManifest(manifest, { publicKeys = null, allowUnsigned = updateAllowsUnsigned() } = {}) {
  if (!manifest || typeof manifest !== 'object') return { ok: false, code: 'invalid_manifest', error: 'Manifest is missing or not an object' };
  if (manifest.product && String(manifest.product).toLowerCase() !== 'openadmin') {
    return { ok: false, code: 'wrong_product', error: `Manifest belongs to ${manifest.product}` };
  }
  if (!semver(manifest.version)) return { ok: false, code: 'invalid_version', error: 'Manifest has no valid version' };
  if (!/^[a-f0-9]{64}$/i.test(String(manifest.sha256 || ''))) {
    return { ok: false, code: 'invalid_sha256', error: 'Manifest has no valid archive SHA-256' };
  }
  if (!manifest.releaseUrl && !manifest.url) return { ok: false, code: 'missing_release_url', error: 'Manifest has no release URL' };
  const signature = signatureValue(manifest);
  if (!signature) {
    if (allowUnsigned) {
      return { ok: true, unsigned: true, insecure: true, code: 'unsigned_accepted', warning: 'Unsigned update accepted because update_allow_unsigned=1' };
    }
    return {
      ok: false,
      code: 'unsigned',
      error: 'Release manifest is unsigned. Signed manifests are required by default (SEC-005); set OA_UPDATE_ALLOW_UNSIGNED=1 only for a controlled migration.',
    };
  }
  if (String(signature.algorithm || '').toLowerCase() !== 'ed25519') {
    return { ok: false, code: 'unsupported_algorithm', error: `Unsupported signature algorithm: ${signature.algorithm}` };
  }
  let keys;
  if (publicKeys) {
    keys = publicKeys.map((entry) => (typeof entry === 'string' ? parsePinnedKeyEntry(entry) : entry)).filter(Boolean);
  } else {
    keys = pinnedUpdateKeys().keys;
  }
  if (!keys.length) {
    return {
      ok: false,
      code: 'no_pinned_key',
      error: 'No pinned update public key is configured. Set OA_UPDATE_PUBLIC_KEY (or setting update_public_key) out-of-band before applying updates.',
    };
  }
  const canonical = canonicalManifest(manifest);
  let signatureBytes;
  try { signatureBytes = Buffer.from(signature.value, 'base64'); } catch { return { ok: false, code: 'invalid_signature', error: 'Signature is not valid base64' }; }
  const candidates = signature.keyId ? keys.filter((entry) => entry.keyId === signature.keyId) : keys;
  if (!candidates.length) return { ok: false, code: 'unknown_key', error: `Manifest is signed by unknown key ${signature.keyId}` };
  for (const entry of candidates) {
    if (entry.error || !entry.key) continue;
    try {
      if (crypto.verify(null, Buffer.from(canonical, 'utf8'), entry.key, signatureBytes)) {
        return { ok: true, unsigned: false, keyId: entry.keyId, algorithm: 'ed25519', canonicalSha256: crypto.createHash('sha256').update(canonical).digest('hex') };
      }
    } catch { /* try the next pinned key */ }
  }
  return { ok: false, code: 'invalid_signature', error: 'Manifest signature does not match any pinned update key' };
}

/* -------------------------------------------------------------------------- */
/* Manifest / artifact acquisition                                            */
/* -------------------------------------------------------------------------- */

function secureUrl(url, { allowInsecure = process.env.OA_UPDATE_ALLOW_INSECURE === '1' } = {}) {
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol === 'https:') return { ok: true, url: parsed.toString() };
    if (parsed.protocol === 'http:' && (allowInsecure || ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(parsed.hostname))) {
      return { ok: true, url: parsed.toString(), insecure: true };
    }
    if (parsed.protocol === 'file:') return { ok: false, code: 'file_url_refused', error: 'file:// update sources are refused' };
    return { ok: false, code: 'insecure_url', error: `Update URL must use HTTPS: ${parsed.protocol}` };
  } catch {
    return { ok: false, code: 'invalid_url', error: `Invalid update URL: ${url}` };
  }
}

async function fetchText(url, { timeout = 20000, maxBytes = 4 * 1024 * 1024, optional = false } = {}) {
  const checked = secureUrl(url);
  if (!checked.ok) throw Object.assign(new Error(checked.error), { code: checked.code });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { headers: { 'user-agent': `OpenAdmin/${VERSION}` }, signal: controller.signal, redirect: 'follow' });
    if (!response.ok) {
      if (optional && response.status === 404) return null;
      throw Object.assign(new Error(`HTTP ${response.status} for ${url}`), { status: response.status });
    }
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared && declared > maxBytes) throw Object.assign(new Error('Manifest/signature is unexpectedly large'), { code: 'too_large' });
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) throw Object.assign(new Error('Manifest/signature is unexpectedly large'), { code: 'too_large' });
    return text;
  } finally {
    clearTimeout(timer);
  }
}

export function manifestUrls() {
  const explicit = String(process.env.OA_UPDATE_MANIFEST_URL || setting('update_manifest_url', '') || '').trim();
  const signature = String(process.env.OA_UPDATE_SIGNATURE_URL || setting('update_signature_url', '') || '').trim();
  return { manifest: explicit, signature: signature || (explicit ? `${explicit}.sig` : '') };
}

async function releaseMetadata(channel = updateChannel()) {
  const endpoint = channel === 'stable'
    ? `https://api.github.com/repos/${REPO}/releases/latest`
    : `https://api.github.com/repos/${REPO}/releases?per_page=5`;
  const response = await fetch(endpoint, { headers: { 'user-agent': 'OpenAdmin-update-check', accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw Object.assign(new Error(`GitHub HTTP ${response.status}`), { status: response.status });
  const json = await response.json();
  if (Array.isArray(json)) return json.find((entry) => channel === 'beta' || !entry.prerelease) || json[0] || null;
  return json;
}

/** Resolve where the signed manifest should come from. */
export async function resolveManifestSource({ channel = updateChannel(), release = null } = {}) {
  const explicit = manifestUrls();
  if (explicit.manifest) {
    return {
      kind: 'url',
      channel,
      manifestUrl: secureUrl(explicit.manifest).ok ? explicit.manifest : null,
      signatureUrl: explicit.signature ? (secureUrl(explicit.signature).ok ? explicit.signature : null) : null,
      release: null,
      error: secureUrl(explicit.manifest).ok ? '' : secureUrl(explicit.manifest).error,
    };
  }
  const meta = release || await releaseMetadata(channel);
  if (!meta) return { kind: 'missing', channel, error: 'No release metadata available', release: null };
  const assets = Array.isArray(meta.assets) ? meta.assets : [];
  const manifestAsset = assets.find((asset) => /(?:^|[/_.-])(?:openadmin-)?manifest\.json$/i.test(asset.name))
    || assets.find((asset) => /manifest\.json$/i.test(asset.name));
  const signatureAsset = assets.find((asset) => /manifest\.json\.(?:sig|signature)$/i.test(asset.name))
    || assets.find((asset) => /\.sig$/i.test(asset.name));
  const releaseInfo = {
    tag: meta.tag_name || '',
    version: String(meta.tag_name || '').replace(/^v/, ''),
    notes: meta.body || '',
    published: meta.published_at || '',
    url: meta.tarball_url || `https://codeload.github.com/${REPO}/tar.gz/refs/heads/main`,
    prerelease: !!meta.prerelease,
  };
  if (!manifestAsset) {
    return { kind: 'missing', channel, release: releaseInfo, error: `Release ${releaseInfo.version || releaseInfo.tag} has no signed manifest asset (openadmin-manifest.json). Refusing unsigned update.` };
  }
  return {
    kind: 'github',
    channel,
    manifestUrl: manifestAsset.browser_download_url,
    signatureUrl: signatureAsset?.browser_download_url || null,
    release: releaseInfo,
    error: '',
  };
}

function signatureFromText(text) {
  if (!text) return null;
  const parsed = parseJson(text, null);
  if (parsed && typeof parsed === 'object') return parsed;
  const trimmed = String(text).trim();
  if (!trimmed) return null;
  return trimmed;
}

export async function loadSignedManifest({ channel = updateChannel(), source = null } = {}) {
  const resolved = source || await resolveManifestSource({ channel });
  if (!resolved.manifestUrl) return { ok: false, code: 'no_signed_manifest', error: resolved.error || 'No signed manifest is available', source: resolved };
  let text;
  try {
    text = await fetchText(resolved.manifestUrl);
  } catch (error) {
    return { ok: false, code: 'manifest_download_failed', error: error.message, source: resolved };
  }
  let manifest;
  try { manifest = JSON.parse(text); } catch (error) {
    return { ok: false, code: 'invalid_manifest', error: `Manifest is not valid JSON: ${error.message}`, source: resolved };
  }
  if (!manifest.signature && resolved.signatureUrl) {
    try {
      const sigText = await fetchText(resolved.signatureUrl, { optional: true });
      const signature = signatureFromText(sigText);
      if (signature) manifest.signature = typeof signature === 'object' ? signature : { algorithm: 'ed25519', value: signature };
    } catch (error) {
      return { ok: false, code: 'signature_download_failed', error: error.message, source: resolved };
    }
  }
  return { ok: true, manifest, source: resolved };
}

export async function checkCompatibility(manifest, { currentVersion = VERSION, channel = updateChannel() } = {}) {
  const checks = [];
  const add = (id, status, detail) => checks.push({ id, status, detail });
  if (!manifest || typeof manifest !== 'object') return { ok: false, code: 'invalid_manifest', checks, error: 'Manifest missing' };
  add('product', manifest.product && String(manifest.product).toLowerCase() === 'openadmin' ? 'ok' : 'fail', `product=${manifest.product || '?'}`);
  const version = semver(manifest.version);
  add('version', version ? 'ok' : 'fail', `version=${manifest.version || '?'}`);
  const newer = version ? cmp(version.text, currentVersion) > 0 : false;
  add('newer', newer ? 'ok' : 'fail', `installed=${currentVersion}; manifest=${version?.text || '?'}`);
  if (manifest.requires?.node) {
    const node = nodeSatisfies(manifest.requires.node);
    add('node', node.ok ? 'ok' : 'fail', `requires=${manifest.requires.node}; running=${node.actual}`);
  } else {
    add('node', 'ok', `running=${process.versions.node}`);
  }
  if (manifest.requires?.minPanelVersion) {
    const min = semver(manifest.requires.minPanelVersion);
    add('minPanelVersion', min && cmp(currentVersion, min.text) >= 0 ? 'ok' : 'fail', `requires >=${manifest.requires.minPanelVersion}; installed=${currentVersion}`);
  }
  if (manifest.channel && !['stable', 'beta', channel].includes(String(manifest.channel))) {
    add('channel', 'fail', `manifest channel=${manifest.channel}; configured=${channel}`);
  } else {
    add('channel', 'ok', `channel=${manifest.channel || channel}`);
  }
  const size = Number(manifest.size || 0);
  add('archive-size', size > 0 && size <= MAX_ARCHIVE_BYTES ? 'ok' : 'fail', `size=${size} bytes (max ${MAX_ARCHIVE_BYTES})`);
  const release = secureUrl(manifest.releaseUrl || manifest.url || '');
  add('release-url', release.ok ? 'ok' : 'fail', release.ok ? String(manifest.releaseUrl || manifest.url) : release.error);
  if (Array.isArray(manifest.files) && manifest.files.length) {
    const bad = manifest.files.filter((file) => !file || !file.path || !/^[a-f0-9]{64}$/i.test(String(file.sha256 || '')) || /^\//.test(file.path) || file.path.split('/').includes('..'));
    add('file-manifest', bad.length ? 'fail' : 'ok', `${manifest.files.length} file hashes, ${bad.length} invalid`);
  } else {
    add('file-manifest', 'warn', 'manifest has no per-file hashes; only the archive SHA-256 can be verified');
  }
  try {
    const stat = fs.statfsSync(config.dataDir);
    const free = Number(stat.bavail) * Number(stat.bsize);
    const required = Math.max(size * 3, 64 * 1024 * 1024);
    add('disk', free >= required ? 'ok' : 'fail', `free=${(free / 1024 / 1024).toFixed(0)} MB, needed=${(required / 1024 / 1024).toFixed(0)} MB`);
  } catch {
    add('disk', 'warn', 'free space could not be measured');
  }
  const failed = checks.filter((check) => check.status === 'fail');
  return {
    ok: failed.length === 0,
    code: failed.length ? 'incompatible' : 'ok',
    checks,
    errors: failed.map((check) => `${check.id}: ${check.detail}`),
    version: version?.text || '',
    currentVersion,
    channel,
  };
}

async function downloadArchive(manifest, destination, { timeout = 300000 } = {}) {
  const url = secureUrl(manifest.releaseUrl || manifest.url || '');
  if (!url.ok) throw Object.assign(new Error(url.error), { code: url.code });
  const expected = String(manifest.sha256).toLowerCase();
  const maxBytes = Math.min(MAX_ARCHIVE_BYTES, Number(manifest.size || MAX_ARCHIVE_BYTES) + 1024 * 1024);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url.url, { headers: { 'user-agent': `OpenAdmin/${VERSION}` }, signal: controller.signal, redirect: 'follow' });
    if (!response.ok) throw Object.assign(new Error(`Download failed: HTTP ${response.status}`), { status: response.status });
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared && declared > maxBytes) throw Object.assign(new Error('Release archive is larger than the signed manifest allows'), { code: 'too_large' });
    const temp = `${destination}.part-${process.pid}`;
    let received = 0;
    const source = Readable.fromWeb(response.body);
    source.on('data', (chunk) => {
      received += chunk.length;
      if (received > maxBytes) source.destroy(Object.assign(new Error('Release archive exceeded its signed size'), { code: 'too_large' }));
    });
    await pipeline(source, fs.createWriteStream(temp, { mode: 0o600 }));
    fs.renameSync(temp, destination);
    const sha256 = sha256File(destination);
    if (sha256 !== expected) {
      fs.rmSync(destination, { force: true });
      throw Object.assign(new Error(`Archive SHA-256 mismatch: expected ${expected}, got ${sha256}`), { code: 'integrity_mismatch' });
    }
    return { file: destination, sha256, bytes: fs.statSync(destination).size };
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------------------------------------- */
/* Update jobs                                                                */
/* -------------------------------------------------------------------------- */

function updatesDir() {
  const dir = path.join(config.dataDir, 'updates');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function pendingUpdateFiles() {
  const dir = path.join(config.dataDir, 'updates');
  try {
    return fs.readdirSync(dir).filter((name) => /^pending-.*\.json$/.test(name)).map((name) => path.join(dir, name));
  } catch { return []; }
}

function pendingFile(jobId) {
  return path.join(updatesDir(), `pending-${Number(jobId)}.json`);
}

function writePending(jobId, state) {
  const file = pendingFile(jobId);
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
  return file;
}

function readPending(file) {
  try { return parseJson(fs.readFileSync(file, 'utf8'), null); } catch { return null; }
}

function applyGuard() {
  if (process.env.OA_UPDATE_ALLOW_SANDBOX === '1') return { ok: true, simulated: true };
  if (config.provider !== 'linux') {
    return { ok: false, code: 'sandbox_provider', error: 'Applying panel updates is disabled in sandbox mode. Use a Linux installation, or set OA_UPDATE_ALLOW_SANDBOX=1 for an isolated test installation.' };
  }
  if (!isRoot()) return { ok: false, code: 'permission_denied', error: 'Panel updates must run as root (or through the signed updater service).' };
  return { ok: true, simulated: false };
}

function installBackup(jobId) {
  const dir = updatesDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `backup-${stamp}.tar.gz`);
  const targets = ['src', 'bin', 'package.json', 'package-lock.json'].filter((name) => fs.existsSync(path.join(config.root, name)));
  if (!targets.includes('src')) throw Object.assign(new Error('Panel source tree is missing; refusing update'), { code: 'invalid_install' });
  const tar = spawnSync('tar', ['-czf', file, '-C', config.root, ...targets], { encoding: 'utf8', timeout: 300000, maxBuffer: 32 * 1024 * 1024 });
  if (tar.status !== 0) throw Object.assign(new Error(`File backup failed: ${(tar.stderr || '').trim()}`), { code: 'backup_failed' });
  const sha256 = sha256File(file);
  const dbFile = path.join(dir, `db-${stamp}.db`);
  const escaped = dbFile.replace(/'/g, "''");
  getDb().exec(`VACUUM INTO '${escaped}'`);
  const dbSha = sha256File(dbFile);
  return { file, sha256, bytes: fs.statSync(file).size, dbFile, dbSha256: dbSha, targets, jobId };
}

function findAppRoot(stagingRoot) {
  if (fs.existsSync(path.join(stagingRoot, 'src', 'server.mjs'))) return stagingRoot;
  let entries = [];
  try { entries = fs.readdirSync(stagingRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()); } catch { return null; }
  for (const entry of entries) {
    const candidate = path.join(stagingRoot, entry.name);
    if (fs.existsSync(path.join(candidate, 'src', 'server.mjs'))) return candidate;
  }
  return null;
}

function verifyManifestFiles(appRoot, manifest) {
  const problems = [];
  if (!Array.isArray(manifest.files) || !manifest.files.length) return problems;
  for (const entry of manifest.files) {
    const rel = String(entry?.path || '');
    if (!rel || rel.startsWith('/') || rel.split('/').includes('..')) { problems.push(`${rel || '?'}: unsafe path`); continue; }
    const target = path.join(appRoot, rel);
    const resolved = path.resolve(target);
    if (!resolved.startsWith(path.resolve(appRoot) + path.sep) && resolved !== path.resolve(appRoot)) { problems.push(`${rel}: escapes staging`); continue; }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) { problems.push(`${rel}: missing`); continue; }
    if (sha256File(resolved) !== String(entry.sha256).toLowerCase()) problems.push(`${rel}: sha256 mismatch`);
    if (problems.length > 8) break;
  }
  return problems;
}

function prepareApplyTree(stagedRoot, jobId) {
  const target = path.join(config.root, `.openadmin-update-${Number(jobId)}`);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const name of ['src', 'bin', 'package.json', 'package-lock.json', 'node_modules']) {
    const source = path.join(stagedRoot, name);
    if (!fs.existsSync(source)) continue;
    fs.cpSync(source, path.join(target, name), { recursive: true, preserveTimestamps: true });
  }
  if (!fs.existsSync(path.join(target, 'src', 'server.mjs'))) throw Object.assign(new Error('Staged tree has no src/server.mjs'), { code: 'invalid_release' });
  return target;
}

function swapInstall(targetRoot, jobId) {
  const oldRoot = path.join(config.root, `.openadmin-old-${Number(jobId)}`);
  fs.rmSync(oldRoot, { recursive: true, force: true });
  fs.mkdirSync(oldRoot, { recursive: true, mode: 0o700 });
  const swapped = [];
  try {
    for (const name of ['node_modules', 'src', 'bin', 'package.json', 'package-lock.json']) {
      const incoming = path.join(targetRoot, name);
      if (!fs.existsSync(incoming)) continue;
      const installed = path.join(config.root, name);
      if (fs.existsSync(installed)) {
        fs.renameSync(installed, path.join(oldRoot, name));
      }
      fs.renameSync(incoming, installed);
      swapped.push(name);
    }
    return { ok: true, oldRoot, swapped };
  } catch (error) {
    for (const swap of [...swapped].reverse()) {
      const installed = path.join(config.root, swap);
      try {
        if (fs.existsSync(installed)) fs.renameSync(installed, path.join(targetRoot, swap));
      } catch { /* ignore */ }
      const previous = path.join(oldRoot, swap);
      if (fs.existsSync(previous)) {
        try { fs.renameSync(previous, installed); } catch { /* ignore */ }
      }
    }
    throw Object.assign(new Error(`File swap failed: ${error.message}`), { code: 'swap_failed' });
  }
}

function rollbackInstall(state) {
  const oldRoot = state.oldRoot;
  const applied = Array.isArray(state.swapped) ? state.swapped : [];
  const errors = [];
  for (const swap of [...applied].reverse()) {
    const installed = path.join(config.root, swap);
    const previous = path.join(oldRoot, swap);
    try {
      if (fs.existsSync(installed)) fs.rmSync(installed, { recursive: true, force: true });
      if (fs.existsSync(previous)) fs.renameSync(previous, installed);
    } catch (error) {
      errors.push(`${swap}: ${error.message}`);
    }
  }
  return { ok: !errors.length, errors };
}

function detectSystemdUnit() {
  if (config.provider !== 'linux') return null;
  for (const unit of ['openadmin', 'openadmin.service', 'openadmin-panel']) {
    const active = spawnSync('systemctl', ['is-active', '--quiet', unit], { encoding: 'utf8', timeout: 5000 });
    if (active.status === 0) return unit;
  }
  return null;
}

function scheduleProcessRestart() {
  const unit = detectSystemdUnit();
  if (unit) {
    const child = spawn('systemctl', ['restart', unit], { detached: true, stdio: 'ignore' });
    child.unref();
    return { mode: 'systemd', unit };
  }
  const helper = `
const { spawn } = require('node:child_process');
const pid = Number(process.argv[1]);
const root = process.argv[2];
const wait = () => {
  try { process.kill(pid, 0); setTimeout(wait, 250); }
  catch {
    const child = spawn(process.execPath, [root + '/src/server.mjs'], { cwd: root, detached: true, stdio: 'ignore', env: process.env });
    child.unref();
  }
};
wait();
`;
  const child = spawn(process.execPath, ['-e', helper, String(process.pid), config.root], {
    detached: true, stdio: 'ignore', env: { ...process.env, OA_DATA_DIR: config.dataDir },
  });
  child.unref();
  return { mode: 'self-restart', helperPid: child.pid };
}

async function hangForRestart() {
  // The process is expected to be replaced within seconds. If it is not (e.g.
  // no service manager and the helper failed), fail loudly instead of marking a
  // half-applied update as successful.
  await new Promise((resolve) => setTimeout(resolve, 120000));
  throw new Error('Panel restart did not happen within 120 seconds');
}

async function pollHealth({ port = config.port, expectedVersion = null, timeoutMs = 90000 } = {}) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(3000) });
      if (response.ok) {
        const json = await response.json();
        last = json;
        if (!expectedVersion || String(json.version) === String(expectedVersion)) {
          return { ok: true, health: json, attempts: Math.ceil((Date.now() - started) / 1000) };
        }
      }
    } catch (error) {
      last = { error: error.message };
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return { ok: false, error: `health check did not pass within ${Math.round(timeoutMs / 1000)}s`, last };
}

async function smokePanelUpdate(state, { simulated = false } = {}) {
  const checks = [];
  const add = (id, status, detail) => checks.push({ id, status, detail });
  const manifest = state.manifest || {};
  const packageFile = path.join(config.root, 'package.json');
  let installedVersion = '';
  try { installedVersion = parseJson(fs.readFileSync(packageFile, 'utf8'), {})?.version || ''; } catch { /* ignore */ }
  add('package.json', installedVersion === manifest.version ? 'ok' : 'fail', `installed=${installedVersion}; expected=${manifest.version}`);
  let health = null;
  if (!simulated) {
    const polled = await pollHealth({ port: state.port || config.port, expectedVersion: manifest.version });
    health = polled.health || polled.last;
    add('health', polled.ok ? 'ok' : 'fail', polled.ok ? `version=${health.version}` : polled.error);
  } else {
    add('health', 'skipped', 'restart simulated (OA_UPDATE_SKIP_RESTART=1)');
  }
  const fileProblems = verifyManifestFiles(config.root, manifest);
  add('files', fileProblems.length ? 'fail' : 'ok', fileProblems.length ? fileProblems.slice(0, 3).join('; ') : 'all signed file hashes match');
  if (manifest.assetsHash) {
    const current = assetsHash().sha256;
    add('assets', current === manifest.assetsHash ? 'ok' : 'fail', `installed=${current.slice(0, 16)}; expected=${String(manifest.assetsHash).slice(0, 16)}`);
  } else {
    add('assets', 'warn', 'manifest has no assetsHash');
  }
  try {
    const users = get('SELECT COUNT(*) AS n FROM users')?.n || 0;
    const integrity = getDb().prepare('PRAGMA integrity_check').all().map((row) => Object.values(row)[0]).join('; ');
    add('database', users > 0 && /^ok$/i.test(String(integrity).trim()) ? 'ok' : 'fail', `users=${users}; integrity=${String(integrity).slice(0, 80)}`);
  } catch (error) {
    add('database', 'fail', error.message);
  }
  const failed = checks.filter((check) => check.status === 'fail');
  return { ok: !failed.length, checks, errors: failed.map((check) => `${check.id}: ${check.detail}`), health, build: buildInfo() };
}

function commitPanelUpdate(state) {
  const created = setting('panel_last_update', '');
  try { fs.rmSync(state.oldRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(state.targetRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(state.stagingRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  setSetting('panel_last_update', nowIso());
  setSetting('panel_last_update_version', state.manifest?.version || '');
  setSetting('panel_deployed_at', nowIso());
  setSetting('panel_build_id', `update-${state.jobId}`);
  if (state.manifest?.channel) setSetting('update_channel', state.manifest.channel);
  try { fs.rmSync(pendingFile(state.jobId), { force: true }); } catch { /* ignore */ }
  audit(state.actor || 'admin', 'admin', 'updates.panel', `${created ? `${created}; ` : ''}${VERSION} -> ${state.manifest?.version || '?'}`, '');
  return { version: state.manifest?.version || '', deployedAt: nowIso(), build: buildInfo() };
}

function rollbackPanelUpdate(state, reason) {
  const rollback = state.oldRoot ? rollbackInstall(state) : { ok: false, errors: ['no rollback directory recorded'] };
  try { fs.rmSync(state.targetRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(state.stagingRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  return { ok: rollback.ok, errors: rollback.errors, reason };
}

async function panelUpdateHandler(ctx) {
  const payload = ctx.job.payload || {};
  const channel = payload.channel || updateChannel();
  const allowUnsigned = payload.allowUnsigned === true || updateAllowsUnsigned();

  const downloaded = await ctx.step('download', async () => {
    const source = payload.manifest
      ? { kind: 'inline', channel, manifestUrl: '', signatureUrl: '', release: null }
      : await resolveManifestSource({ channel });
    let loaded;
    if (payload.manifest) loaded = { ok: true, manifest: payload.manifest, source };
    else loaded = await loadSignedManifest({ channel, source });
    if (!loaded.ok) throw Object.assign(new Error(loaded.error), { code: loaded.code });
    if (!payload.manifest) {
      const verified = verifyUpdateManifest(loaded.manifest, { allowUnsigned });
      if (!verified.ok) throw Object.assign(new Error(verified.error), { code: verified.code });
    }
    const version = semver(loaded.manifest.version)?.text || '';
    const destination = path.join(updatesDir(), `panel-${version || 'latest'}-${ctx.job.id}.tar.gz`);
    const archive = payload.archivePath && fs.existsSync(payload.archivePath)
      ? { file: payload.archivePath, sha256: sha256File(payload.archivePath), bytes: fs.statSync(payload.archivePath).size }
      : await downloadArchive(loaded.manifest, destination);
    ctx.setState({ manifest: loaded.manifest, archivePath: archive.file, signatureSource: loaded.source, version });
    return { version, archive, manifestUrl: loaded.source?.manifestUrl || '', release: loaded.source?.release || null };
  });

  const verification = await ctx.step('verify', () => {
    const manifest = ctx.state.manifest || payload.manifest;
    const signature = verifyUpdateManifest(manifest, { allowUnsigned });
    if (!signature.ok) throw Object.assign(new Error(signature.error), { code: signature.code });
    const sha256 = sha256File(downloaded.archive.file);
    const expected = String(manifest.sha256).toLowerCase();
    if (sha256 !== expected) throw Object.assign(new Error(`Archive SHA-256 mismatch: expected ${expected}, got ${sha256}`), { code: 'integrity_mismatch' });
    if (manifest.size && Number(manifest.size) !== fs.statSync(downloaded.archive.file).size) {
      throw Object.assign(new Error('Archive size does not match the signed manifest'), { code: 'integrity_mismatch' });
    }
    ctx.setState({ signature, archiveSha256: sha256 });
    return { verified: true, sha256, signature, unsigned: !!signature.unsigned };
  });

  const compatibility = await ctx.step('compatibility', () => checkCompatibility(downloaded.manifest || ctx.state.manifest, { channel }));
  if (!compatibility.ok) throw Object.assign(new Error(compatibility.errors.join('; ') || 'Incompatible update'), { code: compatibility.code || 'incompatible' });

  const guard = applyGuard();
  if (!guard.ok) throw Object.assign(new Error(guard.error), { code: guard.code });

  const backup = await ctx.step('backup', () => {
    const result = installBackup(ctx.job.id);
    ctx.setState({ backup: result });
    return result;
  });

  const staging = await ctx.step('staging', () => {
    const root = path.join(updatesDir(), `stage-${ctx.job.id}`);
    fs.rmSync(root, { recursive: true, force: true });
    const extracted = path.join(root, 'archive');
    const extraction = safeExtractTar(ctx.state.archivePath, extracted);
    if (!extraction.ok) throw Object.assign(new Error(extraction.error), { code: extraction.code || 'extract_failed' });
    const appRoot = findAppRoot(extracted);
    if (!appRoot) throw Object.assign(new Error('Update archive has no src/server.mjs'), { code: 'invalid_release' });
    const manifest = ctx.state.manifest || {};
    const problems = verifyManifestFiles(appRoot, manifest);
    if (problems.length) throw Object.assign(new Error(`Staged release failed hash verification: ${problems.slice(0, 3).join('; ')}`), { code: 'integrity_mismatch' });
    let packageJson = {};
    try { packageJson = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')); } catch { /* handled below */ }
    if (!packageJson.name) throw Object.assign(new Error('Staged release has no package.json'), { code: 'invalid_release' });
    if (manifest.version && packageJson.version && packageJson.version !== manifest.version) {
      throw Object.assign(new Error(`package.json version ${packageJson.version} does not match signed manifest ${manifest.version}`), { code: 'invalid_release' });
    }
    ctx.setState({ stagingRoot: root, appRoot, packageJson });
    return { appRoot, files: extraction.entries.length, package: { name: packageJson.name, version: packageJson.version } };
  });

  const dependencies = await ctx.step('dependencies', async () => {
    const packageJson = ctx.state.packageJson || {};
    const deps = Object.keys(packageJson.dependencies || {});
    if (!deps.length) return { installed: 0, skipped: 'no runtime dependencies' };
    const npm = which('npm');
    if (!npm) throw Object.assign(new Error('Release declares runtime dependencies but npm is not installed'), { code: 'dependency_missing' });
    const result = spawnSync(npm, ['install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'], {
      cwd: ctx.state.appRoot, encoding: 'utf8', timeout: 600000, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, npm_config_update_notifier: 'false' },
    });
    if (result.status !== 0) {
      throw Object.assign(new Error(`npm install failed: ${(result.stderr || result.stdout || '').trim().slice(0, 1200)}`), { code: 'dependencies_failed' });
    }
    return { installed: deps.length, output: (result.stdout || '').trim().slice(0, 1000) };
  });

  const migrations = await ctx.step('migrations', () => {
    const appRoot = ctx.state.appRoot;
    const failures = [];
    const walk = (dir) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full); continue; }
        if (!entry.name.endsWith('.mjs')) continue;
        const checked = spawnSync(process.execPath, ['--check', full], { encoding: 'utf8', timeout: 30000 });
        if (checked.status !== 0) failures.push(`${path.relative(appRoot, full)}: ${(checked.stderr || '').trim().split('\n')[0]}`);
        if (failures.length > 5) return;
      }
    };
    walk(path.join(appRoot, 'src'));
    walk(path.join(appRoot, 'bin'));
    if (failures.length) throw Object.assign(new Error(`Syntax check failed: ${failures.slice(0, 3).join('; ')}`), { code: 'syntax_check_failed' });
    const dbModule = path.join(appRoot, 'src', 'db.mjs');
    if (!fs.existsSync(dbModule)) throw Object.assign(new Error('Staged release has no src/db.mjs'), { code: 'invalid_release' });
    const migration = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(dbModule).href)});`], {
      encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, OA_DATA_DIR: config.dataDir },
    });
    if (migration.status !== 0) {
      throw Object.assign(new Error(`Database migration failed: ${(migration.stderr || migration.stdout || '').trim().slice(0, 1200)}`), { code: 'migration_failed' });
    }
    return { syntaxChecked: true, migrated: true };
  });

  const restart = await ctx.step('restart', async () => {
    const targetRoot = prepareApplyTree(ctx.state.appRoot, ctx.job.id);
    ctx.setState({ targetRoot });
    const state = {
      jobId: ctx.job.id,
      phase: 'applying',
      version: ctx.state.version,
      manifest: ctx.state.manifest,
      backup: ctx.state.backup,
      stagingRoot: ctx.state.stagingRoot,
      targetRoot,
      createdAt: nowIso(),
      actor: ctx.job.actor,
      port: config.port,
      root: config.root,
      attempts: 0,
      packageManager: ctx.state.packageJson?.packageManager || '',
    };
    const skipRestart = process.env.OA_UPDATE_SKIP_RESTART === '1';
    if (!skipRestart) writePending(ctx.job.id, state);
    let swap;
    try {
      swap = swapInstall(targetRoot, ctx.job.id);
    } catch (error) {
      try { fs.rmSync(pendingFile(ctx.job.id), { force: true }); } catch { /* ignore */ }
      throw error;
    }
    const pending = { ...state, phase: 'awaiting-restart', oldRoot: swap.oldRoot, swapped: swap.swapped, archivePath: ctx.state.archivePath };
    ctx.setState({ pending: pendingFile(ctx.job.id), oldRoot: swap.oldRoot, swapped: swap.swapped });
    if (skipRestart) {
      return { simulated: true, mode: 'skipped', swap, targetRoot };
    }
    writePending(ctx.job.id, pending);
    let mode;
    try {
      mode = scheduleProcessRestart();
    } catch (error) {
      const rollback = rollbackPanelUpdate(pending, error.message);
      try { fs.rmSync(pendingFile(ctx.job.id), { force: true }); } catch { /* ignore */ }
      throw new Error(`Restart could not be scheduled: ${error.message}${rollback.ok ? ' (files rolled back)' : ' (ROLLBACK FAILED)'}`);
    }
    ctx.log('info', `Restart requested via ${mode.mode}; job continues after restart from ${pendingFile(ctx.job.id)}`);
    // The updater process must exit for the self-restart helper (which waits for
    // this PID) or for systemd to replace it. The new process finalizes the job.
    setTimeout(() => process.exit(0), 1500);
    return { simulated: false, mode, swap };
  });

  if (restart.simulated) {
    const smoke = await ctx.step('smoke', () => smokePanelUpdate({ ...ctx.state, manifest: ctx.state.manifest, port: config.port }, { simulated: true }));
    if (!smoke.ok) {
      const rollback = rollbackPanelUpdate({ ...ctx.state, oldRoot: ctx.state.oldRoot, targetRoot: ctx.state.targetRoot, stagingRoot: ctx.state.stagingRoot }, smoke.errors.join('; '));
      throw Object.assign(new Error(`Post-update smoke tests failed: ${smoke.errors.join('; ')}${rollback.ok ? ' (rolled back)' : ' (ROLLBACK FAILED)'}`), { code: 'smoke_failed' });
    }
    const commit = await ctx.step('commit', () => commitPanelUpdate({ ...ctx.state, manifest: ctx.state.manifest, targetRoot: ctx.state.targetRoot, stagingRoot: ctx.state.stagingRoot, oldRoot: ctx.state.oldRoot }));
    return { ok: true, applied: true, simulated: true, version: ctx.state.version, smoke, commit, backup: ctx.state.backup };
  }

  // Hand the job over to the restarted process. The current process must exit;
  // smoke + commit are resumed from the pending state file by scheduler.mjs.
  try {
    await hangForRestart();
  } catch (error) {
    const rollback = rollbackPanelUpdate({ ...ctx.state, manifest: ctx.state.manifest }, error.message);
    ctx.setResult({ rolledBack: rollback.ok, rollbackErrors: rollback.errors });
    throw new Error(`${error.message}${rollback.ok ? ' (files rolled back)' : ' (ROLLBACK FAILED)'}`);
  }
  return { ok: true, restarting: true };
}

registerJobHandler('update.panel', panelUpdateHandler, { mode: 'async' });

/* -------------------------------------------------------------------------- */
/* Restart hand-off / resume                                                  */
/* -------------------------------------------------------------------------- */

function installDirLooksApplied(state) {
  try {
    const packageJson = parseJson(fs.readFileSync(path.join(config.root, 'package.json'), 'utf8'), {});
    return String(packageJson.version || '') === String(state.manifest?.version || '');
  } catch { return false; }
}

/**
 * Called by scheduler.mjs on every panel start. It finalizes an update that
 * deliberately restarted the process, or rolls it back when smoke tests fail.
 */
export async function resumePendingUpdate() {
  const files = pendingUpdateFiles();
  if (!files.length) return null;
  const results = [];
  for (const file of files) {
    const state = readPending(file);
    if (!state || !state.jobId) { try { fs.rmSync(file, { force: true }); } catch { /* ignore */ } continue; }
    const job = jobView(state.jobId);
    if (!job) { try { fs.rmSync(file, { force: true }); } catch { /* ignore */ } continue; }
    if (job.terminal) {
      // Another process already finalized the job; only clean the hand-off file.
      try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
      try { fs.rmSync(state.targetRoot, { recursive: true, force: true }); } catch { /* ignore */ }
      results.push({ jobId: state.jobId, phase: state.phase, skipped: `already ${job.status}` });
      continue;
    }
    try {
      if (state.phase === 'rollback-restart') {
        try { fs.rmSync(state.oldRoot, { recursive: true, force: true }); } catch { /* ignore */ }
        try { fs.rmSync(state.targetRoot, { recursive: true, force: true }); } catch { /* ignore */ }
        try { fs.rmSync(state.stagingRoot, { recursive: true, force: true }); } catch { /* ignore */ }
        fs.rmSync(file, { force: true });
        results.push({ jobId: state.jobId, phase: state.phase, cleaned: true });
        continue;
      }
      if (state.phase === 'applying') {
        // The process died before the reboot; put the old tree back. A crash can
        // happen after the rename and before the second state write, so rebuild
        // the applied list from the deterministic rollback directory.
        if (!state.oldRoot) state.oldRoot = path.join(config.root, `.openadmin-old-${Number(state.jobId)}`);
        if (!Array.isArray(state.swapped) || !state.swapped.length) {
          state.swapped = ['node_modules', 'src', 'bin', 'package.json', 'package-lock.json']
            .filter((name) => fs.existsSync(path.join(state.oldRoot, name)));
        }
        const rollback = state.oldRoot ? rollbackInstall(state) : { ok: false, errors: ['no rollback directory'] };
        finishJobExternally(state.jobId, 'failed', {
          error: `Update interrupted before restart. ${rollback.ok ? 'Files rolled back.' : `ROLLBACK FAILED: ${rollback.errors.join('; ')}`}`,
          result: { rolledBack: rollback.ok, stage: 'restart', phase: state.phase },
        });
        fs.rmSync(file, { force: true });
        results.push({ jobId: state.jobId, phase: state.phase, rolledBack: rollback.ok });
        continue;
      }
      if (state.phase !== 'awaiting-restart' && state.phase !== 'awaiting-smoke') {
        results.push({ jobId: state.jobId, phase: state.phase, skipped: 'unknown phase' });
        continue;
      }
      setJobStageExternally(state.jobId, 'smoke', 'running', { label: 'Post-restart smoke tests' });
      appendJobEventExternally(state.jobId, 'info', `Resuming after restart in process ${process.pid}`);
      const smoke = await smokePanelUpdate({ ...state, manifest: state.manifest, port: state.port || config.port }, { simulated: process.env.OA_UPDATE_SKIP_RESTART === '1' });
      if (smoke.ok) {
        setJobStageExternally(state.jobId, 'smoke', 'complete', { detail: `checks=${smoke.checks.length}`, value: smoke });
        setJobStageExternally(state.jobId, 'commit', 'running', { label: 'Commit' });
        const commit = commitPanelUpdate({ ...state, manifest: state.manifest });
        setJobStageExternally(state.jobId, 'commit', 'complete', { detail: `version=${commit.version}`, value: commit });
        finishJobExternally(state.jobId, 'succeeded', {
          result: {
            ok: true,
            version: state.manifest?.version || '',
            restartMode: state.restartMode || (detectSystemdUnit() ? 'systemd' : 'self-restart'),
            smoke,
            commit,
            backup: state.backup,
            manifest: { version: state.manifest?.version, sha256: state.manifest?.sha256, channel: state.manifest?.channel },
          },
        });
        results.push({ jobId: state.jobId, ok: true, version: commit.version });
        continue;
      }
      // Smoke failed: roll the file tree back and restart into the old code.
      const rollback = rollbackPanelUpdate({ ...state, manifest: state.manifest }, smoke.errors.join('; '));
      setJobStageExternally(state.jobId, 'smoke', 'failed', { detail: smoke.errors.join('; ').slice(0, 2000) });
      finishJobExternally(state.jobId, 'failed', {
        error: `Post-update smoke tests failed: ${smoke.errors.join('; ')}`,
        result: { ok: false, rolledBack: rollback.ok, rollbackErrors: rollback.errors, smoke, backup: state.backup },
      });
      const restarted = { ...state, phase: 'rollback-restart', smoke };
      writePending(state.jobId, restarted);
      if (process.env.OA_UPDATE_SKIP_RESTART !== '1') {
        scheduleProcessRestart();
        setTimeout(() => process.exit(0), 1500);
      }
      results.push({ jobId: state.jobId, ok: false, rolledBack: rollback.ok, smoke });
    } catch (error) {
      finishJobExternally(state.jobId, 'failed', { error: `Update finalization failed: ${error.message}`, result: { finalizationError: error.message } });
      results.push({ jobId: state.jobId, ok: false, error: error.message });
    }
  }
  return results;
}

/* -------------------------------------------------------------------------- */
/* Public check / stage API                                                   */
/* -------------------------------------------------------------------------- */

export async function checkPanel({ channel = updateChannel() } = {}) {
  const current = VERSION;
  let release = null;
  try {
    release = await releaseMetadata(channel);
  } catch (error) {
    return { ok: false, error: error.message, current, channel };
  }
  if (!release) return { ok: false, error: 'No release found', current, channel };
  const latest = String(release.tag_name || '').replace(/^v/, '') || current;
  const base = {
    ok: true,
    current,
    latest,
    channel,
    url: release.tarball_url || `https://codeload.github.com/${REPO}/tar.gz/refs/heads/main`,
    notes: release.body || '',
    published: release.published_at || '',
    update: cmp(latest, current) > 0,
  };
  try {
    const source = await resolveManifestSource({ channel, release });
    if (!source.manifestUrl) return { ...base, canApply: false, blocked: 'unsigned-release', manifestError: source.error || 'No signed manifest' };
    const loaded = await loadSignedManifest({ channel, source });
    if (!loaded.ok) return { ...base, canApply: false, blocked: loaded.code, manifestError: loaded.error };
    const verification = verifyUpdateManifest(loaded.manifest);
    const compatibility = await checkCompatibility(loaded.manifest, { currentVersion: current, channel });
    return {
      ...base,
      latest: loaded.manifest.version || latest,
      canApply: verification.ok && compatibility.ok,
      manifest: {
        version: loaded.manifest.version,
        sha256: loaded.manifest.sha256,
        channel: loaded.manifest.channel || channel,
        size: loaded.manifest.size || null,
        publishedAt: loaded.manifest.publishedAt || '',
        notes: loaded.manifest.notes || base.notes,
      },
      verification,
      compatibility,
      blocked: verification.ok ? (compatibility.ok ? '' : 'incompatible') : verification.code,
    };
  } catch (error) {
    return { ...base, canApply: false, blocked: 'manifest-error', manifestError: error.message };
  }
}

/**
 * Dry-run: resolve + verify a release without touching the installation.
 * Returns the full verification/compatibility report for the UI.
 */
export async function stagePanelUpdate({ apply = false, actor = 'admin', channel = updateChannel(), manifest = null, allowUnsigned = updateAllowsUnsigned() } = {}) {
  const current = VERSION;
  if (!apply) {
    let loaded;
    if (manifest) loaded = { ok: true, manifest, source: { kind: 'inline', channel, manifestUrl: '', signatureUrl: '' } };
    else loaded = await loadSignedManifest({ channel });
    if (!loaded.ok) return { ok: false, code: loaded.code, error: loaded.error, current, channel, backupDir: path.join(config.dataDir, 'updates') };
    const verification = verifyUpdateManifest(loaded.manifest, { allowUnsigned });
    const compatibility = await checkCompatibility(loaded.manifest, { currentVersion: current, channel });
    if (!verification.ok) return { ok: false, code: verification.code, error: verification.error, verification, compatibility, current, channel };
    if (!compatibility.ok) return { ok: false, code: 'incompatible', error: compatibility.errors.join('; '), verification, compatibility, current, channel };
    return {
      ok: true,
      dryRun: true,
      current,
      latest: loaded.manifest.version,
      channel,
      url: loaded.manifest.releaseUrl || loaded.manifest.url || loaded.source?.manifestUrl || '',
      manifest: {
        version: loaded.manifest.version,
        sha256: loaded.manifest.sha256,
        channel: loaded.manifest.channel || channel,
        size: loaded.manifest.size || null,
        notes: loaded.manifest.notes || '',
        files: Array.isArray(loaded.manifest.files) ? loaded.manifest.files.length : 0,
      },
      verification,
      compatibility,
      backupDir: path.join(config.dataDir, 'updates'),
      note: 'Dry-run only. Nothing was downloaded into the installation or restarted.',
    };
  }

  const guard = applyGuard();
  if (!guard.ok) return { ok: false, code: guard.code, error: guard.error, current, channel };
  // Pin the exact manifest that was verified before the job is queued. This
  // prevents "check then apply" races and makes an unsigned release fail here,
  // before any download or file mutation.
  let pinned = manifest;
  let source = { kind: 'inline', channel };
  if (!pinned) {
    const loaded = await loadSignedManifest({ channel });
    if (!loaded.ok) return { ok: false, code: loaded.code, error: loaded.error, current, channel };
    pinned = loaded.manifest;
    source = loaded.source;
  }
  const verification = verifyUpdateManifest(pinned, { allowUnsigned });
  const compatibility = await checkCompatibility(pinned, { currentVersion: current, channel });
  if (!verification.ok) return { ok: false, code: verification.code, error: verification.error, verification, compatibility, current, channel };
  if (!compatibility.ok) return { ok: false, code: 'incompatible', error: compatibility.errors.join('; '), verification, compatibility, current, channel };
  const version = pinned.version;
  const operation = createJob({
    kind: 'update.panel',
    stages: UPDATE_STAGES,
    actor,
    target: `panel:${current}->${version}`,
    payload: {
      channel,
      actor,
      allowUnsigned,
      manifest: pinned,
      manifestSource: source,
    },
    idempotencyKey: `update.panel:${version}`,
    maxAttempts: 1,
  });
  if (operation.reused) return { ok: true, queued: true, reused: true, jobId: operation.job.id, job: operation.job, current, channel };
  // Run inline in the panel process: the restart hand-off relies on this
  // process being the one that is replaced.
  executeJobById(operation.job.id).catch((error) => {
    console.warn('[openadmin] update job:', error.message);
  });
  return { ok: true, queued: true, jobId: operation.job.id, job: operation.job, current, channel };
}

/* -------------------------------------------------------------------------- */
/* OS updates                                                                 */
/* -------------------------------------------------------------------------- */

export function osCheck() {
  if (config.provider !== 'linux') return { ok: true, packages: [], simulated: true };
  const result = spawnSync('apt-get', ['-s', 'upgrade'], { encoding: 'utf8', timeout: 60000 });
  if (result.status !== 0) return { ok: false, error: (result.stderr || result.stdout || '').trim().slice(0, 800), packages: [] };
  const packages = (result.stdout || '').split('\n').filter((line) => /^Inst /.test(line)).map((line) => {
    const match = /^Inst (\S+) \[([^\]]+)\] \(([^ ]+)/.exec(line);
    return match ? { name: match[1], from: match[2], to: match[3] } : { name: line.replace(/^Inst /, '') };
  });
  return { ok: true, packages, simulated: false };
}

export function applyOsUpdates({ apply = false, actor = 'admin' } = {}) {
  if (config.provider !== 'linux') return { ok: true, simulated: true, packages: [] };
  if (!isRoot()) return { ok: false, error: 'Root privileges required' };
  const check = osCheck();
  if (!check.ok) return check;
  if (!apply) return { ...check, dryRun: true };
  const result = spawnSync('apt-get', ['-y', 'upgrade'], { encoding: 'utf8', timeout: 1800000, maxBuffer: 32 * 1024 * 1024 });
  audit(actor, 'admin', 'updates.os', `${check.packages.length} packages`, '');
  return { ok: result.status === 0, output: ((result.stdout || '') + (result.stderr || '')).trim().slice(0, 4000), count: check.packages.length };
}
