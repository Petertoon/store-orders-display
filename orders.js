// Turns a Wix eCommerce order into one ticket per store, using each item's SKU prefix.
const UNASSIGNED = 'unassigned';

const txt = (v) => (v == null ? '' : typeof v === 'object' ? (v.original || v.translated || '') : String(v));

function pick(obj, paths) {
  for (const p of paths) {
    const v = p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
    if (v != null && v !== '') return v;
  }
  return undefined;
}

function parseCustomer(order) {
  const c = pick(order, [
    'billingInfo.contactDetails',
    'shippingInfo.logistics.shippingDestination.contactDetails',
    'recipientInfo.contactDetails',
  ]) || {};
  const name = [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
  return {
    name: name || pick(order, ['buyerInfo.email']) || 'Customer',
    phone: c.phone || pick(order, ['buyerInfo.phone']) || '',
  };
}

function parseItems(order) {
  return (order.lineItems || []).map((li) => {
    const options = (li.descriptionLines || [])
      .map((d) => {
        const label = txt(d.name);
        const value = txt(d.plainText) || txt(d.colorInfo) || txt(d.color);
        return label && value ? `${label}: ${value}` : value || label;
      })
      .filter(Boolean);
    return {
      name: txt(li.productName) || txt(li.name) || 'Item',
      sku: (pick(li, ['physicalProperties.sku', 'sku']) || '').toString().trim(),
      qty: Number(li.quantity) || 1,
      options,
    };
  });
}

// Longest matching prefix wins, so "AB-" beats "A-".
function storeForSku(sku, stores) {
  const s = sku.toUpperCase();
  let best = null;
  for (const st of stores) {
    const p = (st.skuPrefix || '').toUpperCase();
    if (p && s.startsWith(p) && (!best || p.length > best.skuPrefix.length)) best = st;
  }
  return best;
}

function splitOrder(rawOrder, stores) {
  const order = rawOrder.entity || rawOrder.order || rawOrder;
  const orderId = String(order._id || order.id || '');
  if (!orderId) throw new Error('order has no id');
  const orderNumber = String(order.number || order.orderNumber || orderId.slice(0, 8));
  const customer = parseCustomer(order);
  const note = txt(order.buyerNote) || '';

  const byStore = new Map();
  for (const item of parseItems(order)) {
    const store = storeForSku(item.sku, stores);
    const storeId = store ? store.id : UNASSIGNED;
    if (!byStore.has(storeId)) byStore.set(storeId, []);
    byStore.get(storeId).push(item);
  }
  return [...byStore.entries()].map(([storeId, items]) => ({
    id: `${orderId}:${storeId}`, orderId, orderNumber, storeId, customer, items, note,
  }));
}

module.exports = { splitOrder, storeForSku, UNASSIGNED };
