import assert from "node:assert/strict";
import test from "node:test";

import {
  SHOPIFY_INVENTORY_STRESS_ADJUSTMENT_COUNT,
  executeShopifyInventoryStressTest,
} from "../../api/lib/shopifyInventoryStressTest.js";

test("increments one Shopify variant 500 times and gets EasyCashier sales after each update", async () => {
  const events = [];
  let contextQueryCount = 0;
  const shopify = {
    graphql: async (query, variables) => {
      if (query.includes("ShopifyInventoryStressContext")) {
        contextQueryCount += 1;
        events.push(`inventory-query-${contextQueryCount}`);
        return {
          productVariant: {
            id: variables.variantId,
            sku: "stress-sku",
            product: { id: "gid://shopify/Product/1", title: "Stress product" },
            inventoryItem: {
              id: "gid://shopify/InventoryItem/1",
              inventoryLevel: {
                quantities: [
                  { name: "available", quantity: contextQueryCount === 1 ? 10 : 510 },
                ],
              },
            },
          },
        };
      }

      const iteration = events.filter((event) => event.startsWith("inventory-adjust-")).length + 1;
      events.push(`inventory-adjust-${iteration}`);
      assert.equal(variables.input.changes[0].delta, 1);
      assert.equal(variables.input.changes[0].inventoryItemId, "gid://shopify/InventoryItem/1");
      assert.equal(variables.input.changes[0].locationId, "gid://shopify/Location/2");
      assert.equal(variables.idempotencyKey, `shopify-inventory-stress:test-run:${iteration}`);

      return {
        inventoryAdjustQuantities: {
          inventoryAdjustmentGroup: { changes: [{ name: "available", delta: 1 }] },
          userErrors: [],
        },
      };
    },
  };
  let salesRequestCount = 0;
  const easycashierClient = {
    getTodaysSalesData: async () => {
      salesRequestCount += 1;
      events.push(`sales-${salesRequestCount}`);
      return { date: "2026-09-04", items: [] };
    },
  };

  const result = await executeShopifyInventoryStressTest({
    easycashierClient,
    locationId: "2",
    runId: "test-run",
    shopify,
    variantId: "1",
  });

  assert.equal(result.adjustmentCount, SHOPIFY_INVENTORY_STRESS_ADJUSTMENT_COUNT);
  assert.equal(result.expectedTotalDelta, SHOPIFY_INVENTORY_STRESS_ADJUSTMENT_COUNT);
  assert.equal(result.initialAvailableQuantity, 10);
  assert.equal(result.finalAvailableQuantity, 510);
  assert.equal(result.salesRequestCount, SHOPIFY_INVENTORY_STRESS_ADJUSTMENT_COUNT);
  assert.equal(salesRequestCount, SHOPIFY_INVENTORY_STRESS_ADJUSTMENT_COUNT);
  assert.equal(contextQueryCount, 2);
  assert.equal(
    events.length,
    (SHOPIFY_INVENTORY_STRESS_ADJUSTMENT_COUNT * 2) + 2
  );

  for (
    let iteration = 1;
    iteration <= SHOPIFY_INVENTORY_STRESS_ADJUSTMENT_COUNT;
    iteration += 1
  ) {
    assert.equal(events[(iteration * 2) - 1], `inventory-adjust-${iteration}`);
    assert.equal(events[iteration * 2], `sales-${iteration}`);
  }
});

test("stops before requesting sales when a Shopify increment fails", async () => {
  const shopify = {
    graphql: async (query, variables) => {
      if (query.includes("ShopifyInventoryStressContext")) {
        return {
          productVariant: {
            id: variables.variantId,
            inventoryItem: {
              id: "gid://shopify/InventoryItem/1",
              inventoryLevel: {
                quantities: [{ name: "available", quantity: 10 }],
              },
            },
          },
        };
      }

      return {
        inventoryAdjustQuantities: {
          inventoryAdjustmentGroup: null,
          userErrors: [{ field: ["changes"], message: "Inventory is not active" }],
        },
      };
    },
  };
  let salesRequested = false;

  await assert.rejects(
    executeShopifyInventoryStressTest({
      easycashierClient: {
        getTodaysSalesData: async () => {
          salesRequested = true;
          return { items: [] };
        },
      },
      locationId: "2",
      runId: "failed-run",
      shopify,
      variantId: "1",
      adjustmentCount: 1,
    }),
    /Shopify inventory increment 1 failed: changes: Inventory is not active/
  );

  assert.equal(salesRequested, false);
});
