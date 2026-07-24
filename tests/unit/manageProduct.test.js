import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  buildShopifyProductEasyCashierPayload,
  enqueueShopifyProductEasyCashierPayload,
  enqueueShopifyProductEasyCashierSync,
  enqueueShopifyInventoryLevelEasyCashierSync,
  enqueueShopifyProductVariantDeleteEasyCashierSync,
  isProductWebhookTrigger,
  productEventForTrigger,
  shopifyProductUpdateNeedsSync,
} from "../../api/lib/manageProduct.js";
import { createApiStub, createLogger } from "../support/easycashierTestHelpers.js";

describe("manageProduct helpers", () => {
  test("maps Shopify webhook topics to Easycashier events", () => {
    assert.equal(productEventForTrigger({ topic: "products/create" }, "updated"), "created");
    assert.equal(productEventForTrigger({ topic: "products/update" }, "created"), "updated");
    assert.equal(productEventForTrigger({ topic: "products/delete" }, "created"), "deleted");
    assert.equal(productEventForTrigger({ topic: "inventory_levels/update" }, "updated"), "updated");

    assert.equal(isProductWebhookTrigger({ type: "shopify_webhook", topic: "products/update" }), true);
    assert.equal(isProductWebhookTrigger({ type: "shopify_webhook", topic: "inventory_levels/update" }), false);
  });

  test("buildShopifyProductEasyCashierPayload keeps missing SKUs as null", () => {
    const payload = buildShopifyProductEasyCashierPayload({
      trigger: {
        type: "shopify_webhook",
        topic: "products/create",
        shopId: "shop-1",
        shopDomain: "dragonslair.myshopify.com",
        payload: {
          id: 111,
          admin_graphql_api_id: "gid://shopify/Product/111",
          title: "Test Product",
          variants: [
            {
              id: 222,
              admin_graphql_api_id: "gid://shopify/ProductVariant/222",
              sku: undefined,
              price: "19.99",
              taxable: true,
              inventory_quantity: 5,
            },
          ],
        },
      },
      event: "created",
    });

    assert.equal(payload.event, "created");
    assert.equal(payload.topic, "products/create");
    assert.equal(payload.shopId, "shop-1");
    assert.equal(payload.shopDomain, "dragonslair.myshopify.com");
    assert.equal(payload.shopifyProductId, "111");
    assert.equal(payload.shopifyProductGid, "gid://shopify/Product/111");
    assert.equal(payload.produktnamn, "Test Product");
    assert.equal(payload.products.length, 1);
    assert.equal(payload.products[0].shopifyVariantId, "222");
    assert.equal(payload.products[0].artikelnummer, null);
    assert.equal(payload.products[0].inventoryQuantity, 5);
  });

  test("skips a product webhook with a missing SKU without crashing", async () => {
    const { api, enqueueCalls } = createApiStub();
    const { logger, entries } = createLogger();

    await enqueueShopifyProductEasyCashierSync({
      api,
      logger,
      fallbackEvent: "created",
      trigger: {
        type: "shopify_webhook",
        topic: "products/update",
        shopId: "101583159644",
        payload: {
          id: "15678946869596",
          title: "Pokémon TCG - Ninja Spinner Booster Japansk (Copy)",
          variants: [
            {
              id: "58295968203100",
              admin_graphql_api_id: "gid://shopify/ProductVariant/58295968203100",
              inventory_quantity: "0",
            },
          ],
        },
      },
    });

    assert.equal(enqueueCalls.length, 0);
    assert.equal(entries.warn.length, 1);
    assert.deepEqual(entries.warn[0][0].missingSkuVariantIds, ["58295968203100"]);
    assert.match(entries.warn[0][1], /can not be created without sku/i);
  });

  test("buildShopifyProductEasyCashierPayload keeps product deletes usable without variants", () => {
    const payload = buildShopifyProductEasyCashierPayload({
      trigger: {
        type: "shopify_webhook",
        topic: "products/delete",
        shopId: "shop-1",
        shopDomain: "dragonslair.myshopify.com",
        payload: {
          id: 111,
          title: "Deleted Product",
        },
      },
      event: "deleted",
    });

    assert.equal(payload.event, "deleted");
    assert.equal(payload.topic, "products/delete");
    assert.equal(payload.shopId, "shop-1");
    assert.equal(payload.shopDomain, "dragonslair.myshopify.com");
    assert.equal(payload.shopifyProductId, "111");
    assert.equal(payload.products.length, 1);
    assert.equal(payload.products[0].shopifyProductId, "111");
    assert.equal(payload.products[0].artikelnummer, null);
  });

  test("shopifyProductUpdateNeedsSync returns true when only variants changed", () => {
    assert.equal(
      shopifyProductUpdateNeedsSync({
        changes(field) {
          return {
            changed: field === "variants",
          };
        },
      }),
      true
    );
  });

  test("associates queued product syncs with the Shopify shop and resilient retries", async () => {
    const { api, enqueueCalls } = createApiStub();
    const { logger } = createLogger();

    await enqueueShopifyProductEasyCashierPayload({
      api,
      logger,
      payload: {
        event: "updated",
        shopId: "shop-1",
        shopifyProductId: "111",
        products: [],
      },
    });

    assert.equal(enqueueCalls.length, 1);
    assert.equal(enqueueCalls[0][2].shopifyShop, "shop-1");
    assert.equal(enqueueCalls[0][2].queue.maxConcurrency, 1);
    assert.equal(enqueueCalls[0][2].retries.retryCount, 5);
    assert.equal(enqueueCalls[0][2].retries.randomizeInterval, true);
  });

  test("skips variant delete sync when the SKU is missing", async () => {
    const { api, enqueueCalls } = createApiStub();
    const { logger, entries } = createLogger();

    await enqueueShopifyProductVariantDeleteEasyCashierSync({
      api,
      logger,
      trigger: {
        type: "shopify_webhook",
        topic: "shopify_product_variant_delete",
        shopId: "shop-1",
      },
      record: {
        id: "222",
        productId: "111",
        shopId: "shop-1",
      },
      deletedVariant: {
        id: "222",
        productId: "111",
        shopId: "shop-1",
      },
    });

    assert.equal(enqueueCalls.length, 0);
    assert.equal(entries.warn.length, 1);
    assert.match(entries.warn[0][1], /variant delete because the Shopify variant SKU was missing/i);
  });

  test("uses the inventory webhook quantity when Shopify location GraphQL data is stale", async () => {
    const { api, enqueueCalls } = createApiStub();
    const { logger } = createLogger();
    const trigger = {
      type: "shopify_webhook",
      topic: "inventory_levels/update",
      shopId: "shop-1",
      payload: {
        inventory_item_id: "333",
        location_id: "444",
        available: 7,
      },
    };
    const connections = {
      shopify: {
        current: {
          graphql: async () => ({
            data: {
              inventoryItem: {
                id: "gid://shopify/InventoryItem/333",
                sku: "RAILROAD-TILES",
                variant: {
                  id: "gid://shopify/ProductVariant/222",
                  legacyResourceId: 222,
                  sku: "RAILROAD-TILES",
                  inventoryQuantity: 12,
                  inventoryItem: {
                    inventoryLevels: {
                      nodes: [
                        {
                          location: {
                            id: "gid://shopify/Location/444",
                            name: "Store",
                          },
                          quantities: [{ name: "available", quantity: 8 }],
                        },
                      ],
                    },
                  },
                  product: {
                    id: "gid://shopify/Product/111",
                    legacyResourceId: 111,
                    title: "Railroad tiles",
                  },
                },
              },
            },
          }),
        },
      },
    };

    await enqueueShopifyInventoryLevelEasyCashierSync({
      api,
      logger,
      connections,
      trigger,
    });

    assert.equal(enqueueCalls.length, 1);
    assert.equal(enqueueCalls[0][1].payload.products[0].inventoryByLocation[0].available, 7);
    assert.equal(enqueueCalls[0][1].payload.products[0].inventoryByLocation[0].locationId, "444");
  });

});
