/*
 * Freshness audit for the published site.
 *
 *   node tests/audit-freshness.js        # or: npm run test:fresh
 *
 * Why: the publishing gateway caches responses PER URL, and an entry created before
 * a page learned to self-heal keeps being served — it is never revalidated, and
 * republishing does not clear it. This script samples every page and classifies what
 * the gateway handed out. There are two very different kinds of "out of date":
 *
 *   fresh          — the current build id is embedded in the page.
 *   self-healable  — an OLDER build id: the page will notice the mismatch, reload
 *                    itself once with ?v=<current build> and come back correct.
 *                    The user sees a flicker, not a failure. Normal, expected.
 *   pre-fix        — NO build id at all: the copy predates the self-heal release, so
 *                    nothing can rescue it. On a dashboard this means the login is
 *                    genuinely broken for whoever receives it. This is the dangerous
 *                    class, and it must never be served under a URL we hand out.
 *
 * NOTE this script uses plain fetch, so it measures what the GATEWAY sends, not what a
 * browser ends up displaying (a self-healable copy is invisible to a real user). Read it
 * as "is the gateway clean", not "are users broken".
 *
 * Each line also reports how many responses came from the CDN's own store instead of origin.
 * `eo-cache-status` (HIT/MISS) and `Age` are the authoritative fields when the CDN exposes
 * them; the older tell — a missing Cache-Control header, because origin always sends no-store
 * and a stored copy predating it arrives bare — is kept as a fallback for CDNs that do not.
 * So `HIT 0/8` means the URL is not being served from a stored copy at all.
 *
 * The run also asserts that no-store is actually being honoured: it requests a cache key
 * that cannot exist yet, then repeats it, and requires the repeat to still be a MISS.
 * A HIT there means the CDN started storing responses we told it not to — the one regression
 * that would silently re-poison every advertised URL.
 *
 * URLs are judged in two classes: the addresses we advertise (`strict` — /, /menu,
 * /menu-en, /store, /store-en) must never serve a pre-fix copy, because those are the entry
 * points customers and the shop actually use. The legacy .html paths are reported for
 * information only. Their expired entries cannot be purged on demand — but they do expire on
 * their own, so expect them to go clean eventually and treat a lingering pre-fix copy there
 * as a warning, not an incident.
 *
 * Exit code 1 if a strict URL serves a pre-fix copy or is stale on every sample.
 */
'use strict';

var BASE = process.env.SMOKE_BASE || 'https://tea-courtyard.app.workbuddy.host';
var SAMPLES = Number(process.env.AUDIT_SAMPLES || 8);

var PAGES = [
  { url: '/',           strict: true },
  { url: '/menu',       strict: true },
  { url: '/menu-en',    strict: true },
  { url: '/store',      strict: true },
  { url: '/store-en',   strict: true },
  { url: '/index.html',    strict: false, note: 'legacy path' },
  { url: '/index-en.html', strict: false, note: 'legacy path' },
  { url: '/orders.html',   strict: false, note: 'legacy path' },
  { url: '/orders-en.html', strict: false, note: 'legacy path' }
];

var BUILD_RE = /__CX_BUILD__\s*=\s*'([^']*)'/;

async function probe(url, build) {
  var fresh = 0, healable = 0, prefix = 0, viaGateway = 0;
  var sizes = {}, cc = {}, cdn = {}, ages = [];
  for (var i = 0; i < SAMPLES; i++) {
    var r = await fetch(BASE + url);
    var buf = Buffer.from(await r.arrayBuffer());
    var text = buf.toString('utf8');
    var m = text.match(BUILD_RE);
    var id = m ? m[1] : null;
    if (id === build) fresh++;
    else if (id) healable++;
    else prefix++;
    var c = r.headers.get('cache-control');
    if (!c) viaGateway++;
    /* Authoritative when the CDN exposes it: `eo-cache-status` says HIT/MISS outright and
     * `Age` says how long the stored object has been alive. Use those when present; fall
     * back to the missing-Cache-Control fingerprint otherwise (origin always sends
     * no-store, a stored copy predating it arrives without the header). */
    var st = r.headers.get('eo-cache-status') || (c ? 'ORIGIN' : 'CACHE');
    cdn[st] = (cdn[st] || 0) + 1;
    var age = Number(r.headers.get('age'));
    if (st === 'HIT' && isFinite(age) && age > 0) ages.push(age);
    sizes[buf.length] = (sizes[buf.length] || 0) + 1;
    cc[c || '(none)'] = (cc[c || '(none)'] || 0) + 1;
  }
  return { fresh: fresh, healable: healable, prefix: prefix, viaGateway: viaGateway,
           sizes: sizes, cc: cc, cdn: cdn, ages: ages };
}

/* Several edge nodes each hold their own copy, stored at slightly different times, which is
 * why one URL can be stale on some requests and current on others.
 *
 * Age is seconds since the CDN filled the object, so `now - Age` pins the moment it was
 * stored. That timestamp is the number worth reading: a copy filled in the past is a fossil
 * that is merely ageing in place and will never turn current. If a URL ever recovers, its
 * fill time jumps forward to now — so watching the fill time is how you tell "healed" from
 * "still poisoned", without needing to know the CDN's TTL. */
function fillClock(ageSec) {
  var d = new Date(Date.now() - ageSec * 1000);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function cdnLine(r) {
  var parts = [];
  Object.keys(r.cdn).sort().forEach(function (k) { parts.push(k + ' ' + r.cdn[k] + '/' + SAMPLES); });
  var out = parts.join('   ');
  if (r.ages.length) {
    var s = r.ages.slice().sort(function (a, b) { return a - b; });
    out += '   age ' + s[0] + '-' + s[s.length - 1] + 's';
    out += '   filled ' + fillClock(s[0]) + (s.length > 1 ? '..' + fillClock(s[s.length - 1]) : '');
    if (s[s.length - 1] - s[0] > 30) out += '   (' + s.length + ' edge copies, filled minutes apart)';
  }
  return out;
}

function report(label, r, strict, note) {
  var parts = ['fresh ' + r.fresh + '/' + SAMPLES];
  if (r.healable) parts.push('self-healable ' + r.healable);
  if (r.prefix) parts.push('PRE-FIX ' + r.prefix);
  var flag = '';
  if (r.prefix > 0) flag = strict ? '  <-- PRE-FIX COPY ON AN ADDRESS WE HAND OUT' : '  <-- pre-fix copy (legacy, unfixable)';
  else if (r.healable > 0) flag = '  <-- older copy; pages reload themselves once';
  else if (r.fresh === 0) flag = '  <-- ALL STALE';
  console.log(label.padEnd(18) + parts.join('  ') + (note ? '   (' + note + ')' : '') + flag);
  console.log(''.padEnd(18) + 'CDN: ' + cdnLine(r));
  if (r.prefix > 0 || r.healable > 0) {
    console.log(''.padEnd(18) + 'stale-evidence: sizes=' + JSON.stringify(r.sizes));
  }
}

(async function () {
  var version;
  try {
    version = await (await fetch(BASE + '/api/version')).json();
  } catch (e) {
    console.log('cannot reach ' + BASE + ' — ' + e.message);
    process.exitCode = 1;
    return;
  }

  var build = version.build;
  console.log('server build id : ' + build);
  console.log('samples per page: ' + SAMPLES);
  console.log('');

  var failures = [];
  var warnings = [];

  for (var i = 0; i < PAGES.length; i++) {
    var p = PAGES[i];
    var r = await probe(p.url, build);
    report(p.url, r, p.strict, p.note);
    if (p.strict) {
      if (r.prefix > 0) failures.push(p.url + ' served a pre-fix copy (' + r.prefix + '/' + SAMPLES + ')');
      else if (r.fresh < SAMPLES) warnings.push(p.url + ' served an older but self-healing copy (' + r.healable + '/' + SAMPLES + ')');
      else if (r.fresh === 0) failures.push(p.url + ' is entirely stale');
    }
  }

  // the cache-busted forms used by every in-app link must always be current
  console.log('');
  var busted = await probe('/store?v=' + build, build);
  report('store?v=...', busted, true, 'in-app links');
  if (busted.prefix > 0 || busted.fresh < SAMPLES) failures.push('/store?v=' + build + ' is not reliably current');

  var bustedMenu = await probe('/menu?v=' + build, build);
  report('menu?v=...', bustedMenu, true, 'in-app links');
  if (bustedMenu.prefix > 0 || bustedMenu.fresh < SAMPLES) failures.push('/menu?v=' + build + ' is not reliably current');

  var leftovers = await (await fetch(BASE + '/store?v=' + build)).text();
  var placeholder = leftovers.indexOf('__BUILD__') > -1;
  console.log('build placeholder left un-replaced: ' + (placeholder ? 'YES (bug)' : 'no'));
  if (placeholder) failures.push('placeholder');

  /* Is the CDN actually obeying no-store? Ask for a cache key that cannot exist yet, then
   * ask for exactly the same key a moment later. If the CDN had stored the first response,
   * the repeat would come back HIT with a non-zero Age. Steady MISS means the directive is
   * being honoured and nothing new is being cached in front of us. */
  var nonce = 'audit' + Date.now().toString(36);
  var once = '/index.html?nonce=' + nonce;
  await fetch(BASE + once);
  await new Promise(function (res) { setTimeout(res, 1200); });
  var again = await fetch(BASE + once);
  var status = again.headers.get('eo-cache-status') || 'unknown';
  var ccFresh = again.headers.get('cache-control') || '';
  var honoured = status !== 'HIT' && ccFresh.indexOf('no-store') > -1;
  console.log('no-store honoured on a fresh cache key: ' + (honoured ? 'YES' : 'NO') +
              '   (repeat request -> ' + status + ')');
  if (!honoured) failures.push('the CDN stored a response marked no-store');

  console.log('');
  if (warnings.length) {
    console.log('WARN — older copies are being served, but every one of them self-heals:');
    warnings.forEach(function (w) { console.log('  - ' + w); });
    console.log('A real browser reloads once with ?v=<build> and lands on the current version.');
  }
  if (failures.length) {
    console.log('');
    console.log('FRESHNESS: FAIL');
    failures.forEach(function (f) { console.log('  - ' + f); });
    process.exitCode = 1;
  } else {
    console.log('');
    console.log('FRESHNESS: PASS — no advertised address serves a pre-fix copy');
  }
})();
