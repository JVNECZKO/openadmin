// One place that applies staged configuration to the live system. Every
// user-facing mutation calls this so a non-technical operator never has to
// find several "Deploy" buttons.
import { setting, setSetting, nowIso } from './db.mjs';
import { activeServer, generateAll, deploy } from './webserver.mjs';
import { rebuildAll, deployZones } from './dns.mjs';
import { deployMail } from './mail.mjs';
import { deployPools } from './phpfpm.mjs';

function record(result) {
  const at = nowIso();
  setSetting('last_apply_at', at);
  setSetting('last_apply_ok', result.ok ? '1' : '0');
  setSetting('last_apply_output', JSON.stringify(result.steps).slice(0, 4000));
  setSetting('apply_pending', '0');
  return { ...result, at };
}

export function markPending(reason = '') {
  setSetting('apply_pending', '1');
  if (reason) setSetting('apply_pending_reason', reason);
}

export function applyWeb() {
  const server = activeServer();
  try {
    const generated = generateAll(server.id);
    const deployed = deploy(server.id);
    return { ok: !!deployed.ok, steps: [{ part: 'web', server: server.id, generated: generated.total, ...deployed }] };
  } catch (e) {
    return { ok: false, steps: [{ part: 'web', error: e.message }] };
  }
}

export function applyDns() {
  try {
    const rebuilt = rebuildAll();
    const deployed = deployZones();
    return { ok: !!deployed.ok, steps: [{ part: 'dns', rebuilt: rebuilt.count, ...deployed }] };
  } catch (e) {
    return { ok: false, steps: [{ part: 'dns', error: e.message }] };
  }
}

export function applyMail() {
  try {
    const result = deployMail();
    return { ok: !!result.ok, steps: [{ part: 'mail', ...result, output: result.output }] };
  } catch (e) {
    return { ok: false, steps: [{ part: 'mail', error: e.message }] };
  }
}

export function applyPools() {
  try {
    const result = deployPools();
    return { ok: !!result.ok, steps: [{ part: 'php', ...result }] };
  } catch (e) {
    return { ok: false, steps: [{ part: 'php', error: e.message }] };
  }
}

/** Apply any combination and remember the result for the UI. */
export function apply({ web = false, dns = false, mail = false, pools = false } = {}) {
  const steps = [];
  let ok = true;
  if (pools) { const r = applyPools(); ok = ok && r.ok; steps.push(...r.steps); }
  if (web) { const r = applyWeb(); ok = ok && r.ok; steps.push(...r.steps); }
  if (dns) { const r = applyDns(); ok = ok && r.ok; steps.push(...r.steps); }
  if (mail) { const r = applyMail(); ok = ok && r.ok; steps.push(...r.steps); }
  return record({ ok, steps });
}

export function applyAll() {
  return apply({ pools: true, web: true, dns: true, mail: true });
}

export function applyStatus() {
  let last = [];
  try { last = JSON.parse(setting('last_apply_output', '[]')); } catch { last = []; }
  return {
    pending: setting('apply_pending', '0') === '1',
    reason: setting('apply_pending_reason', ''),
    lastAt: setting('last_apply_at', ''),
    ok: setting('last_apply_ok', '') === '1',
    last,
  };
}
