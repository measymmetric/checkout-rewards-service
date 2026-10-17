import { randomUUID } from 'node:crypto';

export const LIMITS = Object.freeze({
  maxUnitPriceCents: 1_000_000_000,
  maxInventory: 1_000_000,
  maxItemQuantity: 1_000_000,
  maxCartTotalCents: 1_000_000_000_000,
  maxIdempotencyKeyLength: 200,
});

export class DomainError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'DomainError';
    this.status = status;
    this.code = code;
  }
}

export interface Product { id: string; name: string; unitPriceCents: number; inventory: number }
export interface OrderItem {
  productId: string; name: string; quantity: number; unitPriceCents: number; lineTotalCents: number;
}
export interface CartView {
  id: string; status: 'open' | 'checked_out'; items: OrderItem[]; subtotalCents: number; orderId?: string;
}
export interface Order {
  id: string; cartId: string; items: OrderItem[]; subtotalCents: number;
  discountCents: number; totalCents: number; couponCode?: string; createdAt: string;
}
export interface Coupon {
  code: string; milestoneOrderCount: number; discountPercent: number;
  status: 'available' | 'redeemed'; orderId?: string;
}
export interface Report {
  totalOrders: number; purchasedQuantities: { productId: string; quantity: number }[];
  grossRevenueCents: number; totalDiscountCents: number; netRevenueCents: number;
  coupons: { generated: number; available: number; redeemed: number };
}
export interface StoreOptions { products?: Product[]; milestoneEvery?: number; discountPercent?: number }
export interface CheckoutInput { idempotencyKey: string; couponCode?: string }
export interface Store {
  listProducts(): Product[];
  createCart(): CartView;
  getCart(cartId: string): CartView;
  addItem(cartId: string, productId: string, quantity: number): CartView;
  updateItem(cartId: string, productId: string, quantity: number): CartView;
  removeItem(cartId: string, productId: string): CartView;
  checkout(cartId: string, input: CheckoutInput): { order: Order; replayed: boolean };
  getOrder(orderId: string): Order;
  listOrders(): Order[];
  generateCoupon(): Coupon;
  listCoupons(): Coupon[];
  report(): Report;
  updateProduct(productId: string, patch: { unitPriceCents?: number; inventory?: number }): Product;
}

const DEFAULT_PRODUCTS: Product[] = [
  { id: 'keyboard', name: 'Mechanical keyboard', unitPriceCents: 5999, inventory: 20 },
  { id: 'mouse', name: 'Wireless mouse', unitPriceCents: 2499, inventory: 30 },
  { id: 'monitor', name: 'Desktop monitor', unitPriceCents: 18999, inventory: 10 },
  { id: 'headphones', name: 'Studio headphones', unitPriceCents: 7999, inventory: 15 },
  { id: 'limited-controller', name: 'Limited edition controller', unitPriceCents: 6499, inventory: 1 },
];

function fail(status: number, code: string, message: string): never {
  throw new DomainError(status, code, message);
}
function integer(value: unknown, min: number, max: number, label: string, code = 'INVALID_INPUT'): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    fail(422, code, `${label} must be an integer between ${min} and ${max}.`);
  }
}
function textValue(value: unknown, label: string, max = 200): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    fail(400, 'INVALID_INPUT', `${label} must be a nonempty string of at most ${max} characters.`);
  }
}
function bounded(value: bigint, max = Number.MAX_SAFE_INTEGER): number {
  if (value > BigInt(max)) fail(422, 'LIMIT_EXCEEDED', 'The operation exceeds the supported numeric limit.');
  return Number(value);
}
function sum(left: number, right: number, max = Number.MAX_SAFE_INTEGER): number {
  return bounded(BigInt(left) + BigInt(right), max);
}
function copy<T>(value: T): T { return structuredClone(value); }

export function createStore(options: StoreOptions = {}): Store {
  const milestoneEvery = options.milestoneEvery ?? 5;
  const discountPercent = options.discountPercent ?? 10;
  integer(milestoneEvery, 1, Number.MAX_SAFE_INTEGER, 'milestoneEvery');
  integer(discountPercent, 0, 100, 'discountPercent');
  const products = new Map<string, Product>();
  for (const product of options.products ?? DEFAULT_PRODUCTS) {
    textValue(product.id, 'Product ID', 100);
    textValue(product.name, 'Product name');
    integer(product.unitPriceCents, 0, LIMITS.maxUnitPriceCents, 'unitPriceCents');
    integer(product.inventory, 0, LIMITS.maxInventory, 'inventory');
    if (products.has(product.id)) fail(400, 'INVALID_INPUT', 'Product IDs must be unique.');
    products.set(product.id, copy(product));
  }
  interface Cart { id: string; items: Map<string, number>; orderId?: string }
  const carts = new Map<string, Cart>();
  const orders = new Map<string, Order>();
  const coupons = new Map<string, Coupon>();
  const replays = new Map<string, { cartId: string; couponCode?: string; orderId: string }>();

  function productById(id: string): Product {
    const product = products.get(id);
    if (!product) fail(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
    return product;
  }
  function cartById(id: string): Cart {
    const cart = carts.get(id);
    if (!cart) fail(404, 'CART_NOT_FOUND', 'Cart not found.');
    return cart;
  }
  function openCart(id: string): Cart {
    const cart = cartById(id);
    if (cart.orderId) fail(409, 'CART_CLOSED', 'This cart has already been checked out.');
    return cart;
  }
  function orderById(id: string): Order {
    const order = orders.get(id);
    if (!order) fail(404, 'ORDER_NOT_FOUND', 'Order not found.');
    return order;
  }
  function price(items: Map<string, number>, proposedProduct?: Product): { items: OrderItem[]; subtotalCents: number } {
    let subtotalCents = 0;
    const snapshots = [...items].map(([productId, quantity]) => {
      const product = proposedProduct?.id === productId ? proposedProduct : productById(productId);
      const lineTotalCents = bounded(BigInt(product.unitPriceCents) * BigInt(quantity), LIMITS.maxCartTotalCents);
      subtotalCents = sum(subtotalCents, lineTotalCents, LIMITS.maxCartTotalCents);
      return { productId, name: product.name, quantity, unitPriceCents: product.unitPriceCents, lineTotalCents };
    });
    return { items: snapshots, subtotalCents };
  }
  function view(cart: Cart): CartView {
    if (cart.orderId) {
      const order = orderById(cart.orderId);
      return copy({ id: cart.id, status: 'checked_out', items: order.items, subtotalCents: order.subtotalCents, orderId: order.id });
    }
    return { id: cart.id, status: 'open', ...price(cart.items) };
  }
  function edit(cartId: string, productId: string, quantity: number, increment: boolean): CartView {
    integer(quantity, 1, LIMITS.maxItemQuantity, 'quantity', 'INVALID_QUANTITY');
    const cart = openCart(cartId);
    productById(productId);
    if (!increment && !cart.items.has(productId)) fail(404, 'ITEM_NOT_FOUND', 'Product is not in this cart.');
    const nextQuantity = increment ? (cart.items.get(productId) ?? 0) + quantity : quantity;
    integer(nextQuantity, 1, LIMITS.maxItemQuantity, 'quantity', 'INVALID_QUANTITY');
    const nextItems = new Map(cart.items);
    nextItems.set(productId, nextQuantity);
    const priced = price(nextItems);
    cart.items = nextItems;
    return { id: cart.id, status: 'open', ...priced };
  }
  function report(): Report {
    const purchased = new Map<string, number>();
    let grossRevenueCents = 0;
    let totalDiscountCents = 0;
    let netRevenueCents = 0;
    for (const order of orders.values()) {
      grossRevenueCents = sum(grossRevenueCents, order.subtotalCents);
      totalDiscountCents = sum(totalDiscountCents, order.discountCents);
      netRevenueCents = sum(netRevenueCents, order.totalCents);
      for (const item of order.items) purchased.set(item.productId, sum(purchased.get(item.productId) ?? 0, item.quantity));
    }
    const redeemed = [...coupons.values()].filter(coupon => coupon.status === 'redeemed').length;
    return {
      totalOrders: orders.size,
      purchasedQuantities: [...purchased].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([productId, quantity]) => ({ productId, quantity })),
      grossRevenueCents, totalDiscountCents, netRevenueCents,
      coupons: { generated: coupons.size, available: coupons.size - redeemed, redeemed },
    };
  }

  return {
    listProducts: () => copy([...products.values()]),
    createCart() {
      const cart: Cart = { id: randomUUID(), items: new Map() };
      carts.set(cart.id, cart);
      return view(cart);
    },
    getCart: cartId => view(cartById(cartId)),
    addItem: (cartId, productId, quantity) => edit(cartId, productId, quantity, true),
    updateItem: (cartId, productId, quantity) => edit(cartId, productId, quantity, false),
    removeItem(cartId, productId) {
      const cart = openCart(cartId);
      if (!cart.items.has(productId)) fail(404, 'ITEM_NOT_FOUND', 'Product is not in this cart.');
      const nextItems = new Map(cart.items);
      nextItems.delete(productId);
      const priced = price(nextItems);
      cart.items = nextItems;
      return { id: cart.id, status: 'open', ...priced };
    },
    checkout(cartId, input) {
      if (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey.trim() || input.idempotencyKey.length > LIMITS.maxIdempotencyKeyLength) {
        fail(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be a nonempty string of at most 200 characters.');
      }
      let couponCode: string | undefined;
      if (input.couponCode !== undefined) {
        textValue(input.couponCode, 'couponCode');
        couponCode = input.couponCode.trim().toUpperCase();
      }
      const replay = replays.get(input.idempotencyKey);
      if (replay) {
        if (replay.cartId !== cartId || replay.couponCode !== couponCode) {
          fail(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key is already bound to a different checkout.');
        }
        return { order: copy(orderById(replay.orderId)), replayed: true };
      }
      const cart = openCart(cartId);
      if (!cart.items.size) fail(409, 'EMPTY_CART', 'Cannot check out an empty cart.');
      const priced = price(cart.items);
      for (const item of priced.items) {
        if (productById(item.productId).inventory < item.quantity) fail(409, 'INSUFFICIENT_STOCK', `Insufficient stock for product ${item.productId}.`);
      }
      const coupon = couponCode === undefined ? undefined : coupons.get(couponCode);
      if (couponCode !== undefined && !coupon) fail(409, 'INVALID_COUPON', 'Coupon does not exist.');
      if (coupon?.status === 'redeemed') fail(409, 'COUPON_REDEEMED', 'Coupon has already been redeemed.');
      const discountCents = coupon ? Number((BigInt(priced.subtotalCents) * BigInt(coupon.discountPercent) + 50n) / 100n) : 0;
      const totalCents = priced.subtotalCents - discountCents;
      // Check lifetime report bounds too. Replenishment must not permit cumulative overflow.
      const previous = report();
      sum(previous.grossRevenueCents, priced.subtotalCents);
      sum(previous.totalDiscountCents, discountCents);
      sum(previous.netRevenueCents, totalCents);
      const purchased = new Map(previous.purchasedQuantities.map(item => [item.productId, item.quantity]));
      for (const item of priced.items) sum(purchased.get(item.productId) ?? 0, item.quantity);
      const order: Order = {
        id: randomUUID(), cartId, ...priced, discountCents, totalCents,
        ...(couponCode === undefined ? {} : { couponCode }), createdAt: new Date().toISOString(),
      };
      // No await or user callback may enter this commit section. One Node process executes
      // all validation and mutation synchronously, so overlapping requests serialize here.
      for (const item of priced.items) productById(item.productId).inventory -= item.quantity;
      orders.set(order.id, order);
      cart.orderId = order.id;
      if (coupon) { coupon.status = 'redeemed'; coupon.orderId = order.id; }
      replays.set(input.idempotencyKey, { cartId, couponCode, orderId: order.id });
      return { order: copy(order), replayed: false };
    },
    getOrder: orderId => copy(orderById(orderId)),
    listOrders: () => copy([...orders.values()]),
    generateCoupon() {
      const milestone = BigInt(coupons.size + 1) * BigInt(milestoneEvery);
      if (milestone > BigInt(orders.size)) fail(409, 'NO_ELIGIBLE_MILESTONE', 'No unrewarded order milestone is eligible.');
      const coupon: Coupon = {
        code: `REWARD-${milestone}-${randomUUID().toUpperCase()}`,
        milestoneOrderCount: Number(milestone), discountPercent, status: 'available',
      };
      coupons.set(coupon.code, coupon);
      return copy(coupon);
    },
    listCoupons: () => copy([...coupons.values()]),
    report,
    updateProduct(productId, patch) {
      const product = productById(productId);
      if (patch.unitPriceCents === undefined && patch.inventory === undefined) fail(400, 'INVALID_INPUT', 'Specify unitPriceCents and/or inventory.');
      if (patch.unitPriceCents !== undefined) integer(patch.unitPriceCents, 0, LIMITS.maxUnitPriceCents, 'unitPriceCents');
      if (patch.inventory !== undefined) integer(patch.inventory, 0, LIMITS.maxInventory, 'inventory');
      // A price increase must not leave existing open carts unviewable or uneditable.
      // Evaluate the proposed catalog value before changing either patch field.
      if (patch.unitPriceCents !== undefined) {
        const proposed = { ...product, unitPriceCents: patch.unitPriceCents };
        for (const cart of carts.values()) {
          if (!cart.orderId && cart.items.has(productId)) price(cart.items, proposed);
        }
      }
      if (patch.unitPriceCents !== undefined) product.unitPriceCents = patch.unitPriceCents;
      if (patch.inventory !== undefined) product.inventory = patch.inventory;
      return copy(product);
    },
  };
}
