# HomeBoard — Build Handover

Last updated: 2026-11-14 · **HomeBoard v2.1.0** · built from the ContractorPOS v1.7.1 job board, with
`Petertoon/store-orders-display` (commit ba882e3) moved in. Attach this file and the live repo files (or the zip) to a new chat.

## What it is

One program, three kinds of screens, one admin back end (`/admin`, tabs per screen, on/off switch per account):
- 🏠 **Mama's To-Do** (`screen='todo'`): home to-do board.
- 🔧 **Papa's Shop** (`screen='shop'`): job board (job numbers from 1001 per account, customer/phone/address).
- 🛒 **Store Orders** (`screen='store'`): the store-orders-display system. Each store is an account with `store_settings`
  (code, SKU prefix, color, printer, Pi name, emails) instead of `stores.json`. The admin Store Orders tab replaces `/master`.

Each account uses one screen. `/` serves `store.html` for store accounts and `board.html` for the others.

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

Board features on the store screen behind switches (pick list = items as checklist, notes with 🎤, custom columns) ·
site name on tickets when a second Wix site is connected · photos on to-dos/jobs · repeating to-dos · reminders.
