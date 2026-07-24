import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { run as runSyncAllProductsToEasyCashier } from "../../api/actions/syncAllProductsToEasyCashier.js";
import { run as runSyncEasyCashierBulkProducts } from "../../api/actions/syncEasyCashierBulkProducts.js";
import { makeShopifyProductGraphqlResponse, runWithEasycashierHarness } from "../support/easycashierTestHelpers.js";

const shopifyProductListPageResponse = ({ productIds = [], hasNextPage = false, endCursor = null } = {}) => ({
  data: {
    products: {
      nodes: productIds.map((productId) => ({
        id: `gid://shopify/Product/${productId}`,
        legacyResourceId: Number(productId),
      })),
      pageInfo: {
        hasNextPage,
        endCursor,
      },
    },
  },
});

const csvLinesFromFormData = async (formData) => {
  const file = formData.get("file");

  if (!file || typeof file.text !== "function") {
    throw new Error("Expected EasyCashier bulk import to include a CSV file");
  }

  const text = await file.text();

  return text.trim().split(/\r?\n/);
};

describe("syncAllProductsToEasyCashier", () => {
  test("queues bulk sync jobs in a single batch when under the bulk batch size", async () => {
    const productIds = Array.from({ length: 11 }, (_, index) => 201 + index);

    await runWithEasycashierHarness(
      {
        shopifyResponses: [shopifyProductListPageResponse({ productIds })],
      },
      async ({ api, logger, connections, enqueueCalls, shopifyCalls, fetchCalls }) => {
        const result = await runSyncAllProductsToEasyCashier({
          params: {
            shopId: "shop-1",
          },
          logger,
          api,
          connections,
        });

        assert.deepEqual(result, {
          shopId: "shop-1",
          status: "queued",
          totalProducts: 11,
          queuedBatchCount: 1,
          batchBackgroundActionIds: [result.batchBackgroundActionIds[0]],
        });

        assert.equal(shopifyCalls.length, 1);
        assert.equal(shopifyCalls[0].variables.productCursor, null);
        assert.equal(fetchCalls.length, 0);

        assert.equal(enqueueCalls.length, 1);
        assert.deepEqual(
          enqueueCalls.map(([action]) => action.operationName ?? action.functionName),
          ["syncEasyCashierBulkProducts"]
        );
        assert.deepEqual(
          enqueueCalls.map(([, params]) => params.payload.productIds),
          [productIds.map((productId) => String(productId))]
        );
        assert.equal(result.batchBackgroundActionIds.length, 1);
        assert.match(result.batchBackgroundActionIds[0], /:batch:0$/);
        assert.equal(enqueueCalls[0][2].shopifyShop, "shop-1");
        assert.equal(enqueueCalls[0][2].queue.maxConcurrency, 1);
        assert.equal(enqueueCalls[0][2].retries.retryCount, 5);
        assert.equal(enqueueCalls[0][2].retries.randomizeInterval, true);
      }
    );
  });

  test("uploads a bulk CSV for a product chunk", async () => {
    await runWithEasycashierHarness(
      {
        shopifyResponses: [
          makeShopifyProductGraphqlResponse({
            productId: 111,
            variantId: 222,
            sku: "SKU-1",
            barcode: "0123456789012",
            inventoryQuantity: 5,
            locationAvailable: 5,
          }),
          makeShopifyProductGraphqlResponse({
            productId: 112,
            variantId: 223,
            sku: "SKU-2",
            barcode: "0098765432105",
            inventoryQuantity: 3,
            locationAvailable: 3,
          }),
        ],
        fetchResponses: [
          {
            body: {
              imported: true,
            },
          },
        ],
      },
      async ({ api, logger, connections, fetchCalls, shopifyCalls }) => {
        const result = await runSyncEasyCashierBulkProducts({
          params: {
            payload: { shopId: "shop-1", productIds: ["111", "112"] },
          },
          logger,
          api,
          connections,
        });

        assert.deepEqual(result, {
          shopId: "shop-1",
          productIds: ["111", "112"],
          batchNumber: null,
          batchCount: null,
          status: "completed",
          success: true,
          importedProductCount: 2,
          failedProductCount: 0,
          importedRowCount: 2,
        });

        assert.equal(shopifyCalls.length, 2);
        assert.equal(fetchCalls.length, 1);
        assert.equal(fetchCalls[0].url, "https://easycashier.example/123/import/articles");
        assert.equal(fetchCalls[0].options.method, "POST");
        assert.equal(fetchCalls[0].options.body instanceof FormData, true);

        const formData = fetchCalls[0].options.body;
        assert.equal(formData.get("storeNumbers"), "1");

        const csvLines = await csvLinesFromFormData(formData);
        assert.equal(csvLines[0].split(",").length, 27);
        assert.equal(csvLines[0].split(",")[0], "Artikelnummer");
        assert.equal(csvLines[0].split(",")[csvLines[0].split(",").length - 1], "Webshop artikel id");
        assert.equal(csvLines.length, 3);
        assert.ok(csvLines[1].includes("SKU-1"));
        assert.ok(csvLines[2].includes("SKU-2"));
        assert.equal(csvLines[1].split(",")[6], "0123456789012");
        assert.equal(csvLines[2].split(",")[6], "0098765432105");

      }
    );
  });

  test("warns and falls back to the Shopify variant id when a bulk-synced product is missing SKU", async () => {
    await runWithEasycashierHarness(
      {
        shopifyResponses: [
          makeShopifyProductGraphqlResponse({
            productId: 114,
            variantId: 224,
            sku: null,
            inventoryQuantity: 5,
            locationAvailable: 5,
          }),
        ],
        fetchResponses: [
          {
            body: {
              imported: true,
            },
          },
        ],
      },
      async ({ api, logger, connections, fetchCalls, logEntries }) => {
        const result = await runSyncEasyCashierBulkProducts({
          params: {
            payload: { shopId: "shop-1", productIds: ["114"] },
          },
          logger,
          api,
          connections,
        });

        assert.deepEqual(result, {
          shopId: "shop-1",
          productIds: ["114"],
          batchNumber: null,
          batchCount: null,
          status: "completed",
          success: true,
          importedProductCount: 1,
          failedProductCount: 0,
          importedRowCount: 1,
        });

        assert.equal(fetchCalls.length, 1);
        assert.equal(logEntries.warn.length, 1);
        assert.match(logEntries.warn[0][1], /missing SKU/i);

        const formData = fetchCalls[0].options.body;
        const csvLines = await csvLinesFromFormData(formData);
        assert.equal(csvLines[1].split(",")[0], "224");
      }
    );
  });

  test("rethrows transient Shopify failures so Gadget retries the bulk sync", async () => {
    await runWithEasycashierHarness(
      {
        shopifyResponses: [
          () => {
            const error = new Error("[Network] Bad Gateway");
            error.name = "CombinedError";
            throw error;
          },
        ],
      },
      async ({ api, logger, connections, fetchCalls, logEntries }) => {
        await assert.rejects(
          runSyncEasyCashierBulkProducts({
            params: {
              payload: { shopId: "shop-1", productIds: ["115"] },
            },
            logger,
            api,
            connections,
          }),
          /Bad Gateway/
        );

        assert.equal(fetchCalls.length, 0);
        assert.equal(logEntries.error.length, 1);
        assert.match(logEntries.error[0][1], /Transient Shopify failure/i);
      }
    );
  });

  test("rethrows Gadget Shopify rate-limit tracker timeouts for background retry", async () => {
    await runWithEasycashierHarness(
      {
        shopifyResponses: [
          () => {
            const error = Object.assign(new Error("failed to update shopify rate limit: Timeout awaiting 'request' for 5000ms"), {
              name: "RequestError",
              code: "ETIMEDOUT",
            });
            throw error;
          },
        ],
      },
      async ({ api, logger, connections, fetchCalls, logEntries }) => {
        await assert.rejects(
          runSyncEasyCashierBulkProducts({
            params: {
              payload: { shopId: "shop-1", productIds: ["116"] },
            },
            logger,
            api,
            connections,
          }),
          /failed to update shopify rate limit/
        );

        assert.equal(fetchCalls.length, 0);
        assert.equal(logEntries.error.length, 1);
        assert.match(logEntries.error[0][1], /retrying EasyCashier bulk import/i);
      }
    );
  });

  test("marks a queued full sync as cancelled even when the background action handle is stale", async () => {
    const cancelError = Object.assign(new Error("Couldn't find Background Action with id=8606 to cancel"), {
      code: "GGT_RECORD_NOT_FOUND",
    });

    await runWithEasycashierHarness(
      {
        cancelError,
      },
      async ({ api, logger, handleCalls, cancelCalls, logEntries }) => {
        const result = await runSyncAllProductsToEasyCashier({
          params: {
            shopId: "shop-1",
            backgroundActionId: "background-1",
          },
          logger,
          api,
        });

        assert.deepEqual(result, {
          shopId: "shop-1",
          backgroundActionId: "background-1",
          status: "cancelled",
        });

        assert.equal(handleCalls.length, 1);
        assert.deepEqual(handleCalls[0], {
          action: "syncAllProductsToEasyCashier",
          id: "background-1",
        });
        assert.equal(cancelCalls.length, 1);
        assert.deepEqual(cancelCalls[0], {
          action: "syncAllProductsToEasyCashier",
          id: "background-1",
        });
        assert.equal(logEntries.warn.length, 1);
      }
    );
  });
});
