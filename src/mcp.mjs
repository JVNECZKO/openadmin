// Minimal MCP (Model Context Protocol) server over HTTP, authenticated with
// OpenAdmin API keys. Read-only tools; write tools require a key with scope
// "write" and are intentionally added one by one.
import { all, get, setting } from './db.mjs';
import { VERSION } from './config.mjs';
import { keyFromRequest } from './apikeys.mjs';
import { limitsFor } from './auth.mjs';
import { mailOverview, queueList, diagnose } from './mailops.mjs';
import { securitySummary } from './security.mjs';

const TOOLS = [
  { name: 'list_domains', description: 'List domains visible to the key owner', inputSchema: { type: 'object', properties: {} }, run: (u) => u.level === 'admin' ? all('SELECT name, username, status, php_version FROM domains ORDER BY name') : all('SELECT name, status, php_version FROM domains WHERE user_id = ? ORDER BY name', u.id) },
  { name: 'list_mailboxes', description: 'List mailboxes', inputSchema: { type: 'object', properties: {} }, run: (u) => u.level === 'admin' ? all('SELECT domain, local_part, quota_mb, used_mb, suspended FROM email_accounts ORDER BY domain, local_part') : all('SELECT domain, local_part, quota_mb, used_mb FROM email_accounts WHERE domain IN (SELECT name FROM domains WHERE user_id = ?) ORDER BY domain, local_part', u.id) },
  { name: 'list_databases', description: 'List databases', inputSchema: { type: 'object', properties: {} }, run: (u) => u.level === 'admin' ? all('SELECT db_name, db_user, size_mb FROM databases ORDER BY db_name') : all('SELECT db_name, db_user, size_mb FROM databases WHERE user_id = ? ORDER BY db_name', u.id) },
  { name: 'list_backups', description: 'List recent backups', inputSchema: { type: 'object', properties: {} }, run: (u) => all('SELECT filename, kind, size_mb, status, created_at FROM backups ORDER BY id DESC LIMIT 50') },
  { name: 'list_packages', description: 'List hosting packages (admin only)', inputSchema: { type: 'object', properties: {} }, run: (u) => u.level === 'admin' ? all('SELECT name, type, limits FROM packages ORDER BY name') : [] },
  { name: 'list_users', description: 'List panel users (admin only)', inputSchema: { type: 'object', properties: {} }, run: (u) => u.level === 'admin' ? all('SELECT username, email, level, package, suspended, last_login FROM users ORDER BY username') : [] },
  { name: 'list_tickets', description: 'List support tickets', inputSchema: { type: 'object', properties: {} }, run: (u) => u.level === 'admin' ? all('SELECT id, username, subject, status, priority, created_at FROM tickets ORDER BY id DESC LIMIT 100') : all('SELECT id, subject, status, priority, created_at FROM tickets WHERE username = ? ORDER BY id DESC LIMIT 100', u.username) },
  { name: 'list_notifications', description: 'List notifications for the current owner', inputSchema: { type: 'object', properties: {} }, run: (u) => all('SELECT id, level, title, body, read_at, created_at FROM notifications WHERE user_id = ? OR user_id IS NULL ORDER BY id DESC LIMIT 100', u.id) },
  { name: 'get_health', description: 'Server health snapshot', inputSchema: { type: 'object', properties: {} }, run: () => securitySummary() },
  { name: 'get_limits', description: 'Limits of the current account', inputSchema: { type: 'object', properties: {} }, run: (u) => limitsFor(u) },
  { name: 'get_mail_queue', description: 'Mail queue summary', inputSchema: { type: 'object', properties: {} }, run: () => queueList().rows.slice(0, 50) },
  { name: 'get_mail_overview', description: 'Mail operations counters', inputSchema: { type: 'object', properties: {} }, run: () => mailOverview() },
  { name: 'get_settings', description: 'Safe public panel settings', inputSchema: { type: 'object', properties: {} }, run: () => ({ server_name: setting('server_name', ''), ns1: setting('ns1', ''), ns2: setting('ns2', ''), version: VERSION }) },
  { name: 'search_records', description: 'Search domains/mailboxes by literal text', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, run: (u, args) => {
    const q = `%${String(args.query || '').toLowerCase()}%`;
    return {
      domains: (u.level === 'admin' ? all('SELECT name FROM domains WHERE lower(name) LIKE ? LIMIT 25', q) : all('SELECT name FROM domains WHERE user_id = ? AND lower(name) LIKE ? LIMIT 25', u.id, q)).map((r) => r.name),
      mailboxes: all('SELECT domain, local_part FROM email_accounts WHERE lower(domain || \'@\' || local_part) LIKE ? LIMIT 25', q).map((r) => `${r.local_part}@${r.domain}`),
    };
  } },
];

export function mcpTools() {
  return TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

export async function handleMcp(ctx) {
  const user = keyFromRequest(ctx.req.headers, ctx.ip, 'GET');
  if (!user) return { status: 401, json: { jsonrpc: '2.0', error: { code: -32001, message: 'Invalid or missing API key' }, id: ctx.body?.id ?? null } };
  const body = ctx.body || {};
  const id = body.id ?? null;
  if (body.method === 'initialize') {
    return { json: { jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'OpenAdmin', version: VERSION } } } };
  }
  if (body.method === 'notifications/initialized') return { status: 202, json: null };
  if (body.method === 'ping') return { json: { jsonrpc: '2.0', id, result: {} } };
  if (body.method === 'tools/list') return { json: { jsonrpc: '2.0', id, result: { tools: mcpTools() } } };
  if (body.method === 'tools/call') {
    const name = body.params?.name;
    const args = body.params?.arguments || {};
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return { json: { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool ${name}` } } };
    try {
      const result = await tool.run(user, args);
      return { json: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } } };
    } catch (e) {
      return { json: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: e.message }], isError: true } } };
    }
  }
  return { json: { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } } };
}
