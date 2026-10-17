import assert from 'node:assert/strict';
import { createServer, request as nodeRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { createApp, MAX_BODY_BYTES } from '../src/app.ts';
import { createStore } from '../src/domain.ts';
import type { CartView, Coupon, Order, Product, Report, Store } from '../src/domain.ts';

type Failure = { error: { code: string; message: string } };
type Checkout = { order: Order; replayed: boolean };

async function start(t: TestContext, store?: Store) {
  const server = createServer(createApp(store));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function api<T>(path: string, method = 'GET', body?: unknown, key?: string) {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (key !== undefined) headers['idempotency-key'] = key;
    const response = await fetch(url + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() as T, headers: response.headers };
  }
  async function cart(productId = 'p', quantity = 1) {
    const created = await api<CartView>('/carts', 'POST');
    assert.equal(created.status, 201);
    const added = await api<CartView>(`/carts/${created.data.id}/items`, 'POST', { productId, quantity });
    assert.equal(added.status, 200);
    return created.data.id;
  }
  return { url, api, cart };
}

function store(inventory = 20, milestoneEvery = 5) {
  return createStore({ products: [{ id: 'p', name: 'Test product', unitPriceCents: 105, inventory }], milestoneEvery });
}

test('HTTP cart editing, live prices, immutable orders and administrative reads', async (t) => {
  const { api, cart } = await start(t, store());
  assert.equal((await api('/health')).status, 200);
  const id = await cart();
  let edited = await api<CartView>(`/carts/${id}/items`, 'POST', { productId: 'p', quantity: 2 });
  assert.equal(edited.data.items[0]?.quantity, 3);
  edited = await api<CartView>(`/carts/${id}/items/p`, 'PATCH', { quantity: 2 });
  assert.equal(edited.data.subtotalCents, 210);
  edited = await api<CartView>(`/carts/${id}/items/p`, 'DELETE');
  assert.deepEqual(edited.data.items, []);
  await api(`/carts/${id}/items`, 'POST', { productId: 'p', quantity: 2 });
  assert.equal((await api('/admin/products/p', 'PATCH', { unitPriceCents: 200 })).status, 200);
  assert.equal((await api<CartView>(`/carts/${id}`)).data.subtotalCents, 400);
  const checked = await api<Checkout>(`/carts/${id}/checkout`, 'POST', {}, 'purchase');
  assert.equal(checked.status, 201);
  assert.equal(checked.data.order.totalCents, 400);
  await api('/admin/products/p', 'PATCH', { unitPriceCents: 999, inventory: 50 });
  assert.deepEqual((await api<Order>(`/orders/${checked.data.order.id}`)).data, checked.data.order);
  const closed = (await api<CartView>(`/carts/${id}`)).data;
  assert.equal(closed.status, 'checked_out');
  assert.equal(closed.subtotalCents, 400);
  assert.equal((await api(`/carts/${id}/items/p`, 'PATCH', { quantity: 1 })).status, 409);
  assert.deepEqual((await api<Order[]>('/admin/orders')).data, [checked.data.order]);
  assert.deepEqual((await api<Coupon[]>('/admin/coupons')).data, []);
  const noMilestone = await api<Failure>('/admin/coupons', 'POST');
  assert.equal(noMilestone.status, 409);
  assert.equal(noMilestone.data.error.code, 'NO_ELIGIBLE_MILESTONE');
});

test('24 overlapping identical checkout requests create exactly one order', async (t) => {
  const { api, cart } = await start(t, store());
  const id = await cart();
  const results = await Promise.all(Array.from({ length: 24 }, () => api<Checkout>(`/carts/${id}/checkout`, 'POST', {}, 'same-key')));
  assert.equal(results.filter((result) => result.status === 201).length, 1);
  assert.equal(results.filter((result) => result.status === 200).length, 23);
  assert.equal(new Set(results.map((result) => result.data.order.id)).size, 1);
  assert.equal(results.filter((result) => result.data.replayed).length, 23);
  const conflict = await api<Failure>(`/carts/${id}/checkout`, 'POST', { couponCode: 'different' }, 'same-key');
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.error.code, 'IDEMPOTENCY_CONFLICT');
  const anotherCart = await cart();
  assert.equal((await api(`/carts/${anotherCart}/checkout`, 'POST', {}, 'same-key')).status, 409);
  const closed = await api<Failure>(`/carts/${id}/checkout`, 'POST', {}, 'different-key');
  assert.equal(closed.data.error.code, 'CART_CLOSED');
  assert.equal((await api<Product[]>('/products')).data[0]?.inventory, 19);
  assert.equal((await api<Report>('/admin/reports')).data.totalOrders, 1);
});

test('two overlapping buyers cannot oversell inventory1; failed key remains retryable', async (t) => {
  const { api, cart } = await start(t, store(1));
  const ids = await Promise.all([cart(), cart()]);
  const results = await Promise.all(ids.map((id, index) => api<Checkout | Failure>(`/carts/${id}/checkout`, 'POST', {}, `buyer-${index}`)));
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  const failedIndex = results.findIndex((result) => result.status === 409);
  assert.equal((results[failedIndex]!.data as Failure).error.code, 'INSUFFICIENT_STOCK');
  assert.equal((await api<Product[]>('/products')).data[0]?.inventory, 0);
  assert.equal((await api<CartView>(`/carts/${ids[failedIndex]}`)).data.status, 'open');
  assert.deepEqual((await api<Report>('/admin/reports')).data, {
    totalOrders: 1, purchasedQuantities: [{ productId: 'p', quantity: 1 }], grossRevenueCents: 105,
    totalDiscountCents: 0, netRevenueCents: 105, coupons: { generated: 0, available: 0, redeemed: 0 },
  });
  await api('/admin/products/p', 'PATCH', { inventory: 1 });
  assert.equal((await api(`/carts/${ids[failedIndex]}/checkout`, 'POST', {}, `buyer-${failedIndex}`)).status, 201);
  assert.equal((await api<Report>('/admin/reports')).data.totalOrders, 2);
});

test('two overlapping carts redeem a coupon once with half-up rounding and reconciled report', async (t) => {
  const { api, cart } = await start(t, store(10, 1));
  const seed = await cart();
  await api(`/carts/${seed}/checkout`, 'POST', {}, 'seed');
  const coupon = (await api<Coupon>('/admin/coupons', 'POST')).data;
  const ids = await Promise.all([cart(), cart()]);
  const results = await Promise.all(ids.map((id, index) => api<Checkout | Failure>(`/carts/${id}/checkout`, 'POST', { couponCode: coupon.code.toLowerCase() }, `coupon-${index}`)));
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  const success = results.find((result) => result.status === 201)!.data as Checkout;
  assert.equal(success.order.discountCents, 11);
  assert.equal(success.order.totalCents, 94);
  const failure = results.find((result) => result.status === 409)!.data as Failure;
  assert.equal(failure.error.code, 'COUPON_REDEEMED');
  const coupons = (await api<Coupon[]>('/admin/coupons')).data;
  assert.equal(coupons[0]?.status, 'redeemed');
  assert.equal(coupons[0]?.orderId, success.order.id);
  assert.equal((await api<Product[]>('/products')).data[0]?.inventory, 8);
  const report = (await api<Report>('/admin/reports')).data;
  assert.deepEqual(report, {
    totalOrders: 2, purchasedQuantities: [{ productId: 'p', quantity: 2 }], grossRevenueCents: 210,
    totalDiscountCents: 11, netRevenueCents: 199, coupons: { generated: 1, available: 0, redeemed: 1 },
  });
  assert.deepEqual((await api<Report>('/admin/reports')).data, report);
  const winnerIndex = results.findIndex((result) => result.status === 201);
  const replay = await api<Checkout>(`/carts/${ids[winnerIndex]}/checkout`, 'POST', { couponCode: ` ${coupon.code} ` }, `coupon-${winnerIndex}`);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data.order, success.order);
});

test('failed stock and invalid coupon checkout preserve all transactional state', async (t) => {
  const { api, cart } = await start(t, store(2, 1));
  const seed = await cart();
  await api(`/carts/${seed}/checkout`, 'POST', {}, 'seed');
  const coupon = (await api<Coupon>('/admin/coupons', 'POST')).data;
  const id = await cart();
  const before = (await api<Report>('/admin/reports')).data;
  const invalid = await api<Failure>(`/carts/${id}/checkout`, 'POST', { couponCode: 'missing' }, 'bad');
  assert.equal(invalid.data.error.code, 'INVALID_COUPON');
  await api('/admin/products/p', 'PATCH', { inventory: 0 });
  const failed = await api<Failure>(`/carts/${id}/checkout`, 'POST', { couponCode: coupon.code }, 'retry');
  assert.equal(failed.data.error.code, 'INSUFFICIENT_STOCK');
  assert.deepEqual((await api<Report>('/admin/reports')).data, before);
  assert.equal((await api<Coupon[]>('/admin/coupons')).data[0]?.status, 'available');
  assert.equal((await api<CartView>(`/carts/${id}`)).data.status, 'open');
  await api('/admin/products/p', 'PATCH', { inventory: 1 });
  assert.equal((await api(`/carts/${id}/checkout`, 'POST', { couponCode: coupon.code }, 'retry')).status, 201);
});

test('overlapping administrative generation assigns each completed milestone only once', async (t) => {
  const { api, cart } = await start(t, store(10, 2));
  for (let index = 0; index < 4; index++) {
    const id = await cart();
    assert.equal((await api(`/carts/${id}/checkout`, 'POST', {}, `seed-${index}`)).status, 201);
  }
  const generated = await Promise.all(Array.from({ length: 3 }, () => api<Coupon | Failure>('/admin/coupons', 'POST')));
  assert.deepEqual(generated.map((result) => result.status).sort(), [201, 201, 409]);
  assert.deepEqual((await api<Coupon[]>('/admin/coupons')).data.map((coupon) => coupon.milestoneOrderCount).sort(), [2, 4]);
  assert.deepEqual((await api<Report>('/admin/reports')).data.coupons, { generated: 2, available: 2, redeemed: 0 });
});

test('HTTP errors reject bad methods, identifiers, payloads and keys without effects', async (t) => {
  const { api, cart, url } = await start(t, store());
  const id = await cart();
  const cases: [string, string, unknown, string | undefined, number, string][] = [
    ['/missing', 'GET', undefined, undefined, 404, 'NOT_FOUND'],
    ['/carts/missing', 'GET', undefined, undefined, 404, 'CART_NOT_FOUND'],
    ['/products', 'POST', {}, undefined, 405, 'METHOD_NOT_ALLOWED'],
    ['/carts', 'POST', [], undefined, 400, 'INVALID_BODY'],
    ['/carts', 'POST', null, undefined, 400, 'INVALID_BODY'],
    ['/carts', 'POST', { unexpected: true }, undefined, 400, 'INVALID_INPUT'],
    [`/carts/${id}/items`, 'POST', { productId: 'p', quantity: '2' }, undefined, 400, 'INVALID_INPUT'],
    [`/carts/${id}/items`, 'POST', { productId: 'p', quantity: 0 }, undefined, 422, 'INVALID_QUANTITY'],
    [`/carts/${id}/items`, 'POST', { productId: 'p', quantity: 1.5 }, undefined, 422, 'INVALID_QUANTITY'],
    [`/carts/${id}/checkout`, 'POST', {}, undefined, 400, 'INVALID_IDEMPOTENCY_KEY'],
    [`/carts/${id}/checkout`, 'POST', {}, 'x'.repeat(201), 400, 'INVALID_IDEMPOTENCY_KEY'],
    [`/carts/${id}/checkout`, 'POST', { couponCode: ' ' }, 'coupon', 400, 'INVALID_INPUT'],
    ['/admin/products/p', 'PATCH', {}, undefined, 400, 'INVALID_INPUT'],
    ['/admin/products/p', 'PATCH', { inventory: -1 }, undefined, 422, 'INVALID_INPUT'],
    ['/carts/%ZZ', 'GET', undefined, undefined, 400, 'INVALID_PATH'],
    ['/carts/%2F', 'GET', undefined, undefined, 400, 'INVALID_PATH'],
  ];
  for (const [path, method, body, key, status, code] of cases) {
    const result = await api<Failure>(path, method, body, key);
    assert.equal(result.status, status, `${method} ${path}: ${JSON.stringify(result.data)}`);
    assert.equal(result.data.error.code, code);
    assert.equal(typeof result.data.error.message, 'string');
    if (status === 405) assert.equal(result.headers.get('allow'), 'GET');
  }
  const duplicated = await new Promise<{ status: number; data: Failure }>((resolve, reject) => {
    const request = nodeRequest(`${url}/carts/${id}/checkout`, {
      method: 'POST', headers: ['Host', new URL(url).host, 'Idempotency-Key', 'one', 'Idempotency-Key', 'two'],
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode!, data: JSON.parse(Buffer.concat(chunks).toString()) as Failure }));
    });
    request.on('error', reject); request.end();
  });
  assert.equal(duplicated.status, 400);
  assert.equal(duplicated.data.error.code, 'INVALID_IDEMPOTENCY_KEY');
  assert.equal((await api<Report>('/admin/reports')).data.totalOrders, 0);
  assert.equal((await api<Product[]>('/products')).data[0]?.inventory, 20);
});

test('malformed JSON, media types and bounded chunked bodies return useful errors', async (t) => {
  const { url, api } = await start(t, store());
  for (const [body, contentType, status, code] of [
    ['{', 'application/json', 400, 'INVALID_JSON'],
    ['{}', 'text/plain', 415, 'UNSUPPORTED_MEDIA_TYPE'],
    ['x'.repeat(MAX_BODY_BYTES + 1), 'application/json', 413, 'BODY_TOO_LARGE'],
  ] as const) {
    const response = await fetch(`${url}/carts`, { method: 'POST', headers: { 'content-type': contentType }, body });
    assert.equal(response.status, status);
    assert.equal((await response.json() as Failure).error.code, code);
  }
  const chunked = await new Promise<{ status: number; data: Failure }>((resolve, reject) => {
    const request = nodeRequest(`${url}/carts`, { method: 'POST', headers: { 'content-type': 'application/json' } }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode!, data: JSON.parse(Buffer.concat(chunks).toString()) as Failure }));
    });
    request.on('error', reject);
    for (let index = 0; index < 20; index++) request.write('x'.repeat(1024));
    request.end();
  });
  assert.equal(chunked.status, 413);
  assert.equal(chunked.data.error.code, 'BODY_TOO_LARGE');
  assert.equal((await api('/health')).status, 200);
  assert.equal((await api<Report>('/admin/reports')).data.totalOrders, 0);
});

test('independent createApp defaults do not share carts or orders', async (t) => {
  const first = await start(t);
  const second = await start(t);
  const cart = (await first.api<CartView>('/carts', 'POST')).data;
  assert.equal((await second.api(`/carts/${cart.id}`)).status, 404);
  assert.equal((await second.api<Report>('/admin/reports')).data.totalOrders, 0);
});
