// QR rendering for 2FA and mail-client setup. Uses the optional qrencode
// utility; when it is missing the caller falls back to the textual secret.
import { spawnSync } from 'node:child_process';

export function qrSvg(text, { size = 220 } = {}) {
  const r = spawnSync('qrencode', ['-t', 'SVG', '-s', '5', '-m', '2', '-o', '-', String(text)], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024,
  });
  if (r.status !== 0 || !r.stdout || !r.stdout.includes('<svg')) return null;
  return r.stdout.replace(/<svg([^>]*)width="[^"]*"([^>]*)height="[^"]*"/, `<svg$1width="${size}"$2height="${size}"`)
    .replace('<svg', '<svg style="background:#fff;border-radius:8px;padding:6px"');
}

export function qrAvailable() {
  return spawnSync('sh', ['-c', 'command -v qrencode'], { encoding: 'utf8' }).status === 0;
}
