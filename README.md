# Checkout and rewards service

A backend for an ecommerce store. Editable carts over a limited inventory,
immutable orders, checkout that is safe to retry and safe to run concurrently,
milestone discount coupons, and an admin report that reconciles with both.

TypeScript on Node.js, no runtime dependencies, no external services. State lives
in memory, which is a deliberate choice with consequences.
[DECISIONS.md](DECISIONS.md) covers the invariants, the trade-offs, the
concurrency argument and how this would change for a real deployment.

## Setup

Needs Node.js 24.12 or later. Node runs the TypeScript directly, so there is no
build step.

```sh
npm ci
npm run check   # typecheck plus 29 tests, about 2 seconds
npm start       # http://127.0.0.1:3000
```

`npm run check` runs the domain suite and an HTTP integration suite that starts
real servers on ephemeral ports. Neither needs a running service.
`npm run test:domain` and `npm run test:http` run them separately. `npm run dev`
restarts on edit.

Opening <http://127.0.0.1:3000> serves a small page for driving checkout, retries
and coupons by hand. It is there to make the behaviour easy to see. The API below
is the actual deliverable.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | 1 to 65535 |
| `HOST` | `127.0.0.1` | `localhost` or an IP address |
| `MILESTONE_EVERY` | `5` | `n`, so a coupon becomes available every `n`th order |
| `DISCOUNT_PERCENT` | `10` | `x`, the discount percentage, 0 to 100 |

Bad settings fail at startup rather than at the first request. To watch the
reward flow without placing five orders:

```sh
MILESTONE_EVERY=1 npm start
```

```powershell
$env:MILESTONE_EVERY = '1'; npm start
```

### Seed data

Every process starts with empty carts, orders and coupons, plus these five
products. Prices are integer cents in one assumed currency.

| ID | Name | Price | Stock |
| --- | --- | --- | --- |
| `keyboard` | Mechanical keyboard | 5999 | 20 |
| `mouse` | Wireless mouse | 2499 | 30 |
| `monitor` | Desktop monitor | 18999 | 10 |
| `headphones` | Studio headphones | 7999 | 15 |
| `limited-controller` | Limited edition controller | 6499 | 1 |

Use `limited-controller` when you want to test oversell behaviour. It has one
unit.

State lives in one process and dies on restart, so run a single instance. Every
`/admin/*` route is administrative and unauthenticated, which the brief permits.
That is also why the service binds to loopback by default.

## Walkthrough: buy, retry, earn, redeem

```sh
base=http://127.0.0.1:3000

# 1. Create a cart and add an item.
cart=$(curl -s -X POST $base/carts | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')
curl -s -X POST $base/carts/$cart/items \
  -H 'Content-Type: application/json' \
  -d '{"productId":"keyboard","quantity":1}'

# 2. Check out. Returns 201 and {order, replayed:false}.
curl -s -X POST $base/carts/$cart/checkout -H 'Idempotency-Key: demo-1'

# 3. Send the identical request again. Returns 200, the same order,
#    replayed:true. No second order, no second stock decrement.
curl -s -X POST $base/carts/$cart/checkout -H 'Idempotency-Key: demo-1'

# 4. Once MILESTONE_EVERY orders exist, an admin can claim the reward.
curl -s -X POST $base/admin/coupons

# 5. Supply the returned code on a fresh cart's checkout, with a new key.
curl -s -X POST $base/carts/$next/checkout \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: demo-2' \
  -d '{"couponCode":"REWARD-5-..."}'

curl -s $base/admin/reports
```

Worth trying deliberately:

- Reuse `demo-1` on a different cart. You get `409 IDEMPOTENCY_CONFLICT`.
- Use a new key on the cart from step 3. You get `409 CART_CLOSED`.
- Redeem the same coupon twice. The second attempt gets `409 COUPON_REDEEMED`.
- Claim a coupon before the milestone. You get `409 NO_ELIGIBLE_MILESTONE`.
- Buy two `limited-controller` units from two carts. One succeeds, the other gets
  `409 INSUFFICIENT_STOCK`, and the loser's cart stays open and retryable.

A failed checkout never consumes its idempotency key, so a client can fix the
problem and retry with the same one.

## API

Everything returns JSON. Send `Content-Type: application/json` with any non-empty
body. Empty bodies are fine where no field is required. Unknown fields are
rejected. Bodies are capped at 16 KiB. Use exact paths, no trailing slashes.

### Customer

| Method | Path | Body | Success | Notes |
| --- | --- | --- | --- | --- |
| `GET` | `/health` | none | 200 | `{status, service}` |
| `GET` | `/config` | none | 200 | `{milestoneEvery, discountPercent}` |
| `GET` | `/products` | none | 200 | `Product[]` |
| `POST` | `/carts` | none or `{}` | 201 | `CartView` |
| `GET` | `/carts/:cartId` | none | 200 | `CartView` |
| `POST` | `/carts/:cartId/items` | `{productId, quantity}` | 200 | Increments that product's quantity |
| `PATCH` | `/carts/:cartId/items/:productId` | `{quantity}` | 200 | Replaces the quantity. The line must already exist |
| `DELETE` | `/carts/:cartId/items/:productId` | none or `{}` | 200 | Removes the line. Use this instead of quantity 0 |
| `POST` | `/carts/:cartId/checkout` | none, `{}`, or `{couponCode}` | 201 or 200 | Needs exactly one `Idempotency-Key` header. 201 on first success, 200 on replay |
| `GET` | `/orders/:orderId` | none | 200 | `Order` |

### Administrative

| Method | Path | Body | Success | Notes |
| --- | --- | --- | --- | --- |
| `POST` | `/admin/coupons` | none or `{}` | 201 | Issues the oldest unrewarded eligible milestone, otherwise 409 |
| `GET` | `/admin/coupons` | none | 200 | `Coupon[]` |
| `GET` | `/admin/orders` | none | 200 | `Order[]` |
| `GET` | `/admin/reports` | none | 200 | `Report` |
| `PATCH` | `/admin/products/:productId` | `{unitPriceCents?, inventory?}` | 200 | At least one field. `inventory` replaces rather than adjusts |

### Schemas

`CartView` has `id`, `status` of either `open` or `checked_out`, `items`,
`subtotalCents`, and `orderId` once checked out. Each item carries `productId`,
`name`, `quantity`, `unitPriceCents` and `lineTotalCents`.

An open cart prices at current catalog values and reserves no stock, so its total
can change and its quantities may exceed what is actually available until
checkout. A checked-out cart shows the order's historical prices instead.

`Order` has `id`, `cartId`, `items`, `subtotalCents`, `discountCents`,
`totalCents`, an optional `couponCode`, and an ISO-8601 `createdAt`. The items
are snapshots. Later price changes cannot alter a stored order, and neither can
mutating an object the API returned.

`Coupon` has `code`, `milestoneOrderCount`, `discountPercent`, `status` of either
`available` or `redeemed`, and `orderId` once redeemed. Coupons are global, never
expire, allow one per checkout and one redemption each. Codes are trimmed and
upper-cased before lookup, so case and surrounding whitespace affect neither
redemption nor retry matching. Every successful order counts toward a milestone,
discounted and zero-total ones included.

`Report` has `totalOrders`, `purchasedQuantities` as `{productId, quantity}`
sorted by id and listing only purchased products, `grossRevenueCents`,
`totalDiscountCents`, `netRevenueCents`, and `coupons` as
`{generated, available, redeemed}`. Gross minus discounts equals net. The report
is recomputed from stored orders and coupons on every request, so it cannot drift
from them, and reading it changes nothing.

## Errors

```json
{ "error": { "code": "INSUFFICIENT_STOCK", "message": "..." } }
```

Branch on `code`. Treat `message` as explanation only.

| Status | Codes |
| --- | --- |
| 400 | `INVALID_INPUT`, `INVALID_IDEMPOTENCY_KEY`, `INVALID_JSON`, `INVALID_BODY`, `INVALID_PATH` |
| 404 | `PRODUCT_NOT_FOUND`, `CART_NOT_FOUND`, `ORDER_NOT_FOUND`, `ITEM_NOT_FOUND`, `NOT_FOUND` |
| 405 | `METHOD_NOT_ALLOWED`, with an `Allow` header |
| 409 | `CART_CLOSED`, `EMPTY_CART`, `INSUFFICIENT_STOCK`, `INVALID_COUPON`, `COUPON_REDEEMED`, `IDEMPOTENCY_CONFLICT`, `NO_ELIGIBLE_MILESTONE` |
| 413 | `BODY_TOO_LARGE` |
| 415 | `UNSUPPORTED_MEDIA_TYPE` |
| 422 | `INVALID_QUANTITY`, `INVALID_INPUT` for out-of-range values, `LIMIT_EXCEEDED` |
| 500 | `INTERNAL_ERROR`, with no internal detail exposed |

400 means the request was malformed, so a wrong JSON type, an unknown field or a
bad path. 422 means it parsed fine but the value is out of range. 409 means it
was valid but conflicts with current state, and that is the family worth
retrying after you change something.

### Numeric bounds

Unit price runs 0 to 1,000,000,000 cents. Stock runs 0 to 1,000,000. Quantity per
cart line runs 1 to 1,000,000. A cart or order subtotal tops out at
1,000,000,000,000 cents. Breaching any of those gives `422 LIMIT_EXCEEDED`.
Fractions, negatives, unsafe integers and numeric strings are all rejected.

Discounts are computed in BigInt as `(subtotalCents * percent + 50) / 100`,
truncated. That is half-up to the cent, applied once to the subtotal rather than
per line. Since `percent` never exceeds 100, the discount never exceeds the
subtotal, so a total cannot go negative. 11998 cents at 10% gives 1200.

Idempotency keys are opaque non-blank strings of at most 200 characters, scoped
globally. Retry with the same key and the same coupon input. A mismatch gives
`IDEMPOTENCY_CONFLICT`.

## Tests

```sh
npm run check
```

The domain suite covers rounding, snapshot immutability, atomic rejection of bad
edits and admin patches, milestone allocation and the error contract. The HTTP
suite drives a real server with genuinely overlapping requests:

- 24 simultaneous identical checkouts produce one order and 23 replays.
- Two buyers racing for one unit leave one winner, stock at 0, and the loser
  still able to retry.
- Two carts racing one coupon produce one redemption, with the loser untouched.
- Three overlapping admin coupon requests over four orders at `n = 2` produce two
  coupons and one 409.

Each asserts the resulting inventory, coupons, cart states and report totals, not
just the status codes.

## Scope

No payments, shipping, tax, authentication, persistence or multi-instance
coordination. A successful checkout counts as payment success. Those choices, the
invariants behind them, and what I would do next are in
[DECISIONS.md](DECISIONS.md).
