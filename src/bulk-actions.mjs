// Reseller/admin bulk operations with a two-step, signed preview and a
// per-object report. No raw object data is trusted from the browser: the
// confirmation token only binds a server-side batch id, the actor, the action
// and a short expiry. Every selected object is resolved again through
// visibleUsers()/visibleDomains()/canManageUser()/canManageDomain() both when
// the preview is built and when the batch is applied.
import crypto from 'node:crypto';
import { apply as applyConfig } from './apply.mjs';
import { get, run, getDb, setting, audit, nowIso } from './db.mjs';
import { limitsFor } from './auth.mjs';
import { panelSecret } from './config.mjs';
import { safeJson } from './util.mjs';
import { visibleUsers, visibleDomains, canManageUser, canManageDomain } from './core/access.mjs';
import { createUserBackupJob, spawnJobRunner } from './backups.mjs';
import { enqueueAcme } from './autossl.mjs';

export const MAX_BULK_OBJECTS = 500;
export const BULK_BACKUP_KINDS = Object.freeze(['full', 'home', 'email', 'db']);
export const BULK_SSL_MODES = Object.freeze(['letsencrypt', 'selfsigned']);
export const DEFAULT_TOKEN_TTL_SECONDS = 600;

export const BULK_ACTIONS = Object.freeze({
  suspend: Object.freeze({
    objectType: 'users',
    label: 'Suspend accounts',
    effects: ['Blocks panel sign-in and hosted services for the account.'],
    downtimeMinutes: 0,
  }),
  activate: Object.freeze({
    objectType: 'users',
    label: 'Activate accounts',
    effects: ['Restores panel sign-in and hosted services for the account.'],
    downtimeMinutes: 0,
  }),
  package: Object.freeze({
    objectType: 'users',
    label: 'Change package',
    effects: ['Replaces the account package and its quota/feature limits.'],
    downtimeMinutes: 0,
    value: 'package',
  }),
  backup: Object.freeze({
    objectType: 'users',
    label: 'Create backups',
    effects: ['Queues one durable backup job per account and starts its runner.'],
    downtimeMinutes: 0,
    value: 'backup',
  }),
  message: Object.freeze({
    objectType: 'users',
    label: 'Send message',
    effects: ['Adds an in-panel message for each selected account.'],
    downtimeMinutes: 0,
    value: 'message',
  }),
  ssl: Object.freeze({
    objectType: 'domains',
    label: 'Issue SSL certificates',
    effects: ['Queues an ACME certificate request/renewal for each domain.'],
    downtimeMinutes: 0,
    value: 'ssl',
  }),
  php: Object.freeze({
    objectType: 'domains',
    label: 'Change PHP version',
    effects: ['Updates the domain PHP version, then reloads PHP-FPM pools and vhosts.'],
    downtimeMinutes: 1,
    value: 'php',
  }),
});

export const BULK_ACTION_KEYS = Object.freeze(Object.keys(BULK_ACTIONS));

/** Exact SQL a future db.mjs migration should contain. Applied lazily here so
 *  this feature works against an installation that predates the table. */
export const BULK_ACTIONS_MIGRATION = `
CREATE TABLE IF NOT EXISTS bulk_action_batches (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  actor_id INTEGER,
  actor_level TEXT NOT NULL,
  action TEXT NOT NULL,
  object_type TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'preview',
  objects TEXT NOT NULL DEFAULT '[]',
  preview TEXT,
  report TEXT,
  token_hash TEXT NOT NULL,
  token_expires_at TEXT NOT NULL,
  csrf_hash TEXT,
  created_at TEXT NOT NULL,
  applied_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_bulk_action_batches_actor
  ON bulk_action_batches(actor, created_at);
CREATE INDEX IF NOT EXISTS idx_bulk_action_batches_status
  ON bulk_action_batches(status, created_at);
`;

let bulkSchemaReady = false;

export function ensureBulkSchema({ force = false } = {}) {
  if (bulkSchemaReady && !force) return;
  getDb().exec(BULK_ACTIONS_MIGRATION);
  bulkSchemaReady = true;
}

function fail(code, error, status = 400, extra = {}) {
  return { ok: false, code, error, status, ...extra };
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value ?? '')).digest('hex');
}

function hashEquals(left, right) {
  const a = Buffer.from(String(left ?? ''));
  const b = Buffer.from(String(right ?? ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function bulkActionSecret() {
  return panelSecret();
}

function tokenHmac(body) {
  return crypto.createHmac('sha256', bulkActionSecret())
    .update(`openadmin.bulk-actions.v1.${body}`)
    .digest('base64url');
}

export function bulkTokenTtlSeconds() {
  const raw = Number.parseInt(setting('bulk_action_preview_ttl_seconds', String(DEFAULT_TOKEN_TTL_SECONDS)), 10);
  if (!Number.isFinite(raw)) return DEFAULT_TOKEN_TTL_SECONDS;
  return Math.min(3600, Math.max(60, raw));
}

/** Sign a confirmation token. The payload deliberately contains no selected
 *  usernames/domain names or other raw object data, only the server-side batch
 *  id, actor identity, action and expiry. */
export function signBulkToken({ batchId, actor, action, objectType, expiresAt, csrf = '' }) {
  const payload = {
    v: 1,
    b: String(batchId),
    a: Number(actor.id),
    u: String(actor.username),
    l: String(actor.level),
    ac: String(action),
    ot: String(objectType),
    exp: Number(expiresAt),
    n: crypto.randomBytes(9).toString('base64url'),
    c: sha256(csrf),
  };
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${tokenHmac(body)}`;
}

export function verifyBulkToken(token, actor, {
  csrf = null, now = Date.now(), enforceExpiry = true,
} = {}) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return fail('invalid_token', 'The confirmation token is malformed.', 403);
  }
  const expected = tokenHmac(parts[0]);
  if (!hashEquals(parts[1], expected)) {
    return fail('invalid_token', 'The confirmation token signature is invalid.', 403);
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  } catch {
    return fail('invalid_token', 'The confirmation token payload is invalid.', 403);
  }
  if (!payload || payload.v !== 1 || !payload.b || !payload.exp) {
    return fail('invalid_token', 'The confirmation token version is not supported.', 403);
  }
  if (!actor || Number(payload.a) !== Number(actor.id) || String(payload.u) !== String(actor.username)
    || String(payload.l) !== String(actor.level)) {
    return fail('token_actor_mismatch', 'This confirmation token belongs to a different session actor.', 403);
  }
  if (csrf !== null && csrf !== undefined && String(payload.c) !== sha256(csrf)) {
    return fail('csrf_mismatch', 'This confirmation token belongs to a different form session. Reload the preview.', 403);
  }
  if (enforceExpiry && Number(payload.exp) <= Number(now)) {
    return fail('token_expired', 'This preview has expired. Build a new preview before applying.', 400);
  }
  return { ok: true, payload };
}

function actorProblem(actor) {
  if (!actor || !actor.username) {
    return fail('forbidden', 'Sign in to run bulk operations.', 403);
  }
  if (actor.level !== 'admin' && actor.level !== 'reseller') {
    return fail('forbidden', 'Bulk operations are available to administrators and resellers only.', 403);
  }
  return null;
}

function actionSpec(action) {
  if (!Object.prototype.hasOwnProperty.call(BULK_ACTIONS, action)) return null;
  return BULK_ACTIONS[action];
}

function normalizeObjectType(value) {
  const type = String(value ?? '').trim().toLowerCase();
  if (type === 'users' || type === 'user' || type === 'accounts') return 'users';
  if (type === 'domains' || type === 'domain') return 'domains';
  return '';
}

function objectTypeLabel(objectType) {
  return objectType === 'domains' ? 'domain' : 'user';
}

export function bulkActionsFor(objectType) {
  const type = normalizeObjectType(objectType);
  return BULK_ACTION_KEYS
    .filter((key) => BULK_ACTIONS[key].objectType === type)
    .map((key) => ({
      key,
      label: BULK_ACTIONS[key].label,
      objectType: type,
      value: BULK_ACTIONS[key].value || null,
    }));
}

export function bulkPhpVersions(actor = null) {
  const configured = String(setting('php_versions', '8.4,8.3,8.2,8.1,7.4'))
    .split(',')
    .map((value) => value.trim())
    .filter((value) => /^\d+\.\d+$/.test(value));
  const globalVersions = configured.length ? configured : ['8.3'];
  if (!actor || actor.level !== 'reseller') return globalVersions;
  const limits = limitsFor(actor);
  const allowed = Array.isArray(limits?.php)
    ? limits.php.map((value) => String(value)).filter((value) => /^\d+\.\d+$/.test(value))
    : [];
  if (!allowed.length) return globalVersions;
  return globalVersions.filter((version) => allowed.includes(version));
}

/** Normalize a browser-supplied selection without dropping invalid ids: an
 *  invalid id becomes a blocked preview row instead of silently disappearing. */
export function normalizeBulkIds(raw) {
  const values = Array.isArray(raw)
    ? raw
    : raw === undefined || raw === null
      ? []
      : String(raw).split(/[\s,]+/);
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (!text) continue;
    const numeric = /^\d+$/.test(text) ? Number(text) : null;
    const key = numeric !== null ? `id:${numeric}` : `raw:${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(numeric !== null
      ? { id: numeric, valid: true }
      : { id: text.slice(0, 80), valid: false });
  }
  return out;
}

function cleanLine(value, max) {
  const text = String(value ?? '').replace(/\0/g, '').replace(/[\r\n\t]+/g, ' ').trim();
  if (text.length > max) return null;
  return text;
}

function cleanBody(value, max) {
  const text = String(value ?? '').replace(/\0/g, '').trim();
  if (text.length > max) return null;
  return text;
}

function firstText(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
}

function buildValue(action, input = {}) {
  const direct = input.value;
  if (action === 'suspend' || action === 'activate') {
    const reason = cleanLine(firstText(input.reason, typeof direct === 'string' ? direct : ''), 300);
    if (reason === null) return fail('invalid_value', 'The suspension reason is too long (max 300 characters).');
    return { ok: true, value: { reason } };
  }
  if (action === 'package') {
    const name = firstText(input.package, input.packageName, typeof direct === 'string' ? direct : '');
    if (!name) return fail('invalid_value', 'Choose a package for this action.');
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) {
      return fail('invalid_value', 'The package name contains invalid characters.');
    }
    return { ok: true, value: { package: name } };
  }
  if (action === 'php') {
    const version = firstText(input.php, input.phpVersion, input.version, typeof direct === 'string' ? direct : '');
    if (!version) return fail('invalid_value', 'Choose a PHP version for this action.');
    if (!/^\d{1,2}\.\d{1,2}$/.test(version)) {
      return fail('invalid_php_version', 'The PHP version format is invalid.');
    }
    return { ok: true, value: { php: version } };
  }
  if (action === 'backup') {
    const kind = firstText(input.backupKind, input.kind, typeof direct === 'string' ? direct : '', 'full').toLowerCase();
    if (!BULK_BACKUP_KINDS.includes(kind)) {
      return fail('invalid_value', `Backup scope must be one of: ${BULK_BACKUP_KINDS.join(', ')}.`);
    }
    return { ok: true, value: { kind } };
  }
  if (action === 'ssl') {
    const mode = firstText(input.sslMode, input.mode, typeof direct === 'string' ? direct : '', 'letsencrypt').toLowerCase();
    if (!BULK_SSL_MODES.includes(mode)) {
      return fail('invalid_value', `SSL mode must be one of: ${BULK_SSL_MODES.join(', ')}.`);
    }
    return { ok: true, value: { mode } };
  }
  if (action === 'message') {
    const source = direct && typeof direct === 'object' && !Array.isArray(direct) ? direct : input;
    const subject = cleanLine(
      firstText(source.subject, input.subject, source.title),
      200,
    );
    if (!subject) return fail('invalid_value', 'A message subject is required (max 200 characters).');
    const body = cleanBody(
      source.body ?? source.message ?? input.message ?? input.body,
      5000,
    );
    if (!body) return fail('invalid_value', 'A message body is required (max 5000 characters).');
    return { ok: true, value: { subject, body } };
  }
  return fail('unknown_action', `Unknown bulk action: ${action}.`);
}

function validateValue(action, candidate, actor) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return fail('invalid_value', 'The action value is invalid.');
  }
  if (action === 'suspend' || action === 'activate') {
    const reason = cleanLine(candidate.reason, 300);
    if (reason === null) return fail('invalid_value', 'The suspension reason is too long (max 300 characters).');
    return { ok: true, value: { reason: reason || '' } };
  }
  if (action === 'package') {
    const name = String(candidate.package ?? '').trim();
    if (!name) return fail('invalid_value', 'Choose a package for this action.');
    const pkg = get('SELECT * FROM packages WHERE name = ?', name);
    if (!pkg) return fail('invalid_value', `Package ${name} does not exist.`);
    return { ok: true, value: { package: pkg.name } };
  }
  if (action === 'php') {
    const version = String(candidate.php ?? '').trim();
    if (!bulkPhpVersions(actor).includes(version)) {
      return fail('invalid_php_version', `PHP ${version || '?'} is not enabled for this account level.`);
    }
    return { ok: true, value: { php: version } };
  }
  if (action === 'backup') {
    const kind = String(candidate.kind ?? 'full').toLowerCase();
    if (!BULK_BACKUP_KINDS.includes(kind)) {
      return fail('invalid_value', `Backup scope must be one of: ${BULK_BACKUP_KINDS.join(', ')}.`);
    }
    return { ok: true, value: { kind } };
  }
  if (action === 'ssl') {
    const mode = String(candidate.mode ?? 'letsencrypt').toLowerCase();
    if (!BULK_SSL_MODES.includes(mode)) {
      return fail('invalid_value', `SSL mode must be one of: ${BULK_SSL_MODES.join(', ')}.`);
    }
    return { ok: true, value: { mode } };
  }
  if (action === 'message') {
    const subject = cleanLine(candidate.subject, 200);
    const body = cleanBody(candidate.body, 5000);
    if (!subject || !body) return fail('invalid_value', 'A message subject and body are required (200/5000 characters max).');
    return { ok: true, value: { subject, body } };
  }
  return fail('unknown_action', `Unknown bulk action: ${action}.`);
}

function normalizeValue(action, input, actor) {
  const built = buildValue(action, input);
  if (!built.ok) return built;
  return validateValue(action, built.value, actor);
}

function publicValue(action, value) {
  if (action === 'message') {
    return { subject: value.subject, bodyLength: String(value.body || '').length };
  }
  return { ...value };
}

function scopeFor(actor, objectType) {
  if (objectType === 'users') return new Set(visibleUsers(actor).map((row) => row.id));
  return new Set(visibleDomains(actor).map((row) => row.id));
}

function blockedEntry(ref, objectType, label, code, reason) {
  return {
    entry: {
      id: ref.id,
      kind: objectTypeLabel(objectType),
      label,
      eligible: false,
      code,
      reason,
      current: null,
      effects: [],
      downtimeMinutes: 0,
      downtimeText: '',
      diskMb: 0,
    },
    row: null,
  };
}

function eligibleEntry(ref, objectType, label, row, {
  effects, downtimeMinutes = 0, downtimeText = '', diskMb = 0, current = null, target = null,
}) {
  return {
    entry: {
      id: ref.id,
      kind: objectTypeLabel(objectType),
      label,
      eligible: true,
      code: null,
      reason: null,
      current,
      target,
      effects,
      downtimeMinutes,
      downtimeText,
      diskMb,
    },
    row,
  };
}

function userCurrent(row) {
  return {
    username: row.username,
    email: row.email || '',
    package: row.package || '',
    level: row.level,
    suspended: !!row.suspended,
  };
}

function domainCurrent(row) {
  return {
    name: row.name,
    username: row.username,
    phpVersion: row.php_version || '',
    ssl: !!row.ssl,
    status: row.status || '',
  };
}

function evaluateUserAction(actor, ref, row, action, value) {
  const current = userCurrent(row);
  if (action === 'suspend') {
    if (row.suspended) {
      return blockedEntry(ref, 'users', row.username, 'already_suspended', `${row.username} is already suspended.`);
    }
    return eligibleEntry(ref, 'users', row.username, row, {
      current,
      effects: [`Blocks panel sign-in and hosted services for ${row.username}.`],
      downtimeText: 'No restart; the account stays unavailable until activated.',
    });
  }
  if (action === 'activate') {
    if (!row.suspended) {
      return blockedEntry(ref, 'users', row.username, 'already_active', `${row.username} is already active.`);
    }
    return eligibleEntry(ref, 'users', row.username, row, {
      current,
      effects: [`Restores panel sign-in and hosted services for ${row.username}.`],
    });
  }
  if (action === 'package') {
    const pkg = get('SELECT * FROM packages WHERE name = ?', value.package);
    const label = row.username;
    if (!pkg) {
      return blockedEntry(ref, 'users', label, 'package_missing', `Package ${value.package} no longer exists.`);
    }
    const wantedType = row.level === 'reseller' ? 'reseller' : 'user';
    if (pkg.type !== wantedType) {
      return blockedEntry(ref, 'users', label, 'package_type_mismatch', `Package ${pkg.name} is not a ${wantedType} package.`);
    }
    if (actor.level === 'reseller' && pkg.owner && pkg.owner !== actor.username) {
      return blockedEntry(ref, 'users', label, 'package_forbidden', `Package ${pkg.name} belongs to another reseller.`);
    }
    if (row.package === pkg.name) {
      return blockedEntry(ref, 'users', label, 'already_assigned', `${label} already uses package ${pkg.name}.`);
    }
    return eligibleEntry(ref, 'users', label, row, {
      current,
      target: { package: pkg.name, type: pkg.type },
      effects: [
        `Moves ${label} from ${row.package || 'no package'} to ${pkg.name}.`,
        'Quota and feature limits change on the next request after apply.',
      ],
    });
  }
  if (action === 'backup') {
    const disk = get('SELECT COALESCE(SUM(disk_mb), 0) AS mb FROM domains WHERE user_id = ?', row.id)?.mb || 0;
    const diskMb = Math.max(1, Math.ceil(Number(disk || 0) * 1.1) + 25);
    return eligibleEntry(ref, 'users', row.username, row, {
      current,
      target: { kind: value.kind },
      effects: [`Queues a ${value.kind} backup for ${row.username} as a durable job.`],
      diskMb,
      downtimeText: 'Online backup; no planned downtime.',
    });
  }
  if (action === 'message') {
    return eligibleEntry(ref, 'users', row.username, row, {
      current,
      target: { subject: value.subject },
      effects: [`Adds the message "${value.subject}" to ${row.username}'s inbox.`],
      downtimeText: 'No planned downtime.',
    });
  }
  return blockedEntry(ref, 'users', row.username, 'unsupported_action', 'This action is not supported for accounts.');
}

function evaluateDomainAction(actor, ref, row, action, value) {
  const current = domainCurrent(row);
  if (action === 'ssl') {
    return eligibleEntry(ref, 'domains', row.name, row, {
      current,
      target: { mode: value.mode },
      effects: [`Queues a ${value.mode} certificate request for ${row.name}.`],
      downtimeText: 'No planned downtime.',
    });
  }
  if (action === 'php') {
    if (String(row.php_version || '') === value.php) {
      return blockedEntry(ref, 'domains', row.name, 'already_current', `${row.name} already runs PHP ${value.php}.`);
    }
    return eligibleEntry(ref, 'domains', row.name, row, {
      current,
      target: { php: value.php },
      effects: [
        `Changes ${row.name} from PHP ${row.php_version || 'default'} to PHP ${value.php}.`,
        'Reloads PHP-FPM pools and vhosts after the batch finishes.',
      ],
      downtimeMinutes: 1,
      downtimeText: 'Brief PHP-FPM/vhost reload (under a minute).',
    });
  }
  return blockedEntry(ref, 'domains', row.name, 'unsupported_action', 'This action is not supported for domains.');
}

function evaluateObject(actor, objectType, ref, action, value, scope) {
  if (!ref.valid) {
    return blockedEntry(ref, objectType, `#${String(ref.id).slice(0, 40)}`, 'invalid_id', 'The selected identifier is not a valid object id.');
  }
  if (objectType === 'users') {
    const row = get('SELECT * FROM users WHERE id = ?', ref.id);
    if (!row) return blockedEntry(ref, 'users', `user #${ref.id}`, 'not_found', 'The account no longer exists.');
    const manageable = scope.has(row.id) && canManageUser(actor, row);
    if (!manageable) {
      return blockedEntry(ref, 'users', `user #${ref.id}`, 'foreign', 'This account is outside your tenant scope.');
    }
    if (row.level === 'admin') {
      return blockedEntry(ref, 'users', row.username, 'admin_protected', 'Administrator accounts cannot be changed in bulk.');
    }
    return evaluateUserAction(actor, ref, row, action, value);
  }
  const row = get('SELECT * FROM domains WHERE id = ?', ref.id);
  if (!row) return blockedEntry(ref, 'domains', `domain #${ref.id}`, 'not_found', 'The domain no longer exists.');
  const manageable = scope.has(row.id) && canManageDomain(actor, row);
  if (!manageable) {
    return blockedEntry(ref, 'domains', `domain #${ref.id}`, 'foreign', 'This domain is outside your tenant scope.');
  }
  return evaluateDomainAction(actor, ref, row, action, value);
}

function summarizePreview(action, spec, objectType, value, results) {
  const entries = results.map((result) => result.entry);
  const eligible = entries.filter((entry) => entry.eligible);
  const blocked = entries.filter((entry) => !entry.eligible);
  const effects = [...new Set(eligible.flatMap((entry) => entry.effects || []))];
  const downtimeMinutes = eligible.reduce((max, entry) => Math.max(max, Number(entry.downtimeMinutes) || 0), 0);
  const diskMb = Math.round(eligible.reduce((total, entry) => total + (Number(entry.diskMb) || 0), 0));
  return {
    action,
    actionLabel: spec.label,
    objectType,
    count: entries.length,
    eligible: eligible.length,
    blocked: blocked.length,
    eligibleCount: eligible.length,
    blockedCount: blocked.length,
    value: publicValue(action, value),
    objects: entries,
    effects,
    estimate: {
      downtimeMinutes,
      diskMb,
      downtimeText: downtimeMinutes
        ? `${downtimeMinutes} minute(s) of intermittent service while configuration reloads.`
        : 'No planned downtime.',
      diskText: diskMb
        ? `About ${diskMb} MB of additional archive disk after the jobs run.`
        : 'No additional disk footprint.',
    },
  };
}

function parseBatchObjects(raw) {
  const parsed = safeJson(raw, []);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((entry) => ({
      id: typeof entry?.id === 'number' ? entry.id : String(entry?.id ?? ''),
      valid: entry?.valid !== false && (typeof entry?.id === 'number' || /^\d+$/.test(String(entry?.id ?? ''))),
    }))
    .filter((entry) => entry.id !== '')
    .slice(0, MAX_BULK_OBJECTS);
}

function resolveDeps(overrides = {}) {
  return {
    createUserBackupJob,
    spawnJobRunner,
    enqueueAcme,
    audit,
    applyPhp: () => applyConfig({ pools: true, web: true }),
    ...overrides,
  };
}

function recordAudit(deps, actor, action, target, ip, warnings) {
  try {
    deps.audit(actor.username, actor.level, action, target, ip || '');
    return true;
  } catch (error) {
    warnings.push(`Audit write failed: ${error.message}`);
    return false;
  }
}

function storedReport(batch) {
  if (!batch?.report) return null;
  const report = safeJson(batch.report, null);
  return report && typeof report === 'object' ? report : null;
}

/**
 * Build a preview batch. Returns { ok, batchId, token, expiresAt, preview }.
 * Every selected id is validated against the live database and the actor's
 * tenant scope; invalid/foreign/admin/blocked objects appear in preview.objects.
 */
export function previewBulkAction(actor, input = {}, {
  csrf = '', ip = '', now = Date.now(), deps = {},
} = {}) {
  ensureBulkSchema();
  const gate = actorProblem(actor);
  if (gate) return gate;

  const action = String(input.action ?? '').trim().toLowerCase();
  const spec = actionSpec(action);
  if (!spec) return fail('unknown_action', `Unknown bulk action: ${action || '(empty)'}.`);
  const suppliedType = input.objectType ?? input.type;
  const objectType = suppliedType ? normalizeObjectType(suppliedType) : spec.objectType;
  if (!objectType) return fail('unknown_object_type', 'Object type must be users or domains.');
  if (objectType !== spec.objectType) {
    return fail('object_type_mismatch', `${spec.label} can only run on ${spec.objectType}.`);
  }

  const refs = normalizeBulkIds(input.ids ?? input.selected ?? input['selected[]']);
  if (!refs.length) return fail('no_selection', 'Select at least one object.');
  if (refs.length > MAX_BULK_OBJECTS) {
    return fail('too_many_objects', `Select at most ${MAX_BULK_OBJECTS} objects.`);
  }

  const valueCheck = normalizeValue(action, input, actor);
  if (!valueCheck.ok) return valueCheck;
  const value = valueCheck.value;

  const scope = scopeFor(actor, objectType);
  const results = refs.map((ref) => evaluateObject(actor, objectType, ref, action, value, scope));
  const preview = summarizePreview(action, spec, objectType, value, results);

  const timestamp = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const ttlMs = bulkTokenTtlSeconds() * 1000;
  const expiresAt = timestamp + ttlMs;
  const batchId = `bulk_${crypto.randomBytes(12).toString('hex')}`;
  const token = signBulkToken({
    batchId, actor, action, objectType, expiresAt, csrf,
  });

  run(
    `INSERT INTO bulk_action_batches
       (id, actor, actor_id, actor_level, action, object_type, value, status, objects, preview, report,
        token_hash, token_expires_at, csrf_hash, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    batchId,
    actor.username,
    actor.id,
    actor.level,
    action,
    objectType,
    JSON.stringify(value),
    'preview',
    JSON.stringify(refs),
    JSON.stringify(preview),
    null,
    sha256(token),
    new Date(expiresAt).toISOString(),
    sha256(csrf),
    nowIso(),
  );

  const auditWarnings = [];
  recordAudit(resolveDeps(deps), actor, 'bulk.preview', `${action}:${batchId}`, ip, auditWarnings);
  return {
    ok: true,
    batchId,
    token,
    expiresAt: new Date(expiresAt).toISOString(),
    preview,
    count: preview.count,
    eligible: preview.eligible,
    blocked: preview.blocked,
    ...(auditWarnings.length ? { warnings: auditWarnings } : {}),
  };
}

function failure(code, message, details = {}) {
  return { ok: false, code, message, details };
}

function executeObject(actor, action, value, row, context, deps) {
  if (action === 'suspend') {
    const reason = value.reason || `Bulk action by ${actor.username}`;
    run('UPDATE users SET suspended = 1, suspended_reason = ? WHERE id = ?', String(reason).slice(0, 300), row.id);
    return { ok: true, message: `Suspended ${row.username}.`, details: { account: row.username, suspended: true } };
  }
  if (action === 'activate') {
    run('UPDATE users SET suspended = 0, suspended_reason = NULL WHERE id = ?', row.id);
    return { ok: true, message: `Activated ${row.username}.`, details: { account: row.username, suspended: false } };
  }
  if (action === 'package') {
    const pkg = get('SELECT * FROM packages WHERE name = ?', value.package);
    if (!pkg) return failure('package_missing', `Package ${value.package} no longer exists.`);
    run('UPDATE users SET package = ? WHERE id = ?', pkg.name, row.id);
    return {
      ok: true,
      message: `Changed ${row.username} to package ${pkg.name}.`,
      details: { account: row.username, package: pkg.name },
    };
  }
  if (action === 'backup') {
    const created = deps.createUserBackupJob(row, value.kind, { actor: actor.username });
    if (!created || created.ok === false || !created.jobId) {
      return failure('backup_failed', created?.error || 'The backup job could not be created.');
    }
    let runner = { ok: true };
    try {
      runner = deps.spawnJobRunner(created.jobId) || { ok: true };
    } catch (error) {
      runner = { ok: false, error: error.message };
    }
    const warnings = runner.ok === false
      ? [`Backup job #${created.jobId} is queued but the runner was not started (${runner.error || 'spawn failed'}); the scheduler will pick it up.`]
      : [];
    return {
      ok: true,
      message: `Queued backup job #${created.jobId} for ${row.username}.`,
      details: {
        account: row.username,
        jobId: created.jobId,
        kind: value.kind,
        reused: !!created.reused,
        runner: runner.ok === false ? 'deferred' : 'spawned',
      },
      warnings,
    };
  }
  if (action === 'message') {
    run(
      'INSERT INTO messages(level, username, subject, body, created_at) VALUES(?,?,?,?,?)',
      row.level,
      row.username,
      value.subject,
      value.body,
      nowIso(),
    );
    return {
      ok: true,
      message: `Message "${value.subject}" added for ${row.username}.`,
      details: { account: row.username, subject: value.subject },
    };
  }
  if (action === 'ssl') {
    const queued = deps.enqueueAcme(row.name, {
      username: row.username,
      actorLevel: actor.level,
      email: actor.email || '',
      mode: value.mode,
      source: 'bulk',
      reason: `bulk:${context.batchId}`,
    });
    if (!queued || queued.ok === false) {
      return failure('ssl_failed', queued?.error || 'The SSL request could not be queued.');
    }
    return {
      ok: true,
      message: queued.reused
        ? `Reused the active ACME job for ${row.name}.`
        : `Queued an ACME certificate request for ${row.name}.`,
      details: { domain: row.name, entryId: queued.entry?.id || '', reused: !!queued.reused, mode: value.mode },
    };
  }
  if (action === 'php') {
    run('UPDATE domains SET php_version = ? WHERE id = ?', value.php, row.id);
    return {
      ok: true,
      message: `Changed ${row.name} to PHP ${value.php}.`,
      details: { domain: row.name, php: value.php },
    };
  }
  return failure('unsupported_action', `Unsupported bulk action: ${action}.`);
}

function reportMessage(status, totals, maintenance = null) {
  if (status === 'succeeded') return `Completed: all ${totals.succeeded} selected object(s) were changed.`;
  if (status === 'partial') {
    if (maintenance && maintenance.ok === false && totals.failed === 0 && totals.blocked === 0) {
      return `All ${totals.succeeded} object(s) were changed, but ${maintenance.detail}`;
    }
    return `Partial success: ${totals.succeeded} of ${totals.selected} object(s) changed; `
      + `${totals.failed} failed and ${totals.blocked} blocked. Review the report below.`;
  }
  if (status === 'blocked') {
    return `No objects were changed: all ${totals.blocked} selected object(s) were blocked.`;
  }
  return `No objects were changed: ${totals.failed} failed and ${totals.blocked} blocked.`;
}

function buildReport({
  batch, preview, results, status, totals, warnings, maintenance, startedAt, finishedAt,
}) {
  const selected = totals.selected;
  const ok = status === 'succeeded' && selected > 0 && totals.succeeded === selected;
  return {
    batchId: batch.id,
    action: batch.action,
    actionLabel: preview?.actionLabel || batch.action,
    objectType: batch.object_type,
    status,
    ok,
    fullSuccess: ok,
    message: reportMessage(status, totals, maintenance),
    totals,
    objects: results,
    effects: preview?.effects || [],
    estimate: preview?.estimate || { downtimeMinutes: 0, diskMb: 0 },
    warnings,
    maintenance: maintenance || null,
    startedAt,
    finishedAt,
    appliedAt: finishedAt,
  };
}

/**
 * Apply a preview batch. The token is verified against the server secret and
 * the current session CSRF, then every object is revalidated and executed
 * independently. Repeated calls with the same token return the stored report
 * instead of enqueueing backups/SSL jobs/messages again.
 */
export function applyBulkAction(actor, token, {
  csrf = null, ip = '', now = Date.now(), deps = {},
} = {}) {
  ensureBulkSchema();
  const gate = actorProblem(actor);
  if (gate) return gate;
  if (!token) return fail('missing_token', 'The confirmation token is required.', 400);

  const verified = verifyBulkToken(token, actor, { csrf, now, enforceExpiry: false });
  if (!verified.ok) return verified;

  const batch = get('SELECT * FROM bulk_action_batches WHERE id = ?', verified.payload.b);
  if (!batch) return fail('batch_not_found', 'This preview batch no longer exists.', 404);
  if (!hashEquals(batch.token_hash, sha256(String(token)))) {
    return fail('invalid_token', 'The confirmation token does not match this batch.', 403);
  }
  if (Number(batch.actor_id) !== Number(actor.id) || String(batch.actor_level) !== String(actor.level)) {
    return fail('token_actor_mismatch', 'This confirmation token belongs to a different actor.', 403);
  }
  if (String(verified.payload.ac) !== String(batch.action) || String(verified.payload.ot) !== String(batch.object_type)) {
    return fail('invalid_token', 'The confirmation token does not match this batch action.', 403);
  }

  const replay = storedReport(batch);
  if (replay) {
    return {
      ok: !!replay.ok,
      reused: true,
      batchId: batch.id,
      report: replay,
      status: replay.status,
      totals: replay.totals,
    };
  }
  if (Date.parse(batch.token_expires_at) <= Number(now)) {
    return fail('token_expired', 'This preview has expired. Build a new preview before applying.', 400);
  }

  const spec = actionSpec(batch.action);
  if (!spec) return fail('batch_corrupt', 'The stored batch action is not recognized.', 500);
  if (batch.status !== 'preview') {
    return fail('already_applying', 'This preview is already being applied. Reload its report instead of retrying.', 409);
  }
  const claim = run("UPDATE bulk_action_batches SET status = 'applying' WHERE id = ? AND status = 'preview'", batch.id);
  if (!claim.changes) {
    const fresh = get('SELECT * FROM bulk_action_batches WHERE id = ?', batch.id);
    const freshReport = storedReport(fresh);
    if (freshReport) {
      return {
        ok: !!freshReport.ok,
        reused: true,
        batchId: fresh.id,
        report: freshReport,
        status: freshReport.status,
        totals: freshReport.totals,
      };
    }
    return fail('already_applying', 'This preview is already being applied. Reload its report instead of retrying.', 409);
  }

  const runtime = resolveDeps(deps);
  const startedAt = nowIso();
  const warnings = [];
  const preview = safeJson(batch.preview, {}) || {};
  const refs = parseBatchObjects(batch.objects);
  const storedValue = safeJson(batch.value, null);
  const scope = scopeFor(actor, batch.object_type);
  const results = [];
  let succeeded = 0;
  let failed = 0;
  let blocked = 0;
  let maintenance = null;

  const valueCheck = validateValue(batch.action, storedValue, actor);
  if (!valueCheck.ok) {
    for (const ref of refs) {
      blocked += 1;
      results.push({
        id: ref.id,
        kind: objectTypeLabel(batch.object_type),
        label: `#${ref.id}`,
        ok: false,
        blocked: true,
        code: valueCheck.code,
        message: valueCheck.error,
        details: {},
      });
    }
  } else {
    const value = valueCheck.value;
    for (const ref of refs) {
      const evaluated = evaluateObject(actor, batch.object_type, ref, batch.action, value, scope);
      const entry = evaluated.entry;
      if (!entry.eligible) {
        blocked += 1;
        results.push({
          id: entry.id,
          kind: entry.kind,
          label: entry.label,
          ok: false,
          blocked: true,
          code: entry.code,
          message: entry.reason,
          details: {},
        });
        continue;
      }
      const targetLabel = batch.object_type === 'domains' ? evaluated.row.name : evaluated.row.username;
      let outcome;
      try {
        outcome = executeObject(actor, batch.action, value, evaluated.row, { batchId: batch.id }, runtime);
      } catch (error) {
        outcome = failure('execution_failed', error.message || 'The operation failed.');
      }
      if (outcome.ok) {
        succeeded += 1;
        warnings.push(...(outcome.warnings || []));
        recordAudit(runtime, actor, `bulk.${batch.action}`, targetLabel, ip, warnings);
        results.push({
          id: entry.id,
          kind: entry.kind,
          label: entry.label,
          ok: true,
          blocked: false,
          code: null,
          message: outcome.message,
          details: outcome.details || {},
        });
      } else {
        failed += 1;
        recordAudit(runtime, actor, `bulk.${batch.action}.failed`, targetLabel, ip, warnings);
        results.push({
          id: entry.id,
          kind: entry.kind,
          label: entry.label,
          ok: false,
          blocked: false,
          code: outcome.code,
          message: outcome.message,
          details: outcome.details || {},
        });
      }
    }

    if (batch.action === 'php' && succeeded > 0) {
      try {
        const applied = runtime.applyPhp();
        const ok = applied?.ok !== false;
        maintenance = {
          ok,
          detail: ok
            ? 'PHP-FPM pools and vhosts were reloaded.'
            : 'the PHP configuration reload reported errors. Review the panel apply log.',
        };
        if (!ok) warnings.push('The PHP configuration reload reported errors. Review the panel apply log.');
      } catch (error) {
        maintenance = { ok: false, detail: `the PHP configuration reload failed: ${error.message}` };
        warnings.push(maintenance.detail);
      }
    }
  }

  const totals = { selected: refs.length, eligible: refs.length - blocked, succeeded, failed, blocked };
  let status = 'failed';
  if (refs.length > 0 && succeeded === refs.length) status = 'succeeded';
  else if (succeeded === 0 && blocked === refs.length) status = 'blocked';
  else if (succeeded > 0) status = 'partial';
  // A PHP version update is only fully effective after the configuration
  // reload. A failed reload is a partial outcome, never a full success.
  if (status === 'succeeded' && maintenance && maintenance.ok === false) status = 'partial';

  const finishedAt = nowIso();
  const report = buildReport({
    batch, preview, results, status, totals, warnings, maintenance, startedAt, finishedAt,
  });

  try {
    run(
      "UPDATE bulk_action_batches SET status = 'applied', report = ?, applied_at = ? WHERE id = ?",
      JSON.stringify(report),
      finishedAt,
      batch.id,
    );
  } catch (error) {
    return fail('apply_failed', `The report could not be stored: ${error.message}`, 500);
  }
  try {
    runtime.audit(
      actor.username,
      actor.level,
      'bulk.apply',
      `${batch.action}:${batch.id}:${status}:${succeeded}/${refs.length}`,
      ip || '',
    );
  } catch { /* the per-object audits are authoritative; the summary is best effort */ }
  return {
    ok: report.ok,
    reused: false,
    batchId: batch.id,
    report,
    status: report.status,
    totals: report.totals,
  };
}

/** Safe rows for the GET selection page. Admin accounts are never offered for
 *  bulk operations; resellers only see their own customer accounts/domains. */
export function listBulkTargets(actor, {
  objectType = 'users', q = '', state = '', limit = MAX_BULK_OBJECTS,
} = {}) {
  ensureBulkSchema();
  const gate = actorProblem(actor);
  if (gate) return gate;
  const type = normalizeObjectType(objectType);
  if (!type) return fail('unknown_object_type', 'Object type must be users or domains.');
  const search = String(q ?? '').trim().toLowerCase().slice(0, 80);
  const wantedState = String(state ?? '').trim().toLowerCase();
  const cap = Math.min(MAX_BULK_OBJECTS, Math.max(1, Number(limit) || MAX_BULK_OBJECTS));

  let rows;
  if (type === 'users') {
    rows = visibleUsers(actor)
      .filter((row) => row.level !== 'admin')
      .map((row) => ({
        id: row.id,
        label: row.username,
        username: row.username,
        email: row.email || '',
        level: row.level,
        package: row.package || '',
        owner: row.owner || '',
        suspended: !!row.suspended,
        status: row.suspended ? 'suspended' : 'active',
        created_at: row.created_at,
        last_login: row.last_login,
      }))
      .filter((row) => !search
        || row.username.toLowerCase().includes(search)
        || row.email.toLowerCase().includes(search)
        || row.package.toLowerCase().includes(search));
  } else {
    rows = visibleDomains(actor).map((row) => ({
      id: row.id,
      label: row.name,
      name: row.name,
      username: row.username,
      docroot: row.docroot || '',
      php_version: row.php_version || '',
      ssl: !!row.ssl,
      status: row.status || 'active',
      disk_mb: Number(row.disk_mb) || 0,
    })).filter((row) => !search
      || row.name.toLowerCase().includes(search)
      || row.username.toLowerCase().includes(search)
      || row.docroot.toLowerCase().includes(search));
  }
  if (wantedState === 'active' || wantedState === 'suspended') {
    rows = rows.filter((row) => row.status === wantedState);
  }
  const total = rows.length;
  return {
    ok: true,
    objectType: type,
    actions: bulkActionsFor(type),
    rows: rows.slice(0, cap),
    total,
    shown: Math.min(total, cap),
    truncated: total > cap,
    query: search,
    state: wantedState,
  };
}
