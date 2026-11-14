// Self-service password reset by email.
import crypto from 'node:crypto';
import { config } from './config.mjs';
import { get, run, nowIso, setting } from './db.mjs';
import { sendMail, mtaStatus } from './mta.mjs';

const TTL_MS = 60 * 60 * 1000;

function hash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

export function panelBaseUrl() {
  const host = setting('panel_hostname', setting('server_name', 'localhost'));
  const https = setting('panel_https', '0') === '1';
  return `${https ? 'https' : 'http'}://${host}:${config.port}`;
}

export function createResetToken(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  run('DELETE FROM password_resets WHERE user_id = ? OR expires_at < ?', userId, nowIso());
  run('INSERT INTO password_resets(token_hash, user_id, expires_at, created_at) VALUES(?,?,?,?)',
    hash(token), userId, new Date(Date.now() + TTL_MS).toISOString(), nowIso());
  return token;
}

export function resetLink(token) {
  return `${panelBaseUrl()}/reset-password?token=${encodeURIComponent(token)}`;
}

/** Send the reset mail. Returns ok plus a reason for the UI/log. */
export function requestPasswordReset(user) {
  if (!user?.email) return { ok: false, reason: 'no-email' };
  if (!mtaStatus().available) return { ok: false, reason: 'no-mta' };
  const token = createResetToken(user.id);
  const body = [
    `Hello ${user.username},`,
    '',
    'A password reset was requested for your OpenAdmin account.',
    `Open this link within one hour: ${resetLink(token)}`,
    '',
    'If you did not request it, ignore this message.',
  ].join('\n');
  const sent = sendMail({
    from: `no-reply@${setting('server_name', 'localhost')}`,
    to: user.email,
    subject: 'Reset your OpenAdmin password',
    body,
  });
  return { ok: sent.ok, reason: sent.output, token: sent.ok ? token : null };
}

export function verifyResetToken(token) {
  if (!token) return null;
  const row = get('SELECT * FROM password_resets WHERE token_hash = ?', hash(token));
  if (!row || row.used_at || new Date(row.expires_at) < new Date()) return null;
  return row;
}

export function consumeResetToken(row) {
  run('UPDATE password_resets SET used_at = ? WHERE token_hash = ?', nowIso(), row.token_hash);
  run('DELETE FROM password_resets WHERE user_id = ?', row.user_id);
}
