[README (14).md](https://github.com/user-attachments/files/34863576/README.14.md)
# HomeBoard

One program with three kinds of screens and an admin back end:

| Screen | What it is |
|---|---|
| 🏠 **Mama's To-Do** | A to-do board for the house: to-dos typed (or spoken) right on the ticket, checklist, who it's for, due date, priority |
| 🔧 **Papa's Shop** | A shop job board: job numbers (#1001…), customer, phone, email, address, task checklist, crew, plus **parts & charges, up-charges per phase, sales tax, payments, invoices** and a **phone barcode scanner** |
| 🛒 **Store Orders** | Wix Stores orders split per store by SKU prefix: store screen (New → Picking → Ready → Picked up, bell, timers, reprint), receipt printer via a Raspberry Pi, email. Moved in from `store-orders-display` |

## Admin back end (`/admin`)

- **Tabs:** Mama's To-Do | Papa's Shop | Store Orders, each listing every account that uses that screen.
- **+ New account:** name, screen, sign-in email, password ("Make one"), people. Store Orders accounts also get their
  **SKU prefix**, color, printer on/off, Raspberry Pi name and order emails (this replaces `stores.json`).
- **On/off switch** per account. Switched off: its screen shows "switched off" and comes back by itself when switched on;
  it can't be signed in to. A switched-off store still receives and prints its orders, so nothing is lost.
- **Open screen:** see exactly what the account sees (yellow admin bar; "← Back to admin"). **Edit:** rename, move to
  another tab, store settings, email, new password, delete.
- **Store Orders tab** (was the master screen): all orders with store filters, the "unassigned" alert for SKUs that match
  no store, Raspberry Pi status with **Copy agent key**, recent print jobs with **Retry**, **Send test order**, and
  **Copy Wix webhook address**.

## Papa's Shop money

- **🔩 Parts** (top bar): the parts list (name, part number, barcode, price, taxable) and invoice settings (sales tax %,
  shop address/phone under the name, note at the bottom).
- **Parts & charges** on the job ticket: search the parts list, type or scan a barcode / part number (a USB scanner works
  here too: it types and presses Enter), or **+ Charge** for labor and fees (quantities like 1.5 hours work).
  An unknown barcode opens "New part" so it's saved to the list and added to the job.
- **Up-charges:** every line is stamped with the phase (column) it was added in. Lines added in the first column are the
  original price; anything added later is an up-charge (tap the Original / Up-charge tag on a line to change it).
- **Totals:** original, up-charges, subtotal, tax, total, payments, balance due. **💵 Payment** records cash/check/card/other.
- **🧾 Invoice:** printable page (Print / Save as PDF); **✉ Email invoice** sends it to the customer (needs the SMTP settings).
- **📷 Scanner:** shows a QR code. Scan it with a phone and the phone becomes a barcode scanner for that screen: open a job
  on the screen, scan parts with the phone, and they land on that job. "New QR code" unpairs phones.
- Board cards show each job's total and what's still due.

## Customers, sending invoices, QuickBooks, logo (v2.3)

- **👥 Customers** (Papa's Shop): name, phone, email, address, notes; each customer's jobs, totals and what they owe.
  On a job, type in Customer to pick from the list (fills phone, email, address), or "＋ Save as a customer".
  Sending an invoice adds the customer to the list by itself if they aren't in it (matched by phone, email or name).
- **📤 Send invoice:** a message with a private link to the invoice (the customer opens it without signing in, and can print
  or save it as a PDF). **WhatsApp** opens WhatsApp with the message; **Text** opens the phone's Messages; **Email** sends it
  from the server (SMTP settings) or, without them, opens the email app; **Print** opens the invoice to print.
- **📊 QuickBooks** (Papa's Shop): connect the shop's QuickBooks company. Customers → QuickBooks Customers, jobs → Invoices
  (lines, up-charges labeled with their phase, taxable / not), payments → Payments on the invoice (into Undeposited Funds
  or a bank account) so they match bank deposits in QuickBooks Banking. A job goes once its invoice is sent or printed, it has
  a payment, or it's finished; later changes update the invoice; deleting a job voids its invoice (and deletes its payments);
  deleting a payment deletes it. **Nothing waits on QuickBooks:** while it's disconnected, expired or down, everything is
  listed as "waiting" and goes on the next sync (a few seconds after changes, every 5 minutes, or Sync now).
  Render → Environment: `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET`, `QBO_ENVIRONMENT` (`sandbox` / `production`) from the Intuit app
  (same as ContractorPOS); add `https://<this site>/api/qbo/callback` as a redirect URI in the Intuit app.
- **Logo circle:** admin page → **Logo**: a picture and a link (your Lokaalapp). It shows top-left on every screen (to-do,
  shop, store, admin, sign-in, phone scanner, customer invoices); tapping it opens the link.

## Stack

Node 18+ / Express 4 / PostgreSQL on Render, plain HTML + JavaScript. Tables create and update themselves on startup.
Sign-ins last 60 days and renew with use, so screens that stay on are never signed out.

| File | What it holds |
|---|---|
| `server.js` | Setup, sign-in, accounts, admin back end, people, pages |
| `board.js` | To-do / job boards: columns, card buttons, moving, checklist, history, live updates |
| `shop.js` | Papa's Shop money: parts, job lines, up-charges, tax, payments, invoice page and email, phone scanner pairing |
| `qbo.js` | QuickBooks Online for Papa's Shop: connect, customers, invoices, payments, waiting list, sync |
| `stores.js` | Store Orders: Wix webhook, store screen API, print agent API, admin Store Orders tab |
| `orders.js` | Splits a Wix order into one ticket per store by SKU prefix (unchanged from store-orders-display) |
| `email.js` | Per-store order emails over SMTP (unchanged) |
| `db.js` | Database connection and schema |
| `public/admin.html` | Admin back end with the tabs |
| `public/board.html` | To-do / job board screen |
| `public/store.html` | Store screen |
| `public/shop-ui.js` | Papa's Shop parts & charges on the job ticket, Parts dialog, scanner QR |
| `public/scan.html` | The phone barcode scanner page (camera reader from ContractorPOS) |
| `public/brand.js` | The logo circle on every screen |
| `public/keys.js` | 🎤 voice typing and ⌨ on-screen keyboard |
| `public/app.js`, `public/style.css`, `public/login.html`, `public/setup.html` | Shared helpers, look, sign-in, first-run setup |
| `print-agent/` | Raspberry Pi print agent (unchanged; only its config points at the new address) |
| `wix/events.js` | Code for the Wix site's Backend (unchanged) |

## Deploy on Render

1. GitHub repo (e.g. `Petertoon/homeboard`): upload every file, keeping the folders (`public/`, `print-agent/`, `wix/`).
2. Render → **New → PostgreSQL** (`homeboard`). Copy its **Internal Database URL**.
3. Render → **New → Web Service** from the repo, **Starter plan** (the free plan sleeps and would miss Wix orders).
   Build `npm install`, start `npm start`. Environment: `DATABASE_URL`.
   Optional: `APP_NAME` (name at the top), `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`, `TIME_ZONE`
   (store emails, same as before). `WEBHOOK_TOKEN` and `MASTER_KEY` are optional: without them the program makes its own.
4. Open the site right away: the first visit makes **your admin sign-in**. Then make the accounts.

## Switching Store Orders over from store-orders-display

The old service keeps taking orders until you do this, so take your time:

1. On the new admin page, make a Store Orders account for each store with the **same SKU prefix** (A-, B-…).
2. Press **Send test order** and check each store screen (sign in as the store on its screen; Fully Kiosk Browser keeps the sign-in).
3. In Wix: Developer Tools → Secrets Manager → `STORE_ORDERS_WEBHOOK_URL` → paste the value from **Copy Wix webhook address**.
   `events.js` doesn't change. Place a real test order on the published site.
4. For each Raspberry Pi: in `config.json` change `server` to the new address, `agentKey` to **Copy agent key**,
   `agentId` to the store's Pi name and `storeId` to the store's code (shown with the Pi on the Store Orders tab); restart it (`pm2 restart all`).
5. When everything works, suspend the old `store-orders-display` service on Render.
