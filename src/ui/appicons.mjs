// Brand-style inline logos for the application catalogue. Original simplified
// artwork (no external assets, no network requests). The outer squircle scales
// with the requested size and carries a subtle rim so the tile reads well on
// both the light and the dark surface.
import { raw } from '../util.mjs';

const META = {
  wordpress: { bg: '#21759b', fg: '#ffffff', label: 'WordPress' },
  nextcloud: { bg: '#0082c9', fg: '#ffffff', label: 'Nextcloud' },
  prestashop: { bg: '#df0067', fg: '#ffffff', label: 'PrestaShop' },
  joomla: { bg: '#f44321', fg: '#ffffff', label: 'Joomla' },
  drupal: { bg: '#0678be', fg: '#ffffff', label: 'Drupal' },
  moodle: { bg: '#f98012', fg: '#ffffff', label: 'Moodle' },
  generic: { bg: '#0a6daa', fg: '#ffffff', label: 'Aplikacja' },
};

function glyph(key, fg) {
  switch (key) {
    case 'wordpress':
      return `<circle cx="20" cy="20" r="14.2" fill="none" stroke="${fg}" stroke-width="2.1"/>
        <path d="M11 15.2h3l3.3 9.5 2.2-6.2-1.5-3.3h2.8l3.1 9.5 2.2-9.5h2.7l-3.8 12.4h-2.9l-2.5-7.2-2.6 7.2H16Z" fill="${fg}"/>`;
    case 'nextcloud':
      return `<path d="M12.4 27.5a6.2 6.2 0 0 1-.6-12.3 8.3 8.3 0 0 1 15.8 2.4 5.7 5.7 0 0 1-.5 9.9Z" fill="none" stroke="${fg}" stroke-width="2.2" stroke-linejoin="round"/>
        <path d="M9 21.5h5M26 24h4" stroke="${fg}" stroke-width="2.2" stroke-linecap="round"/>`;
    case 'prestashop':
      return `<path d="M11 17h18l-1.7 12H12.7Z" fill="none" stroke="${fg}" stroke-width="2.1" stroke-linejoin="round"/>
        <path d="M15 17v-3.4a5 5 0 0 1 10 0V17" fill="none" stroke="${fg}" stroke-width="2.1"/>
        <path d="M17.5 21.5h5.2a2.3 2.3 0 0 1 0 4.6h-5.2v-6.4m0 6.4V28" fill="none" stroke="${fg}" stroke-width="2" stroke-linecap="round"/>`;
    case 'joomla':
      return `<path d="M12 16.7a4.3 4.3 0 0 1 6.1-6.1l4.6 4.6M28 23.3a4.3 4.3 0 0 1-6.1 6.1l-4.6-4.6M28 16.7a4.3 4.3 0 0 0-6.1-6.1L16 16.4M12 23.3a4.3 4.3 0 0 0 6.1 6.1l5.9-5.8" fill="none" stroke="${fg}" stroke-width="2.2" stroke-linecap="round"/>
        <circle cx="20" cy="20" r="2.2" fill="${fg}"/>`;
    case 'drupal':
      return `<path d="M20 7c4 4.4 7.6 7.6 7.6 12.1A7.6 7.6 0 0 1 20 27a7.6 7.6 0 0 1-7.6-7.9C12.4 14.6 16 11.4 20 7Z" fill="none" stroke="${fg}" stroke-width="2.2" stroke-linejoin="round"/>
        <path d="M16.8 21.8a3.2 3.2 0 0 0 3.2 2.2" fill="none" stroke="${fg}" stroke-width="1.8" stroke-linecap="round"/>`;
    case 'moodle':
      return `<path d="M10 19.2 20 14l10 5.2-10 5.2Z" fill="none" stroke="${fg}" stroke-width="2.1" stroke-linejoin="round"/>
        <path d="M13 21.3v4.4c0 1.7 3.1 3.1 7 3.1s7-1.4 7-3.1v-4.4M30 19.2v7" fill="none" stroke="${fg}" stroke-width="2.1" stroke-linecap="round"/>
        <path d="M20 14v5.2" stroke="${fg}" stroke-width="2.1"/>`;
    default:
      return `<rect x="12" y="12" width="16" height="16" rx="4" fill="none" stroke="${fg}" stroke-width="2.2"/><path d="M16 20h8M20 16v8" stroke="${fg}" stroke-width="2.2" stroke-linecap="round"/>`;
  }
}

function safeKey(key) {
  return Object.hasOwn(META, key) ? key : 'generic';
}

function safeClassNames(cls) {
  return String(cls || '')
    .split(/\s+/)
    .filter((name) => /^[A-Za-z0-9_-]+$/.test(name))
    .join(' ');
}

export function appIcon(key, { size = 44, cls = '' } = {}) {
  const cleanKey = safeKey(key);
  const meta = META[cleanKey];
  const px = Math.max(24, Math.min(96, Math.round(Number(size) || 44)));
  // Keep the squircle proportional at every size (40–52 px in catalogue
  // tiles, 46–52 px on the dashboard and result screens).
  const radius = Math.round(px * 0.26);
  const classes = safeClassNames(cls);
  return raw(`<span class="app-logo${classes ? ' ' + classes : ''}" style="--app-bg:${meta.bg};width:${px}px;height:${px}px;border-radius:${radius}px" data-app-icon="${cleanKey}" aria-hidden="true">
    <svg width="${px}" height="${px}" viewBox="0 0 40 40" focusable="false" aria-hidden="true"><rect width="40" height="40" rx="12" fill="${meta.bg}"/><rect x="0.7" y="0.7" width="38.6" height="38.6" rx="11.3" fill="none" stroke="rgba(255,255,255,.2)" stroke-width="1.4"/>${glyph(cleanKey, meta.fg)}</svg>
  </span>`);
}

export function appName(key) {
  return META[safeKey(key)].label;
}

export const APP_KEYS = ['wordpress', 'nextcloud', 'prestashop', 'joomla', 'drupal', 'moodle'];
