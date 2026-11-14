// Crawl every DirectAdmin route in the manifest and report status.
import fs from 'node:fs';
import path from 'node:path';
const base = process.env.BASE || 'http://127.0.0.1:2222';
const cookie = process.env.COOKIE || '';
const manifest = JSON.parse(fs.readFileSync('src/compat/manifest.json', 'utf8'));
const seen = new Set();
const failures = [];
const samples = { ':tab': 'general', ':database': 'demo', ':pathMatch(.*)*': 'nope' };
for (const r of manifest) {
  let url = r.url;
  for (const [k, v] of Object.entries(samples)) url = url.replace(k + (url.includes(k + '?') ? '?' : ''), v);
  if (url.includes(':')) continue;
  if (url === '/') continue;
  if (seen.has(url)) continue;
  seen.add(url);
  const res = await fetch(base + url, { headers: cookie ? { Cookie: cookie } : {}, redirect: 'manual' });
  const html = res.status === 200 ? await res.text() : '';
  const expected403 = res.status === 403;
  const bad = (!(res.status === 200 || res.status === 302 || expected403) || /Something went wrong/.test(html)) && !url.includes('pathMatch') && url !== '/nope';
  if (bad) failures.push({ url, status: res.status, title: r.title });
}
console.log(`checked ${seen.size} routes, ${failures.length} problems`);
for (const f of failures) console.log(`  ${f.status} ${f.url} ${f.title ? '— ' + f.title : ''}`);
