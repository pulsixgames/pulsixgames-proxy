// =====================================================================
//  proxy-server.js  —  the server behind proxy.html
//
//  To run it 24/7 without your computer: put this file, package.json and render.yaml
//  in a GitHub repo and deploy it on Render (Blueprint). Then put the address you
//  get in SERVER at the top of proxy.html. Any Node host (Railway, Fly.io, a VPS) works too.
//  To try it on your own computer instead:  node proxy-server.js  (Node 18 or newer)
//
//  What it does: fetches a page for you, strips the headers that stop pages from
//  being shown in a frame, and rewrites the page's links so they stay inside the
//  proxy. Simple and text-heavy sites work best. Sites that depend on heavy
//  JavaScript or logins (YouTube, Google sign-in, Discord...) will not fully work;
//  for those, look at a service-worker proxy such as Ultraviolet or Scramjet.
// =====================================================================
const http  = require('http');
const https = require('https');
const zlib  = require('zlib');
const dns   = require('dns').promises;
const net   = require('net');

const PORT = process.env.PORT || 8080;


/* ---- safety: refuse addresses on this machine or its network ---- */
const PRIVATE = /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|::$|fc|fd|fe80|::ffff:(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.))/i;

const DECODERS = { gzip: zlib.createGunzip, deflate: zlib.createInflate, br: zlib.createBrotliDecompress };
const MAX_BYTES = 25 * 1024 * 1024;

// fetches a page: looks the address up, refuses private ones, then connects to exactly that address
// (IPv4 first, because many networks have no working IPv6)
async function request(target, { method, headers, body }) {
  const host = target.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some(a => PRIVATE.test(a.address))) throw new Error('That address is not allowed.');
  const pick = addrs.find(a => a.family === 4) || addrs[0];

  return new Promise((resolve, reject) => {
    const req = (target.protocol === 'https:' ? https : http).request({
      host: pick.address, family: pick.family, port: target.port || undefined,
      path: target.pathname + target.search, method,
      headers: { ...headers, host: target.host },
      servername: net.isIP(host) ? undefined : host,   // so HTTPS still checks the real site name
      timeout: 15000
    }, res => {
      const decode = DECODERS[(res.headers['content-encoding'] || '').toLowerCase()];
      const stream = decode ? res.pipe(decode()) : res;
      const chunks = [];
      let size = 0;
      stream.on('data', c => {
        size += c.length;
        if (size > MAX_BYTES) return req.destroy(new Error('That file is too big.'));
        chunks.push(c);
      });
      stream.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      stream.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('The site took too long to answer.')));
    req.on('error', reject);
    req.end(body);
  });
}

// page text, read with the character set the site says it uses
function pageText(up) {
  const cs = /charset=["']?([\w-]+)/i.exec(up.headers['content-type'] || '');
  try { return new TextDecoder(cs ? cs[1] : 'utf-8').decode(up.body); } catch { return up.body.toString('utf8'); }
}


/* ---- rewriting pages so their links stay inside the proxy ---- */
const SKIP_URL = /^(#|data:|javascript:|mailto:|tel:|blob:|about:)/i;

function proxied(value, base, prox) {
  const v = value.trim();
  return !v || SKIP_URL.test(v) ? value : prox(new URL(v, base).href);
}

function rewriteCss(css, base, prox) {
  return css.replace(/url\(\s*(["']?)(.*?)\1\s*\)/gi, (m, q, v) => {
    try { return `url(${q}${proxied(v, base, prox)}${q})`; } catch { return m; }
  });
}

// runs inside the proxied page: sends fetch / XHR / form submits through the proxy
function clientScript(base, prefix) {
  const fix = u => {
    try { const a = new URL(u, base); return a.href.startsWith(prefix) || !/^https?:$/.test(a.protocol) ? u : prefix + encodeURIComponent(a.href); }
    catch { return u; }
  };
  const f = window.fetch;
  window.fetch = (input, init) => f(typeof input === 'string' ? fix(input) : input, init);
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) { return open.call(this, method, fix(url), ...rest); };

  document.addEventListener('submit', e => {
    const form = e.target;
    const real = new URL(form.getAttribute('action') || '', base);
    if ((form.method || 'get').toLowerCase() === 'get') {
      e.preventDefault();
      real.search = new URLSearchParams(new FormData(form)).toString();
      location.href = prefix + encodeURIComponent(real.href);
    } else {
      form.action = prefix + encodeURIComponent(real.href);
    }
  }, true);

  // elements created by the page's own scripts
  const setAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    return setAttr.call(this, name, /^(src|href|poster)$/i.test(name) && typeof value === 'string' ? fix(value) : value);
  };
  for (const [proto, prop] of [[HTMLImageElement, 'src'], [HTMLScriptElement, 'src'], [HTMLIFrameElement, 'src'],
                               [HTMLLinkElement, 'href'], [HTMLSourceElement, 'src'], [HTMLMediaElement, 'src']]) {
    const d = Object.getOwnPropertyDescriptor(proto.prototype, prop);
    if (d && d.set) Object.defineProperty(proto.prototype, prop, { ...d, set(v) { d.set.call(this, fix(String(v))); } });
  }
  const winOpen = window.open;
  window.open = (u, ...rest) => winOpen.call(window, u ? fix(u) : u, ...rest);

  // tell the proxy page which real address this is (it shows it in the address bar and keeps back / forward)
  parent.postMessage({ proxyUrl: base }, '*');
}

function rewriteHtml(html, base, prox) {
  html = html.replace(/<base\b[^>]*>/gi, '');
  html = html.replace(/\ssrcset=(["'])(.*?)\1/gi, (m, q, v) => {
    try {
      const list = v.split(',').map(p => { const [u, ...size] = p.trim().split(/\s+/); return [proxied(u, base, prox), ...size].join(' '); });
      return ` srcset=${q}${list.join(', ')}${q}`;
    } catch { return m; }
  });
  html = html.replace(/\s(href|src|poster)=(["'])(.*?)\2/gi, (m, attr, q, v) => {
    try { return ` ${attr}=${q}${proxied(v, base, prox)}${q}`; } catch { return m; }
  });
  const inject = `<script>(${clientScript})(${JSON.stringify(base)}, ${JSON.stringify(prox(''))})</script>`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, m => m + inject) : inject + html;
}


/* ---- the server ---- */
// headers that would stop the page from showing in a frame (or are not needed)
const DROP = new Set(['x-frame-options', 'content-security-policy', 'content-security-policy-report-only', 'content-encoding',
  'content-length', 'transfer-encoding', 'connection', 'set-cookie', 'strict-transport-security', 'report-to', 'nel']);

http.createServer(async (req, res) => {
  const self = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
  const prox = href => `${self}/proxy?url=${encodeURIComponent(href)}`;
  const send = (code, text) => { res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' }); res.end(text); };

  const u = new URL(req.url, self);
  if (u.pathname === '/ping') { res.writeHead(200, { 'access-control-allow-origin': '*' }); return res.end('ok'); }

  if (u.pathname !== '/proxy') {
    // a page's own script asked for "/something": work out the real address from the page it came from
    try {
      const from = new URL(req.headers.referer).searchParams.get('url');
      if (from) { res.writeHead(307, { location: prox(new URL(u.pathname + u.search, from).href) }); return res.end(); }
    } catch {}
    if (u.pathname === '/') return send(200, 'Proxy server is running.');
    return send(404, 'Not found');
  }

  try {
    const target = new URL(u.searchParams.get('url'));
    if (!/^https?:$/.test(target.protocol)) return send(403, 'That address is not allowed.');

    let body;
    if (!['GET', 'HEAD'].includes(req.method)) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      body = Buffer.concat(chunks);
    }

    const up = await request(target, {
      method: req.method, body,
      headers: {
        'user-agent': req.headers['user-agent'] || 'Mozilla/5.0',
        'accept': req.headers.accept || '*/*',
        'accept-language': req.headers['accept-language'] || 'en',
        'accept-encoding': 'gzip, deflate, br',
        'referer': target.origin + '/',
        ...(req.headers.range && { range: req.headers.range }),
        ...(req.headers['content-type'] && { 'content-type': req.headers['content-type'] })
      }
    });

    // redirects stay inside the proxy
    const next = up.headers.location;
    if (up.status >= 300 && up.status < 400 && next) {
      res.writeHead(302, { location: prox(new URL(next, target).href) });
      return res.end();
    }

    const headers = {};
    for (const [key, value] of Object.entries(up.headers)) if (!DROP.has(key)) headers[key] = Array.isArray(value) ? value.join(', ') : value;

    const type = up.headers['content-type'] || '';
    let out = up.body;
    if (type.includes('text/html'))     { out = rewriteHtml(pageText(up), target.href, prox); headers['content-type'] = 'text/html; charset=utf-8'; }
    else if (type.includes('text/css')) { out = rewriteCss(pageText(up), target.href, prox);  headers['content-type'] = 'text/css; charset=utf-8'; }

    res.writeHead(up.status, headers);
    res.end(out);
  } catch (e) {
    // e.code says what went wrong, e.g. ENOTFOUND = no such site, ETIMEDOUT = it never answered
    send(502, 'Could not load that page: ' + e.message + (e.code ? ` (${e.code})` : ''));
  }
}).listen(PORT, () => console.log(`Proxy running on http://localhost:${PORT}`));
