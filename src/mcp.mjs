// Minimal MCP (Model Context Protocol) server over HTTP, authenticated with
// OpenAdmin API keys. Read-only tools; write tools require a key with scope
// "write" and are intentionally added one by one.
//
// SEC-019: every tool declares its minimum role and uses the same tenant scope
// as the REST API. Global server state tools are administrator-only; resellers
// see their own clients; users see only their own objects.
import { all, setting } from './db.mjs';
import { VERSION } from './config.mjs';
import { keyFromRequest } from './apikeys.mjs';
import { limitsFor } from './auth.mjs';
import { visibleDomains, visibleUsers } from './core/access.mjs';
import { mailOverview, queueList } from './mailops.mjs';
import { securitySummary } from './security.mjs';

function scopedUserIds(user) {
  if (user.level === 'admin') return null;
  const ids = new Set();
  if (Number.isSafeInteger(Number(user.id))) ids.add(Number(user.id));
  for (const visible of visibleUsers(user)) {
    if (Number.isSafeInteger(Number(visible.id))) ids.add(Number(visible.id));
  }
  return [...ids];
}

function placeholders(count) {
  return Array.from({ length: count }, () => '?').join(',');
}

function scopedDomainNames(user) {
  if (user.level === 'admin') return null;
  return visibleDomains(user).map((domain) => domain.name);
}

function scopedBackups(user) {
  const ids = scopedUserIds(user);
  if (!ids) return all('SELECT filename, kind, size_mb, status, created_at FROM backups ORDER BY id DESC LIMIT 50');
  if (!ids.length) return [];
  return all(`SELECT filename, kind, size_mb, status, created_at FROM backups
              WHERE user_id IN (${placeholders(ids.length)}) ORDER BY id DESC LIMIT 50`, ...ids);
}

function scopedDatabases(user) {
  const ids = scopedUserIds(user);
  if (!ids) return all('SELECT db_name, db_user, size_mb FROM databases ORDER BY db_name');
  if (!ids.length) return [];
  return all(`SELECT db_name, db_user, size_mb FROM databases
              WHERE user_id IN (${placeholders(ids.length)}) ORDER BY db_name`, ...ids);
}

function scopedMailboxes(user) {
  const domains = scopedDomainNames(user);
  if (!domains) return all('SELECT domain, local_part, quota_mb, used_mb, suspended FROM email_accounts ORDER BY domain, local_part');
  if (!domains.length) return [];
  return all(`SELECT domain, local_part, quota_mb, used_mb, suspended FROM email_accounts
              WHERE domain IN (${placeholders(domains.length)}) ORDER BY domain, local_part`, ...domains);
}

function likeLiteral(value) {
  return `%${String(value || '').toLowerCase().replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}

const TOOLS = [
  {
    name: 'list_domains', description: 'List domains visible to the key owner',
    inputSchema: { type: 'object', properties: {} },
    run: (u) => visibleDomains(u).map((domain) => (u.level === 'admin'
      ? { name: domain.name, username: domain.username, status: domain.status, php_version: domain.php_version }
      : { name: domain.name, status: domain.status, php_version: domain.php_version })),
  },
  {
    name: 'list_mailboxes', description: 'List mailboxes in the visible tenant scope',
    inputSchema: { type: 'object', properties: {} },
    run: (u) => scopedMailboxes(u),
  },
  {
    name: 'list_databases', description: 'List databases in the visible tenant scope',
    inputSchema: { type: 'object', properties: {} },
    run: (u) => scopedDatabases(u),
  },
  {
    name: 'list_backups', description: 'List recent backups owned by the key owner or their clients',
    inputSchema: { type: 'object', properties: {} },
    run: (u) => scopedBackups(u),
  },
  {
    name: 'list_packages', description: 'List hosting packages (admin only)',
    inputSchema: { type: 'object', properties: {} }, adminOnly: true,
    run: () => all('SELECT name, type, limits FROM packages ORDER BY name'),
  },
  {
    name: 'list_users', description: 'List panel users (admin only)',
    inputSchema: { type: 'object', properties: {} }, adminOnly: true,
    run: () => all('SELECT username, email, level, package, suspended, last_login FROM users ORDER BY username'),
  },
  {
    name: 'list_tickets', description: 'List support tickets visible to the key owner',
    inputSchema: { type: 'object', properties: {} },
    run: (u) => {
      const ids = scopedUserIds(u);
      if (!ids) return all('SELECT id, username, subject, status, priority, created_at FROM tickets ORDER BY id DESC LIMIT 100');
      if (!ids.length) return [];
      return all(`SELECT id, subject, status, priority, created_at FROM tickets
                  WHERE user_id IN (${placeholders(ids.length)}) ORDER BY id DESC LIMIT 100`, ...ids);
    },
  },
  {
    name: 'list_notifications', description: 'List notifications for the current owner',
    inputSchema: { type: 'object', properties: {} },
    run: (u) => all('SELECT id, level, title, body, read_at, created_at FROM notifications WHERE user_id = ? OR user_id IS NULL ORDER BY id DESC LIMIT 100', u.id),
  },
  {
    name: 'get_health', description: 'Server health snapshot (admin only)',
    inputSchema: { type: 'object', properties: {} }, adminOnly: true,
    run: () => securitySummary(),
  },
  {
    name: 'get_limits', description: 'Limits of the current account',
    inputSchema: { type: 'object', properties: {} },
    run: (u) => limitsFor(u),
  },
  {
    name: 'get_mail_queue', description: 'Mail queue summary (admin only)',
    inputSchema: { type: 'object', properties: {} }, adminOnly: true,
    run: () => queueList().rows.slice(0, 50),
  },
  {
    name: 'get_mail_overview', description: 'Mail operations counters (admin only)',
    inputSchema: { type: 'object', properties: {} }, adminOnly: true,
    run: () => mailOverview(),
  },
  {
    name: 'get_settings', description: 'Panel settings (admin only)',
    inputSchema: { type: 'object', properties: {} }, adminOnly: true,
    run: () => ({ server_name: setting('server_name', ''), ns1: setting('ns1', ''), ns2: setting('ns2', ''), version: VERSION }),
  },
  {
    name: 'search_records', description: 'Search domains/mailboxes by literal text in the visible tenant scope',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    run: (u, args) => {
      const q = likeLiteral(args.query);
      const domains = scopedDomainNames(u);
      const domainRows = domains
        ? (domains.length ? all(`SELECT name FROM domains WHERE lower(name) LIKE ? ESCAPE '\\' AND name IN (${placeholders(domains.length)}) LIMIT 25`, q, ...domains) : [])
        : all("SELECT name FROM domains WHERE lower(name) LIKE ? ESCAPE '\\' LIMIT 25", q);
      const mailboxRows = domains
        ? (domains.length ? all(`SELECT domain, local_part FROM email_accounts
             WHERE lower(domain || '@' || local_part) LIKE ? ESCAPE '\\'
               AND domain IN (${placeholders(domains.length)}) LIMIT 25`, q, ...domains) : [])
        : all("SELECT domain, local_part FROM email_accounts WHERE lower(domain || '@' || local_part) LIKE ? ESCAPE '\\' LIMIT 25", q);
      return {
        domains: domainRows.map((row) => row.name),
        mailboxes: mailboxRows.map((row) => `${row.local_part}@${row.domain}`),
      };
    },
  },
];

export function mcpTools(user = null) {
  return TOOLS
    .filter((tool) => !tool.adminOnly || user?.level === 'admin')
    .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

function rpcError(id, message, code = -32602) {
  return { status: 200, json: { jsonrpc: '2.0', id, error: { code, message } } };
}

function toolError(id, message) {
  return {
    status: 200,
    json: {
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: message }], isError: true },
    },
  };
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
  if (body.method === 'tools/list') return { json: { jsonrpc: '2.0', id, result: { tools: mcpTools(user) } } };
  if (body.method === 'tools/call') {
    const name = body.params?.name;
    const args = body.params?.arguments || {};
    const tool = TOOLS.find((candidate) => candidate.name === name);
    if (!tool) return rpcError(id, `Unknown tool ${name}`, -32602);
    if (tool.adminOnly && user.level !== 'admin') return toolError(id, 'Admin access required');
    try {
      const result = await tool.run(user, args);
      return { json: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } } };
    } catch (e) {
      return toolError(id, e.message);
    }
  }
  return rpcError(id, 'Method not found', -32601);
}
