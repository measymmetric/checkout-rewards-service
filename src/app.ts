import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { ApiError, createStore, LIMITS } from './domain.ts';
import type { ProductPatch, Store } from './domain.ts';

export const MAX_BODY_BYTES = 16 * 1024;

type Body = Record<string, unknown>;

interface RequestContext {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly store: Store;
  readonly params: Readonly<Record<string, string>>;
}

type Handler = (context: RequestContext) => Promise<void> | void;

interface Route {
  /** A segment beginning with `:` captures into `params`. The handler keys drive the 405 `Allow` header. */
  readonly segments: readonly string[];
  readonly handlers: Readonly<Record<string, Handler>>;
}

/** The only files served from disk. No filesystem path is ever derived from client input. */
const assets = new Map([
  ['/', { file: new URL('../public/index.html', import.meta.url), type: 'text/html; charset=utf-8' }],
  ['/styles.css', { file: new URL('../public/styles.css', import.meta.url), type: 'text/css; charset=utf-8' }],
  ['/app.js', { file: new URL('../public/app.js', import.meta.url), type: 'text/javascript; charset=utf-8' }],
]);

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
        if (!exceeded) {
          reject(new ApiError(413, 'BODY_TOO_LARGE', `Body must not exceed ${MAX_BODY_BYTES} bytes`));
        }
        exceeded = true;
        chunks.length = 0;
      } else if (!exceeded) {
        chunks.push(chunk);
      }
    });
    request.once('error', reject);
    request.once('aborted', () => reject(new ApiError(400, 'INVALID_BODY', 'Request body was interrupted')));
    request.once('end', () => {
      if (exceeded) return;
      if (bytes === 0) return resolve({});
      const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
      if (contentType !== 'application/json') {
        return reject(new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use Content-Type: application/json'));
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return reject(new ApiError(400, 'INVALID_JSON', 'Body must contain valid JSON'));
      }
      if (body === null || Array.isArray(body) || typeof body !== 'object') {
        return reject(new ApiError(400, 'INVALID_BODY', 'Body must be a JSON object'));
      }
      resolve(body as Body);
    });
  });
}

/** Unknown fields are rejected so a client typo fails loudly instead of silently. */
function assertOnlyFields(body: Body, allowed: string[]): void {
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new ApiError(400, 'INVALID_INPUT', `Allowed fields: ${allowed.join(', ') || 'none'}`);
  }
}

async function bodyWithFields(request: IncomingMessage, allowed: string[]): Promise<Body> {
  const body = await readBody(request);
  assertOnlyFields(body, allowed);
  return body;
}

function stringField(body: Body, key: string): string {
  const value = body[key];
  const valid =
    typeof value === 'string' && value.trim().length > 0 && value.length <= LIMITS.maxTextLength;
  if (!valid) {
    throw new ApiError(
      400,
      'INVALID_INPUT',
      `${key} must be a nonempty string of at most ${LIMITS.maxTextLength} characters`,
    );
  }
  return value;
}

/** Type only. Range and integrality belong to the domain, which reports those as 422. */
function numberField(body: Body, key: string): number {
  const value = body[key];
  if (typeof value !== 'number') throw new ApiError(400, 'INVALID_INPUT', `${key} must be a number`);
  return value;
}

/** Exactly one header: Node joins duplicates into one comma-separated value, which would read as a third key. */
function idempotencyKey(request: IncomingMessage): string {
  const occurrences = request.rawHeaders
    .filter((_, index) => index % 2 === 0)
    .filter((name) => name.toLowerCase() === 'idempotency-key').length;
  const value = request.headers['idempotency-key'];
  const valid =
    occurrences === 1 &&
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= LIMITS.maxTextLength;
  if (!valid) {
    throw new ApiError(
      400,
      'INVALID_IDEMPOTENCY_KEY',
      `Provide one nonempty Idempotency-Key header of at most ${LIMITS.maxTextLength} characters`,
    );
  }
  return value as string;
}

function requestPath(request: IncomingMessage): string {
  return (request.url ?? '/').split('?', 1)[0] ?? '/';
}

/** Control characters, plus the separators that would re-introduce path structure after decoding (`%2F`, `%5C`). */
const INVALID_SEGMENT = /[\p{Cc}/\\]/u;

function pathSegments(request: IncomingMessage): string[] {
  const pathname = requestPath(request);
  if (!pathname.startsWith('/')) throw new ApiError(400, 'INVALID_PATH', 'Use an absolute request path');
  try {
    return pathname
      .slice(1)
      .split('/')
      .map((segment) => {
        const decoded = decodeURIComponent(segment);
        if (decoded.length > LIMITS.maxTextLength || INVALID_SEGMENT.test(decoded)) {
          throw new Error('Invalid segment');
        }
        return decoded;
      });
  } catch {
    throw new ApiError(400, 'INVALID_PATH', 'Path contains an invalid identifier or encoding');
  }
}

const routes: Route[] = [
  {
    segments: ['health'],
    handlers: {
      GET: ({ response }) => send(response, 200, { status: 'ok', service: 'checkout-rewards' }),
    },
  },
  {
    segments: ['config'],
    handlers: {
      GET: ({ response, store }) => send(response, 200, store.getConfig()),
    },
  },
  {
    segments: ['products'],
    handlers: {
      GET: ({ response, store }) => send(response, 200, store.listProducts()),
    },
  },
  {
    segments: ['carts'],
    handlers: {
      POST: async ({ request, response, store }) => {
        await bodyWithFields(request, []);
        send(response, 201, store.createCart());
      },
    },
  },
  {
    segments: ['carts', ':cartId'],
    handlers: {
      GET: ({ response, store, params }) => send(response, 200, store.getCart(params.cartId!)),
    },
  },
  {
    segments: ['carts', ':cartId', 'items'],
    handlers: {
      POST: async ({ request, response, store, params }) => {
        const body = await bodyWithFields(request, ['productId', 'quantity']);
        const view = store.addItem(
          params.cartId!,
          stringField(body, 'productId'),
          numberField(body, 'quantity'),
        );
        send(response, 200, view);
      },
    },
  },
  {
    segments: ['carts', ':cartId', 'items', ':productId'],
    handlers: {
      PATCH: async ({ request, response, store, params }) => {
        const body = await bodyWithFields(request, ['quantity']);
        const view = store.updateItem(params.cartId!, params.productId!, numberField(body, 'quantity'));
        send(response, 200, view);
      },
      DELETE: async ({ request, response, store, params }) => {
        await bodyWithFields(request, []);
        send(response, 200, store.removeItem(params.cartId!, params.productId!));
      },
    },
  },
  {
    segments: ['carts', ':cartId', 'checkout'],
    handlers: {
      POST: async ({ request, response, store, params }) => {
        const key = idempotencyKey(request);
        const body = await bodyWithFields(request, ['couponCode']);
        const couponCode = Object.hasOwn(body, 'couponCode') ? stringField(body, 'couponCode') : undefined;
        const result = store.checkout(params.cartId!, { idempotencyKey: key, couponCode });
        send(response, result.replayed ? 200 : 201, result);
      },
    },
  },
  {
    segments: ['orders', ':orderId'],
    handlers: {
      GET: ({ response, store, params }) => send(response, 200, store.getOrder(params.orderId!)),
    },
  },
  {
    segments: ['admin', 'coupons'],
    handlers: {
      GET: ({ response, store }) => send(response, 200, store.listCoupons()),
      POST: async ({ request, response, store }) => {
        await bodyWithFields(request, []);
        send(response, 201, store.generateCoupon());
      },
    },
  },
  {
    segments: ['admin', 'orders'],
    handlers: {
      GET: ({ response, store }) => send(response, 200, store.listOrders()),
    },
  },
  {
    segments: ['admin', 'reports'],
    handlers: {
      GET: ({ response, store }) => send(response, 200, store.report()),
    },
  },
  {
    segments: ['admin', 'products', ':productId'],
    handlers: {
      PATCH: async ({ request, response, store, params }) => {
        const body = await bodyWithFields(request, ['unitPriceCents', 'inventory']);
        const patch: ProductPatch = {};
        if (Object.hasOwn(body, 'unitPriceCents')) patch.unitPriceCents = numberField(body, 'unitPriceCents');
        if (Object.hasOwn(body, 'inventory')) patch.inventory = numberField(body, 'inventory');
        send(response, 200, store.updateProduct(params.productId!, patch));
      },
    },
  },
];

function matchRoute(segments: string[]): { route: Route; params: Record<string, string> } | undefined {
  for (const route of routes) {
    if (route.segments.length !== segments.length) continue;
    const params: Record<string, string> = {};
    const matched = route.segments.every((template, index) => {
      const actual = segments[index] ?? '';
      if (!template.startsWith(':')) return template === actual;
      if (actual.length === 0) return false;
      params[template.slice(1)] = actual;
      return true;
    });
    if (matched) return { route, params };
  }
  return undefined;
}

function assertMethodAllowed(request: IncomingMessage, response: ServerResponse, allowed: string[]): void {
  if (allowed.includes(request.method ?? '')) return;
  response.setHeader('allow', allowed.join(', '));
  throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed for this route');
}

async function handle(request: IncomingMessage, response: ServerResponse, store: Store): Promise<void> {
  // Decoded first, so a bad encoding fails before reaching the asset map or route table.
  const segments = pathSegments(request);

  const asset = assets.get(requestPath(request));
  if (asset) {
    assertMethodAllowed(request, response, ['GET']);
    request.resume();
    const content = await readFile(asset.file);
    response.writeHead(200, {
      'content-type': asset.type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    response.end(content);
    return;
  }

  const match = matchRoute(segments);
  if (!match) throw new ApiError(404, 'NOT_FOUND', 'Route not found');

  const allowed = Object.keys(match.route.handlers);
  assertMethodAllowed(request, response, allowed);
  if (request.method === 'GET') request.resume();
  await match.route.handlers[request.method!]!({ request, response, store, params: match.params });
}

/** Each application gets independent state unless a store is supplied. */
export function createApp(store: Store = createStore()): RequestListener {
  return (request, response) => {
    void handle(request, response, store).catch((error: unknown) => {
      request.resume();
      if (response.destroyed || response.headersSent) return;
      if (error instanceof ApiError) {
        send(response, error.status, { error: { code: error.code, message: error.message } });
      } else {
        send(response, 500, { error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } });
      }
    });
  };
}
