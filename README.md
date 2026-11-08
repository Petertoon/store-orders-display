[README (10).md](https://github.com/user-attachments/files/34536883/README.10.md)
# Store Orders Display

Order screens and receipt printers for several stores sold on one Wix Stores site.
Customers order online and **pay at pickup**. Each order is split by store and sent
automatically to that store's screen and printer. A master screen shows everything for support.

```
Wix Stores order ──> Velo events.js ──> Render server ──> store screen (SSE)  per store
                                              │       └─> master screen (all stores)
                                              └─> print job ──> Raspberry Pi agent ──> printer :9100
```

**How an item finds its store:** every product SKU must start with that store's prefix
(Store A = `A-1001`, Store B = `B-1001`). Items whose SKU matches no store show up as an
**Unassigned** alert on the master screen and don't go to any store.

## Files

| Path | What it is |
|---|---|
| `server.js` | Express server: webhook, routing, live feed, print jobs, master API |
| `orders.js` | Reads a Wix order and splits it into one ticket per store |
| `db.js` | Postgres storage (in-memory if `DATABASE_URL` is missing — testing only) |
| `stores.json` | Your stores: id, name, SKU prefix, color, screen on/off, printer on/off, Pi |
| `public/store.html` | A store's screen (New → Picking → Ready → Picked up) |
| `private/master.html` | Master support screen, served only at `/master?key=MASTER_KEY` |
| `print-agent/` | Raspberry Pi agent (one Pi per store address) |
| `wix/events.js` | Code to paste into the Wix site backend |

`private/` must never move into `public/` — `public/` has no login.

## 1. Server on Render

1. Create a **new** GitHub repo and upload everything except `node_modules`.
2. Render → New → Web Service → that repo. Build `npm install`, start `npm start`.
   Use the **Starter (paid)** plan: the free plan sleeps and Wix orders would be lost.
3. Create a Render Postgres database and copy its **Internal Database URL**.
4. Environment variables:
   - `DATABASE_URL` — the Postgres URL
   - `MASTER_KEY` — a long random password (your master login)
   - `WEBHOOK_TOKEN` — another long random string (Wix uses it)
5. Open `https://YOUR-SERVICE.onrender.com/master?key=YOUR_MASTER_KEY`.
   Press **Send test order** — it should appear under All orders.

## 2. Stores

Edit `stores.json` (one block per store), commit, and Render redeploys.
Each store's screen link and its Pi's agent key are on the master screen (**Copy link** / **Copy agent key**).
They're derived from `MASTER_KEY`, so changing `MASTER_KEY` changes every link and key.

## Email (optional, per store)

Add addresses to a store's `"email"` list in `stores.json`, e.g.
`"email": ["owner@theirstore.com", "manager@theirstore.com"]`. Leave it `[]` for no email.
Every new order for that store is emailed with the same details as the printed ticket.

The server sends through any SMTP account. Add these in Render → Environment:

| Variable | Gmail example |
|---|---|
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `465` |
| `SMTP_USER` | the Gmail address |
| `SMTP_PASS` | a Gmail **App Password** (Google Account → Security → 2-Step Verification → App passwords), not the normal password |
| `EMAIL_FROM` | `Store Orders <that Gmail address>` |

Gmail allows about 500 emails a day. For more, or to send from your own domain,
use a sending service (Resend, SendGrid, Zoho) with its SMTP settings instead.
The master screen shows each store's email status; a failed email never blocks the
order, the screen or the printer.

## 3. Wix site

1. Wix Stores: give each store a **category** and a store page showing that category.
2. Set every product's **SKU** with the store's prefix (`A-…`, `B-…`).
3. Payments: turn on a **manual / offline payment** method ("Pay at pickup") and turn off online
   payment methods, so the money goes to each store at pickup.
4. Shipping & delivery: add **pickup** as the fulfillment option.
5. Dashboard → Developer Tools → **Secrets Manager** → add
   `STORE_ORDERS_WEBHOOK_URL` = `https://YOUR-SERVICE.onrender.com/webhook/wix-order?token=YOUR_WEBHOOK_TOKEN`
6. Turn on Dev Mode → Backend → `events.js` → paste `wix/events.js` (merge if the file exists).
7. **Publish.** Backend events don't run in Preview. Place a real test order on the live site.

## 4. Raspberry Pi print agent (one per store address)

```bash
# on the Pi (Node 18 or newer: node -v)
git clone https://github.com/YOU/YOUR-REPO.git store-orders
cd store-orders/print-agent
npm install
cp config.example.json config.json
nano config.json   # server URL, agentId from stores.json, agent key from master, printer IP
node agent.js      # test: should print "[health] store-a printer ready"
# keep it running and start after reboot
sudo npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup        # run the command it prints
```

`type` is `epson` or `star`. `width` is characters per line (48 for most 80 mm printers;
try 42 if lines wrap). Give each printer a fixed IP (DHCP reservation) on the Pi's network.

## 5. Store screen

Open the store's link (from master) in Fully Kiosk Browser on the tablet/monitor and tap
**Tap to start** once so the new-order chime can play. Tickets turn red after 15 minutes
(`&late=20` in the link changes it). **Picked up** asks for a second tap to confirm.

## Testing locally

```bash
npm install
MASTER_KEY=test WEBHOOK_TOKEN=test node server.js
# open http://localhost:3000/master?key=test and press "Send test order"
```

## Not in this version

Online prepayment (next project), editing stores from the master screen (edit `stores.json`),
and per-store logins beyond the secret screen link.
