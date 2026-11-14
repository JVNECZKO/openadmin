// Tiny HTTP router with :params and wildcard support.
export class Router {
  constructor() { this.routes = []; }

  add(method, pattern, handler, opts = {}) {
    const keys = [];
    const regex = new RegExp('^' + pattern
      .replace(/\/+$/, '')
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\/:([A-Za-z0-9_]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; })
      .replace(/\*/g, '(.*)') + '/?$');
    this.routes.push({ method, pattern, regex, keys, handler, ...opts });
    return this;
  }
  get(p, h, o) { return this.add('GET', p, h, o); }
  post(p, h, o) { return this.add('POST', p, h, o); }
  put(p, h, o) { return this.add('PUT', p, h, o); }
  delete(p, h, o) { return this.add('DELETE', p, h, o); }
  any(p, h, o) { return this.add('ANY', p, h, o); }

  match(method, path) {
    const head = method === 'HEAD' ? 'GET' : method;
    for (const r of this.routes) {
      if (r.method !== head && r.method !== 'ANY') continue;
      const m = r.regex.exec(path);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1] || ''); });
      return { route: r, params };
    }
    return null;
  }
}
