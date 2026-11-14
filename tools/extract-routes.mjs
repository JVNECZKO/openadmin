// Extract the DirectAdmin Evolution route table + navigation metadata from the
// captured bundle and write src/compat/manifest.json for the compatibility layer.
import fs from 'node:fs';
import path from 'node:path';

const root = new URL('../recon/', import.meta.url);
const files = ['index.js', ...fs.readdirSync(new URL('evo/', root)).filter((f) => f.endsWith('.js')).map((f) => 'evo/' + f)];
const routes = [];
const seen = new Set();
const nav = [];

for (const file of files) {
  const src = fs.readFileSync(new URL(file, root), 'utf8');
  // Split on route objects: `{name:v.ROUTE_NAME` (also handles {name:$...).
  for (const raw of src.split('{name:')) {
    const head = raw.slice(0, 3200);
    const m = /^[A-Za-z_$][\w$]*\.([A-Z][A-Z0-9_]+)/.exec(head);
    if (!m) continue;
    const name = m[1];
    if (!head.includes('path:`')) continue;
    const pathStr = /path:`([^`]*)`/.exec(head)?.[1] || '';
    const aliases = [...head.matchAll(/`(\/(?:user|reseller|admin|CMD_)[^`]*)`/g)].map((x) => x[1]);
    const title = /title:\(\)=>[A-Za-z_$][\w$]*\(`([^`]+)`\)/.exec(head)?.[1]
      || /title:`([^`]+)`/.exec(head)?.[1] || null;
    const level = /level:`(user|reseller|admin)`/.exec(head)?.[1] || null;
    const commands = [...new Set([...head.matchAll(/y\.([A-Z0-9_]+)/g)].map((x) => 'CMD_' + x[1]))];
    const needsDomain = /needsDomain:!0/.test(head);
    const urls = aliases.filter((a) => !a.startsWith('/CMD_')).map((a) => a.replace(/\/+$/, '') || '/');
    if (!urls.length && pathStr.startsWith('/') && !pathStr.startsWith('/CMD_')) urls.push(pathStr.replace(/\/+$/, '') || '/');
    for (const url of urls) {
      const key = url;
      if (seen.has(key)) {
        const prev = routes.find((r) => r.url === key);
        if (prev) {
          prev.title ||= title;
          prev.commands = [...new Set([...prev.commands, ...commands])];
          prev.legacy = [...new Set([...prev.legacy, ...aliases.filter((a) => a.startsWith('/CMD_'))])];
        }
        continue;
      }
      seen.add(key);
      routes.push({
        name, url, title, level: level || url.split('/')[1] || null,
        commands, legacy: [...new Set(aliases.filter((a) => a.startsWith('/CMD_')))], needsDomain,
      });
    }
  }
  // Navigation metadata: [j.ROUTE]:{id:j.ROUTE,icon:`name`,enabled:!0,position:n}
  for (const mm of src.matchAll(/\[[a-z]\.([A-Z0-9_]+)\]:\{id:[a-z]\.\1,icon:`([a-z0-9-]+)`,enabled:(!0|!1),position:(\d+)\}/g)) {
    nav.push({ route: mm[1], icon: mm[2], enabled: mm[3] === '!0', position: Number(mm[4]) });
  }
}

routes.sort((a, b) => a.url.localeCompare(b.url));
fs.mkdirSync(new URL('../src/compat/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('../src/compat/manifest.json', import.meta.url), JSON.stringify(routes, null, 2));
fs.writeFileSync(new URL('../src/compat/nav.json', import.meta.url), JSON.stringify(nav, null, 2));
const byLevel = {};
for (const r of routes) byLevel[r.level] = (byLevel[r.level] || 0) + 1;
console.log('files:', files.length, 'routes:', routes.length, 'titled:', routes.filter((r) => r.title).length,
  'commands:', new Set(routes.flatMap((r) => r.commands)).size, 'nav:', nav.length);
console.log(byLevel);
console.log(routes.filter((r) => r.title).slice(0, 15).map((r) => `${r.level}\t${r.url}\t${r.title}\t${r.commands.join(',')}`).join('\n'));
