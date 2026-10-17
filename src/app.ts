import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { createStore, DomainError } from './domain.ts';

export const MAX_BODY_BYTES = 16 * 1024;
type Store = ReturnType<typeof createStore>;
type Body = Record<string, unknown>;

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(value));
}

function readBody(request: IncomingMessage): Promise<Body> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let exceeded = false;
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        if (!exceeded) reject(new HttpError(413, 'BODY_TOO_LARGE', `Body must not exceed ${MAX_BODY_BYTES} bytes`));
        exceeded = true;
        chunks.length = 0;
      } else if (!exceeded) chunks.push(chunk);
    });
    request.once('error', reject);
    request.once('aborted', () => reject(new HttpError(400, 'INVALID_BODY', 'Request body was interrupted')));
    request.once('end', () => {
      if (exceeded) return;
      if (bytes === 0) return resolve({});
      const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
      if (contentType !== 'application/json') return reject(new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use Content-Type: application/json'));
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return reject(new HttpError(400, 'INVALID_JSON', 'Body must contain valid JSON')); }
      if (body === null || Array.isArray(body) || typeof body !== 'object') {
        return reject(new HttpError(400, 'INVALID_BODY', 'Body must be a JSON object'));
      }
      resolve(body as Body);
    });
  });
}

function fields(body: Body, allowed: string[]): void {
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new HttpError(400, 'INVALID_INPUT', `Allowed fields: ${allowed.join(', ') || 'none'}`);
  }
}

function stringField(body: Body, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 200) {
    throw new HttpError(400, 'INVALID_INPUT', `${key} must be a nonempty string of at most 200 characters`);
  }
  return value;
}

function numberField(body: Body, key: string): number {
  const value = body[key];
  if (typeof value !== 'number') throw new HttpError(400, 'INVALID_INPUT', `${key} must be a number`);
  return value;
}

function idempotencyKey(request: IncomingMessage): string {
  const occurrences = request.rawHeaders.filter((_, index) => index % 2 === 0)
    .filter((name) => name.toLowerCase() === 'idempotency-key').length;
  const value = request.headers['idempotency-key'];
  if (occurrences !== 1 || typeof value !== 'string' || value.trim().length === 0 || value.length > 200) {
    throw new HttpError(400, 'INVALID_IDEMPOTENCY_KEY', 'Provide one nonempty Idempotency-Key header of at most 200 characters');
  }
  return value;
}

function pathSegments(request: IncomingMessage): string[] {
  const pathname = (request.url ?? '/').split('?', 1)[0] ?? '/';
  if (!pathname.startsWith('/')) throw new HttpError(400, 'INVALID_PATH', 'Use an absolute request path');
  try {
    return pathname.slice(1).split('/').map((segment) => {
      const decoded = decodeURIComponent(segment);
      if (decoded.length > 200 || /[/\\\u0000-\u001f\u007f]/u.test(decoded)) throw new Error('Invalid segment');
      return decoded;
    });
  } catch { throw new HttpError(400, 'INVALID_PATH', 'Path contains an invalid identifier or encoding'); }
}

/** Each application gets independent state unless a store is supplied. */
export function createApp(store: Store = createStore()): RequestListener {
  return (request, response) => {
    void handle(request, response, store).catch((error: unknown) => {
      request.resume();
      if (response.destroyed || response.headersSent) return;
      if (error instanceof DomainError || error instanceof HttpError) {
        send(response, error.status, { error: { code: error.code, message: error.message } });
      } else send(response, 500, { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } });
    });
  };
}

async function handle(request: IncomingMessage, response: ServerResponse, store: Store): Promise<void> {
  const path = pathSegments(request);
  const route = path.join('/');
  let methods: string[];
  let action: () => Promise<void> | void;
  const method = request.method;
  const cartId = path[1] ?? '';
  const productId = path[3] ?? '';

  if (route === 'health') {
    methods = ['GET'];
    action = () => send(response, 200, { status: 'ok', service: 'checkout-rewards' });
  } else if (route === 'products') {
    methods = ['GET'];
    action = () => send(response, 200, store.listProducts());
  } else if (route === 'carts') {
    methods = ['POST'];
    action = async () => { fields(await readBody(request), []); send(response, 201, store.createCart()); };
  } else if (path.length === 2 && path[0] === 'carts' && cartId) {
    methods = ['GET'];
    action = () => send(response, 200, store.getCart(cartId));
  } else if (path.length === 3 && path[0] === 'carts' && cartId && path[2] === 'items') {
    methods = ['POST'];
    action = async () => {
      const body = await readBody(request); fields(body, ['productId', 'quantity']);
      send(response, 200, store.addItem(cartId, stringField(body, 'productId'), numberField(body, 'quantity')));
    };
  } else if (path.length === 4 && path[0] === 'carts' && cartId && path[2] === 'items' && productId) {
    methods = ['PATCH', 'DELETE'];
    action = async () => {
      const body = await readBody(request);
      if (method === 'DELETE') { fields(body, []); send(response, 200, store.removeItem(cartId, productId)); }
      else { fields(body, ['quantity']); send(response, 200, store.updateItem(cartId, productId, numberField(body, 'quantity'))); }
    };
  } else if (path.length === 3 && path[0] === 'carts' && cartId && path[2] === 'checkout') {
    methods = ['POST'];
    action = async () => {
      const key = idempotencyKey(request);
      const body = await readBody(request); fields(body, ['couponCode']);
      const couponCode = Object.hasOwn(body, 'couponCode') ? stringField(body, 'couponCode') : undefined;
      const result = store.checkout(cartId, { idempotencyKey: key, couponCode });
      send(response, result.replayed ? 200 : 201, result);
    };
  } else if (path.length === 2 && path[0] === 'orders' && cartId) {
    methods = ['GET'];
    action = () => send(response, 200, store.getOrder(cartId));
  } else if (route === 'admin/coupons') {
    methods = ['GET', 'POST'];
    action = async () => {
      if (method === 'GET') send(response, 200, store.listCoupons());
      else { fields(await readBody(request), []); send(response, 201, store.generateCoupon()); }
    };
  } else if (route === 'admin/orders') {
    methods = ['GET'];
    action = () => send(response, 200, store.listOrders());
  } else if (route === 'admin/reports') {
    methods = ['GET'];
    action = () => send(response, 200, store.report());
  } else if (path.length === 3 && path[0] === 'admin' && path[1] === 'products' && path[2]) {
    methods = ['PATCH'];
    action = async () => {
      const body = await readBody(request); fields(body, ['unitPriceCents', 'inventory']);
      const patch: { unitPriceCents?: number; inventory?: number } = {};
      if (Object.hasOwn(body, 'unitPriceCents')) patch.unitPriceCents = numberField(body, 'unitPriceCents');
      if (Object.hasOwn(body, 'inventory')) patch.inventory = numberField(body, 'inventory');
      send(response, 200, store.updateProduct(path[2]!, patch));
    };
  } else throw new HttpError(404, 'NOT_FOUND', 'Route not found');

  if (!methods.includes(method ?? '')) {
    response.setHeader('allow', methods.join(', '));
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed for this route');
  }
  if (method === 'GET') request.resume();
  await action();
}
