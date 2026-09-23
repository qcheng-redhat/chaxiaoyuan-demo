/*
 * Tea Courtyard backend - zero-dependency Node.js server
 * Serves the static pages + JSON API in one port.
 *
 * Endpoints:
 *   GET    /health                      liveness check
 *   POST   /api/orders                  place an order (public, rate-limited, idempotent, price recomputed server-side)
 *   POST   /api/login                   store login {password} -> {token}
 *                                       (disabled with reason "not_configured" when
 *                                        ADMIN_PASSWORD is not set - the site still boots)
 *   GET    /api/orders                  list orders           (auth)
 *   PATCH  /api/orders/:no/status       update order status   (auth)
 *   POST   /api/orders/seed             insert 4 demo orders  (auth)
 *   DELETE /api/orders                  clear all orders      (auth)
 */
'use strict';

var http = require('http');
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var PORT = Number(process.env.PORT) || 3000;
var HOST = '0.0.0.0';
var ROOT = __dirname;
var DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');  // override for tests
var DATA_FILE = path.join(DATA_DIR, 'orders.json');
/* The store password is OPTIONAL BY DESIGN: the customer-facing site must boot
 * even when it is not configured. Without it, only the dashboard login is disabled. */
var ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
var ADMIN_LOGIN_ENABLED = !!ADMIN_PASSWORD;
if (!ADMIN_LOGIN_ENABLED) {
  console.warn(
    '[tea-courtyard] ADMIN_PASSWORD is not set - the site is starting anyway, but\n' +
    'the store dashboard login is DISABLED. Set ADMIN_PASSWORD to enable it.'
  );
}

/* ---------- Server-side menu: the ONLY source of truth for prices ---------- */
var MENU = {
  p1: { price: 16 },
  p2: { price: 14 },
  p3: { price: 18 },
  p4: { price: 19 },
  m5: { price: 15 },
  m6: { price: 15 },
  m7: { price: 10 }
};
var ADDON_PRICE = 3;
var VALID_STATUS = ['new', 'making', 'done', 'canceled'];

/* ---------- Simple JSON-file store ---------- */
var db = { orders: [] };

function loadDb() {
  try {
    var raw = fs.readFileSync(DATA_FILE, 'utf8');
    var parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.orders)) db.orders = parsed.orders;
  } catch (e) { /* first run or unreadable: start empty */ }
}

function persistDb() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    var tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db.orders));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.error('[db] persist failed:', e.message);
  }
}

/* ---------- Auth tokens: stateless HMAC-signed, survive restarts / multiple instances ----------
 * The secret is derived from the admin password (plus a fixed label) so every instance
 * computes the same key without shared storage. The first secret wins for the process
 * lifetime, which keeps old tokens verifiable across a password change window.
 *
 * With NO password configured, a RANDOM per-process secret is used instead. Login is
 * disabled in that mode anyway, and the randomness guarantees two things: nobody can
 * forge a token by recomputing the well-known derivation for an empty password, and
 * every token issued under a previous configuration stops verifying immediately. */
var TOKEN_SECRET = ADMIN_LOGIN_ENABLED
  ? crypto.createHash('sha256').update('tea-courtyard-token-v1|' + ADMIN_PASSWORD).digest()
  : crypto.randomBytes(32);

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

function issueToken() {
  var payload = b64url(Buffer.from(JSON.stringify({ exp: Date.now() + 7 * 24 * 3600 * 1000 })));
  var sig = b64url(crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest());
  return payload + '.' + sig;
}

function tokenValid(t) {
  if (!t) return false;
  var parts = String(t).split('.');
  if (parts.length !== 2) return false;
  var expected = b64url(crypto.createHmac('sha256', TOKEN_SECRET).update(parts[0]).digest());
  if (expected.length !== parts[1].length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts[1]))) return false;
  try {
    var p = JSON.parse(b64urlDecode(parts[0]).toString('utf8'));
    return !!(p && p.exp > Date.now());
  } catch (e) { return false; }
}

/* Read the token from wherever it arrives, then pick the channel that actually
 * carries a validly-signed token.
 *
 * Why not just read the Authorization header: the publishing gateway in front of
 * this app REPLACES `Authorization` with its own gateway JWT (a 379-char, 3-part
 * token). Trusting the header blindly means we validate the gateway's token, fail,
 * and reject a perfectly good session — which is exactly the bug this fixes.
 * So we gather every candidate and prefer the first one whose signature verifies.
 * Channels (in preference order):
 *   1. X-Cy-Token header  — our own header, nothing in front rewrites it
 *   2. ?token= query      — survives proxies that strip headers
 *   3. cy_token cookie    — survives proxies that rewrite the URL
 *   4. Authorization      — kept as a last resort so plain local runs keep working
 */
function readToken(req, query, source) {
  var cands = [];
  function add(name, val) {
    if (val != null && String(val).trim() !== '') cands.push({ name: name, val: String(val).trim() });
  }

  add('xcyheader', req.headers['x-cy-token']);
  add('query', query && query.token);
  var m = String(req.headers['cookie'] || '').match(/(?:^|;\s*)cy_token=([^;]+)/);
  if (m) add('cookie', decodeURIComponent(m[1]));
  /* A gateway may append its own JWT to Authorization (comma-separated values).
   * Try every value on its own, so a client that only sends this header can still
   * authenticate even when something in front adds a token of its own. */
  String(req.headers['authorization'] || '')
    .split(',')
    .map(function (s) { return s.replace(/^Bearer\s+/i, '').trim(); })
    .filter(function (s) { return s !== ''; })
    .forEach(function (s, i) { add(i ? 'header' + (i + 1) : 'header', s); });

  if (source) source.seen = cands.map(function (c) { return c.name; });

  for (var i = 0; i < cands.length; i++) {
    if (tokenValid(cands[i].val)) {
      if (source) source.via = cands[i].name;
      return cands[i].val;
    }
  }
  if (cands.length) {
    if (source) source.via = cands[0].name + ':unverified';
    return cands[0].val;
  }
  if (source) source.via = 'none';
  return '';
}

/* ---------- Rate limiting (sliding window, in-memory) ---------- */
var hits = {}; // key -> [timestamps]

function rateLimit(key, max, windowMs) {
  var now = Date.now();
  if (!hits[key]) hits[key] = [];
  var arr = hits[key];
  while (arr.length && now - arr[0] > windowMs) arr.shift();
  if (arr.length >= max) return false;
  arr.push(now);
  return true;
}

/* ---------- Helpers ---------- */
function pad(x) { return String(x).length < 2 ? '0' + x : String(x); }
function nowStr() {
  var d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function cleanStr(v, maxLen) {
  return String(v == null ? '' : v).slice(0, maxLen || 100).trim();
}

function findOrder(no) {
  for (var i = 0; i < db.orders.length; i++) if (db.orders[i].no === no) return db.orders[i];
  return null;
}

/* Recompute every price from the server-side menu. Returns null on bad input. */
function buildOrder(body) {
  var no = cleanStr(body.no, 32);
  if (!/^CY[0-9]{10}-[0-9]{4}$/.test(no)) return { error: 'bad order number' };

  var items = body.items;
  if (!Array.isArray(items) || items.length < 1 || items.length > 50) return { error: 'bad items' };

  var clean = [];
  var total = 0;
  var qty = 0;
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var m = MENU[it.id];
    if (!m) return { error: 'unknown product: ' + it.id };

    var n = Number(it.qty);
    if (!Number.isInteger(n) || n < 1 || n > 99) return { error: 'bad qty' };

    var addons = Array.isArray(it.addons) ? it.addons.slice(0, 5) : [];
    var unit = m.price + addons.length * ADDON_PRICE;
    total += unit * n;
    qty += n;

    clean.push({
      id: it.id,
      name: cleanStr(it.name, 40),      // display name kept from client (language-aware)
      qty: n,
      unit: unit,                        // price from SERVER menu
      spec: cleanStr(it.spec, 80),
      addons: addons.map(function(a) { return cleanStr(a, 12); }).filter(Boolean)
    });
  }

  return {
    order: {
      no: no,
      ts: Date.now(),
      time: nowStr(),
      pick: cleanStr(body.pick, 16) || 'Pickup',
      phone: cleanStr(body.phone, 20),
      note: cleanStr(body.note, 200),
      items: clean,
      qty: qty,
      total: total,                      // server-computed total
      status: 'new'
    }
  };
}

/* ---------- Response helpers ---------- */
function sendJson(res, code, obj) {
  var body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    /* never let the gateway cache API replies (a cached 401 kept a broken
     * login loop alive long after the server had been fixed) */
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Pragma': 'no-cache',
    'Expires': '0'
  });
  res.end(body);
}

function readBody(req, cb) {
  var chunks = [];
  var size = 0;
  req.on('data', function(c) {
    size += c.length;
    if (size > 200 * 1024) { req.destroy(); cb(null); return; }
    chunks.push(c);
  });
  req.on('end', function() {
    if (!chunks.length) return cb({});
    try { cb(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
    catch (e) { cb(null); }
  });
  req.on('error', function() { cb(null); });
}

/* ---------- Static files (whitelist only) ----------
 * Short aliases (/menu, /store) alongside the .html paths, and why they exist:
 * the publishing gateway caches responses PER EXACT URL. Two URLs cached before
 * the no-store fix was deployed (/index.html and /orders.html) still hand out that
 * pre-fix copy roughly half the time — and the pre-fix dashboard has no token
 * header and no self-heal, so login genuinely cannot work there. `?v=<build>`
 * dodges it, but a URL nobody can remember is no good to a shop owner who wants to
 * bookmark the dashboard. A brand-new path has no stale gateway entry, so the
 * first request goes to origin and picks up the correct headers. Same file, clean
 * address: /menu, /menu-en, /store, /store-en — and /store is safe to bookmark. */
var STATIC = {
  '/':            ['index.html', 'text/html; charset=utf-8'],
  '/index.html':  ['index.html', 'text/html; charset=utf-8'],
  '/menu':        ['index.html', 'text/html; charset=utf-8'],
  '/index-en.html': ['index-en.html', 'text/html; charset=utf-8'],
  '/menu-en':     ['index-en.html', 'text/html; charset=utf-8'],
  '/orders.html': ['orders.html', 'text/html; charset=utf-8'],
  '/store':       ['orders.html', 'text/html; charset=utf-8'],
  '/orders-en.html': ['orders-en.html', 'text/html; charset=utf-8'],
  '/store-en':    ['orders-en.html', 'text/html; charset=utf-8'],
  '/qr-code-tea-courtyard.png': ['qr-code-tea-courtyard.png', 'image/png'],
  '/sample_orders_export.csv': ['sample_orders_export.csv', 'text/csv; charset=utf-8']
};

/* ---------- Build id: makes pages self-heal against stale gateway caches -----
 * The publishing gateway caches responses per URL and kept serving an OLD
 * orders.html after a deploy (old JS -> auth failures that looked like a broken
 * password). Newer responses now say no-store, but an entry cached earlier can
 * outlive the fix, so every page also carries its build id:
 *   - the HTML contains the literal __BUILD__, replaced at serve time with BUILD
 *   - the page compares it against GET /api/version and, on mismatch, reloads
 *     itself with ?v=<build> — a fresh cache key, so the gateway goes to origin.
 * BUILD is a hash of the HTML files (with the placeholder stripped), so it only
 * changes when the pages actually change. */
var BUILD_TOKEN = '__BUILD__';

function computeBuild() {
  var h = crypto.createHash('sha256');
  Object.keys(STATIC).forEach(function (k) {
    if (String(STATIC[k][1]).indexOf('text/html') !== 0) return;
    try {
      h.update(fs.readFileSync(path.join(ROOT, STATIC[k][0]), 'utf8').split(BUILD_TOKEN).join(''));
    } catch (e) { /* file missing: ignore */ }
  });
  return h.digest('hex').slice(0, 10);
}

var BUILD = computeBuild();

function serveStatic(req, res, urlPath) {
  var entry = STATIC[urlPath];
  if (!entry) { res.writeHead(404); res.end('Not Found'); return; }
  fs.readFile(path.join(ROOT, entry[0]), function(err, data) {
    if (err) { res.writeHead(500); res.end('Server Error'); return; }
    /* The publishing gateway caches any response that does not forbid it. With no
     * Cache-Control at all, it kept serving a STALE orders.html after a deploy —
     * old JS, no token header — which looked exactly like "login is broken".
     * These headers keep every page honest after each publish. */
    var body = data;
    if (String(entry[1]).indexOf('text/html') === 0) {
      body = Buffer.from(data.toString('utf8').split(BUILD_TOKEN).join(BUILD), 'utf8');
    }
    res.writeHead(200, {
      'Content-Type': entry[1],
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    res.end(body);
  });
}

/* ---------- Demo seed (server-side) ---------- */
function seedOrders() {
  var picks = ['到店自取', '到店自取', '需要外送'];
  var menuIds = Object.keys(MENU);
  var specs = ['少冰 · 半糖', '正常冰 · 七分糖', '去冰 · 三分糖', '热饮 · 半糖', '少冰 · 无糖 · 加珍珠', ''];
  var now = Date.now();
  var made = [];

  [0, 1, 2, 3].forEach(function(i) {
    var n = 1 + Math.floor(Math.random() * 2);
    var items = [], total = 0, qty = 0;
    for (var j = 0; j < n; j++) {
      var id = menuIds[Math.floor(Math.random() * menuIds.length)];
      var q = 1 + Math.floor(Math.random() * 2);
      var addons = Math.random() < 0.3 ? ['珍珠'] : [];
      var unit = MENU[id].price + addons.length * ADDON_PRICE;
      items.push({ id: id, name: '示例饮品 ' + id, qty: q, unit: unit, spec: specs[Math.floor(Math.random() * specs.length)], addons: addons });
      total += unit * q; qty += q;
    }
    var d = new Date(now - (i + 1) * (7 + Math.floor(Math.random() * 14)) * 60000);
    made.push({
      no: 'CY' + String(d.getFullYear()).slice(2) + pad(d.getMonth() + 1) + pad(d.getDate()) +
          pad(d.getHours()) + pad(d.getMinutes()) + '-' + Math.floor(1000 + Math.random() * 9000),
      ts: d.getTime(),
      time: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()),
      pick: picks[Math.floor(Math.random() * picks.length)],
      phone: '138' + Math.floor(10000000 + Math.random() * 89999999),
      note: i === 2 ? '少放冰，打包分开装' : '',
      items: items,
      qty: qty,
      total: total,
      status: i === 0 ? 'new' : (i === 1 ? 'making' : 'done')
    });
  });
  return made;
}

/* ---------- Router ---------- */
var server = http.createServer(function(req, res) {
  var fullUrl = req.url || '/';
  var urlPath = fullUrl.split('?')[0];
  var query = {};
  var qIndex = fullUrl.indexOf('?');
  if (qIndex > -1) {
    fullUrl.slice(qIndex + 1).split('&').forEach(function(pair) {
      if (!pair) return;
      var eq = pair.indexOf('=');
      var k = eq > -1 ? pair.slice(0, eq) : pair;
      var v = eq > -1 ? pair.slice(eq + 1) : '';
      try { query[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' ')); } catch (e) {}
    });
  }
  var ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').split(',')[0].trim();

  /* health */
  if (urlPath === '/health' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, orders: db.orders.length });
  }

  /* build id — pages compare this with their own embedded id and reload with a
   * cache-busting query if they are a stale copy served by the gateway cache */
  if (urlPath === '/api/version' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, build: BUILD });
  }

  /* auth probe: reports HOW the token arrived (booleans only, no secrets) —
   * used to diagnose proxies that strip the Authorization header.
   * Add ?diag=1 to also get non-secret process fingerprints (which instance
   * answered, which signing key it holds) — these pin down "the server rejects
   * its own token" cases caused by multiple instances or a stale process. */
  if (urlPath === '/api/authprobe' && req.method === 'GET') {
    var src = {};
    var tk = readToken(req, query, src);
    var parts = String(tk).split('.');
    var expected = parts[0]
      ? b64url(crypto.createHmac('sha256', TOKEN_SECRET).update(parts[0]).digest())
      : '';
    var body = {
      ok: true,
      sawAuthorizationHeader: !!req.headers['authorization'],
      sawCookie: !!req.headers['cookie'],
      sawXcyHeader: !!req.headers['x-cy-token'],
      channelsSeen: src.seen || [],
      tokenVia: src.via,
      tokenValid: tokenValid(tk),
      forwardedFor: req.headers['x-forwarded-for'] ? 'present' : 'absent'
    };
    if (query && query.diag === '1') {
      body.tokenLen = String(tk).length;
      body.partsLen = parts.length;
      body.receivedSigHead = parts[1] ? parts[1].slice(0, 8) : null;
      body.expectedSigHead = expected ? expected.slice(0, 8) : null;
      body.sigMatch = !!(parts[1] && expected && parts[1] === expected);
      body.payloadHead = parts[0] ? parts[0].slice(0, 24) : null;
      body.pid = process.pid;
      body.uptimeSec = Math.round(process.uptime());
      body.node = process.version;
      /* fingerprint of the signing key: a hash, not the key — cannot be used to forge */
      body.secretFp = crypto.createHash('sha256').update(TOKEN_SECRET).digest('hex').slice(0, 8);
      body.pwdFp = ADMIN_LOGIN_ENABLED ? crypto.createHash('sha256').update(ADMIN_PASSWORD).digest('hex').slice(0, 8) : null;
      body.pwdLen = ADMIN_LOGIN_ENABLED ? ADMIN_PASSWORD.length : 0;
    }
    return sendJson(res, 200, body);
  }

  /* ---------- public: place order ---------- */
  if (urlPath === '/api/orders' && req.method === 'POST') {
    if (!rateLimit('order:' + ip, 30, 60000)) {
      return sendJson(res, 429, { ok: false, error: '操作太频繁，请稍后再试 / Too many requests' });
    }
    return readBody(req, function(body) {
      if (!body) return sendJson(res, 400, { ok: false, error: 'bad json' });
      var built = buildOrder(body);
      if (built.error) return sendJson(res, 400, { ok: false, error: built.error });

      /* idempotency: same order number -> return the existing one */
      var existing = findOrder(built.order.no);
      if (existing) return sendJson(res, 200, { ok: true, duplicate: true, order: existing });

      db.orders.unshift(built.order);
      persistDb();
      return sendJson(res, 200, { ok: true, order: built.order });
    });
  }

  /* ---------- public: login ---------- */
  if (urlPath === '/api/login' && req.method === 'POST') {
    if (!rateLimit('login:' + ip, 10, 300000)) {
      return sendJson(res, 429, { ok: false, error: '尝试太频繁，请 5 分钟后再试' });
    }
    return readBody(req, function(body) {
      if (!ADMIN_LOGIN_ENABLED) {
        /* Config problem, not a wrong password: say so precisely, so the store owner
           does not chase a phantom "wrong password" (a symptom this project has been
           burned by before). */
        return sendJson(res, 200, {
          ok: false,
          reason: 'not_configured',
          error: 'dashboard login is disabled: ADMIN_PASSWORD is not set on the server'
        });
      }
      if (!body || cleanStr(body.password, 100) !== ADMIN_PASSWORD) {
        return sendJson(res, 200, { ok: false, error: 'wrong password' });
      }
      var out = { ok: true, token: issueToken() };
      if (query && query.diag === '1') {
        out.pid = process.pid;
        out.uptimeSec = Math.round(process.uptime());
        out.secretFp = crypto.createHash('sha256').update(TOKEN_SECRET).digest('hex').slice(0, 8);
        out.pwdFp = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest('hex').slice(0, 8);
        out.pwdLen = ADMIN_PASSWORD.length;
      }
      return sendJson(res, 200, out);
    });
  }

  /* ---------- authed endpoints ---------- */
  var auth = readToken(req, query);
  if (urlPath.indexOf('/api/orders') === 0) {
    if (!tokenValid(auth)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });

    /* list */
    if (urlPath === '/api/orders' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true, orders: db.orders });
    }

    /* clear all */
    if (urlPath === '/api/orders' && req.method === 'DELETE') {
      db.orders = [];
      persistDb();
      return sendJson(res, 200, { ok: true });
    }

    /* seed demo */
    if (urlPath === '/api/orders/seed' && req.method === 'POST') {
      var demo = seedOrders();
      var fresh = demo.filter(function(o) { return !findOrder(o.no); });
      db.orders = fresh.concat(db.orders);
      persistDb();
      return sendJson(res, 200, { ok: true, orders: db.orders });
    }

    /* update status: /api/orders/:no/status */
    var m = urlPath.match(/^\/api\/orders\/([^/]+)\/status$/);
    if (m && req.method === 'PATCH') {
      return readBody(req, function(body) {
        if (!body || VALID_STATUS.indexOf(body.status) === -1) {
          return sendJson(res, 400, { ok: false, error: 'bad status' });
        }
        var o = findOrder(m[1]);
        if (!o) return sendJson(res, 404, { ok: false, error: 'order not found' });
        o.status = body.status;
        o.updatedAt = Date.now();
        persistDb();
        return sendJson(res, 200, { ok: true, order: o });
      });
    }
  }

  /* ---------- static ---------- */
  if (req.method === 'GET') return serveStatic(req, res, urlPath);

  res.writeHead(405); res.end('Method Not Allowed');
});

loadDb();
server.listen(PORT, HOST, function() {
  console.log('[tea-courtyard] listening on http://' + HOST + ':' + PORT);
});
