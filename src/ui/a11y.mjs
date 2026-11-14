// Last-mile accessibility hardening for legacy server-rendered forms.
// Adds ids/aria-labels and alt text only; never changes names, values or actions.
const SKIP_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image']);

function attr(attrs, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs);
  return m ? (m[2] ?? m[3] ?? m[4] ?? '') : null;
}

function putAttr(attrs, name, value) {
  if (attr(attrs, name) !== null) return attrs;
  return `${attrs} ${name}="${String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`;
}

function humanize(name) {
  return String(name || 'field')
    .replace(/\[.*?\]/g, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (c) => c.toUpperCase()) || 'Pole';
}

export function enhanceFormA11y(markup) {
  const source = String(markup ?? '');
  let seq = 0;
  const used = new Set([...source.matchAll(/\bid\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]));
  const nextId = () => {
    let id;
    do { id = `oa-auto-${++seq}`; } while (used.has(id));
    used.add(id);
    return id;
  };

  let html = source.replace(/<(input|select|textarea)\b([^>]*)>/gi, (whole, tag, attrs, offset) => {
    const type = String(attr(attrs, 'type') || (tag.toLowerCase() === 'input' ? 'text' : '')).toLowerCase();
    if (tag.toLowerCase() === 'input' && SKIP_TYPES.has(type)) return whole;
    let out = attrs;
    let id = attr(out, 'id');
    if (!id) { id = nextId(); out = putAttr(out, 'id', id); }
    if (attr(out, 'aria-label') !== null || attr(out, 'aria-labelledby') !== null) return `<${tag}${out}>`;

    const before = source.slice(Math.max(0, offset - 700), offset);
    const labels = [...before.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/gi)];
    const last = labels[labels.length - 1];
    const labelFor = last ? attr(last[1], 'for') : null;
    if (last && (labelFor === id || (!labelFor && !/<(input|select|textarea)\b/i.test(before.slice(last.index + last[0].length))))) {
      const labelText = last[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (labelText) out = putAttr(out, 'aria-label', labelText);
      return `<${tag}${out}>`;
    }
    const name = attr(out, 'name') || attr(out, 'placeholder') || '';
    out = putAttr(out, 'aria-label', humanize(name));
    if (!attr(out, 'autocomplete') && (type === 'password' || /pass/i.test(name))) out = putAttr(out, 'autocomplete', 'current-password');
    return `<${tag}${out}>`;
  });

  html = html.replace(/<img\b([^>]*)>/gi, (m, attrs) => (attr(attrs, 'alt') === null ? `<img${attrs} alt="">` : m));
  return html;
}
