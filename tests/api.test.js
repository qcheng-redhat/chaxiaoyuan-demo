/*
 * API regression tests for server.js — zero dependencies, Node built-in runner.
 *
 * Run:  node --test tests/
 *
 * Spawns a real server on port 3777 with an isolated temp data directory
 * and a test-only admin password, so the real data/orders.json is never touched.
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var spawn = require('child_process').spawn;
var path = require('path');
var fs = require('fs');
var os = require('os');

var PORT = 3777;
var BASE = 'http://127.0.0.1:' + PORT;
var PASS = 'test-pass-123';
var child = null;
var tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'tea-test-'));
var token = '';

function req(method, p, body, auth) {
  var headers = { 'Content-Type': 'application/json' };
  if (auth) headers['Authorization'] = 'Bearer ' + auth;
  return fetch(BASE + p, {
    method: method,
    headers: headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  }).then(function (r) {
    return r.json().then(function (j) { return { status: r.status, body: j }; });
  });
}

function orderBody(no, overrides) {
  var o = {
    no: no,
    pick: 'Pickup',
    phone: '13800000000',
    note: 'test order',
    items: [{ id: 'p1', name: 'Black Sugar Pearl Milk', qty: 2, spec: 'Less Ice/50%', addons: ['Pearl'] }]
  };
  if (overrides) for (var k in overrides) o[k] = overrides[k];
  return o;
}

test.before(async function () {
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT), DATA_DIR: tmpData, ADMIN_PASSWORD: PASS }),
    stdio: 'ignore'
  });
  for (var i = 0; i < 50; i++) {
    try {
      var r = await fetch(BASE + '/health');
      if (r.ok) return;
    } catch (e) { /* not up yet */ }
    await new Promise(function (res) { setTimeout(res, 100); });
  }
  throw new Error('server did not start within 5s');
});

test.after(function () {
  if (child) child.kill();
  if (child2) child2.kill();
  try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch (e) {}
  try { fs.rmSync(tmpData2, { recursive: true, force: true }); } catch (e) {}
});

/* ---------- health ---------- */

test('GET /health returns ok', async function () {
  var r = await fetch(BASE + '/health');
  var j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.ok, true);
});

/* ---------- order placement & server-side price recomputation ---------- */

test('place order: total is recomputed from the SERVER menu, client-sent total ignored', async function () {
  var body = orderBody('CY2609181000-1111', { items: [{ id: 'p1', name: 'X', qty: 2, addons: ['Pearl'] }], total: 999 });
  var r = await req('POST', '/api/orders', body);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.order.total, 38);          // (16 + 3) * 2, NOT 999
  assert.equal(r.body.order.qty, 2);
  assert.equal(r.body.order.status, 'new');
});

test('rejects malformed order number', async function () {
  var r = await req('POST', '/api/orders', orderBody('FAKE-1'));
  assert.equal(r.status, 400);
});

test('rejects unknown product id', async function () {
  var r = await req('POST', '/api/orders', orderBody('CY2609181001-2222', { items: [{ id: 'hack', qty: 1 }] }));
  assert.equal(r.status, 400);
  assert.match(r.body.error, /unknown product/);
});

test('rejects bad qty (0, non-integer, over 99)', async function () {
  for (var i = 0; i < 3; i++) {
    var r = await req('POST', '/api/orders', orderBody('CY2609181002-333' + i, { items: [{ id: 'p1', qty: [0, 1.5, 100][i] }] }));
    assert.equal(r.status, 400);
    assert.match(r.body.error, /bad qty/);
  }
});

/* ---------- idempotency ---------- */

test('idempotency: same order number twice -> duplicate:true, still only one in the list', async function () {
  var first = await req('POST', '/api/orders', orderBody('CY2609181003-4444'));
  var second = await req('POST', '/api/orders', orderBody('CY2609181003-4444'));
  assert.equal(first.body.ok, true);
  assert.equal(second.body.ok, true);
  assert.equal(second.body.duplicate, true);
  assert.equal(second.body.order.no, first.body.order.no);

  var login = await req('POST', '/api/login', { password: PASS });
  token = login.body.token;
  assert.equal(login.body.ok, true);

  var list = await req('GET', '/api/orders', undefined, token);
  var matches = list.body.orders.filter(function (o) { return o.no === 'CY2609181003-4444'; });
  assert.equal(matches.length, 1);
});

/* ---------- auth ---------- */

test('GET /api/orders without token -> 401', async function () {
  var r = await req('GET', '/api/orders');
  assert.equal(r.status, 401);
});

test('login with wrong password -> ok:false', async function () {
  var r = await req('POST', '/api/login', { password: 'wrong' });
  assert.equal(r.body.ok, false);
});

test('PATCH status requires token too', async function () {
  var r = await req('PATCH', '/api/orders/CY2609181003-4444/status', { status: 'making' });
  assert.equal(r.status, 401);
});

/* ---------- token transport (Authorization header / query / cookie) ---------- */

test('token works via ?token= query param (proxy may strip the Authorization header)', async function () {
  var r = await fetch(BASE + '/api/orders?token=' + encodeURIComponent(token));
  assert.equal(r.status, 200);
  var j = await r.json();
  assert.equal(j.ok, true);
});

test('token works via cy_token cookie', async function () {
  var r = await fetch(BASE + '/api/orders', { headers: { Cookie: 'cy_token=' + token } });
  assert.equal(r.status, 200);
});

test('tampered / forged tokens are rejected on every transport', async function () {
  var forged = token.slice(0, -2) + (token.slice(-2) === 'aa' ? 'bb' : 'aa');
  var h = await fetch(BASE + '/api/orders', { headers: { Authorization: 'Bearer ' + forged } });
  var q = await fetch(BASE + '/api/orders?token=' + encodeURIComponent(forged));
  var c = await fetch(BASE + '/api/orders', { headers: { Cookie: 'cy_token=' + forged } });
  assert.equal(h.status, 401);
  assert.equal(q.status, 401);
  assert.equal(c.status, 401);
});

test('token works via the X-Cy-Token header alone', async function () {
  var r = await fetch(BASE + '/api/orders', { headers: { 'X-Cy-Token': token } });
  assert.equal(r.status, 200);
});

/* Regression for the published-site outage: the publishing gateway REPLACES the
 * Authorization header with its own 3-part JWT. The server must ignore that and
 * authenticate from whichever channel actually carries our token. */
var GATEWAY_JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJnYXRld2F5In0.' + 'x'.repeat(43);

test('a gateway JWT squatting on Authorization does not break auth (other channel wins)', async function () {
  var viaCustom = await fetch(BASE + '/api/orders', {
    headers: { 'X-Cy-Token': token, Authorization: 'Bearer ' + GATEWAY_JWT }
  });
  assert.equal(viaCustom.status, 200);

  var viaQuery = await fetch(BASE + '/api/orders?token=' + encodeURIComponent(token), {
    headers: { Authorization: 'Bearer ' + GATEWAY_JWT }
  });
  assert.equal(viaQuery.status, 200);

  var viaCookie = await fetch(BASE + '/api/orders', {
    headers: { Cookie: 'cy_token=' + encodeURIComponent(token), Authorization: 'Bearer ' + GATEWAY_JWT }
  });
  assert.equal(viaCookie.status, 200);

  var probe = await (await fetch(BASE + '/api/authprobe?token=' + encodeURIComponent(token), {
    headers: { 'X-Cy-Token': token, Authorization: 'Bearer ' + GATEWAY_JWT }
  })).json();
  assert.equal(probe.tokenValid, true);
  assert.equal(probe.tokenVia, 'xcyheader');
});

test('a lone gateway JWT is still rejected (no auth bypass)', async function () {
  var r = await fetch(BASE + '/api/orders', { headers: { Authorization: 'Bearer ' + GATEWAY_JWT } });
  assert.equal(r.status, 401);
});

test('authprobe reports how the token arrived', async function () {
  var p1 = await req('GET', '/api/authprobe');
  assert.equal(p1.body.tokenVia, 'none');
  assert.equal(p1.body.tokenValid, false);

  var r = await fetch(BASE + '/api/authprobe?token=' + encodeURIComponent(token));
  var p2 = await r.json();
  assert.equal(p2.tokenVia, 'query');
  assert.equal(p2.tokenValid, true);

  var r3 = await fetch(BASE + '/api/authprobe', { headers: { Authorization: 'Bearer ' + token } });
  var p3 = await r3.json();
  assert.equal(p3.tokenVia, 'header');
  assert.equal(p3.tokenValid, true);
});

/* ---------- cache headers ---------- */

test('static pages and API replies forbid caching (the gateway served stale HTML)', async function () {
  var s = await fetch(BASE + '/orders.html');
  assert.equal(s.status, 200);
  assert.match(s.headers.get('cache-control') || '', /no-store/);

  var i = await fetch(BASE + '/');
  assert.match(i.headers.get('cache-control') || '', /no-store/);

  var h = await fetch(BASE + '/health');
  assert.match(h.headers.get('cache-control') || '', /no-store/);
});

test('GET /api/version exposes a build id, and pages embed the same one', async function () {
  var v = await fetch(BASE + '/api/version');
  var j = await v.json();
  assert.equal(j.ok, true);
  assert.match(j.build, /^[0-9a-f]{10}$/);

  // the placeholder is substituted at serve time, so a stale cached copy is detectable
  var page = await (await fetch(BASE + '/orders.html')).text();
  assert.equal(page.indexOf('__BUILD__'), -1, 'served page still contains the raw placeholder');
  assert.ok(page.indexOf("window.__CX_BUILD__ = '" + j.build + "'") > -1,
    'served page does not carry the current build id');
});

/* ---------- short aliases ---------- */

/* Why these matter: the publishing gateway caches per exact URL, and two URLs
 * cached before the no-store fix (/index.html, /orders.html) still return that
 * pre-fix copy part of the time. A URL that has never been requested has no such
 * entry, so /store and /menu are the addresses that are actually safe to bookmark. */
test('short aliases serve the same pages as the .html paths, with the current build id', async function () {
  var v = await (await fetch(BASE + '/api/version')).json();
  var pairs = [
    ['/menu', '/index.html'],
    ['/menu-en', '/index-en.html'],
    ['/store', '/orders.html'],
    ['/store-en', '/orders-en.html']
  ];
  for (var i = 0; i < pairs.length; i++) {
    var alias = await fetch(BASE + pairs[i][0]);
    assert.equal(alias.status, 200, pairs[i][0] + ' is not served');
    var text = await alias.text();
    assert.ok(text.indexOf("window.__CX_BUILD__ = '" + v.build + "'") > -1,
      pairs[i][0] + ' does not carry the current build id');
    assert.match(alias.headers.get('cache-control') || '', /no-store/);
  }
});

test('every internal .html link is cache-busted (a bare link can land on a stale copy)', async function () {
  var pages = ['/', '/index.html', '/index-en.html', '/orders.html', '/orders-en.html'];
  for (var i = 0; i < pages.length; i++) {
    var html = await (await fetch(BASE + pages[i])).text();
    var hrefs = html.match(/href="[^"]+\.html[^"]*"/g) || [];
    for (var j = 0; j < hrefs.length; j++) {
      assert.ok(hrefs[j].indexOf('?v=') > -1 || hrefs[j].indexOf('.html#') > -1,
        pages[i] + ' has a bare internal link: ' + hrefs[j]);
    }
  }
});

/* ---------- status flow ---------- */

test('PATCH status new -> making -> done, invalid status rejected', async function () {
  var r1 = await req('PATCH', '/api/orders/CY2609181003-4444/status', { status: 'making' }, token);
  assert.equal(r1.body.ok, true);
  assert.equal(r1.body.order.status, 'making');

  var r2 = await req('PATCH', '/api/orders/CY2609181003-4444/status', { status: 'done' }, token);
  assert.equal(r2.body.order.status, 'done');

  var bad = await req('PATCH', '/api/orders/CY2609181003-4444/status', { status: 'hacked' }, token);
  assert.equal(bad.status, 400);
});

/* ---------- rate limiting (must stay last: it exhausts the order budget) ---------- */

test('rate limiting: the 31st POST within one minute -> 429', async function () {
  // 5 POSTs were consumed above (1 ok + 4 rejected-but-counted). Send 30 more.
  var got429 = false;
  for (var i = 0; i < 30; i++) {
    var res = await fetch(BASE + '/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(orderBody('CY2609182000-' + String(1000 + i)))
    });
    if (res.status === 429) { got429 = true; break; }
  }
  assert.equal(got429, true, 'expected a 429 within 30 extra requests');
});

/* ---------- cleanup endpoint ---------- */

test('DELETE /api/orders clears everything (auth)', async function () {
  var r = await req('DELETE', '/api/orders', undefined, token);
  assert.equal(r.body.ok, true);
  var list = await req('GET', '/api/orders', undefined, token);
  assert.equal(list.body.orders.length, 0);
});

/* ---------- no-password mode (ADMIN_PASSWORD unset) ----------
 * The site MUST still boot and serve customers; only the dashboard login is disabled.
 * Spawned on its own port with ADMIN_PASSWORD explicitly removed from the env. */

var PORT2 = 3778;
var BASE2 = 'http://127.0.0.1:' + PORT2;
var child2 = null;
var tmpData2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tea-test-nopass-'));

function req2(method, p, body, headers) {
  return fetch(BASE2 + p, {
    method: method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
    body: body === undefined ? undefined : JSON.stringify(body)
  }).then(function (r) {
    return r.json().then(function (j) { return { status: r.status, body: j }; });
  });
}

async function ensureNoPassServer() {
  if (child2) return;
  var env = Object.assign({}, process.env, { PORT: String(PORT2), DATA_DIR: tmpData2 });
  delete env.ADMIN_PASSWORD;                       // the whole point of this block
  child2 = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: env,
    stdio: 'ignore'
  });
  for (var i = 0; i < 50; i++) {
    try {
      var r = await fetch(BASE2 + '/health');
      if (r.ok) return;
    } catch (e) { /* not up yet */ }
    await new Promise(function (res) { setTimeout(res, 100); });
  }
  throw new Error('no-password server did not start within 5s');
}

test('no ADMIN_PASSWORD: the site still boots (health + version answer)', async function () {
  await ensureNoPassServer();
  var h = await fetch(BASE2 + '/health');
  var v = await fetch(BASE2 + '/api/version');
  assert.equal(h.status, 200);
  assert.equal((await h.json()).ok, true);
  assert.equal(v.status, 200);
  assert.match((await v.json()).build, /^[0-9a-f]+$/);
});

test('no ADMIN_PASSWORD: login is refused as "not_configured", even with a password sent', async function () {
  var r = await req2('POST', '/api/login', { password: 'whatever' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.reason, 'not_configured');
  assert.equal(r.body.token, undefined);
});

test('no ADMIN_PASSWORD: a token forged with the well-known empty-password secret is rejected', async function () {
  /* If the secret were still derived from the (empty) password, anyone could compute it.
   * The server must use a random per-process secret instead, so this forged token fails. */
  var crypto = require('crypto');
  var secret = crypto.createHash('sha256').update('tea-courtyard-token-v1|').digest();
  function b64url(buf) { return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  var payload = b64url(Buffer.from(JSON.stringify({ exp: Date.now() + 3600 * 1000 })));
  var forged = payload + '.' + b64url(crypto.createHmac('sha256', secret).update(payload).digest());
  var r = await req2('GET', '/api/orders', undefined, { 'X-Cy-Token': forged });
  assert.equal(r.status, 401);
  assert.equal(r.body.ok, false);
});
