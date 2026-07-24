const DEFAULT_TEST_ENV = {
  EASYCASHIER_API_BASE_URL: "https://easycashier.example",
  EASYCASHIER_COMPANY_ID: "123",
  EASYCASHIER_RATE_LIMIT_REQUESTS_PER_MINUTE: "60000000",
  EASYCASHIER_SYNC_INVENTORY_FROM_SHOPIFY: "true",
  EASYCASHIER_STOCK_LOCATION_MAPPINGS: JSON.stringify([
    {
      easyCashierStoreNumber: 1,
      shopifyLocationName: "Kungsholmstorg 8",
    },
  ]),
  SHOPIFY_PRODUCT_DEFAULT_VAT_RATE: "25",
};

const cloneValue = (value) => {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }

  return value == null ? value : JSON.parse(JSON.stringify(value));
};

export function setTestEnv(overrides = {}) {
  const nextEnv = { ...DEFAULT_TEST_ENV, ...overrides };
  const previousEnv = new Map();

  for (const [key, value] of Object.entries(nextEnv)) {
    previousEnv.set(key, process.env[key]);

    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = String(value);
    }
  }

  return () => {
    for (const [key, value] of previousEnv.entries()) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

export function installImmediateTimers() {
  const originalSetTimeout = globalThis.setTimeout;

  // EasyCashier requests are rate limited in production, but tests should
  // execute synchronously instead of waiting for that sleep.
  globalThis.setTimeout = ((callback, _delay, ...args) => {
    if (typeof callback === "function") {
      callback(...args);
    }

    return 0;
  });

  return () => {
    globalThis.setTimeout = originalSetTimeout;
  };
}

const toResponse = (value) => {
  if (value instanceof Response) {
    return value;
  }

  if (typeof value === "string") {
    return new Response(value, {
      status: 200,
    });
  }

  const status = value?.status ?? 200;
  const headers = value?.headers ?? {
    "Content-Type": "application/json",
  };
  const body = value?.body ?? "";
  const payload = typeof body === "string" ? body : JSON.stringify(body);

  return new Response(payload, {
    status,
    headers,
  });
};

export function createFetchQueue(responses = []) {
  const calls = [];
  const queue = [...responses];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, options = {}) => {
    const call = {
      url: String(url),
      options: {
        ...options,
      },
    };

    calls.push(call);

    if (queue.length === 0) {
      throw new Error(`Unexpected fetch call to ${call.url}`);
    }

    const next = queue.shift();
    const response = typeof next === "function" ? await next(call) : next;

    return toResponse(response);
  };

  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

export function createShopifyConnection(responses = []) {
  const calls = [];
  const queue = [...responses];

  return {
    calls,
    connection: {
      graphql: async (query, variables) => {
        calls.push({
          query,
          variables,
        });

        if (queue.length === 0) {
          throw new Error("Unexpected Shopify GraphQL call");
        }

        const next = queue.shift();

        return typeof next === "function" ? await next({ query, variables, calls }) : next;
      },
    },
  };
}

export function createLogger() {
  const entries = {
    info: [],
    warn: [],
    error: [],
  };

  const log = (level) => (...args) => {
    entries[level].push(args.map(cloneValue));
  };

  return {
    logger: {
      info: log("info"),
      warn: log("warn"),
      error: log("error"),
    },
    entries,
  };
}

export function createApiStub({ cancelError = null } = {}) {
  const enqueueCalls = [];
  const handleCalls = [];
  const cancelCalls = [];
  const variantStates = new Map();

  return {
    api: {
      internal: {
        shopifyProductVariant: {
          update: async (id, values) => {
            variantStates.set(String(id), cloneValue(values.easyCashierInventorySyncState ?? null));
            return { id: String(id), ...cloneValue(values) };
          },
        },
      },
      shopifyProductVariant: {
        findOne: async (id) => ({
          id: String(id),
          easyCashierInventorySyncState: cloneValue(variantStates.get(String(id)) ?? null),
        }),
      },
      createdProductSync: {
        operationName: "createdProductSync",
        functionName: "createdProductSync",
      },
      deletedProductSync: {
        operationName: "deletedProductSync",
        functionName: "deletedProductSync",
      },
      syncAllProductsToEasyCashier: {
        operationName: "syncAllProductsToEasyCashier",
        functionName: "syncAllProductsToEasyCashier",
      },
      syncEasyCashierBulkProducts: {
        operationName: "syncEasyCashierBulkProducts",
        functionName: "syncEasyCashierBulkProducts",
      },
      syncEasyCashierProduct: {
        operationName: "syncEasyCashierProduct",
        functionName: "syncEasyCashierProduct",
      },
      updatedProductSync: {
        operationName: "updatedProductSync",
        functionName: "updatedProductSync",
      },
      handle: (action, id) => {
        handleCalls.push({
          action: action?.operationName ?? action?.functionName ?? null,
          id: cloneValue(id),
        });

        return {
          cancel: async () => {
            cancelCalls.push({
              action: action?.operationName ?? action?.functionName ?? null,
              id: cloneValue(id),
            });

            if (cancelError) {
              throw cancelError;
            }
          },
        };
      },
      enqueue: async (...args) => {
        enqueueCalls.push(args.map(cloneValue));

        const backgroundId = args[2]?.id ?? `background-${enqueueCalls.length}`;

        return {
          id: backgroundId,
        };
      },
    },
    enqueueCalls,
    handleCalls,
    cancelCalls,
    variantStates,
  };
}

export function makeShopifyProductGraphqlResponse({
  productId = 111,
  variantId = 222,
  title = "Test Product",
  sku = "SKU-1",
  price = "19.99",
  barcode = "1234567890",
  taxable = true,
  inventoryQuantity = 5,
  locationName = "Kungsholmstorg 8",
  locationAvailable = inventoryQuantity,
  inventoryLevels = null,
} = {}) {
  const inventoryLevelNodes =
    inventoryLevels ?? [
      {
        location: {
          id: `gid://shopify/Location/${variantId}`,
          name: locationName,
        },
        quantities: [
          {
            name: "available",
            quantity: locationAvailable,
          },
        ],
      },
    ];

  return {
    data: {
      product: {
        id: `gid://shopify/Product/${productId}`,
        legacyResourceId: Number(productId),
        title,
        variants: {
          nodes: [
            {
              id: `gid://shopify/ProductVariant/${variantId}`,
              legacyResourceId: Number(variantId),
              sku,
              price,
              barcode,
              taxable,
              inventoryQuantity,
              inventoryItem: {
                inventoryLevels: {
                  nodes: inventoryLevelNodes,
                },
              },
            },
          ],
          pageInfo: {
            hasNextPage: false,
            endCursor: null,
          },
        },
      },
    },
  };
}

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

export function textResponse(body, status = 200) {
  return new Response(String(body), {
    status,
  });
}

export function createEasycashierHarness({
  env = {},
  fetchResponses = [],
  shopifyResponses = [],
  cancelError = null,
} = {}) {
  const restoreEnv = setTestEnv(env);
  const restoreTimers = installImmediateTimers();
  const fetchQueue = createFetchQueue(fetchResponses);
  const shopify = createShopifyConnection(shopifyResponses);
  const { api, enqueueCalls, handleCalls, cancelCalls, variantStates } = createApiStub({ cancelError });
  const { logger, entries } = createLogger();

  return {
    api,
    logger,
    logEntries: entries,
    enqueueCalls,
    handleCalls,
    cancelCalls,
    variantStates,
    fetchCalls: fetchQueue.calls,
    shopifyCalls: shopify.calls,
    connections: {
      shopify: {
        current: shopify.connection,
      },
    },
    restore: () => {
      fetchQueue.restore();
      restoreTimers();
      restoreEnv();
    },
  };
}

export async function runWithEasycashierHarness(options, fn) {
  const harness = createEasycashierHarness(options);

  try {
    return await fn(harness);
  } finally {
    harness.restore();
  }
}
