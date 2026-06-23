import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  buildShopifyProductEasyCashierPayload,
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
});
