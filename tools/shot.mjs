#!/usr/bin/env node
// Headless screenshot helper used for visual QA of the panel.
// Usage: node tools/shot.mjs <url> <out.png> [--cookie name=value]... [--size 1440x1000] [--full] [--dark]
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const args = process.argv.slice(2);
const url = args[0];
const out = args[1] || 'shot.png';
const cookies = [];
let size = [1440, 1000];
let full = false;
let dark = false;
for (let i = 2; i < args.length; i++) {
  if (args[i] === '--cookie') cookies.push(args[++i]);
  else if (args[i] === '--size') size = args[++i].split('x').map(Number);
  else if (args[i] === '--full') full = true;
  else if (args[i] === '--dark') dark = true;
}

const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const port = 9333;
const profile = `/tmp/oa-chrome-${process.pid}`;
const child = spawn(chrome, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--window-size=${size[0]},${size[1]}`, 'about:blank',
], { stdio: 'ignore', detached: false });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(path) {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      if (res.ok) return await res.json();
    } catch { /* retry */ }
    await sleep(150);
  }
  throw new Error('chrome did not start');
}

let ws;
let msgId = 0;
const pending = new Map();
function send(method, params = {}, sessionId) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

try {
  const version = await getJson('/json/version');
  ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
    }
  };

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => send(m, p, sessionId);

  await s('Page.enable');
  await s('Network.enable');
  await s('Network.setCacheDisabled', { cacheDisabled: true });
  await s('Emulation.setDeviceMetricsOverride', { width: size[0], height: size[1], deviceScaleFactor: 1, mobile: false });

  for (const c of cookies) {
    const idx = c.indexOf('=');
    await s('Network.setCookie', {
      name: c.slice(0, idx), value: c.slice(idx + 1),
      domain: new URL(url).hostname, path: '/', httpOnly: true,
    });
  }
  await s('Page.addScriptToEvaluateOnNewDocument', {
    source: `try{localStorage.setItem('oa_theme','${dark ? 'dark' : 'light'}')}catch(e){}`,
  });

  await s('Page.navigate', { url });
  await sleep(900);
  const { data } = await s('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full });
  fs.writeFileSync(out, Buffer.from(data, 'base64'));
  console.log(`saved ${out}`);
} finally {
  try { ws?.close(); } catch { /* ignore */ }
  child.kill();
}
