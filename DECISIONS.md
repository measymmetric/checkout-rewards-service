# Design decisions

The endpoints here are not the hard part. What makes this interesting is what
happens when two requests collide, or when one request arrives twice because a
client gave up waiting and retried. This document records the invariants I chose
to protect, the semantics I picked where the brief left room, and what I traded
away to finish inside the timebox.

The service is a single Node process holding state in memory, with no runtime
dependencies. `src/domain.ts` owns every business rule. `src/app.ts` is transport
only. That split is what lets me make a concurrency argument you can actually
check.

## Invariants

These are the properties I believe hold at every observable point, and the code
that enforces each one. References are to `src/domain.ts` unless noted.

| Invariant | Enforced by |
| --- | --- |
| Inventory never goes below zero. | `checkout()` checks every line against current stock, then decrements inside the commit block. Cart edits reserve nothing. |
| A cart produces at most one order. | `openCartById()` rejects a cart that already has an `orderId`. The commit block sets it. |
| Retrying a successful checkout returns the original order and charges nothing again. | `successfulCheckouts` is the first thing `checkout()` consults, before any state check. |
| A retry key is bound to one cart and one normalized coupon. | The replay record stores both and compares them. A mismatch raises `IDEMPOTENCY_CONFLICT`. |
| A coupon belongs to one milestone, is generated once, and is redeemed at most once. | `generateCoupon()` derives its target from the coupon count. `checkout()` rejects a redeemed coupon before committing. |
| A failed checkout changes no inventory, coupon, order, cart status or replay record. | Every `fail()` in `checkout()` happens before the commit block. There is no rollback path because there is nothing to roll back. |
| Orders keep the names, quantities and prices that applied at purchase. | Order items are snapshots, and `detach()` deep-clones everything the store hands back. |
| Returned data cannot mutate stored state. | `detach()` at every read boundary. `test/domain.test.ts` proves it by mutating returned objects and re-reading. |
| Money is always exact integer cents, and a total is never negative. | All arithmetic runs through `toBoundedNumber()` and `addBounded()`. `discountFor()` cannot exceed the subtotal. |
| Reports reconcile with orders and coupons, and reading one changes nothing. | `report()` recomputes from stored orders and coupons and writes nothing. |

Two of those depend on `checkout()` running start to finish without yielding, and
nothing in the type system enforces that. I call it out under *Concurrency* below
because it is the invariant I am most likely to break by accident.

## Ambiguities I had to resolve

The brief leaves several things open on purpose. Here is how I read them.

**Prices move under an open cart.** An open cart is a list of intentions, not a
quote. It prices at current catalog values every time you look at it, and
checkout re-prices and re-checks stock. Freezing the price when an item is added
would need an expiry policy and a story for what the customer sees when it
lapses. That is a feature, not a detail, and it is not what this assignment is
testing.

**Carts do not reserve stock.** You can hold 50 of a product that has 1 in stock.
You lose at checkout. Reservations need a timeout and something to sweep up
abandoned carts.

**Every successful order counts toward a milestone**, including discounted ones
and zero-total ones. A failed checkout never counts.

**Coupons are global and unowned.** Anyone holding the code can use it. Scoping a
reward to the customer who earned it needs a customer identity the brief never
defines.

**One coupon per checkout, and no expiry.**

**Milestones drain oldest first.** With 12 orders, `n = 5` and no coupons yet,
the first admin request issues milestone 5, the second issues 10, the third is
refused. I did not want a reward to vanish because nobody called the endpoint in
time.

**A failed checkout leaves its key reusable.** Only successful checkouts bind a
key, so a client that lost on stock can fix the problem and retry with the same
one. The cost is that a failed key can later be reused with a different payload.

**Quantity zero is invalid.** Removal is `DELETE`. That keeps "change the
quantity" and "remove the line" as separate intents.

**A blank coupon code is a client error.** Omitting the field means no coupon.

## Decision: in-memory state behind a synchronous critical section

**Context:** Checkout has to be atomic across four pieces of state, namely
inventory, the cart, the order log and the coupon, while other requests are in
flight.

**Options considered:** A real database with one transaction per checkout. An
embedded store like SQLite. In-memory maps guarded by an async mutex. In-memory
maps with a domain API that is synchronous throughout.

**Choice:** In-memory maps, and not a single `async` anywhere in the domain.

**Why:** The brief allows in-memory state as long as the invariants survive
overlapping requests. Because every domain method is synchronous, Node runs each
one to completion before the next can start. The event loop is the lock. That
keeps the critical section small enough to read in one screen, and it means a
validation failure needs no compensating write, since `checkout()` finishes all
its checking before it touches anything. An async mutex would buy the same
guarantee with more moving parts and more ways to deadlock.

**Consequences:** State dies on restart, and the design is correct for exactly
one process. Report and checkout work grows with history. The part that worries
me most is that this shape cannot absorb an `await` inside checkout. Adding one
would quietly reintroduce interleaving, and no test would fail. The moment a real
payment call or a database round trip enters that path, this design has to go.

## Decision: idempotency recorded on success, fingerprinted by payload

**Context:** A client that times out will retry. The retry must not create a
second order, and it must not fail just because the cart is now closed.

**Options considered:** Lean on "a cart can only be checked out once". Record
every attempted key. Record successful keys together with a fingerprint of the
request.

**Choice:** The third. On success I store the key against the cart id, the
normalized coupon and the order id, and the lookup is the first thing
`checkout()` does.

**Why:** The closed-cart rule on its own hands the retrying client a 409 when it
has in fact earned an order, and the client never learns the first attempt
worked. Putting the replay lookup ahead of the closed-cart, stock and coupon
checks is the whole trick. The retry returns its original order instead of
tripping over state its own first attempt created. Storing the cart and coupon
alongside the key turns a key reused with a different payload into a loud
`IDEMPOTENCY_CONFLICT` rather than a quiet wrong answer. Recording failed
attempts too would have burned a key permanently over a transient stock problem.

**Consequences:** A fresh key against an already-checked-out cart still returns
`CART_CLOSED`, which is correct. A replay returns 200 where the original returned
201, so a client can tell the two apart. Records never expire, so the map grows
without bound. Fine for a single-process demo, not fine for production.

## Decision: live prices, no stock reservation

**Context:** The brief asks directly what happens when price or availability
changes between adding an item and checking out.

**Options considered:** Freeze the price at add time. Reserve stock with a TTL.
Price and check availability live.

**Choice:** Live for both, with the purchase snapshotted into the order.

**Why:** A frozen price is a promise, and a promise needs an expiry, a
renegotiation path, and something sensible to show the customer when it lapses. A
stock reservation needs a sweeper for abandoned carts. Both are real features,
and neither is what this assignment is testing. Live pricing keeps the
interesting correctness in one place, which is checkout, and the order snapshot
still satisfies the requirement that history survive catalog changes.

**Consequences:** A cart total can shift under the customer, which a real
storefront would surface in the UI. Overselling is impossible, but disappointment
is not, since you can fill a cart you cannot buy. Administrative price changes
have to keep existing carts readable, which is where the bug described under *How
I used AI* came from.

## Decision: coupons are generated explicitly, oldest milestone first

**Context:** The brief says an administrator requests generation, and that a
milestone yields a coupon only once.

**Options considered:** Issue automatically at checkout when the order count hits
a multiple of `n`. Issue only the newest eligible milestone on request. Drain
eligible milestones one per request, oldest first.

**Choice:** The third. `generateCoupon()` targets
`(couponCount + 1) * milestoneEvery` and refuses if that exceeds the order count.

**Why:** Issuing automatically at checkout would drag reward creation into the
checkout transaction and widen the critical section for no benefit, and the brief
asks for an administrator action anyway. Issuing only the newest milestone throws
away earned rewards when nobody calls the endpoint promptly. Deriving the target
from the coupon count instead of storing a flag per milestone keeps the state
minimal, and it is sound only because coupons are never deleted and
`milestoneEvery` is fixed for the life of the store. Change either of those and I
need a real milestone table.

**Consequences:** Each milestone yields exactly one coupon, and concurrent admin
requests serialize, so four orders at `n = 2` produce two coupons and one 409.
The derivation would break if `n` were reconfigurable at runtime, which I do not
support.

## Decision: integer cents with BigInt intermediates

**Context:** Money has to avoid floating-point error, and a percentage discount
has to be deterministic and never drive a total below zero.

**Options considered:** Floats with rounding at the edges. A decimal library.
Integer minor units with BigInt for the intermediate products.

**Choice:** Integer cents everywhere, BigInt for multiplication and summation,
narrowed back to `number` through one bounds-checked helper.

**Why:** The brief rules out floats. A decimal library is the right answer for
multi-currency money, but this arithmetic is genuinely integer, so it would be a
dependency bought for nothing. BigInt costs nothing at this scale and makes
overflow visible instead of silent, because `toBoundedNumber()` refuses anything
outside the exactly-representable range rather than returning an approximation.

The discount is `floor((subtotal * percent + 50) / 100)` in BigInt. Half-up,
applied once to the subtotal rather than per line, so the parts always sum to the
whole. Since `percent` never exceeds 100, that expression never exceeds the
subtotal, which is why a total cannot go negative. 11998 cents at 10% gives 1200,
not 1199.8.

**Consequences:** One assumed currency, no conversion, no sub-cent prices.
Percentages are integers from 0 to 100. No BigInt ever reaches JSON.

## Decision: reports recomputed from history, not kept as counters

**Context:** The report has to reconcile with the orders and coupons the API
returns, and repeated reads must not change anything.

**Options considered:** Running counters updated at checkout. Recompute by
walking stored orders and coupons.

**Choice:** Recompute.

**Why:** Six independently updated counters are six chances to drift, and drift
in a financial summary is the kind of bug a customer finds before you do.
Recomputing makes reconciliation structural. The report cannot disagree with the
orders it is derived from, which means the test asserting gross minus discounts
equals net against `/admin/orders` is checking something real.

**Consequences:** `GET /admin/reports` is O(orders). Fine here, wrong at scale.
Production wants aggregates maintained in the same transaction, or database-side
aggregation, with periodic reconciliation against the order log to catch the
exact drift this avoids. I pushed this idea too far at one point and had to walk
it back, which I describe below.

## Decision: native Node HTTP, no runtime dependencies

**Context:** Thirteen endpoints needing body parsing, validation and a stable
error contract.

**Options considered:** Express plus a validation library. A server generated
from an OpenAPI document. Native `node:http` with validation written out.

**Choice:** Native `node:http`, with a table of route templates.

**Why:** At this size a framework mostly buys middleware I would not use, and
charges a dependency tree I would have to vouch for. Writing it out keeps the
body-size cap, the media-type check and the unknown-field rejection visible
instead of configured. I rejected my own first attempt at this. It was a long
`if/else` chain that reassigned a handler variable per branch, it worked, and it
was unpleasant to extend. It had also leaked a variable named `cartId` into the
`/orders/:orderId` route. The route table derives the `Allow` header from each
route's handler keys, so a 405 cannot disagree with what the route actually
accepts.

**Consequences:** No request logging, CORS, rate limiting or auth. All out of
scope per the brief, and all things a framework would have handed me cheaply. Past
roughly twenty endpoints I would adopt one rather than keep growing this table.

## Concurrency, transactions and idempotency

The transaction boundary is `checkout()`, and it has two halves.

First it validates. Resolve the replay. Open the cart. Reject an empty one. Price
every line. Check stock on every line. Check the coupon exists and is unredeemed.
Compute the discount. Build the order object.

Then it commits. Decrement stock, store the order, close the cart, redeem the
coupon, record the replay key.

Nothing in the second half can fail, because everything that can fail lives in
the first. There is no `await`, no I/O and no caller-supplied callback anywhere in
either half, so one Node process cannot interleave two checkouts. Overlapping
HTTP requests queue at the event loop and each domain call runs to completion.

I tested this rather than asserting it. `test/http.test.ts` fires real concurrent
requests at a real server:

- 24 simultaneous identical checkouts produce one 201, twenty-three 200 replays,
  one order and one stock decrement.
- Two buyers racing for a single unit produce one 201 and one 409, stock 0, and
  the loser's cart still open and still retryable.
- Two carts racing one coupon produce one redemption, with the loser untouched.
- Three overlapping admin coupon requests against four orders at `n = 2` produce
  two 201s and one 409.

Each of those asserts the resulting inventory, coupons, carts and report, not
just the status codes.

The weakness is worth stating plainly. This guarantee is a property of the code's
shape, not of its types. A future `await` placed between validation and commit
would void it with every test still green, because the tests cannot manufacture a
yield point that does not exist in the code. In a durable version, the database
transaction is what replaces this argument.

## Error model

Failures always look like `{"error": {"code": "...", "message": "..."}}`. The
`code` is the contract. The `message` is prose and may change. Statuses go by
kind.

- **400** for a malformed request: wrong JSON type, unknown field, bad JSON, bad
  path, missing or duplicated `Idempotency-Key`.
- **404** when a named resource does not exist.
- **405** for the wrong method, always with an `Allow` header.
- **409** when the request was well formed but conflicts with current state.
  `CART_CLOSED`, `EMPTY_CART`, `INSUFFICIENT_STOCK`, `COUPON_REDEEMED`,
  `IDEMPOTENCY_CONFLICT`, `NO_ELIGIBLE_MILESTONE`.
- **413** and **415** for a body too large or not JSON.
- **422** when the value is well typed but out of range. `INVALID_QUANTITY`,
  `LIMIT_EXCEEDED`.
- **500** for anything unexpected, with no internal detail in the response.

Splitting 400 from 422 is deliberate. A client that sent `"2"` instead of `2` has
a different bug from one that sent `0`, and the first is worth distinguishing
because retrying will never fix it.

The call I am least sure about is returning 409 for `INVALID_COUPON` rather than
404. A coupon code is user-supplied data rather than a resource the client
addressed, and it sits in the same recovery path as `COUPON_REDEEMED`, so I kept
both in the conflict family. I would not argue hard against 404.

## What I implemented, and what I deferred

Implemented: products and inventory with five seeds, one of them down to a single
unit. Editable multi-product carts. Atomic checkout that is safe to retry.
Configurable single-use milestone coupons. Order history that survives catalog
changes. A reconciled admin report. A documented error contract with bounds on
every numeric field. Tests covering retries, contention and failure paths.

Deferred on purpose, roughly in the order I would add them: durable persistence
and a real transaction, authentication and resource ownership, a payment
abstraction with a pending-checkout state machine, coupon expiry and ownership
and abuse limits, pagination on the admin lists, expiry for replay records, and
observability.

Treating a successful checkout as payment success is a conscious simplification.
A fake async payment stage would have added failure modes without exercising
anything the brief asks about.

## How this changes for multiple instances and production scale

The event loop stops being a lock the moment a second process exists, so the
critical section has to move into the database.

One transaction per checkout. Lock the cart row and the affected product rows in
a deterministic order, by product id, so two carts with overlapping products
cannot deadlock. Re-check quantities inside the transaction. Write the order
snapshot before commit.

Then make the invariants the database's job rather than the application's. A
unique constraint on `cart_id` in orders. A unique constraint on the idempotency
key. A unique constraint on milestone number in coupons. A conditional update for
redemption, `WHERE status = 'available'`, so exactly one concurrent redeemer
wins. A request that loses one of those races should read the winning row and
return it as a replay, which is the same shape as today's in-memory replay path.

Replace the recomputed report with aggregates maintained in the same transaction,
plus a scheduled job that reconciles them against the order log.

A real payment provider needs more than that: a durable pending state,
provider-side idempotency keys, an outbox for post-payment side effects, and a
reconciliation job for payments whose response was lost. Inventory then needs a
reservation with a TTL, because money and stock no longer move together.

## How I used AI

I used AI assistance throughout. It drafted the first implementation, generated
test scaffolding, and acted as a reviewer looking for cases I had missed. It was
genuinely useful for volume. The HTTP body parser and most of the test fixtures
were faster to get right with help than from scratch.

What it was bad at was judgment about what deserved to exist at all. Three
corrections, in increasing order of how much they changed the submission.

**I rejected generated code that broke cart recovery.** The first version let an
administrative price rise push an open cart past the cart-total bound. I
reproduced it with three one-cent products at quantity 1,000 each, then repriced
to 1,000,000,000 cents. The cart could no longer be viewed, and every attempt to
reduce or remove a line failed too, because each of those paths re-prices the
whole cart first. The cart was unrecoverable through the API. The suggested fix
was to raise the limit. I rejected that as treating the symptom, and instead made
`updateProduct()` re-price every affected open cart against the proposed value
and refuse the entire patch if any would overflow. The failure now lands on the
administrator making the change, who can act on it, rather than on a customer who
cannot. The regression test is in `test/domain.test.ts`.

**I removed a guard I had been talked into.** The same instinct that produced
that bug also produced a lifetime-revenue overflow check that ran on every single
checkout. It called `report()`, walked all of history, and confirmed that
cumulative revenue would still fit in `Number.MAX_SAFE_INTEGER`. Line by line it
was defensible. As a whole it was wrong. It made checkout O(history), the only
non-linear thing in the system, to guard against roughly 90 trillion dollars of
cumulative revenue, and it needed a test that placed 9,007 maximal orders and ran
10.4 seconds, which was 98% of the suite. I deleted it. The bound still holds in
`report()`, which already walks every order, so it costs nothing there, and the
per-line and per-cart bounds still protect checkout itself. The suite went from
10.5 seconds to 1.5. This is the correction I would most want to be asked about,
because the code was not buggy. It was disproportionate, and that is much harder
to notice than a bug.

**I caught a generated feature that never worked at all.** The small demo page
called `GET /config` to show milestone progress. That route did not exist.
`getConfig()` had been added to the store interface and never wired up, so the
page's startup `Promise.all` rejected and it rendered nothing. The tests passed
the entire time, because they asserted that the three static files were served
with the right MIME type, not that the page could load its data. The real lesson
was about the test rather than the route, so I added one that walks the exact
endpoint set the page fetches at startup.

The pattern across all three is the same. The output was locally plausible and
globally unjustified, and the tests written alongside it confirmed what the code
did rather than what the system needed. I have read every line in `src/` and can
say why it is there.

## What I would look at first with another two hours

Move the transaction into a real database. SQLite would be enough to make the
point. Then re-run the existing contention tests against it unchanged, since they
drive HTTP rather than internals and should port directly. If they pass, the
concurrency story stops depending on the event loop. I would include killing the
process mid-checkout.

After that, make the critical section hard to break. The largest risk in this
codebase is someone adding an `await` to `checkout()`. At minimum I want a test
asserting the domain surface returns no promises, so the property is checked
rather than remembered.

Third, expiry for replay records, since an unbounded map is the clearest
production defect that is purely mine.

## Time spent

About 6 to 7 hours across two sittings. Design and implementation in the first,
then a review pass that produced the three corrections above, plus this document,
in the second.

That sits at or just past the suggested 4 to 6 hour window. The extra time went
almost entirely into the review pass, which is also where most of the value ended
up. Two of the three corrections removed code rather than adding it, and the
second one changed how I read the rest of the codebase.
