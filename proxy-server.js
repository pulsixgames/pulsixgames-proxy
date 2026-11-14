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
const http = require('http');
const dns  = require('dns').promises;
const net  = require('net');

const PORT = process.env.PORT || 8080;


/* ---- safety: refuse addresses on this machine or its network ---- */
const PRIVATE = /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|::$|fc|fd|fe80|::ffff:(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.))/i;

async function allowed(url) {
  if (!/^https?:$/.test(url.protocol)) return false;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  return addrs.length > 0 && !addrs.some(a => PRIVATE.test(a.address));
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
    if (!(await allowed(target))) return send(403, 'That address is not allowed.');

    let body;
    if (!['GET', 'HEAD'].includes(req.method)) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      body = Buffer.concat(chunks);
    }

    const up = await fetch(target, {
      method: req.method, body, redirect: 'manual', signal: AbortSignal.timeout(15000),
      headers: {
        'user-agent': req.headers['user-agent'] || 'Mozilla/5.0',
        'accept': req.headers.accept || '*/*',
        'accept-language': req.headers['accept-language'] || 'en',
        'referer': target.origin + '/',
        ...(req.headers.range && { range: req.headers.range }),
        ...(req.headers['content-type'] && { 'content-type': req.headers['content-type'] })
      }
    });

    // redirects stay inside the proxy
    const next = up.headers.get('location');
    if (up.status >= 300 && up.status < 400 && next) {
      res.writeHead(302, { location: prox(new URL(next, target).href) });
      return res.end();
    }

    const headers = {};
    up.headers.forEach((value, key) => { if (!DROP.has(key)) headers[key] = value; });

    const type = up.headers.get('content-type') || '';
    let out;
    if (type.includes('text/html'))     out = rewriteHtml(await up.text(), target.href, prox);
    else if (type.includes('text/css')) out = rewriteCss(await up.text(), target.href, prox);
    else                                out = Buffer.from(await up.arrayBuffer());

    res.writeHead(up.status, headers);
    res.end(out);
  } catch (e) {
    send(502, 'Could not load that page: ' + e.message);
  }
}).listen(PORT, () => console.log(`Proxy running on http://localhost:${PORT}`));
