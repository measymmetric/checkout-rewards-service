import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, createStore, LIMITS } from '../src/domain.ts';
import type { Product, Store } from '../src/domain.ts';

const product = (id = 'p', unitPriceCents = 105, inventory = 100): Product => ({ id, name: `Product ${id}`, unitPriceCents, inventory });
function error(code: string, status?: number) {
  return (value: unknown) => value instanceof ApiError && value.code === code && (status === undefined || value.status === status);
}
function cartWith(store: Store, quantity = 1, productId = 'p'): string {
  const cart = store.createCart();
  store.addItem(cart.id, productId, quantity);
  return cart.id;
}
function buy(store: Store, key: string, quantity = 1) {
  return store.checkout(cartWith(store, quantity), { idempotencyKey: key }).order;
}

test('seeds five products, including scarce inventory, and isolates stores and caller-owned objects', () => {
  const defaults = createStore();
  assert.equal(defaults.listProducts().length, 5);
  assert.ok(defaults.listProducts().some(value => value.inventory === 1));
  const initial = [product()];
  const first = createStore({ products: initial });
  const second = createStore({ products: initial });
  initial[0]!.inventory = 0;
  first.listProducts()[0]!.inventory = 0;
  first.updateProduct('p', { inventory: 3 }).inventory = 0;
  assert.equal(first.listProducts()[0]!.inventory, 3);
  assert.equal(second.listProducts()[0]!.inventory, 100);
});

test('editable cart increments, replaces and removes with current prices and no stock reservation', () => {
  const store = createStore({ products: [product('p', 105, 1)] });
  const id = cartWith(store, 2);
  assert.equal(store.addItem(id, 'p', 1).items[0]!.quantity, 3);
  assert.equal(store.updateItem(id, 'p', 2).subtotalCents, 210);
  store.updateProduct('p', { unitPriceCents: 200 });
  assert.equal(store.getCart(id).subtotalCents, 400);
  assert.equal(store.listProducts()[0]!.inventory, 1);
  assert.equal(store.removeItem(id, 'p').subtotalCents, 0);
  assert.throws(() => store.updateItem(id, 'p', 1), error('ITEM_NOT_FOUND', 404));
  assert.throws(() => store.removeItem(id, 'p'), error('ITEM_NOT_FOUND', 404));
});

test('invalid cart edits are atomic, including totals and accumulated quantity bounds', () => {
  const store = createStore({ products: [product('p', LIMITS.maxUnitPriceCents, LIMITS.maxInventory)] });
  const id = cartWith(store, 1);
  const before = store.getCart(id);
  for (const quantity of [0, -1, 1.5, NaN, Infinity, LIMITS.maxItemQuantity + 1]) {
    assert.throws(() => store.addItem(id, 'p', quantity), error('INVALID_QUANTITY', 422));
  }
  assert.throws(() => store.addItem(id, 'missing', 1), error('PRODUCT_NOT_FOUND', 404));
  assert.throws(() => store.addItem(id, 'p', 1000), error('LIMIT_EXCEEDED', 422));
  assert.deepEqual(store.getCart(id), before);
  const free = createStore({ products: [product('p', 0)] });
  const freeId = cartWith(free, LIMITS.maxItemQuantity);
  assert.throws(() => free.addItem(freeId, 'p', 1), error('INVALID_QUANTITY'));
  assert.equal(free.getCart(freeId).items[0]!.quantity, LIMITS.maxItemQuantity);
});

test('admin repricing preflights every open cart and rejects the entire patch before overflow', () => {
  const store = createStore({ products: [product('p', 1), product('q', 1), product('r', 1)] });
  const id = cartWith(store, 1000);
  store.addItem(id, 'q', 1000);
  store.addItem(id, 'r', 1000);
  const otherId = cartWith(store, 1);
  const before = { products: store.listProducts(), cart: store.getCart(id), other: store.getCart(otherId) };
  assert.throws(() => store.updateProduct('p', { unitPriceCents: LIMITS.maxUnitPriceCents, inventory: 0 }), error('LIMIT_EXCEEDED', 422));
  assert.deepEqual({ products: store.listProducts(), cart: store.getCart(id), other: store.getCart(otherId) }, before);
  assert.equal(store.updateProduct('p', { unitPriceCents: 100 }).unitPriceCents, 100);
  assert.equal(store.getCart(id).subtotalCents, 102_000);
  assert.equal(store.getCart(otherId).subtotalCents, 100);
  assert.equal(store.removeItem(id, 'p').subtotalCents, 2000);
  assert.equal(store.updateItem(id, 'q', 1).subtotalCents, 1001);
});

test('admin repricing ignores historical checked-out cart totals', () => {
  const store = createStore({ products: [product('p', 1, 10_000)] });
  const order = buy(store, 'large-historical', 2000);
  store.updateProduct('p', { unitPriceCents: LIMITS.maxUnitPriceCents });
  assert.equal(store.getCart(order.cartId).subtotalCents, 2000);
  assert.equal(store.getOrder(order.id).totalCents, 2000);
});

test('checkout preflights every item before stock, coupon, order or idempotency mutation', () => {
  const store = createStore({ products: [product('p'), product('q', 200, 0)], milestoneEvery: 1 });
  buy(store, 'seed');
  const coupon = store.generateCoupon();
  const id = cartWith(store, 2);
  store.addItem(id, 'q', 1);
  const before = { products: store.listProducts(), coupons: store.listCoupons(), orders: store.listOrders(), report: store.report() };
  assert.throws(() => store.checkout(id, { idempotencyKey: 'retry', couponCode: coupon.code }), error('INSUFFICIENT_STOCK', 409));
  assert.deepEqual({ products: store.listProducts(), coupons: store.listCoupons(), orders: store.listOrders(), report: store.report() }, before);
  assert.equal(store.getCart(id).status, 'open');
  store.updateProduct('q', { inventory: 1 });
  const result = store.checkout(id, { idempotencyKey: 'retry', couponCode: coupon.code });
  assert.equal(result.replayed, false);
  assert.equal(store.listCoupons()[0]!.status, 'redeemed');
  assert.equal(store.report().totalOrders, 2);
});

test('successful idempotency binding survives replay, coupon redemption and product changes', () => {
  const store = createStore({ products: [product()], milestoneEvery: 1 });
  buy(store, 'seed');
  const coupon = store.generateCoupon();
  const id = cartWith(store);
  const checkout = store.checkout(id, { idempotencyKey: 'opaque key', couponCode: ` ${coupon.code.toLowerCase()} ` });
  store.updateProduct('p', { inventory: 0, unitPriceCents: 900 });
  const replay = store.checkout(id, { idempotencyKey: 'opaque key', couponCode: coupon.code });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.order, checkout.order);
  assert.throws(() => store.checkout(id, { idempotencyKey: 'opaque key' }), error('IDEMPOTENCY_CONFLICT'));
  assert.throws(() => store.checkout(store.createCart().id, { idempotencyKey: 'opaque key', couponCode: coupon.code }), error('IDEMPOTENCY_CONFLICT'));
  assert.throws(() => store.checkout(id, { idempotencyKey: 'different', couponCode: coupon.code }), error('CART_CLOSED'));
  assert.equal(store.report().totalOrders, 2);
});

test('empty, invalid coupon and invalid idempotency attempts leave no successful replay record', () => {
  const store = createStore({ products: [product()] });
  const id = store.createCart().id;
  assert.throws(() => store.checkout(id, { idempotencyKey: 'empty' }), error('EMPTY_CART', 409));
  store.addItem(id, 'p', 1);
  for (const idempotencyKey of ['', '   ', 'k'.repeat(201)]) {
    assert.throws(() => store.checkout(id, { idempotencyKey }), error('INVALID_IDEMPOTENCY_KEY', 400));
  }
  assert.throws(() => store.checkout(id, { idempotencyKey: 'empty', couponCode: '   ' }), error('INVALID_INPUT', 400));
  assert.throws(() => store.checkout(id, { idempotencyKey: 'empty', couponCode: 'missing' }), error('INVALID_COUPON', 409));
  assert.equal(store.report().totalOrders, 0);
  assert.equal(store.checkout(id, { idempotencyKey: 'empty' }).replayed, false);
});

test('orders and checked-out carts retain immutable pricing despite caller mutation and catalog updates', () => {
  const store = createStore({ products: [product()] });
  const id = cartWith(store, 2);
  const result = store.checkout(id, { idempotencyKey: 'one' });
  const original = structuredClone(result.order);
  result.order.items[0]!.quantity = 999;
  store.getOrder(original.id).items[0]!.name = 'modified';
  store.listOrders()[0]!.totalCents = 0;
  store.getCart(id).items[0]!.unitPriceCents = 0;
  store.updateProduct('p', { unitPriceCents: 999, inventory: 0 });
  assert.deepEqual(store.getOrder(original.id), original);
  assert.deepEqual(store.getCart(id).items, original.items);
  assert.equal(store.getCart(id).subtotalCents, 210);
  assert.equal(store.getCart(id).orderId, original.id);
  assert.throws(() => store.addItem(id, 'p', 1), error('CART_CLOSED'));
  assert.throws(() => store.updateItem(id, 'p', 1), error('CART_CLOSED'));
  assert.throws(() => store.removeItem(id, 'p'), error('CART_CLOSED'));
});

test('milestones count only successful orders and generate each backlog reward once, oldest first', () => {
  const store = createStore({ products: [product()], milestoneEvery: 2, discountPercent: 25 });
  assert.throws(() => store.generateCoupon(), error('NO_ELIGIBLE_MILESTONE'));
  for (let index = 0; index < 5; index++) buy(store, `order-${index}`);
  const first = store.generateCoupon();
  const second = store.generateCoupon();
  assert.equal(first.milestoneOrderCount, 2);
  assert.equal(second.milestoneOrderCount, 4);
  assert.equal(first.discountPercent, 25);
  assert.notEqual(first.code, second.code);
  first.status = 'redeemed';
  store.listCoupons()[0]!.discountPercent = 99;
  assert.equal(store.listCoupons()[0]!.status, 'available');
  assert.equal(store.listCoupons()[0]!.discountPercent, 25);
  assert.throws(() => store.generateCoupon(), error('NO_ELIGIBLE_MILESTONE', 409));
  assert.throws(() => store.checkout(store.createCart().id, { idempotencyKey: 'failed' }), error('EMPTY_CART'));
  assert.throws(() => store.generateCoupon(), error('NO_ELIGIBLE_MILESTONE'));
  buy(store, 'sixth');
  assert.equal(store.generateCoupon().milestoneOrderCount, 6);
});

test('single-use coupons reject a second buyer without changing that buyer or inventory', () => {
  const store = createStore({ products: [product()], milestoneEvery: 1 });
  buy(store, 'seed');
  const coupon = store.generateCoupon();
  const firstId = cartWith(store);
  const secondId = cartWith(store);
  store.checkout(firstId, { idempotencyKey: 'first', couponCode: coupon.code });
  const before = { inventory: store.listProducts(), report: store.report() };
  assert.throws(() => store.checkout(secondId, { idempotencyKey: 'second', couponCode: coupon.code }), error('COUPON_REDEEMED'));
  assert.deepEqual({ inventory: store.listProducts(), report: store.report() }, before);
  assert.equal(store.getCart(secondId).status, 'open');
  assert.equal(store.checkout(secondId, { idempotencyKey: 'second' }).replayed, false);
});

test('discounts round half a cent upward once per order, including zero and 100 percent', () => {
  for (const [percent, price, quantity, expected] of [[10, 105, 1, 11], [10, 104, 1, 10], [50, 1, 3, 2], [0, 105, 1, 0], [100, 105, 1, 105], [10, 0, 1, 0]]) {
    const store = createStore({ products: [product('p', price)], milestoneEvery: 1, discountPercent: percent });
    buy(store, 'seed');
    const coupon = store.generateCoupon();
    const order = store.checkout(cartWith(store, quantity), { idempotencyKey: 'discount', couponCode: coupon.code }).order;
    assert.equal(order.discountCents, expected);
    assert.equal(order.totalCents, order.subtotalCents - expected!);
    assert.ok(Number.isSafeInteger(order.totalCents) && order.totalCents >= 0);
  }
});

test('reports reconcile immutable orders, coupon counts and purchased quantity, without mutations', () => {
  const store = createStore({ products: [product(), product('q', 199)], milestoneEvery: 1 });
  buy(store, 'one', 2);
  const coupon = store.generateCoupon();
  const id = cartWith(store, 3);
  store.addItem(id, 'q', 2);
  store.checkout(id, { idempotencyKey: 'two', couponCode: coupon.code });
  store.generateCoupon();
  const orders = store.listOrders();
  const report = store.report();
  assert.equal(report.totalOrders, 2);
  assert.equal(report.grossRevenueCents, orders.reduce((total, order) => total + order.subtotalCents, 0));
  assert.equal(report.totalDiscountCents, orders.reduce((total, order) => total + order.discountCents, 0));
  assert.equal(report.netRevenueCents, report.grossRevenueCents - report.totalDiscountCents);
  assert.deepEqual(report.purchasedQuantities, [{ productId: 'p', quantity: 5 }, { productId: 'q', quantity: 2 }]);
  assert.deepEqual(report.coupons, { generated: 2, available: 1, redeemed: 1 });
  const before = structuredClone(report);
  report.purchasedQuantities[0]!.quantity = 99;
  report.coupons.available = 99;
  assert.deepEqual(store.report(), before);
  assert.deepEqual(store.report(), before);
});

test('invalid configuration and combined admin patches fail before mutation', () => {
  for (const milestoneEvery of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createStore({ milestoneEvery }), error('INVALID_INPUT', 422));
  }
  for (const discountPercent of [-1, 1.5, 101, Infinity]) {
    assert.throws(() => createStore({ discountPercent }), error('INVALID_INPUT', 422));
  }
  assert.throws(() => createStore({ products: [product(), product()] }), error('INVALID_INPUT', 400));
  assert.throws(() => createStore({ products: [product('p', LIMITS.maxUnitPriceCents + 1)] }), error('INVALID_INPUT', 422));
  const store = createStore({ products: [product()] });
  const before = store.listProducts();
  assert.throws(() => store.updateProduct('p', { unitPriceCents: 1, inventory: -1 }), error('INVALID_INPUT', 422));
  assert.throws(() => store.updateProduct('p', {}), error('INVALID_INPUT', 400));
  assert.deepEqual(store.listProducts(), before);
  assert.throws(() => store.getCart('missing'), error('CART_NOT_FOUND', 404));
  assert.throws(() => store.getOrder('missing'), error('ORDER_NOT_FOUND', 404));
});

test('configuration is readable and defaults to n=5, x=10', () => {
  assert.deepEqual(createStore().getConfig(), { milestoneEvery: 5, discountPercent: 10 });
  const configured = createStore({ products: [product()], milestoneEvery: 3, discountPercent: 25 });
  assert.deepEqual(configured.getConfig(), { milestoneEvery: 3, discountPercent: 25 });
  // Coupons must carry the configured percent, not a recomputed one.
  for (let index = 0; index < 3; index++) buy(configured, `config-${index}`);
  assert.equal(configured.generateCoupon().discountPercent, 25);
});

test('a single line total beyond the cart limit is refused rather than rounded', () => {
  // The aggregate guard lives in report(), which already walks all orders; the
  // per-line and per-cart bounds are what protect the checkout path itself.
  const store = createStore({ products: [product('p', LIMITS.maxUnitPriceCents, LIMITS.maxInventory)] });
  const id = cartWith(store, 1);
  assert.throws(() => store.updateItem(id, 'p', 1001), error('LIMIT_EXCEEDED', 422));
  assert.equal(store.getCart(id).subtotalCents, LIMITS.maxUnitPriceCents);
  const order = store.checkout(id, { idempotencyKey: 'bounded' }).order;
  assert.ok(Number.isSafeInteger(order.totalCents));
  assert.equal(store.report().grossRevenueCents, LIMITS.maxUnitPriceCents);
});

