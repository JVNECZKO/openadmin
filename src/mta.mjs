// Outbound SMTP submission through a local MTA (sendmail/exim/msmtp).
// The panel never claims a message was sent unless the MTA exited successfully.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const CANDIDATES = [
  '/usr/sbin/sendmail', '/usr/lib/sendmail', '/usr/bin/sendmail',
  '/usr/sbin/exim4', '/usr/sbin/exim', '/usr/bin/msmtp',
];

export function findMta() {
  if (process.env.OA_MTA_BIN) {
    try { fs.accessSync(process.env.OA_MTA_BIN, fs.constants.X_OK); return process.env.OA_MTA_BIN; } catch { /* fall through */ }
  }
  for (const p of CANDIDATES) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  for (const name of ['sendmail', 'exim', 'msmtp']) {
    const r = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return null;
}

function attachmentPart(file, boundary) {
  try {
    const data = fs.readFileSync(file.path);
    const name = String(file.filename || path.basename(file.path)).replace(/[\r\n"]/g, '');
    return [
      `--${boundary}`,
      `Content-Type: ${file.mime || 'application/octet-stream'}; name="${name}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${name}"`,
      '',
      data.toString('base64').replace(/.{1,76}/g, '$&\r\n'),
    ].join('\r\n');
  } catch {
    return null;
  }
}

export function buildMessage({ from, to, subject, body, headers = {}, attachments = [] }) {
  const list = Array.isArray(to) ? to : [to];
  const files = (attachments || []).filter((a) => a && a.path && fs.existsSync(a.path));
  if (files.length) {
    const boundary = `openadmin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const parts = [
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      body || '',
      ...files.map((f) => attachmentPart(f, boundary)).filter(Boolean),
      `--${boundary}--`,
      '',
    ];
    return [
      `From: ${from}`,
      `To: ${list.join(', ')}`,
      `Subject: ${String(subject || '(no subject)').replace(/[\r\n]+/g, ' ')}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@${from.split('@')[1] || 'localhost'}>`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      '',
      ...parts,
    ].join('\r\n');
  }
  const lines = [
    `From: ${from}`,
    `To: ${list.join(', ')}`,
    `Subject: ${String(subject || '(no subject)').replace(/[\r\n]+/g, ' ')}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@${from.split('@')[1] || 'localhost'}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    '',
    body || '',
  ];
  return lines.join('\r\n');
}

export function sendMail({ from, to, subject, body, headers = {}, attachments = [] }) {
  const bin = findMta();
  if (!bin) return { ok: false, output: 'No local MTA found (sendmail/exim/msmtp). Install one to deliver external mail.' };
  const message = buildMessage({ from, to, subject, body, headers, attachments });
  const args = bin.endsWith('msmtp') ? ['--read-envelope-from'] : ['-t', '-f', from];
  const r = spawnSync(bin, args, { input: message, encoding: 'utf8', timeout: 30000 });
  return {
    ok: r.status === 0,
    output: r.status === 0 ? `accepted by ${bin}` : `${bin}: ${(r.stderr || r.stdout || r.error?.message || '').trim().slice(0, 500)}`,
    bin,
  };
}

export function mtaStatus() {
  const bin = findMta();
  return { available: !!bin, bin: bin || null };
}
