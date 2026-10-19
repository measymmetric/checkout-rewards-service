import { randomUUID } from 'node:crypto';

/** Bounds that keep money arithmetic inside the range JavaScript represents exactly. */
export const LIMITS = Object.freeze({
  maxUnitPriceCents: 1_000_000_000,
  maxInventory: 1_000_000,
  maxItemQuantity: 1_000_000,
  maxCartTotalCents: 1_000_000_000_000,
  maxTextLength: 200,
  maxProductIdLength: 100,
});

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export interface Product {
  id: string;
  name: string;
  unitPriceCents: number;
  inventory: number;
}

export interface OrderItem {
  productId: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
}

export interface CartView {
  id: string;
  status: 'open' | 'checked_out';
  items: OrderItem[];
  subtotalCents: number;
  orderId?: string;
}

export interface Order {
  id: string;
  cartId: string;
  items: OrderItem[];
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  couponCode?: string;
  createdAt: string;
}

export interface Coupon {
  code: string;
  milestoneOrderCount: number;
  discountPercent: number;
  status: 'available' | 'redeemed';
  orderId?: string;
}

export interface Report {
  totalOrders: number;
  purchasedQuantities: { productId: string; quantity: number }[];
  grossRevenueCents: number;
  totalDiscountCents: number;
  netRevenueCents: number;
  coupons: { generated: number; available: number; redeemed: number };
}

export interface StoreConfig {
  milestoneEvery: number;
  discountPercent: number;
}

export interface StoreOptions {
  products?: Product[];
  milestoneEvery?: number;
  discountPercent?: number;
}

export interface CheckoutInput {
  idempotencyKey: string;
  couponCode?: string;
}

export interface CheckoutResult {
  order: Order;
  replayed: boolean;
}

export interface ProductPatch {
  unitPriceCents?: number;
  inventory?: number;
}

export interface Store {
  getConfig(): StoreConfig;
  listProducts(): Product[];
  createCart(): CartView;
  getCart(cartId: string): CartView;
  addItem(cartId: string, productId: string, quantity: number): CartView;
  updateItem(cartId: string, productId: string, quantity: number): CartView;
  removeItem(cartId: string, productId: string): CartView;
  checkout(cartId: string, input: CheckoutInput): CheckoutResult;
  getOrder(orderId: string): Order;
  listOrders(): Order[];
  generateCoupon(): Coupon;
  listCoupons(): Coupon[];
  report(): Report;
  updateProduct(productId: string, patch: ProductPatch): Product;
}

const DEFAULT_PRODUCTS: Product[] = [
  { id: 'keyboard', name: 'Mechanical keyboard', unitPriceCents: 5999, inventory: 20 },
  { id: 'mouse', name: 'Wireless mouse', unitPriceCents: 2499, inventory: 30 },
  { id: 'monitor', name: 'Desktop monitor', unitPriceCents: 18999, inventory: 10 },
  { id: 'headphones', name: 'Studio headphones', unitPriceCents: 7999, inventory: 15 },
  { id: 'limited-controller', name: 'Limited edition controller', unitPriceCents: 6499, inventory: 1 },
];

function fail(status: number, code: string, message: string): never {
  throw new ApiError(status, code, message);
}

function assertInteger(
  value: unknown,
  min: number,
  max: number,
  label: string,
  code = 'INVALID_INPUT',
): asserts value is number {
  const valid = typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
  if (!valid) fail(422, code, `${label} must be an integer between ${min} and ${max}.`);
}

function assertText(value: unknown, label: string, max: number = LIMITS.maxTextLength): asserts value is string {
  const valid = typeof value === 'string' && value.trim().length > 0 && value.length <= max;
  if (!valid) fail(400, 'INVALID_INPUT', `${label} must be a nonempty string of at most ${max} characters.`);
}

/** All money arithmetic funnels through here, so an overflow is a 422 rather than a silent approximation. */
function toBoundedNumber(value: bigint, max = Number.MAX_SAFE_INTEGER): number {
  if (value > BigInt(max)) {
    fail(422, 'LIMIT_EXCEEDED', 'The operation exceeds the supported numeric limit.');
  }
  return Number(value);
}

function addBounded(left: number, right: number, max = Number.MAX_SAFE_INTEGER): number {
  return toBoundedNumber(BigInt(left) + BigInt(right), max);
}

/** Detaches returned state so callers cannot mutate what the store still owns. */
function detach<T>(value: T): T {
  return structuredClone(value);
}

function compareIds(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

export function createStore(options: StoreOptions = {}): Store {
  const milestoneEvery = options.milestoneEvery ?? 5;
  const discountPercent = options.discountPercent ?? 10;
  assertInteger(milestoneEvery, 1, Number.MAX_SAFE_INTEGER, 'milestoneEvery');
  assertInteger(discountPercent, 0, 100, 'discountPercent');

  const products = new Map<string, Product>();
  for (const product of options.products ?? DEFAULT_PRODUCTS) {
    assertText(product.id, 'Product ID', LIMITS.maxProductIdLength);
    assertText(product.name, 'Product name');
    assertInteger(product.unitPriceCents, 0, LIMITS.maxUnitPriceCents, 'unitPriceCents');
    assertInteger(product.inventory, 0, LIMITS.maxInventory, 'inventory');
    if (products.has(product.id)) fail(400, 'INVALID_INPUT', 'Product IDs must be unique.');
    products.set(product.id, detach(product));
  }

  /** Quantities only. Prices are resolved live from the catalog on every read. */
  interface Cart {
    id: string;
    items: Map<string, number>;
    orderId?: string;
  }

  const carts = new Map<string, Cart>();
  const orders = new Map<string, Order>();
  const coupons = new Map<string, Coupon>();

  /** Successful checkouts only. The cart and coupon are kept so a retry with a different payload is rejected. */
  const successfulCheckouts = new Map<string, { cartId: string; couponCode?: string; orderId: string }>();

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

  function openCartById(id: string): Cart {
    const cart = cartById(id);
    if (cart.orderId) fail(409, 'CART_CLOSED', 'This cart has already been checked out.');
    return cart;
  }

  function orderById(id: string): Order {
    const order = orders.get(id);
    if (!order) fail(404, 'ORDER_NOT_FOUND', 'Order not found.');
    return order;
  }

  /** `proposedProduct` prices a cart against a pending price change without applying it to the catalog. */
  function priceItems(
    items: Map<string, number>,
    proposedProduct?: Product,
  ): { items: OrderItem[]; subtotalCents: number } {
    let subtotalCents = 0;
    const priced = [...items].map(([productId, quantity]) => {
      const product = proposedProduct?.id === productId ? proposedProduct : productById(productId);
      const lineTotalCents = toBoundedNumber(
        BigInt(product.unitPriceCents) * BigInt(quantity),
        LIMITS.maxCartTotalCents,
      );
      subtotalCents = addBounded(subtotalCents, lineTotalCents, LIMITS.maxCartTotalCents);
      return {
        productId,
        name: product.name,
        quantity,
        unitPriceCents: product.unitPriceCents,
        lineTotalCents,
      };
    });
    return { items: priced, subtotalCents };
  }

  function viewCart(cart: Cart): CartView {
    if (cart.orderId) {
      const order = orderById(cart.orderId);
      return detach({
        id: cart.id,
        status: 'checked_out',
        items: order.items,
        subtotalCents: order.subtotalCents,
        orderId: order.id,
      });
    }
    return { id: cart.id, status: 'open', ...priceItems(cart.items) };
  }

  /** Prices the proposed basket before assigning it, so a rejected edit leaves the cart untouched. */
  function commitItems(cart: Cart, nextItems: Map<string, number>): CartView {
    const priced = priceItems(nextItems);
    cart.items = nextItems;
    return { id: cart.id, status: 'open', ...priced };
  }

  function setQuantity(
    cartId: string,
    productId: string,
    quantity: number,
    mode: 'add' | 'replace',
  ): CartView {
    assertInteger(quantity, 1, LIMITS.maxItemQuantity, 'quantity', 'INVALID_QUANTITY');
    const cart = openCartById(cartId);
    productById(productId);
    const existing = cart.items.get(productId);
    if (mode === 'replace' && existing === undefined) {
      fail(404, 'ITEM_NOT_FOUND', 'Product is not in this cart.');
    }
    const nextQuantity = mode === 'add' ? (existing ?? 0) + quantity : quantity;
    assertInteger(nextQuantity, 1, LIMITS.maxItemQuantity, 'quantity', 'INVALID_QUANTITY');
    const nextItems = new Map(cart.items);
    nextItems.set(productId, nextQuantity);
    return commitItems(cart, nextItems);
  }

  /** Half-up, once per order. For percent <= 100 the result never exceeds the subtotal, so totals stay non-negative. */
  function discountFor(subtotalCents: number, percent: number): number {
    return Number((BigInt(subtotalCents) * BigInt(percent) + 50n) / 100n);
  }

  function report(): Report {
    const purchased = new Map<string, number>();
    let grossRevenueCents = 0;
    let totalDiscountCents = 0;
    let netRevenueCents = 0;
    for (const order of orders.values()) {
      grossRevenueCents = addBounded(grossRevenueCents, order.subtotalCents);
      totalDiscountCents = addBounded(totalDiscountCents, order.discountCents);
      netRevenueCents = addBounded(netRevenueCents, order.totalCents);
      for (const item of order.items) {
        purchased.set(item.productId, addBounded(purchased.get(item.productId) ?? 0, item.quantity));
      }
    }
    const redeemed = [...coupons.values()].filter((coupon) => coupon.status === 'redeemed').length;
    return {
      totalOrders: orders.size,
      purchasedQuantities: [...purchased]
        .sort(([left], [right]) => compareIds(left, right))
        .map(([productId, quantity]) => ({ productId, quantity })),
      grossRevenueCents,
      totalDiscountCents,
      netRevenueCents,
      coupons: { generated: coupons.size, available: coupons.size - redeemed, redeemed },
    };
  }

  function normalizeCouponCode(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    assertText(value, 'couponCode');
    return value.trim().toUpperCase();
  }

  function checkout(cartId: string, input: CheckoutInput): CheckoutResult {
    const key = input.idempotencyKey;
    const validKey =
      typeof key === 'string' && key.trim().length > 0 && key.length <= LIMITS.maxTextLength;
    if (!validKey) {
      fail(
        400,
        'INVALID_IDEMPOTENCY_KEY',
        `Idempotency-Key must be a nonempty string of at most ${LIMITS.maxTextLength} characters.`,
      );
    }
    const couponCode = normalizeCouponCode(input.couponCode);

    // Resolved before any state check, so a retry returns its original order
    // instead of failing on the closed cart its own first attempt created.
    const previous = successfulCheckouts.get(key);
    if (previous) {
      if (previous.cartId !== cartId || previous.couponCode !== couponCode) {
        fail(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency-Key is already bound to a different checkout.');
      }
      return { order: detach(orderById(previous.orderId)), replayed: true };
    }

    // Validation: everything that can fail happens before the commit below.
    const cart = openCartById(cartId);
    if (cart.items.size === 0) fail(409, 'EMPTY_CART', 'Cannot check out an empty cart.');
    const priced = priceItems(cart.items);
    for (const item of priced.items) {
      if (productById(item.productId).inventory < item.quantity) {
        fail(409, 'INSUFFICIENT_STOCK', `Insufficient stock for product ${item.productId}.`);
      }
    }
    const coupon = couponCode === undefined ? undefined : coupons.get(couponCode);
    if (couponCode !== undefined && !coupon) fail(409, 'INVALID_COUPON', 'Coupon does not exist.');
    if (coupon?.status === 'redeemed') fail(409, 'COUPON_REDEEMED', 'Coupon has already been redeemed.');
    const discountCents = coupon ? discountFor(priced.subtotalCents, coupon.discountPercent) : 0;
    const order: Order = {
      id: randomUUID(),
      cartId,
      ...priced,
      discountCents,
      totalCents: priced.subtotalCents - discountCents,
      ...(couponCode === undefined ? {} : { couponCode }),
      createdAt: new Date().toISOString(),
    };

    // Commit. Overlapping requests serialize here only because nothing above
    // yields: adding an await anywhere in this function voids that guarantee.
    for (const item of priced.items) {
      productById(item.productId).inventory -= item.quantity;
    }
    orders.set(order.id, order);
    cart.orderId = order.id;
    if (coupon) {
      coupon.status = 'redeemed';
      coupon.orderId = order.id;
    }
    successfulCheckouts.set(key, { cartId, couponCode, orderId: order.id });
    return { order: detach(order), replayed: false };
  }

  /** Deriving the target from the coupon count holds only because coupons are never deleted. */
  function generateCoupon(): Coupon {
    const milestone = BigInt(coupons.size + 1) * BigInt(milestoneEvery);
    if (milestone > BigInt(orders.size)) {
      fail(409, 'NO_ELIGIBLE_MILESTONE', 'No unrewarded order milestone is eligible.');
    }
    const coupon: Coupon = {
      code: `REWARD-${milestone}-${randomUUID().toUpperCase()}`,
      milestoneOrderCount: Number(milestone),
      discountPercent,
      status: 'available',
    };
    coupons.set(coupon.code, coupon);
    return detach(coupon);
  }

  function updateProduct(productId: string, patch: ProductPatch): Product {
    const product = productById(productId);
    if (patch.unitPriceCents === undefined && patch.inventory === undefined) {
      fail(400, 'INVALID_INPUT', 'Specify unitPriceCents and/or inventory.');
    }
    if (patch.unitPriceCents !== undefined) {
      assertInteger(patch.unitPriceCents, 0, LIMITS.maxUnitPriceCents, 'unitPriceCents');
    }
    if (patch.inventory !== undefined) {
      assertInteger(patch.inventory, 0, LIMITS.maxInventory, 'inventory');
    }
    // Reject the whole patch if any open cart would overflow, rather than leaving
    // that cart unviewable and uneditable for its owner.
    if (patch.unitPriceCents !== undefined) {
      const proposed: Product = { ...product, unitPriceCents: patch.unitPriceCents };
      for (const cart of carts.values()) {
        if (!cart.orderId && cart.items.has(productId)) priceItems(cart.items, proposed);
      }
      product.unitPriceCents = patch.unitPriceCents;
    }
    if (patch.inventory !== undefined) product.inventory = patch.inventory;
    return detach(product);
  }

  return {
    getConfig: () => ({ milestoneEvery, discountPercent }),
    listProducts: () => detach([...products.values()]),
    createCart() {
      const cart: Cart = { id: randomUUID(), items: new Map() };
      carts.set(cart.id, cart);
      return viewCart(cart);
    },
    getCart: (cartId) => viewCart(cartById(cartId)),
    addItem: (cartId, productId, quantity) => setQuantity(cartId, productId, quantity, 'add'),
    updateItem: (cartId, productId, quantity) => setQuantity(cartId, productId, quantity, 'replace'),
    removeItem(cartId, productId) {
      const cart = openCartById(cartId);
      if (!cart.items.has(productId)) fail(404, 'ITEM_NOT_FOUND', 'Product is not in this cart.');
      const nextItems = new Map(cart.items);
      nextItems.delete(productId);
      return commitItems(cart, nextItems);
    },
    checkout,
    getOrder: (orderId) => detach(orderById(orderId)),
    listOrders: () => detach([...orders.values()]),
    generateCoupon,
    listCoupons: () => detach([...coupons.values()]),
    report,
    updateProduct,
  };
}
