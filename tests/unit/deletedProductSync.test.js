import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { run } from "../../api/actions/deletedProductSync.js";
import { createApiStub, createLogger } from "../support/easycashierTestHelpers.js";

describe("deletedProductSync action", () => {
  test("queues a background delete sync when triggered by Shopify product delete webhook", async () => {
    const { api, enqueueCalls } = createApiStub();
    const { logger } = createLogger();

    const result = await run({
      params: {},
      logger,
      api,
      connections: {},
      trigger: {
        type: "shopify_webhook",
        topic: "products/delete",
        shopId: "shop-1",
        shopDomain: "dragonslair.myshopify.com",
        payload: {
          id: 123,
        },
      },
    });

    assert.deepEqual(result, {
      success: true,
      queued: true,
    });

    assert.equal(enqueueCalls.length, 1);
    assert.equal(enqueueCalls[0][0].operationName, "deletedProductSync");
    assert.deepEqual(enqueueCalls[0][1], {
      payload: {
        event: "deleted",
        topic: "products/delete",
        shopId: "shop-1",
        shopDomain: "dragonslair.myshopify.com",
        shopifyProductId: "123",
        shopifyProductGid: null,
        produktnamn: null,
        products: [
          {
            shopifyProductId: "123",
            shopifyVariantId: null,
            shopifyVariantGid: null,
            artikelnummer: null,
            produktnamn: null,
          },
        ],
      },
    });
    assert.deepEqual(enqueueCalls[0][2], {
      queue: {
        name: "easycashier-sync",
        maxConcurrency: 1,
      },
      retries: {
        retryCount: 1,
        initialInterval: 2000,
      },
    });
  });
});
