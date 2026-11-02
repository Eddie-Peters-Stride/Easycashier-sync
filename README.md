# EasyCashier–Shopify sync

This Gadget application synchronizes product information from Shopify to
EasyCashier and inventory changes from EasyCashier sales back to Shopify.

## Synchronization directions

| Data | Direction | Source of truth |
| --- | --- | --- |
| Product creation | Shopify → EasyCashier | Shopify |
| Product title, SKU, barcode, and price | Shopify → EasyCashier | Shopify |
| Product/variant deletion | Shopify → EasyCashier | Shopify |
| Available inventory | EasyCashier → Shopify | EasyCashier sales report |

Shopify product changes are received through Shopify webhooks. Slow or remote
work is placed in background queues so webhook processing can finish quickly.

## Product identity

A Shopify variant maps to one EasyCashier article:

- Shopify variant `sku` → EasyCashier `articleNumber`
- Shopify product `title` → EasyCashier `description`
- Shopify variant `barcode` → EasyCashier `barcode`
- Shopify variant `price` → EasyCashier `retailPriceIncludingVat`
- Shopify product ID → EasyCashier `webshopArticleId`

SKUs are therefore required and should be unique. Product and inventory syncs
match records by the exact, trimmed SKU.

## Product creation

Shopify `products/create` triggers
`api/models/shopifyProduct/actions/create.js`.

1. The Shopify product and all variants are read from the webhook payload.
2. If any variant has no SKU, creation of the entire product is skipped and a
   warning is logged.
3. `createProductSync` is queued in the single-concurrency `easycashier-api`
   queue.
4. Every unique variant SKU is searched in EasyCashier.
5. If the exact SKU already exists, it is left unchanged.
6. Otherwise, a separate EasyCashier article is created for the variant.

Duplicate SKUs inside the same webhook payload are processed only once.

The created EasyCashier article currently uses these important defaults:

- `articleType: "PRODUCT"`
- `accountNumber: 3051`
- `vat: 0.25`
- `webshop: true`
- `stockItem: false`
- cost and average cost are initially set to the Shopify variant price

## Product updates

Updates can originate from either the Shopify product or variant webhook
actions.

### Product-level changes

On `products/update`, the product action:

- detects variants that are new to Gadget and queues them for creation in
  EasyCashier;
- detects a changed Shopify product title and updates the EasyCashier
  `description` for every variant that has a SKU.

### Variant-level changes

The Shopify variant update action handles:

- `barcode` changes → EasyCashier `barcode`;
- `price` changes → EasyCashier `retailPriceIncludingVat`;
- assigning a SKU to a previously SKU-less variant → creates an EasyCashier
  article;
- removing a SKU → deletes the article using the previous SKU;
- changing a SKU → deletes the old EasyCashier article and creates a new one.

An SKU replacement requires exactly one variant and performs deletion before
creation.

### Safe EasyCashier lookup

Updates and deletes first look for an exact EasyCashier `articleNumber` match.
If no SKU matches, the code can fall back to an exact, case-insensitive Swedish
title match. `webshopArticleId` is used to narrow title matches when available.

An ambiguous title match is never selected. The operation is skipped and a
warning is logged instead of modifying the wrong EasyCashier article.

When updating an article, the existing EasyCashier object is loaded first and
only the intended fields are replaced. Other article configuration is
preserved.

## Product and variant deletion

Variant deletion is the operation that queues deletion from EasyCashier:

1. The variant SKU, product ID, and shop ID are captured before the Gadget
   record is deleted.
2. A background `deleteProductSync` action is queued.
3. The action finds the EasyCashier article using the safe lookup described
   above.
4. If found, it deletes the article by `articleNumber`.
5. Missing or ambiguous matches are logged and skipped safely.

A variant without a SKU cannot identify an EasyCashier article and is skipped.

The Shopify product delete action currently deletes the Gadget product record
but does not directly enqueue `deleteProductSync`; EasyCashier deletion is
implemented in the Shopify variant delete action.

## Inventory synchronization

Inventory synchronization runs in the opposite direction: EasyCashier sales
change Shopify inventory.

The public entry action is `syncInventoryFromEasycashier`. It queues
`processEasyCashierInventorySync` in the
`easycashier-api` queue with a maximum concurrency of one and two
retries.

The inventory scheduler in `syncInventoryFromEasycashier.js` is currently
commented out. Calling the action through the API works, but automatic
every-minute execution must be enabled explicitly.

### Sales report

The worker requests today's date in the `Europe/Stockholm` timezone and reads:

```text
GET /report/sales/groupedByArticleAndStore/preview
```

The report is fetched in pages of 50, up to 100 pages. Each usable row must
contain:

```js
{
  articleNumber: "variant-sku",
  storeNumber: "1",
  quantity: 2,
}
```

Rows without an article number or store number are ignored. Quantities must be
integers. The endpoint is expected to return at most one grouped row for each
article/store combination.

### Cumulative difference calculation

EasyCashier's report is treated as a cumulative total for the current day. The
application stores the last observed quantity for each SKU and store in the
variant's `easyCashierInventorySyncState` JSON field.

Only the difference since the previous successful sync is sent to Shopify:

```text
new EasyCashier sales = current report quantity - saved report quantity
Shopify inventory delta = -new EasyCashier sales
```

Examples:

| Saved report | Current report | Shopify delta | Meaning |
| ---: | ---: | ---: | --- |
| 0 | 2 | -2 | Two items sold |
| 2 | 2 | 0 | No new sales |
| 2 | 5 | -3 | Three additional items sold |
| 5 | 3 | +2 | Two sales were reversed |
| 0 | -2 | +2 | Two returned items are added |

If Shopify has 5 available and the first report quantity is 2, Shopify receives
delta `-2` and the resulting available quantity is 3. A report quantity of
`-2` produces delta `+2`.

The state is saved only after Shopify confirms the adjustment. If the Shopify
request fails, the old state remains so the job can retry the same difference.
The Shopify mutation also uses an idempotency key based on the date, shop,
variant, and quantity transition to protect retries from applying the same
adjustment twice.

### Multiple stores and Shopify locations

Each EasyCashier store is mapped to a Shopify location. A sale changes
inventory only at that store's configured Shopify location. If the same SKU has
sales in two stores, two location-specific changes are sent.

Configure mappings with private Gadget environment variables:

- `EASYCASHIER_STORE_1_SHOPIFY_LOCATION_ID`
- `EASYCASHIER_STORE_3_SHOPIFY_LOCATION_ID`

Values can be numeric Shopify location IDs or complete
`gid://shopify/Location/...` IDs. A missing mapping stops the sync with an
error; state is not saved for that variant.

### No sales and missing rows

If the report returns an empty `items` array, the action succeeds without
changing Shopify inventory or variant state.

If a previously reported row later remains present with quantity `0`, the
difference is applied. If the row disappears from the report entirely, the
current implementation does not interpret that disappearance as zero and does
not reverse the previous adjustment.

### Mock sales test

Call the entry action with `test: true` to use
`api/lib/mockEasycashierSales.js` instead of requesting the EasyCashier sales
endpoint:

```js
await api.syncInventoryFromEasycashier({ test: true });
```

Mock data follows the complete real synchronization path. It uses and updates
the same cumulative `easyCashierInventorySyncState`, so sending an unchanged
mock report twice produces no second inventory adjustment. Change the mock
quantity cumulatively to simulate additional sales.

`test: true` is not a dry run: it modifies real Shopify inventory in the
selected Gadget environment.

## Background queues and retries

| Queue | Purpose | Concurrency |
| --- | --- | ---: |
| `easycashier-api` | Product changes and inventory synchronization | 1 |

Product webhook jobs use stable IDs derived from product IDs and SKUs. Gadget's
default duplicate-ID behavior is to throw an error if a background action with
the same ID is already enqueued. The current enqueue calls do not set
`onDuplicateID: "ignore"`.

## EasyCashier authentication

Configure these private Gadget environment variables in every environment:

- `EASYCASHIER_API_BASE_URL`
- `EASYCASHIER_COMPANY_ID`
- `EASYCASHIER_API_USERNAME`
- `EASYCASHIER_API_PASSWORD`

Optional variables:

- `EASYCASHIER_LOGIN_URL` defaults to
  `https://backoffice.easycashier.se/v1/login`.
- `EASYCASHIER_API_AUTH_HEADER_NAME` defaults to `x-auth-token`.

The client caches the access token until shortly before expiration. Concurrent
requests share an in-progress login, and an EasyCashier `401` response causes
one forced token refresh and request retry.

### API rate limiting

EasyCashier allows 300 requests per minute. The application reserves a safety
margin and permits at most 250 requests in any rolling 60-second window.
Requests below that threshold are sent immediately; request 251 waits only
until the oldest recorded request leaves the window.

The limiter applies to article requests, paginated sales-report requests,
authentication, and retries. Its timestamps are stored in the singleton
`easyCashierRateLimitState` Gadget record, so the budget survives serverless
process changes. Every EasyCashier-calling background job also uses the shared
single-concurrency `easycashier-api` queue, preventing concurrent jobs from
racing while reserving slots.

If EasyCashier still responds with HTTP `429`, the client retries up to three
times. It honors `Retry-After` when provided; otherwise it uses exponential
backoff with jitter. Product worker timeouts are 15 minutes so a valid
rate-limit wait does not cause a short action timeout.

### Rate-limit stress test

`runShopifyInventoryStressTest` is an opt-in development-only test targeting
one existing Shopify variant at one location. It repeats this sequence 500
times:

1. Increment the Shopify `available` inventory by `1`.
2. Fetch the complete EasyCashier sales report with `getTodaysSalesData()`.

The worker uses the shared `easycashier-api` queue and the real
`EasycashierClient`, so every report page and the authentication request count
toward the same durable 250-per-60-second budget as production sync work. If a
report contains more than 50 rows, a single `getTodaysSalesData()` call uses
multiple rate-limited EasyCashier requests because the report is paginated.

Every Shopify adjustment has a stable run-and-iteration idempotency key. If
Gadget retries the worker, Shopify does not apply a successful increment twice.
The target variant must already be stocked at the supplied location.

Enqueue the test with:

```js
await api.runShopifyInventoryStressTest({
  shopId: "71573209157",
  variantId: "gid://shopify/ProductVariant/VARIANT_ID",
  locationId: "gid://shopify/Location/LOCATION_ID",
  confirmation: "INCREMENT_INVENTORY_AND_GET_SALES_500_TIMES",
});
```

The entry action returns immediately with the background job ID and run ID.
The completed worker reports the initial and final available quantity, the
expected total delta (`+500`), the number of sales-report calls, and the total
sales rows read. A fixed background-job ID prevents another run against the
same variant and location while the first run is active. Both actions refuse
to run when `GADGET_ENV` is `production`; Gadget development environments use
their branch name as `GADGET_ENV`. The confirmation value must also match.

The non-destructive mock test for the interleaved 500-adjustment/500-report
sequence is available as:

```text
yarn test:stress
```

## Shopify configuration

The app currently requests:

- `read_products`
- `read_inventory`
- `write_inventory`
- `read_locations`

Shopify webhook subscriptions and API version are defined in
`shopify.app.toml`. The current Admin API version is `2026-04`.

## Operational checks

Use Gadget logs to trace queued and completed work. Useful structured log
fields include product ID, variant ID, SKU, shop ID, inventory changes,
matched-variant count, and unmatched SKUs.

Before enabling inventory synchronization on a short interval:

1. Confirm every sellable Shopify variant has the intended unique SKU.
2. Confirm each EasyCashier store has the correct Shopify location mapping.
3. Run a controlled mock test against a development store.
4. Confirm the first cumulative quantity and a subsequent unchanged quantity.
5. Confirm negative EasyCashier quantities increase Shopify inventory.
6. Review Gadget problems and logs before deployment.
