// Central outbound HTTP policy: no credentials in URLs, no loopback/link-local
// or metadata targets unless an administrator explicitly allows private ranges,
// DNS checked before every request and every redirect, bounded response size.
import dns from 'node:dns/promises';
import net from 'node:net';

const BLOCKED = new net.BlockList();
for (const [net4, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 4]]) BLOCKED.addSubnet(net4, prefix, 'ipv4');
for (const [net6, prefix] of [['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) BLOCKED.addSubnet(net6, prefix, 'ipv6');

export class OutboundError extends Error {
  constructor(code, message) { super(message); this.name = 'OutboundError'; this.code = code; }
}

function addressAllowed(address, allowPrivate) {
  if (BLOCKED.check(address, net.isIP(address) === 6 ? 'ipv6' : 'ipv4')) return allowPrivate;
  return true;
}

export async function assertOutboundUrl(value, { allowPrivate = false, allowAnyPort = false } = {}) {
  let url;
  try { url = new URL(String(value)); } catch { throw new OutboundError('invalid_url', 'Nieprawidłowy adres URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new OutboundError('invalid_scheme', 'Dozwolone są tylko http(s)');
  if (url.username || url.password) throw new OutboundError('credentials_in_url', 'Adres nie może zawierać danych logowania');
  if (!allowAnyPort && url.port && !['80', '443'].includes(url.port)) throw new OutboundError('invalid_port', 'Dozwolone porty to 80 i 443');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses;
  if (net.isIP(host)) addresses = [{ address: host, family: net.isIP(host) }];
  else {
    try { addresses = await dns.lookup(host, { all: true, verbatim: true }); } catch { throw new OutboundError('dns_failed', 'Nie można rozwiązać nazwy hosta'); }
  }
  if (!addresses.length) throw new OutboundError('dns_failed', 'Brak adresów dla hosta');
  if (!allowPrivate && addresses.some((entry) => !addressAllowed(entry.address, false))) throw new OutboundError('private_address', 'Cel prowadzi do sieci prywatnej lub lokalnej');
  return { url, addresses };
}

export async function safeFetch(value, { method = 'GET', headers = {}, body = null, allowPrivate = false, allowAnyPort = false, maxBytes = 256 * 1024, timeoutMs = 10000, maxRedirects = 3 } = {}) {
  let current = String(value);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const checked = await assertOutboundUrl(current, { allowPrivate, allowAnyPort });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(checked.url, { method, headers, body, redirect: 'manual', signal: controller.signal });
    } finally { clearTimeout(timer); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new OutboundError('bad_redirect', 'Przekierowanie bez adresu');
      current = new URL(location, checked.url).toString();
      if (response.status === 303) method = 'GET';
      continue;
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxBytes) { try { response.body.cancel(); } catch { /* ignore */ } throw new OutboundError('response_too_large', 'Odpowiedź przekracza limit'); }
      chunks.push(chunk);
    }
    return { ok: response.ok, status: response.status, headers: response.headers, body: Buffer.concat(chunks), url: checked.url.toString() };
  }
  throw new OutboundError('too_many_redirects', 'Zbyt wiele przekierowań');
}
