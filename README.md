[README (13).md](https://github.com/user-attachments/files/34859416/README.13.md)
# HomeBoard

One program with three kinds of screens and an admin back end:

| Screen | What it is |
|---|---|
| 🏠 **Mama's To-Do** | A to-do board for the house: to-dos typed (or spoken) right on the ticket, checklist, who it's for, due date, priority |
| 🔧 **Papa's Shop** | A shop job board: job numbers (#1001…), customer, phone (tap to call), address (tap for maps), task checklist, crew |
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

## Stack

Node 18+ / Express 4 / PostgreSQL on Render, plain HTML + JavaScript. Tables create and update themselves on startup.
Sign-ins last 60 days and renew with use, so screens that stay on are never signed out.

| File | What it holds |
|---|---|
| `server.js` | Setup, sign-in, accounts, admin back end, people, pages |
| `board.js` | To-do / job boards: columns, card buttons, moving, checklist, history, live updates |
| `stores.js` | Store Orders: Wix webhook, store screen API, print agent API, admin Store Orders tab |
| `orders.js` | Splits a Wix order into one ticket per store by SKU prefix (unchanged from store-orders-display) |
| `email.js` | Per-store order emails over SMTP (unchanged) |
| `db.js` | Database connection and schema |
| `public/admin.html` | Admin back end with the tabs |
| `public/board.html` | To-do / job board screen |
| `public/store.html` | Store screen |
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
