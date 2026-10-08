/*
 * Live smoke test against the PUBLISHED site (not a local server).
 *
 *   node tests/live-smoke.js        # or: npm run test:live
 *
 * It drives two separate browser contexts, imitating a customer on a phone and
 * the store on a laptop:
 *   A. menu page -> add a drink, pick ice/sugar, submit, read the order number
 *   B. dashboard -> log in with the admin password, assert that exact order
 *                   number appears
 *
 * It follows the DEFAULT language, which is English: `/` is the menu customers
 * actually get and `/store` is the dashboard the shop is given. That is why the
 * ice/sugar labels clicked below are the English ones — the Chinese pages use
 * different strings ('去冰' / '无糖'), and clicking those would silently fail on
 * an English page.
 *
 * Why this exists: three separate production-only failures (gateway replacing the
 * Authorization header, a stale cached orders.html, a login modal that could never
 * open) passed every local test and only showed up here. Run this after each publish.
 *
 * Caveats:
 *   - It creates ONE real order in the production data file; the script marks it
 *     canceled at the end so the store dashboard stays tidy.
 *   - Requires the Playwright Chromium build: npx playwright install chromium
 *   - Override the target with SMOKE_BASE=...; SMOKE_PASS=... is REQUIRED
 *     (there is no default password anywhere in this repository)
 */
'use strict';

var chromium = require('@playwright/test').chromium;

var BASE = process.env.SMOKE_BASE || 'https://tea-courtyard.app.workbuddy.host';
var PASSWORD = process.env.SMOKE_PASS;
if (!PASSWORD) {
  console.error(
    '[live-smoke] SMOKE_PASS is not set - refusing to run.\n' +
    'This script logs into a real site, so the password must be supplied explicitly:\n' +
    '  SMOKE_PASS=your-secret node tests/live-smoke.js'
  );
  process.exit(1);
}
var TEST_PHONE = '13800001234';

var log = function (s) { console.log(s); };

(async function () {
  var browser = await chromium.launch();
  var failures = [];
  var orderNo = null;

  try {
    /* ---------- A. customer places an order ---------- */
    var customer = await browser.newContext();
    var a = await customer.newPage();
    var apiA = [];
    a.on('response', function (r) {
      if (r.url().indexOf('/api/') > -1) {
        apiA.push(r.request().method() + ' ' + r.url().replace(BASE, '').split('?')[0] + ' -> ' + r.status());
      }
    });

    await a.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await a.waitForSelector('#navCart');

    await a.click('.add-btn[data-id="p1"]');
    await a.waitForSelector('#sheet.on');
    await a.click('#sIce .chip[data-v="No Ice"]');
    await a.click('#sSugar .chip[data-v="0% Sugar"]');
    await a.click('#sOk');
    await a.waitForFunction(function () {
      return !document.querySelector('#sheet').classList.contains('on');
    });

    // adding an item opens the cart drawer asynchronously — just wait for it
    await a.waitForSelector('#drawer.on', { timeout: 15000 });
    await a.fill('#phone', TEST_PHONE);
    await a.click('#submitBtn');
    await a.waitForSelector('#done.on', { timeout: 20000 });

    var doneText = (await a.textContent('#doneNo')) || '';
    var m = doneText.match(/CY\d{10}-\d{4}/);
    orderNo = m ? m[0] : null;

    log('customer: order placed           -> ' + (orderNo || 'FAILED (no order number)'));
    log('  panel text : ' + doneText.trim());
    log('  api        : ' + apiA.join(' | '));
    if (!orderNo) failures.push('no order number in the confirmation panel');
    if (apiA.join(' ').indexOf('POST /api/orders -> 200') === -1) {
      failures.push('POST /api/orders did not return 200');
    }

    /* ---------- B. store logs in and finds it ---------- */
    var store = await browser.newContext();
    var b = await store.newPage();
    var apiB = [];
    b.on('response', function (r) {
      if (r.url().indexOf('/api/') > -1) {
        apiB.push(r.request().method() + ' ' + r.url().replace(BASE, '').split('?')[0] + ' -> ' + r.status());
      }
    });

    /* The publishing gateway caches pages per exact URL and can hand out an
     * out-of-date copy after a deploy. /store is the address we actually hand out:
     * it was never requested before the no-store fix, so the gateway has no stale
     * entry for it — check that one, and recover via ?v= if it ever goes stale. */
    var build = '';
    try { build = (await (await fetch(BASE + '/api/version')).json()).build; } catch (e) {}

    async function loadDashboard(page, url) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      return await page.evaluate(function () { return window.__CX_BUILD__ || null; });
    }

    var pageBuild = await loadDashboard(b, BASE + '/store');
    if (build && pageBuild !== build) {
      log('dashboard: STALE cached copy served by the gateway for /store');
      log('  page build ' + pageBuild + ' vs server build ' + build + ' -> retrying with a cache-buster');
      pageBuild = await loadDashboard(b, BASE + '/store?v=' + build);
      if (pageBuild !== build) {
        failures.push('gateway keeps serving a stale /store even with a cache-buster');
      }
    }
    log('');
    log('dashboard: page build ' + pageBuild + ' (server ' + (build || 'unknown') + ')');

    /* Informational: the legacy bare path still has a pre-fix entry in the gateway
     * cache, so it can serve a copy whose login is broken. Reported, not failed —
     * nobody is told to use it. */
    var legacyFresh = false;
    try {
      var legacyHtml = await (await fetch(BASE + '/orders.html')).text();
      legacyFresh = !!build && legacyHtml.indexOf("window.__CX_BUILD__ = '" + build + "'") > -1;
    } catch (e) {}
    log('legacy bare /orders.html fresh -> ' + (legacyFresh ? 'yes' : 'NO (gateway cache; hand out /store instead)'));

    await b.waitForSelector('#login', { state: 'visible', timeout: 15000 });
    log('dashboard: login modal appears   -> OK');

    await b.fill('#loginPwd', PASSWORD);
    await b.click('#loginOk');

    // the modal closing is the proof that login + the first authed request succeeded
    await b.waitForFunction(function () {
      var el = document.querySelector('#login');
      return el && getComputedStyle(el).display === 'none';
    }, null, { timeout: 20000 });
    log('dashboard: login accepted        -> OK');

    await b.waitForTimeout(1500);
    var body = await b.textContent('body');
    var visible = !!(orderNo && body.indexOf(orderNo) > -1);
    log('dashboard: order ' + orderNo + ' visible -> ' + (visible ? 'YES' : 'NO'));
    log('  api        : ' + apiB.join(' | '));

    if (!visible) failures.push('order ' + orderNo + ' not visible on the dashboard after login');
    if (apiB.join(' ').indexOf('GET /api/orders -> 200') === -1) {
      failures.push('no successful GET /api/orders after login (auth broken)');
    }

    /* ---------- tidy up: mark the test order canceled ---------- */
    if (orderNo) {
      var cancelled = await b.evaluate(async function (no) {
        var t = null;
        try { t = sessionStorage.getItem('cy_token'); } catch (e) {}
        if (!t) return 'no token';
        var r = await fetch('/api/orders/' + encodeURIComponent(no) + '/status?token=' + encodeURIComponent(t), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'X-Cy-Token': t },
          body: JSON.stringify({ status: 'canceled' })
        });
        return r.status;
      }, orderNo);
      log('');
      log('cleanup: test order marked canceled -> ' + cancelled);
    }
  } catch (e) {
    failures.push('threw: ' + e.message);
    log('');
    log('ERROR: ' + e.message);
  } finally {
    await browser.close();
  }

  log('');
  if (failures.length) {
    log('LIVE SMOKE: FAIL');
    failures.forEach(function (f) { log('  - ' + f); });
    process.exitCode = 1;
  } else {
    log('LIVE SMOKE: PASS — customer order reaches the store dashboard on ' + BASE);
  }
})();
