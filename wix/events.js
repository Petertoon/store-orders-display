// =====================================================================
// Paste into your Wix site: Code (Dev Mode) -> Backend -> events.js
// If events.js already exists, add these functions to it instead of
// replacing it.
//
// Also add a secret in the Wix dashboard: Developer Tools -> Secrets Manager
//   Name:  STORE_ORDERS_WEBHOOK_URL
//   Value: https://YOUR-RENDER-SERVICE.onrender.com/webhook/wix-order?token=YOUR_WEBHOOK_TOKEN
//
// Backend events do NOT run in Preview — test on the published site.
// =====================================================================
import { fetch } from 'wix-fetch';
import { secrets } from 'wix-secrets-backend.v2';
import { elevate } from 'wix-auth';

const getSecretValue = elevate(secrets.getSecretValue);

async function sendToStoreDisplays(type, order) {
  const secret = await getSecretValue('STORE_ORDERS_WEBHOOK_URL');
  const url = typeof secret === 'string' ? secret : secret.value;
  const body = JSON.stringify({ type, order });
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      if (res.ok) return;
      console.error(`Store displays: HTTP ${res.status} on attempt ${attempt}`, await res.text());
      if (res.status === 401 || res.status === 400) return; // won't fix itself by retrying
    } catch (e) {
      console.error(`Store displays: attempt ${attempt} failed`, e);
    }
    await new Promise((r) => setTimeout(r, 1500 * attempt));
  }
}

// New Wix Stores order -> split by store and sent to each store's screen/printer
export async function wixEcom_onOrderCreated(event) {
  await sendToStoreDisplays('created', event.entity);
}

// Cancelled order -> removed from the store screens
export async function wixEcom_onOrderCanceled(event) {
  await sendToStoreDisplays('canceled', event.entity);
}
