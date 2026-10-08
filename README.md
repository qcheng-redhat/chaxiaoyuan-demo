# Tea Courtyard (茶小院)

A small, self-contained ordering site for a milk tea shop: a bilingual
(Chinese / English) customer-facing menu, and a password-protected dashboard
where the store watches incoming orders and moves them through
`new → making → done`.

The whole thing runs as **one Node.js process with zero runtime dependencies**
— no framework, no database server, no build step. Node's standard library
serves both the static pages and the JSON API on a single port, and orders are
persisted to a plain JSON file.

- **Live site:** https://tea-courtyard.app.workbuddy.host/
- Customer menu: `/` and `/menu` (English, the default) · `/menu-zh` (Chinese)
- Store dashboard: `/store` (English, the default) · `/store-zh` (Chinese)

---

## Features

**Customer side**

- Bilingual menu (Chinese and English pages, cross-linked).
- Per-drink spec sheet: ice level, sugar level, and one or more add-ons.
- Cart drawer with quantity, live per-line and total price in ¥.
- Pickup or delivery (delivery requires a phone number), free-text notes
  ("less ice, pack separately…").
- Idempotent submit with a double-click guard; the customer gets an order number
  such as `CY2609181742-4821` plus a copyable summary of the order.
- Works offline-ish: if the API is unreachable the order is still saved in the
  customer's browser so it can be copied and sent to the shop by hand.

**Store side**

- Password login; the session lives in `sessionStorage` plus a session-scoped
  cookie, so closing the browser ends it.
- Today's order count, today's revenue, and today's best sellers.
- Status tabs (new / making / done / canceled) and one-click status changes,
  which are pushed back to the server.
- CSV export, print-friendly order slips, "seed demo orders", and "clear all".
- Polls the server for new orders while the tab is open.

**Backend**

- Prices are recomputed **server-side** from a menu table; a tampered client
  payload cannot change the price it is billed at.
- HMAC-SHA256 signed bearer tokens (stateless, no session store).
- Per-IP rate limiting on order creation and login attempts.
- `no-store` on every response, plus a content-hash build id that lets pages
  self-heal when a caching proxy serves a stale copy (see
  [Caching and the build id](#caching-and-the-build-id)).

---

## Requirements

- **Node.js 18 or newer** (CI runs Node 22; that is the recommended version).
- No database, no external services, no npm packages needed at runtime.
- Playwright's Chromium, only if you want to run the end-to-end tests.

---

## Install and run

```bash
git clone https://github.com/qcheng-redhat/chaxiaoyuan-demo.git
cd chaxiaoyuan-demo
npm install          # installs Playwright, the only devDependency
```

Start the server:

```bash
npm start            # = node server.js
```

Then open:

| Page | URL |
| --- | --- |
| Menu (English — default) | http://localhost:3000/ |
| Menu (Chinese) | http://localhost:3000/menu-zh |
| Dashboard (English — default) | http://localhost:3000/store |
| Dashboard (Chinese) | http://localhost:3000/store-zh |
| Health check | http://localhost:3000/health |

The original `.html` paths (`/index.html`, `/index-en.html`, `/orders.html`,
`/orders-en.html`) keep working, as do the older `/menu-en` and `/store-en`
aliases, so existing links and bookmarks do not break.

### Configuration

Everything is configured through environment variables — there is no config
file, and **no password is hard-coded anywhere in this repository**.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on (binds `0.0.0.0`). |
| `ADMIN_PASSWORD` | *(empty)* | Password for the store dashboard. **Optional by design** — see below. |
| `DATA_DIR` | `./data` | Directory holding `orders.json`. Point it somewhere else to keep test data separate. |

```bash
# Typical local run with a dashboard password
ADMIN_PASSWORD=my-secret npm start

# Windows PowerShell
$env:ADMIN_PASSWORD = "my-secret"; npm start
```

**If `ADMIN_PASSWORD` is not set, the site still starts normally.** Customers
can browse and order exactly as usual; only the dashboard login is disabled. In
that mode `POST /api/login` answers
`{"ok": false, "reason": "not_configured"}` so the UI can say "login is not
configured on the server" instead of the misleading "wrong password". The token
signing key then becomes a random per-process value, which means nobody can
forge a token by recomputing the derivation for an empty password, and any token
issued under a previous configuration stops working immediately.

---

## Usage

### Customer: placing an order

1. Open `/` — English, the default. The Chinese menu is at `/menu-zh`.
2. Tap **＋ 加入 / Add** on a drink — a spec sheet opens; choose ice, sugar and
   add-ons, then confirm.
3. Open the cart, pick **到店自取 / Pickup** or **需要外送 / Delivery**, optionally
   add a phone number and a note.
4. Submit. The order number and a text summary appear; if the API is reachable
   the order goes straight to the store dashboard.

Order numbers are generated on the client as
`CY` + `YYMMDDHHmm` + `-` + 4 random digits. Submitting the same order number
twice is safe: the server treats it as a duplicate and returns the existing
order rather than creating a second one.

### Store: running the dashboard

1. Open `/store` (English, the default) or `/store-zh` (Chinese), and sign in with
   `ADMIN_PASSWORD`.
2. The top row shows today's orders, today's revenue and today's best sellers.
3. Switch tabs between **new / making / done / canceled**; changing a status
   writes it back to the server.
4. **导出 CSV** exports the current list, **print** produces a kitchen-friendly
   slip, **生成示例订单** inserts demo orders for a quick tour, **清空** deletes
   everything (with a confirmation prompt).
5. Click **退出登录 / Sign out** when you are done — this clears both the
   in-browser token and the cookie.

The dashboard password can be changed at any time by restarting the process with
a different `ADMIN_PASSWORD`. Tokens are signed with a key derived from the
password, so all previously issued tokens stop validating after the change.

---

## API reference

All request and response bodies are JSON. Every response carries `no-store`
cache headers.

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| `GET` | `/health` | – | Liveness check, returns the order count. |
| `GET` | `/api/version` | – | Current build id (hash of the HTML pages). |
| `GET` | `/api/authprobe` | – | Reports how a token arrived and whether it validates. Add `?diag=1` for non-secret process fingerprints. |
| `POST` | `/api/orders` | – | Place an order. Prices are recomputed server-side; duplicate order numbers return the original. Rate limit: 30/min per IP. |
| `POST` | `/api/login` | – | `{"password": "..."}` → `{"token": "..."}`. Rate limit: 10 per 5 min per IP. |
| `GET` | `/api/orders` | ✔ | List all orders, newest first. |
| `PATCH` | `/api/orders/:no/status` | ✔ | `{"status": "new" \| "making" \| "done" \| "canceled"}`. |
| `POST` | `/api/orders/seed` | ✔ | Insert four demo orders. |
| `DELETE` | `/api/orders` | ✔ | Delete every order. |

**Authentication.** Send the token from `/api/login` in any of these channels —
the server tries them in order and uses the first one that verifies:

1. `X-Cy-Token: <token>` header (preferred; nothing in front of the app rewrites it)
2. `?token=<token>` query parameter
3. `cy_token` cookie
4. `Authorization: Bearer <token>` (kept as a fallback for plain local runs)

The `X-Cy-Token` header exists because some gateways replace the `Authorization`
header with a token of their own; trusting that header blindly made valid
sessions fail to authenticate.

### Menu and pricing

`server.js` holds the single source of truth for prices. The HTTP API ignores
whatever unit price the client sends and recomputes every line.

| ID | Item | Price |
| --- | --- | --- |
| `p1` | 黑糖珍珠鲜奶 / Brown sugar pearl milk | ¥16 |
| `p2` | 茉莉奶绿 / Jasmine milk green tea | ¥14 |
| `p3` | 芋泥波波奶茶 / Taro boba milk tea | ¥18 |
| `p4` | 杨枝甘露 / Mango pomelo sago | ¥19 |
| `m5` | 古法烤奶茶 / Charcoal-roasted milk tea | ¥15 |
| `m6` | 四季春柠檬茶 / Four Seasons lemon tea | ¥15 |
| `m7` | 纯茶 / Plain tea | ¥10 |

Each add-on costs ¥3 (up to 5 per line item), on top of the drink price. Order
statuses are `new`, `making`, `done` and `canceled`.

---

## Data and persistence

Orders live in a single JSON file: `data/orders.json` (override the directory
with `DATA_DIR`). Writes go to a temp file and are then renamed, so a crash
mid-write cannot leave a truncated file behind. If the file is missing or
unreadable the server starts with an empty list.

`data/` is git-ignored on purpose — it is runtime state, not source, and it must
not be shipped inside a release package or reset by a redeploy. Back it up
separately if the shop's order history matters.

---

## Testing

```bash
npm run check:syntax   # static syntax checks (no dependencies)
npm test               # API regression tests (26 tests, node:test)
npm run test:e2e       # Playwright end-to-end (desktop + mobile)
npm run test:live      # smoke test against the published site
npm run test:fresh     # check whether the CDN/gateway serves stale pages
```

| Script | What it does |
| --- | --- |
| `check:syntax` | `node --check` on every `.js` file, plus parses the inline `<script>` blocks of all four HTML pages. Catches syntax errors in seconds without a browser. |
| `test` | API tests. Spawns a real server on port 3777 with an isolated temp data dir and `ADMIN_PASSWORD=test-pass-123`, so `data/orders.json` is never touched. |
| `test:e2e` | Playwright specs in `tests/e2e/` (`order`, `auth`, `sync`, `mobile`). The config starts its own server on port 3780 with `DATA_DIR=.playwright-data`. |
| `test:live` | Drives a real browser against the published site: a customer places an order and the store dashboard must show it. The test order is marked canceled at the end. Requires `SMOKE_PASS`, because it logs into a real site: `SMOKE_PASS=... npm run test:live`. |
| `test:fresh` | Samples every page on the live site and classifies each response as `fresh`, `self-healable` (an older build id the page can recover from) or `pre-fix` (no build id at all — genuinely broken). Run it after each publish. |

The E2E config starts and stops its own server; nothing needs to be running
first. If you run the tests without npm, the equivalents are
`node --test tests/api.test.js`, `npx playwright test`,
`node tests/live-smoke.js` and `node tests/audit-freshness.js`.

---

## Continuous integration

`.github/workflows/ci.yml` runs on every push to `main`, on every pull request,
and on manual dispatch:

- **Phase 0 — static checks:** `npm ci` then `npm run check:syntax`.
- **Phase 1 — tests:** `npm test`, install Playwright Chromium, then
  `npm run test:e2e`. On failure, the `test-results/` and `playwright-report/`
  directories are uploaded as an artifact.

Phase 1 only starts if Phase 0 passes. **Deployment is not part of CI** — the
site is hosted on the WorkBuddy publishing platform, which GitHub cannot reach,
so publishing stays a deliberate, manual step.

---

## Caching and the build id

Published pages are served through a gateway that caches responses per exact
URL. An entry created before the `no-store` headers existed keeps being served
and is never revalidated, which once produced a dashboard that looked like it
had a broken password (it was simply an old copy of the page).

Two mechanisms defend against this:

- **Every response says `no-store`**, so nothing new gets cached.
- **Every page embeds a build id.** The HTML files contain a literal
  `__BUILD__`, which the server replaces with a hash of the pages themselves.
  A page compares its id against `GET /api/version` and, on a mismatch, reloads
  itself once with `?v=<build>` — a fresh cache key that forces the gateway to
  go back to the origin. Users see a flicker, not a failure.

Two consequences worth knowing:

- The build id is a **content hash**, so line-ending conversion would change it.
  `.gitattributes` pins `* -text` and the repository keeps `core.autocrlf=false`
  for exactly this reason. Please do not change either.
- `data/orders.json` is runtime state. A redeploy that ships a `data/` directory
  can overwrite the live order history, so keep it out of release packages.

Short aliases exist alongside the `.html` paths. A brand-new URL has no stale
gateway entry, so it goes straight to the origin — which is why every in-page
link points at an alias rather than at a `.html` file, and why the shop owner can
safely bookmark the dashboard.

**English is the default.** `/`, `/menu` and `/store` — the addresses we hand
out, and the one the QR code encodes — serve the English pages. The Chinese pages
have their own aliases, `/menu-zh` and `/store-zh`. The rule for in-page links is
one language, one address: English pages link to `/menu` and `/store`, Chinese
pages to `/menu-zh` and `/store-zh`.

| Address | Serves | Notes |
| --- | --- | --- |
| `/`, `/menu` | `index-en.html` | English menu — the default entry point |
| `/menu-zh` | `index.html` | Chinese menu |
| `/store` | `orders-en.html` | English dashboard — safe to bookmark |
| `/store-zh` | `orders.html` | Chinese dashboard |
| `/menu-en`, `/store-en` | English pages | kept working for links already in the wild |
| `/index.html`, `/index-en.html`, `/orders.html`, `/orders-en.html` | as named | legacy paths; the CDN once cached stale copies of these |

Keep all of these routes if you fork this project — the in-page links depend on
the aliases, and dropping one turns a language switch into a 404.

---

## Project layout

```
├── index.html / index-en.html        Customer menu (Chinese / English)
├── orders.html / orders-en.html      Store dashboard (Chinese / English)
├── server.js                         HTTP server: static files + JSON API
├── package.json                      Scripts; engines: node >= 18
├── playwright.config.js              E2E config (own server on port 3780)
├── qr-code-tea-courtyard.png         QR code encoding `/` (the English menu)
├── sample_orders_export.csv          Example of the dashboard CSV export
├── data/orders.json                  Runtime order store (git-ignored)
├── tests/
│   ├── syntax-check.js               Static syntax checks
│   ├── api.test.js                   API regression tests
│   ├── live-smoke.js                 Post-publish smoke test
│   ├── audit-freshness.js            Post-publish cache audit
│   └── e2e/                          Playwright specs + helpers
└── .github/workflows/ci.yml          CI: static checks → API + E2E tests
```

---

## License

No license file is included yet. Until one is added, all rights are reserved
and the code may not be reused without permission.
