// One source of truth for account home locations. The sandbox keeps homes under
// the data directory; the Linux provider uses the real /home layout that the
// generated vhosts and mail configuration already reference.
import path from 'node:path';
import { config } from './config.mjs';

export function homeRoot() {
  return config.provider === 'linux' ? '/home' : path.join(config.dataDir, 'homes');
}

export function userHome(username) {
  return path.join(homeRoot(), String(username));
}

export function virtualMailRoot() {
  return config.provider === 'linux' ? '/var/mail/virtual' : path.join(config.dataDir, 'homes');
}

/** Maildir for one account: /var/mail/virtual on Linux, under the home in sandbox. */
export function mailHome(username, domain, local) {
  if (config.provider === 'linux') return path.join(virtualMailRoot(), domain, local);
  return path.join(userHome(username), 'mail', domain, local);
}
