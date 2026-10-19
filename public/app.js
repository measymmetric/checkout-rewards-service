const $ = (id) => document.getElementById(id);
const money = (cents) => new Intl.NumberFormat('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100);
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const storageKey = 'checkout-rewards-review';
let saved = {};
try { saved = JSON.parse(sessionStorage.getItem(storageKey) || '{}'); if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {}; } catch { /* A fresh session can recover from invalid saved state. */ }
const state = { cart: null, products: [], coupons: [], report: null, config: null, order: null, couponCode: saved.couponCode || '', attempt: saved.attempt || null, busy: false, events: [] };

class ApiError extends Error {
  constructor(message, code, status) { super(message); this.code = code; this.status = status; }
}
async function api(path, method = 'GET', body, key) {
  const response = await fetch(path, {
    method, signal: AbortSignal.timeout(15000),
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(key ? { 'Idempotency-Key': key } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new ApiError(result.error?.message || 'Request could not be completed.', result.error?.code, response.status);
  return result;
}
function persist() {
  try { sessionStorage.setItem(storageKey, JSON.stringify({ cartId: state.cart?.id, couponCode: state.couponCode, attempt: state.attempt })); } catch { /* Review still works when browser storage is unavailable. */ }
}
function message(text, kind = 'success') { $('message').textContent = text; $('message').dataset.kind = kind; }
function activity(text) { state.events.unshift({ text, time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }); state.events = state.events.slice(0, 6); }
const icon = (id) => {
  const shapes = {
    keyboard: '<rect x="10" y="24" width="76" height="39" rx="7"/><path d="M20 34h6m7 0h6m7 0h6m7 0h6m7 0h5M20 44h6m7 0h6m7 0h6m7 0h6m7 0h5M30 54h37"/>',
    mouse: '<rect x="29" y="9" width="39" height="68" rx="20"/><path d="M49 10v24m-19 0h37"/>',
    monitor: '<rect x="9" y="11" width="78" height="51" rx="5"/><path d="M48 62v13M31 76h34M17 52h62"/>',
    headphones: '<path d="M20 45V34a28 28 0 0 1 56 0v11"/><rect x="13" y="38" width="18" height="33" rx="8"/><rect x="65" y="38" width="18" height="33" rx="8"/>',
    'limited-controller': '<path d="M26 26h44c10 0 16 37 9 43-7 6-14-11-20-12H37c-6 1-13 18-20 12-7-6-1-43 9-43Z"/><path d="M31 36v17m-9-8h18m20-7h1m10 10h1"/>',
  };
  return `<svg viewBox="0 0 96 88" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${shapes[id] || shapes.monitor}</svg>`;
};
function render() {
  const closed = state.cart?.status === 'checked_out';
  const unresolved = state.attempt?.status === 'pending';
  const locked = state.busy || closed || unresolved;
  $('products').innerHTML = state.products.map((product, index) => `<article class="product-card">
    <div class="product-art tone-${index % 5}">${icon(product.id)}</div>
    <div class="product-category">${index === 4 ? 'Limited collection' : 'Everyday essentials'}</div>
    <h3 class="product-name">${escapeHtml(product.name)}</h3>
    <div class="product-footer"><strong class="product-price">${money(product.unitPriceCents)}</strong><span class="stock-pill ${product.inventory === 0 ? 'out-of-stock' : product.inventory <= 1 ? 'low-stock' : ''}">${product.inventory ? `${product.inventory} in stock` : 'Sold out'}</span></div>
    <button class="button button-secondary add-product" data-product-id="${escapeHtml(product.id)}" ${locked || !product.inventory ? 'disabled' : ''}>${product.inventory ? '+ Add to cart' : 'Unavailable'}</button>
  </article>`).join('');
  const items = state.cart?.items || [];
  $('cart-count').textContent = items.reduce((count, item) => count + item.quantity, 0);
  $('cart-items').innerHTML = items.length ? items.map((item) => `<div class="cart-item"><div class="cart-item-info"><div class="cart-item-name">${escapeHtml(item.name)}</div><div class="cart-item-price">${money(item.unitPriceCents)} each</div></div><div class="cart-item-controls"><label class="sr-only" for="qty-${escapeHtml(item.productId)}">Quantity for ${escapeHtml(item.name)}</label><input id="qty-${escapeHtml(item.productId)}" class="quantity-input" data-product-id="${escapeHtml(item.productId)}" type="number" min="1" max="1000000" value="${item.quantity}" ${locked ? 'disabled' : ''}><strong>${money(item.lineTotalCents)}</strong><button class="remove-item" data-product-id="${escapeHtml(item.productId)}" aria-label="Remove ${escapeHtml(item.name)}" ${locked ? 'disabled' : ''}>×</button></div></div>`).join('') : '<div class="empty-state"><span class="empty-icon">＋</span><h3>Your next order starts here</h3><p>Add something from the collection to try checkout.</p></div>';
  const selected = state.coupons.find((coupon) => coupon.code === state.couponCode);
  const subtotal = state.order?.subtotalCents ?? state.cart?.subtotalCents ?? 0;
  const discount = state.order?.discountCents ?? (selected ? Number((BigInt(subtotal) * BigInt(selected.discountPercent) + 50n) / 100n) : 0);
  $('cart-subtotal').textContent = money(subtotal);
  $('cart-discount').textContent = `−${money(discount)}`;
  $('cart-total').textContent = money(state.order?.totalCents ?? subtotal - discount);
  $('cart-status').textContent = unresolved ? 'Awaiting confirmation' : closed ? 'Order confirmed' : 'Ready when you are';
  $('cart-id').textContent = state.cart?.id || 'Preparing your cart…';
  $('coupon-input').value = state.couponCode;
  $('coupon-input').disabled = locked;
  $('apply-coupon').disabled = locked;
  $('checkout').disabled = locked || !items.length || !state.cart;
  $('checkout').textContent = state.busy ? 'Working…' : closed ? 'Order placed' : 'Place order';
  $('retry-checkout').disabled = state.busy || !state.attempt;
  $('retry-checkout').textContent = unresolved ? 'Retry to confirm order' : 'Try the same request again';
  $('new-cart').disabled = state.busy || unresolved;
  $('refresh').disabled = state.busy;
  $('generate-coupon').disabled = state.busy;
  $('checkout-result').innerHTML = state.order ? `<span class="success-kicker">✓ Order confirmed</span><h3>Thank you. Your order is in.</h3><p>${money(state.order.totalCents)} total · Stock deducted once.</p><p class="order-reference">Order ${escapeHtml(state.order.id)}</p><p>Try the same request again to see a safe replay, or start a new cart.</p>` : unresolved ? '<h3>Let’s confirm your checkout</h3><p>The response was interrupted. Retry the same request before changing this cart.</p>' : '';
  $('coupon-list').innerHTML = state.coupons.length ? state.coupons.map((coupon) => `<div class="coupon-card ${coupon.status === 'redeemed' ? 'redeemed' : ''}"><div><strong>${coupon.discountPercent}% off your order</strong><span class="coupon-badge">${coupon.status === 'redeemed' ? 'Used' : 'Available'}</span><div class="coupon-code">${escapeHtml(coupon.code)}</div><small>Unlocked at order ${coupon.milestoneOrderCount}</small></div>${coupon.status === 'available' ? `<button class="button button-ghost use-coupon" data-coupon-code="${escapeHtml(coupon.code)}" ${locked ? 'disabled' : ''}>Use reward</button>` : ''}</div>`).join('') : '<div class="empty-state"><p>Your first reward is on its way. Complete the order milestone, then generate your coupon.</p></div>';
  const report = state.report;
  for (const [id, value] of Object.entries({ 'report-orders': report?.totalOrders || 0, 'report-gross': money(report?.grossRevenueCents || 0), 'report-discount': money(report?.totalDiscountCents || 0), 'report-net': money(report?.netRevenueCents || 0), 'report-available': report?.coupons.available || 0, 'report-redeemed': report?.coupons.redeemed || 0 })) $(id).textContent = value;
  if (state.config && report) {
    const eligible = Math.floor(report.totalOrders / state.config.milestoneEvery) - report.coupons.generated;
    const nextMilestone = (report.coupons.generated + 1) * state.config.milestoneEvery;
    $('milestone-progress').textContent = eligible > 0 ? `${eligible} reward${eligible === 1 ? '' : 's'} ready to generate · ${state.config.discountPercent}% off` : `${report.totalOrders} of ${nextMilestone} successful orders · ${state.config.discountPercent}% reward`;
    $('milestone-fill').style.width = `${Math.min(100, report.totalOrders / nextMilestone * 100)}%`;
    $('milestone-fill').parentElement.setAttribute('aria-valuenow', String(Math.min(100, Math.round(report.totalOrders / nextMilestone * 100))));
    $('generate-coupon').disabled = state.busy || eligible <= 0;
  }
  $('activity-log').innerHTML = state.events.length ? state.events.map((event) => `<li class="activity-item"><span>${escapeHtml(event.text)}</span><time>${escapeHtml(event.time)}</time></li>`).join('') : '<li class="activity-item">Your actions will appear here as you explore.</li>';
}
async function refreshData() {
  const [products, coupons, report, config] = await Promise.all([api('/products'), api('/admin/coupons'), api('/admin/reports'), api('/config')]);
  Object.assign(state, { products, coupons, report, config });
  if (state.cart) {
    state.cart = await api(`/carts/${state.cart.id}`);
    if (state.cart.orderId && state.order?.id !== state.cart.orderId) state.order = await api(`/orders/${state.cart.orderId}`);
  }
}
async function run(action) {
  if (state.busy) return;
  state.busy = true; render();
  try { await action(); } catch (error) { message(error instanceof ApiError ? error.message : 'The service could not be reached. Refresh or retry your request.', 'error'); }
  finally { state.busy = false; persist(); render(); }
}
async function newCart() {
  state.cart = await api('/carts', 'POST', {});
  state.order = null; state.attempt = null; state.couponCode = '';
  activity('Started a fresh cart'); message('Your cart is ready. Choose something you like.');
}
async function checkout(retry = false) {
  if (!retry) {
    state.attempt = { cartId: state.cart.id, key: crypto.randomUUID(), couponCode: state.couponCode, status: 'pending' };
    persist();
  }
  const attempt = state.attempt;
  try {
    const result = await api(`/carts/${attempt.cartId}/checkout`, 'POST', attempt.couponCode ? { couponCode: attempt.couponCode } : {}, attempt.key);
    attempt.status = 'confirmed'; state.order = result.order;
    state.cart = { ...state.cart, status: 'checked_out', orderId: result.order.id, items: result.order.items, subtotalCents: result.order.subtotalCents };
    activity(result.replayed ? 'Same request, same order. No extra stock deducted.' : `Order placed for ${money(result.order.totalCents)}`);
    message(result.replayed ? 'Safe replay confirmed. Same order, no duplicate purchase.' : 'Order placed successfully. Your report has been updated.');
    persist();
    try { await refreshData(); } catch { message('Order confirmed. Refresh the page to update the latest report.', 'error'); }
  } catch (error) {
    if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
      // Defined client/business errors are definitive. Server, network and parse
      // failures retain the same key/coupon until a retry confirms the outcome.
      if (attempt.status !== 'confirmed') state.attempt = null;
      try { await refreshData(); } catch { /* Keep the original business error. */ }
      throw error;
    }
    activity('Checkout response interrupted. Original request kept for retry.');
    message(state.order ? 'Your order is confirmed. The replay response was interrupted; the same request is available to retry.' : 'We could not confirm that response. Choose “Retry to confirm order”; the original request is preserved.', 'error');
  }
}
document.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button || button.disabled) return;
  if (button.classList.contains('add-product')) {
    const productId = button.dataset.productId;
    void run(async () => { state.cart = await api(`/carts/${state.cart.id}/items`, 'POST', { productId, quantity: 1 }); activity('Added an item to your cart'); message('Added to cart. Stock is confirmed when you place the order.'); });
  }
  if (button.classList.contains('remove-item')) {
    const productId = button.dataset.productId;
    void run(async () => { state.cart = await api(`/carts/${state.cart.id}/items/${encodeURIComponent(productId)}`, 'DELETE'); message('Item removed.'); });
  }
  if (button.classList.contains('use-coupon')) {
    state.couponCode = button.dataset.couponCode; persist(); render(); message('Reward selected. Your discount will be confirmed at checkout.');
  }
});
$('cart-items').addEventListener('change', (event) => {
  if (!event.target.matches('.quantity-input')) return;
  const productId = event.target.dataset.productId;
  const quantity = Number(event.target.value);
  void run(async () => { state.cart = await api(`/carts/${state.cart.id}/items/${encodeURIComponent(productId)}`, 'PATCH', { quantity }); message('Quantity updated.'); });
});
$('apply-coupon').addEventListener('click', () => {
  const code = $('coupon-input').value.trim().toUpperCase();
  if (!code) { state.couponCode = ''; persist(); render(); message('Reward cleared.'); return; }
  const coupon = state.coupons.find((value) => value.code === code && value.status === 'available');
  if (!coupon) { message('Choose an available reward from the rewards section.', 'error'); return; }
  state.couponCode = code; persist(); render(); message('Reward selected. Your discount will be confirmed at checkout.');
});
$('checkout').addEventListener('click', () => void run(() => checkout()));
$('retry-checkout').addEventListener('click', () => void run(() => checkout(true)));
$('new-cart').addEventListener('click', () => void run(newCart));
$('refresh').addEventListener('click', () => void run(async () => { await refreshData(); activity('Refreshed products, rewards and report'); message('Everything is up to date.'); }));
$('generate-coupon').addEventListener('click', () => void run(async () => { const coupon = await api('/admin/coupons', 'POST', {}); await refreshData(); activity(`Generated a ${coupon.discountPercent}% reward`); message('Your reward is ready. Choose “Use reward” to apply it to an open cart.'); }));

void run(async () => {
  await refreshData();
  if (saved.cartId) {
    try {
      state.cart = await api(`/carts/${encodeURIComponent(saved.cartId)}`);
      if (state.cart.orderId) state.order = await api(`/orders/${state.cart.orderId}`);
      if (state.attempt?.cartId !== state.cart.id) state.attempt = null;
    } catch (error) { if (error instanceof ApiError && error.status === 404) { await newCart(); } else throw error; }
  } else await newCart();
  activity('Connected to your local demo');
  message(state.attempt?.status === 'pending' ? 'An earlier checkout needs confirmation. Retry the same request before changing the cart.' : 'Welcome. Add products, place an order, and watch your rewards grow.');
});
