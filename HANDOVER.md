[HANDOVER (33).md](https://github.com/user-attachments/files/35059487/HANDOVER.33.md)
# HomeBoard — Build Handover

Last updated: 2026-11-18 · **HomeBoard v2.5.0** · repo `Petertoon/store-orders-display` · live at
`https://store-orders-display.onrender.com` (Render Starter, Postgres via `DATABASE_URL`).
Built from the ContractorPOS v1.7.1 job board; the old store-orders-display system was moved in.
**Attach this file plus the repo files (or a zip of the repo) to a new chat.**

The next project is a **Farm & Ranch version of Papa's Shop**, so Papa's Shop is covered in the most detail
(sections 4 to 7). Section 8 is a step-by-step plan for that build.

---

## 1. What it is

One Node program with **three kinds of screens** and one admin back end:

| Screen | `households.screen` | Sign-in link | What it does |
|---|---|---|---|
| 🏠 Mama's To-Do | `todo` | `/login/mama` | Home to-do board, 📅 Calendar column, 🛒 Shopping lists |
| 🔧 Papa's Shop | `shop` | `/login/shop` | Job board + parts, charges, up-charges, invoices, payments, customers, phone scanner, QuickBooks |
| 🛒 Store Orders | `store` | `/login/store` | Wix orders split by SKU prefix, shown per store, printed by a Raspberry Pi |

- An **account** = one row in `households` (name, `screen`, `active`, `qbo_on`). Each account uses exactly one screen.
- **Admin** (`/admin`, a login with `is_admin`): tabs per screen type, one card per account with an **on/off switch**,
  Papa's Shop cards also have a **📊 QuickBooks switch**, **🔗 Sign-in link** button per tab, **Logo** (Lokaalapp circle).
- `/` serves `store.html` for store accounts and `board.html` for todo and shop accounts.
- **People** on an account are `members` (Family / Crew); each screen picks "Who's using this?" once.

## 2. Tech

Node 18+, Express 4, PostgreSQL (`pg`), plain HTML + JS (no build step), bcryptjs passwords, cookie sessions (60 days,
renewed with use), live updates by Server-Sent Events. Packages: `express cookie-parser pg bcryptjs nodemailer qrcode
barcode-detector@2.3.1 zxing-wasm@1.3.4`. Render: `npm install`, `npm start` (= `node server.js`), health check `/health`.

**How the code is split:** `server.js` makes the shared helpers and passes them to each module:
`require('./x')(app, { pool, wrap, fail, text, requireLogin, notify, hooks, … })`. Each module adds its own routes.
`db.js` creates/updates every table on start (`CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`), so
**uploading a new db.js and deploying is the whole database update**. Nothing is ever run by hand.

Live updates: `board.notify(household_id, payload)` sends `{type: …}` to every open screen of that account over
`/api/events`. Types used: `todo`, `columns`, `members`, `calendar`, `shopping`, `parts`, `customers`, `money`, `qbo`,
`account`, `ticket`, `printed`. The board's `listen()` (end of `board.html`) decides what to reload.

## 3. Files (line counts as of v2.4.0)

Top folder:

| File | Lines | What |
|---|---|---|
| server.js | 381 | setup, sign-in, sessions, admin API, sign-in pages `/login/:kind`, brand/logo, wiring of all modules |
| db.js | 335 | every table and column |
| board.js | 477 | board API: columns, to-dos/jobs, steps, history, members, calendar column + daily move, live events, hooks |
| shop.js | 600 | Papa's Shop money: settings, parts, lines, payments, invoices, customers, sending, phone scanner |
| qbo.js | 459 | QuickBooks Online: connect, invoices + payments sync, switch per account |
| shopping.js | 103 | shopping lists (Mama's To-Do) |
| stores.js | 298 | Store Orders (webhook, store screens, print agent API, admin store tab) |
| orders.js | 76 | splits a Wix order by SKU prefix |
| email.js | 99 | SMTP email (store emails, invoice email) |
| package.json, render.yaml, README.md, HANDOVER.md, .gitignore | | |
| print-agent/ (4 files), wix/events.js | | Raspberry Pi printer agent; Wix Velo code (unchanged) |

`public/` folder:

| File | Lines | What |
|---|---|---|
| board.html | 1108 | the board for todo **and** shop screens (columns, ticket, Family/Crew, Board setup, calendar) |
| shop-ui.js | 480 | everything shop-only on the board (`Shop` object) |
| scan.html | 341 | phone barcode scanner page (`/scan#token`) |
| shopping-ui.js | 113 | shopping lists dialog (`Shopping` object) |
| keys.js | 180 | 🎤 voice typing + on-screen keyboard (`Voice`, `Keys`) |
| admin.html | 390 | admin back end |
| store.html | 365 | Store Orders screen |
| login.html | 70 | sign-in page; colors/title per `/login/mama|shop|store` |
| app.js | 40 | `$`, `api()`, `toast`, `esc`, `logout`, `loginPage` |
| brand.js | 28 | fills `<span data-brand>` with the logo circle |
| setup.html, style.css | 34, 43 | first-run admin setup; shared styles |

Upload rule that bit us: **Chrome renames repeat downloads** (`server (24).js`). Delete old copies from Downloads first,
check the line count on GitHub after uploading, and check top folder vs `public/`. A wrong name or folder shows up in
Render's log as `Cannot find module` or a page as `Cannot GET /x`.

## 4. Papa's Shop: how it was built

Papa's Shop is **the same board as Mama's To-Do** with a shop layer on top. There is no separate shop app:

1. **Account type.** `households.screen = 'shop'`. Allowed values are checked in db.js
   (`households_screen_check`), listed in `SCREENS` (server.js), admin `ORDER` (admin.html), sign-in aliases
   (`LOGIN_KINDS` server.js, `ALIAS` login.html, `LOGIN_SLUG` admin.html).
2. **Board columns.** board.js `SHOP_COLUMNS`: New → Scheduled → In Progress → Ready for Pickup → Done, each with its
   card buttons (Rush, Need info, Start, Waiting on parts, Finished, Called customer, Picked up). Made the first time
   the board loads. **The last column always means "done".** Columns and buttons can be changed in Board setup.
3. **Words.** board.html `WORDS.shop` turns "to-do" into "job", Family into Crew, 🏠 into 🔧.
4. **Job fields.** Jobs are rows in `todos` with extra columns: `job_number` (from 1001 per account),
   `customer_name/phone/email`, `job_address`, `customer_id`, `invoice_code`, `invoice_sent_at`, `qbo_*`.
   board.js gives the job number when `screen === 'shop'`.
5. **Shop switch on the page.** board.html sets `isShop = me.account.screen === 'shop'` and then calls into
   `Shop` (shop-ui.js): `Shop.init()`, `Shop.render()` when a ticket opens, `Shop.loadMoney()`, `Shop.cardMeta(t)`
   for the $ on cards, `Shop.target(id)` to tell the phone scanner which job is open.
6. **Server side.** shop.js: every route starts with `shopOnly(req)`. It returns
   `{ money, settings, computeTotals, lineTotal, ensureCustomer, loadJob, invoiceLink }` for qbo.js to use.

### The job ticket (three columns, like ContractorPOS)

`board.html` `.tgrid.shop3`: **left** `#tLeft` (Add to this job: scan/search box + qty, + Charge / labor / up-charge,
📷 Phone scanner, parts list to tap), **middle** `#tMain` (title, customer box, `#moneyBox` = job ticket lines grouped
*Original* and *Up-charges · phase*, notes, checklist), **right** `#moneySide` (totals, payments, Take payment,
Send invoice, View/print invoice, QuickBooks line) above the usual details and history. On phones the columns stack.

### Money rules

- Money is whole **cents** everywhere (`INT`). Quantities are `NUMERIC(10,2)` (1.5 hours of labor works).
- `job_lines.kind` = `part` (from the parts list) or `charge` (typed: labor, fees). Each line remembers the column it
  was added in (`phase`); **up-charge** = added after the job left the first column (can be changed per line).
- Tax = round(taxable subtotal × shop tax rate %). One tax rate per shop (`shop_settings`).
- Payments are **recorded only** (cash, check, card, other); no card processing. Balance = total − payments.
- Prices only: there are no stock counts.
- Barcode matching tries UPC-A/EAN-13 variants (`barcodeVariants`): a leading 0 is added or removed.

### Phone scanner

The shop screen makes a pair token (`/api/shop/pair`, kept in localStorage `hbPair:<account>`) and shows a QR code
for `/scan#token`. The phone needs no sign-in. Whenever a ticket opens, the screen calls `/api/shop/pair/target`, so
**scans go into the job open on that screen**. Phone endpoints: `/api/pair/:token`, `/scan`, `/custom`, `/remove`.
The camera code in scan.html is the same as ContractorPOS: the phone's built-in `BarcodeDetector`, or else
`/vendor/barcode-detector.js` + `/vendor/zxing_reader.wasm` (served from node_modules by shop.js). It reads only
inside the white box, about 6 times a second. On iPhone there's no 💡 light (Safari doesn't allow it).
A barcode not in the parts list → the phone offers to add it with a name and price.

### Customers and sending invoices

`customers` table; `ensureCustomer` links a job to a customer by phone, then email, then name (or adds one).
Invoice: `/invoice/:id` (signed in, printable) and public `/i/<invoice_code>`. Send dialog: **WhatsApp**
(`https://wa.me/1XXXXXXXXXX?text=…`), **text** (`sms:…?&body=…`), **email** (SMTP via `email.sendMail`, or the
phone's mail app), **print**. Sending marks `invoice_sent_at` and writes history.

### QuickBooks (qbo.js)

OAuth code taken from ContractorPOS; tokens encrypted (AES-256-GCM, key from `QBO_TOKEN_KEY` or the client secret).
Customers → QuickBooks Customers; jobs → **Invoices** with two items, "Shop Parts" and "Shop Labor & Charges", tax as
TAX/NON + TxnTaxDetail.TotalTax; payments → **Payments** linked to the invoice (Undeposited Funds or a chosen bank
account). A job goes over once it has lines AND (invoice sent or printed, OR a payment, OR in the last column).
Changes update the same invoice (content hash `qbo_hash`). Deleting a payment deletes it in QuickBooks; deleting a job
voids its invoice (`qbo_removals`). Sync runs a few seconds after a change, every 5 minutes, and on "Sync now".
If QuickBooks is offline or needs reconnecting, nothing is lost: it shows ⏳ how many are waiting and catches up.
**Admin switch** `households.qbo_on` (starts off): off = no button, nothing sent, connection kept.
Board hooks used: `hooks.beforeDelete`, `hooks.changed`, `hooks.paymentRemoved`.
Render env: `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_ENVIRONMENT` (`sandbox` or `production`).
Intuit redirect URI: `https://store-orders-display.onrender.com/api/qbo/callback`.
**Not yet done:** a run against a real QuickBooks company (it was tested against a stand-in Intuit server).

## 5. Papa's Shop API

All need sign-in and a shop account unless noted.

- Settings: `GET/PUT /api/shop/settings` (tax_rate, invoice_header, invoice_footer)
- Parts: `GET/POST /api/shop/parts`, `PUT/DELETE /api/shop/parts/:id` (name, part_number, barcode, price, taxable)
- Job money: `GET /api/shop/jobs/:id/money`, `POST …/lines`, `PATCH/DELETE …/lines/:lid`,
  `POST …/payments`, `DELETE …/payments/:pid`, `GET /api/shop/summary` (totals for the cards)
- Invoices: `GET /invoice/:id`, `POST /api/shop/jobs/:id/email-invoice`, `POST …/share`, `POST …/sent`,
  public `GET /i/:code`
- Customers: `GET/POST /api/shop/customers`, `GET/PUT/DELETE /api/shop/customers/:id`
- Scanner: `POST /api/shop/pair`, `POST /api/shop/pair/target`; phone (no sign-in): `GET /api/pair/:token`,
  `POST /api/pair/:token/scan|custom|remove`
- QuickBooks: `GET /api/qbo/status`, `GET /api/qbo/job/:id`, `GET /api/qbo/connect`, `GET /api/qbo/callback`,
  `POST /api/qbo/disconnect|sync|retry`, `GET /api/qbo/accounts`, `PUT /api/qbo/settings`
- Shared board API: `/api/board`, `/api/events`, `/api/columns[/:id][/move]`,
  `/api/todos[/:id][/move|/button|/steps[/:sid]]`, `/api/members[/:id]`, `/api/household`

## 6. Papa's Shop tables

`shop_settings` (household_id, tax_rate %, invoice_header, invoice_footer) · `parts` (name, part_number, barcode,
price_cents, taxable, active) · `job_lines` (todo_id, kind, part_id, barcode, name, qty, unit_cents, taxable, phase,
upcharge, added_by) · `job_payments` (todo_id, amount_cents, method, note, added_by) · `scan_pairs` (token,
household_id, target_todo_id) · `customers` (name, phone, email, address, notes, active, qbo_*) ·
`qbo_connections`, `qbo_removals` · on `todos`: job_number, customer_*, job_address, customer_id, invoice_code,
invoice_sent_at, qbo_invoice_id, qbo_hash.
Shared: `households`, `logins`, `sessions`, `members`, `board_columns` (+ kind, cal_target), `todos` (+ due_time),
`todo_steps`, `todo_history`, `app_settings`.

## 7. Everything else (short)

- **Mama's To-Do:** 📅 Calendar column (`board_columns.kind='calendar'`, at the left, sends items to Today on their
  day, checked every minute in `TIME_ZONE`, default America/Chicago), 🛒 Shopping lists (`shop_pages`, `shop_items`,
  up to 5 pages), family colors are 12 circles to tap, ⌨ on-screen keyboard and 🎤 voice everywhere, ✕ on every dialog.
- **Store Orders:** `POST /webhook/wix-order?token=…`, split by SKU prefix, store screens, Pi print agent
  (`/api/agent/poll`, HMAC keys from `MASTER_KEY`), emails over SMTP. Not yet tried for real: a live Wix order to the
  new address, the real Pi + printer, SMTP.
- **Render env:** `DATABASE_URL` (required), `QBO_*` (QuickBooks), `SMTP_*` + `EMAIL_FROM` (email), `MASTER_KEY`,
  `WEBHOOK_TOKEN` (store orders), `PUBLIC_URL`, `TIME_ZONE`, `APP_NAME` (all optional).
- **Tests** (kept outside the repo): real Postgres + real Chrome (Playwright). API suites for board, admin, store,
  shop, QuickBooks (fake Intuit server), shopping, calendar; browser suites for each screen, phone layouts, two screens
  updating each other, the scanner, sign-in pages. One known test quirk (typing a capital letter in a step).

## 7b. Looks: Ranch and Dark (v2.5)

Same two looks as Peter's other programs (THEME-HANDOVER.md from ContractorPOS v1.16). **Ranch** (parchment, tan,
forest green, burgundy) is the default; **Dark** is charcoal, lime and gold.
- Stored per account: `households.theme` (`NULL` = ranch). Set in **Board setup → Look of the program** (to-do and shop
  boards), or by the admin in an account's **Edit** dialog (any account, including stores). `PUT /api/household/theme`;
  admin `theme` on `PUT /api/admin/accounts/:id`. Every screen of that account reloads in the new look (`account` message).
- The admin page has its own look: the 🎨 select in its header, `app_settings admin_theme`, `GET/PUT /api/admin/theme`.
- How it works: `<html data-theme="ranch|dark">`. A one-line script in each page's `<head>` sets the remembered look
  (localStorage `hb_theme`) before drawing; `applyTheme()` in app.js applies the account's setting after `/api/me`.
  All colors are variables in `public/style.css` (`--bg --panel --panel2 --card --line --ink --muted --top --btn
  --input --accent --sel --head --owed --paid --warn …`); the pages use only those. store.html has its own variable set.
  The phone scanner gets the shop's look from `/api/pair/:token` (`theme`).
- Colors people pick stay their own: column header/card colors, family colors, store colors, button colors.
  Board column presets: "Standard (follows the look)" leaves the column on the theme colors.
- Invoices (`/invoice/:id`, `/i/:code`) are separate plain pages and always print black on white.

## 8. Plan: Farm & Ranch version of Papa's Shop

### Recommended way: a fourth screen type in this same program

Add `screen = 'farm'` (🚜 Farm & Ranch) next to todo/shop/store. You keep one login system, one admin, one Render
service and one database, and you get the board, calendar, voice, keyboard, scanner, invoices and QuickBooks for free.
(The other way, copying the repo into a new Render service, means fixing every bug twice.)

**Step 1: make the new screen type exist** (small; touches the lists from section 4.1):
- db.js: add `'farm'` to `households_screen_check`.
- server.js: `SCREENS.farm = { label: 'Farm & Ranch', icon: '🚜' }`; `LOGIN_KINDS.farm/ranch = 'farm'`.
- admin.html: add `'farm'` to `ORDER`, people word (e.g. "Hands"), `LOGIN_SLUG.farm = 'farm'`.
- login.html: `KINDS.farm` (icon, title, color, e.g. green/brown), `ALIAS.farm/ranch`.
- board.js: `FARM_COLUMNS` and pick them when `screen === 'farm'`; job numbers for farm too.
- board.html: `WORDS.farm` (what a card is called: "work order", "job", "task"…).

**Step 2: reuse the shop layer.** Today shop.js, qbo.js and shop-ui.js check `screen === 'shop'` (see the list in
section 4). Change those checks to a helper like `hasShop(screen)` = shop or farm, and `isShop` in board.html to the
same. Then a farm account has parts, charges, invoices, payments, customers, the scanner and QuickBooks right away.
The `h.screen='shop'` checks in shop.js (invoice link `/i/`, scanner pairing) and qbo.js need the same change.

**Step 3: add what a farm & ranch needs.** Decide these first in the new chat. They decide the tables:

1. Who is it for? (a) a **farm/ranch equipment repair shop** (tractors, balers, trailers: customers, invoices; almost
   Papa's Shop as is), or (b) **running a farm or ranch** (your own work, livestock, fields, equipment upkeep; few
   or no customer invoices), or both.
2. Columns: e.g. Requested → Scheduled → In the field / In the shop → Waiting on parts → Done.
3. What cards are about: equipment (unit, make/model, VIN/serial, **hours meter**), animals (tag number, pen/pasture),
   fields (name, acres), locations (pasture, barn, gate).
4. Equipment list with **service by hours** (oil change every 250 hrs) that makes a card by itself when due. The
   calendar column's daily check in board.js (`rollCalendar`) is the pattern to copy for "make a card when due".
5. Charges: mileage/trip charge, field-call fee, hourly labor, rental of equipment, per-head or per-acre pricing.
6. Parts: same parts list + scanner; maybe a "farm store" list (feed, mineral, fencing, vet supplies).
7. Invoices/QuickBooks: same as the shop, or none for own-farm use (the admin switch already allows off).
8. Photos on jobs (before/after, damage) and GPS/map link for field calls (address field already opens maps).

**Suggested order:** 1) new screen type + reuse shop layer (deploy, test with one account); 2) farm columns and
words; 3) equipment list (+ hours) on the ticket; 4) service-by-hours reminders; 5) farm charges; 6) photos.

## 9. Ideas for later (all screens)

Stock counts · quotes/estimates the customer approves · discount line · repeating to-dos and calendar items
(birthdays, trash day every week) · reminders by text · photos on to-dos/jobs · a real QuickBooks sandbox run ·
the first real Wix order, Pi printer and SMTP email for Store Orders.
