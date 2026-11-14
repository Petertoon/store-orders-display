[HANDOVER (7).md](https://github.com/user-attachments/files/34863594/HANDOVER.7.md)
# HomeBoard — Build Handover

Last updated: 2026-11-14 · **HomeBoard v2.3.0** · built from the ContractorPOS v1.7.1 job board, with
`Petertoon/store-orders-display` (commit ba882e3) moved in. Attach this file and the live repo files (or the zip) to a new chat.

## What it is

One program, three kinds of screens, one admin back end (`/admin`, tabs per screen, on/off switch per account):
- 🏠 **Mama's To-Do** (`screen='todo'`): home to-do board.
- 🔧 **Papa's Shop** (`screen='shop'`): job board (job numbers from 1001 per account, customer/phone/address).
- 🛒 **Store Orders** (`screen='store'`): the store-orders-display system. Each store is an account with `store_settings`
  (code, SKU prefix, color, printer, Pi name, emails) instead of `stores.json`. The admin Store Orders tab replaces `/master`.

Each account uses one screen. `/` serves `store.html` for store accounts and `board.html` for the others.

## Papa's Shop money (v2.2)

`shop.js` + `public/shop-ui.js` + `public/scan.html`. Tables: `shop_settings` (tax_rate %, invoice_header, invoice_footer),
`parts`, `job_lines` (kind part/charge, qty NUMERIC, unit_cents, taxable, phase, upcharge), `job_payments`, `scan_pairs`
(token → account + target job), `todos.customer_email`. Up-charge = added while the job isn't in the first column (editable per line).
Tax = round(taxable subtotal × rate). Phone scanner: shop screen keeps a pair token (localStorage `hbPair:<account>`), tells the
server which job is open (`/api/shop/pair/target`); the phone (`/scan#token`, no sign-in) scans into that job. Camera reader:
`barcode-detector` + `zxing-wasm` served at `/vendor/…` (same as ContractorPOS). Invoice: `/invoice/:id` (signed in), email via
`email.sendMail`. Decided: payments recorded (no card processing), tax per shop, prices only (no stock counts).

## v2.3: customers, invoice sending, QuickBooks, logo

- `customers` table (+ `todos.customer_id`); `shop.ensureCustomer` links a job to a customer by phone/email/name or adds one.
- Invoice link: `todos.invoice_code` → public `/i/<code>`; `/api/shop/jobs/:id/share` (link + message), `/sent` (whatsapp, text,
  print, mailapp) sets `invoice_sent_at` and history. WhatsApp = `https://wa.me/1XXXXXXXXXX?text=…`; text = `sms:…?&body=…`.
- `qbo.js` (OAuth/token code from ContractorPOS). Tables `qbo_connections` (settings: income_account_id, deposit_account_id,
  items cache), `qbo_removals`; ids on `customers`, `todos` (qbo_invoice_id, qbo_hash = content hash), `job_payments`.
  Items "Shop Parts" and "Shop Labor & Charges" (Service) on the chosen income account. Tax: lines TAX/NON +
  TxnTaxDetail.TotalTax; if QuickBooks' total differs the ticket says so (it figured tax itself). Hooks from board.js:
  `beforeDelete`, `changed`, `paymentRemoved`. Disconnect keeps settings for the same company (`app_settings qbo_last:<id>`).
  Tested against a stand-in Intuit API (`tests/fakeqbo.js`; env `QBO_AUTH_URL`, `QBO_TOKEN_URL`, `QBO_API_BASE`); still to do:
  a real sandbox run.
- Logo: `app_settings` brand_logo (data URL, 256 px), brand_link, brand_title; `/api/brand`, `/brand-logo`, `PUT /api/admin/brand`;
  `public/brand.js` fills every `<span data-brand>`.

## Store Orders: what stayed the same

- `POST /webhook/wix-order?token=…` (same path and body; token from `WEBHOOK_TOKEN` env or made once and stored in `app_settings`).
- `orders.js` and `email.js` unchanged; `print-agent/` and `wix/events.js` unchanged (agent config points at the new server).
- Print agent API `POST /api/agent/poll`, `POST /api/agent/jobs/:id/done` with `x-agent-id` / `x-agent-key`; agent keys are
  HMAC of `agent:<id>` with `MASTER_KEY` env or a stored `agent_secret`.
- Tables `tickets` and `print_jobs` as before. `tickets.store_id` = the store's `code`, or `unassigned`.
- Store screen: same 3 columns, bell + tap-to-stop, timers (`?late=`), "tap again" for Picked up, reprint, "✓ printed".

## What changed for Store Orders

- Stores sign in with their account (no key links). Sessions renew with use, so kiosks stay signed in.
- Live updates to store screens go through the board's `/api/events` (`{type:'ticket'|'printed'|'account'}`); the admin tab uses `/api/admin/store/stream`.
- A switched-off store's screen is blocked, but its orders are still recorded, printed and emailed.
- Store accounts need no people; SKU prefixes are unique (case-insensitive) and required.

## Data model

`households` (account: name, screen, active) · `logins` (email, password_hash, household_id, is_admin) · `sessions`
(acting_household_id for the admin) · `members` · `board_columns` · `todos` (+ job_number, customer_name/phone, job_address) ·
`todo_steps` · `todo_history` · `app_settings` · `store_settings` · `tickets` · `print_jobs`.

## API

Sign-in & admin: `/api/setup-status`, `/api/setup`, `/api/login`, `/api/logout`, `/api/me`, `/api/me/member`, `/api/password`,
`/api/admin/accounts[/:id]` (body may include `store: {sku_prefix, color, printer, agent_id, emails}`), `/api/admin/open/:id`, `/api/admin/leave`.

Boards: `/api/board`, `/api/events`, `/api/columns[/:id][/move]`, `/api/todos[/:id][/move|/button|/steps[/:sid]]`, `/api/members[/:id]`, `/api/household`.

Store Orders: `/webhook/wix-order`, `/api/store/info`, `/api/store/tickets`, `/api/store/tickets/:id/status|reprint`,
`/api/agent/poll`, `/api/agent/jobs/:id/done`, `/api/admin/store/overview|tickets|stream|test-order`, `/api/admin/store/tickets/:id/status|reprint`.

## Tested (real Postgres + real Chrome)

All board and admin tests from v2.0, plus Store Orders: prefix required/unique, splitting A/B/unknown, duplicate webhook
ignored, bad token refused, stores see only their own items and can't change another store's, status flow with confirm,
reprint, printing off, the real `print-agent/agent.js` printing to a stand-in printer on port 9100, Pi key check, job resend
guard, admin overview/jobs/agents, unassigned alert, test order, cancel, switched-off store (screen blocked, orders kept),
moving an account to Store Orders asks for a prefix, admin viewing a store screen, phone layout.
Not yet tried for real: a real Wix order to the new address, a real Pi + printer, SMTP email.

## Switch-over steps (also in README)

Make store accounts with the same SKU prefixes → test order → change the Wix secret `STORE_ORDERS_WEBHOOK_URL` to
"Copy Wix webhook address" → update each Pi's config.json (server, agentId, agentKey, storeId) → suspend the old service.

## Ideas for later

Papa's Shop: stock counts, quotes/estimates the customer approves, a discount line, QuickBooks (ContractorPOS has qbo.js),
a public invoice link for customers.


Board features on the store screen behind switches (pick list = items as checklist, notes with 🎤, custom columns) ·
site name on tickets when a second Wix site is connected · photos on to-dos/jobs · repeating to-dos · reminders.
