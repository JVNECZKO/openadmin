// Plugin hooks: each enabled plugin may ship a hook.js executed on panel events
// with a JSON payload on stdin. Output is captured to a per-plugin log.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { config } from './config.mjs';
import { all, nowIso } from './db.mjs';

export function pluginRoot(name) {
  return path.join(config.dataDir, 'plugins', name);
}

export function hookScript(name) {
  return path.join(pluginRoot(name), 'hook.js');
}

export function runHooks(event, payload = {}) {
  const plugins = all('SELECT * FROM plugins WHERE enabled = 1 ORDER BY name');
  const results = [];
  for (const p of plugins) {
    const script = hookScript(p.name);
    if (!fs.existsSync(script)) continue;
    const started = Date.now();
    const r = spawnSync('node', [script, event], {
      input: JSON.stringify({ event, at: nowIso(), payload }),
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, OA_EVENT: event, OA_PLUGIN: p.name },
    });
    const result = {
      plugin: p.name, event, ok: r.status === 0, status: r.status,
      output: `${r.stdout || ''}${r.stderr || ''}`.trim().slice(0, 2000),
      ms: Date.now() - started,
    };
    results.push(result);
    try {
      const log = path.join(pluginRoot(p.name), 'hook.log');
      fs.mkdirSync(pluginRoot(p.name), { recursive: true });
      fs.appendFileSync(log, JSON.stringify(result) + '\n');
    } catch { /* logging is best effort */ }
  }
  return results;
}

export function pluginInventory() {
  return all('SELECT * FROM plugins ORDER BY name').map((p) => ({
    ...p,
    script: hookScript(p.name),
    hasHook: fs.existsSync(hookScript(p.name)),
  }));
}
