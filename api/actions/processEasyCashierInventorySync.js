import { EasycashierClient } from "../lib/EasycashierApiClient.js";
import { createEasyCashierRateLimiter } from "../lib/easycashierRateLimit.js";
import {
  adjustShopifyInventory,
  calculateShopifyInventoryDelta,
} from "../lib/shopifyInventory.js";

/** @type { ActionRun } */
export const run = async ({ logger, api, connections, params }) => {
  try {
    const easycashierClient = new EasycashierClient({
      rateLimiter: createEasyCashierRateLimiter({ api, logger }),
      logger,
    });
    const salesResponse = await easycashierClient.getTodaysSalesData({
      test: params.test,
    });
    const salesDate = salesResponse.date;
    const sales = salesResponse?.items ?? [];

    if (!Array.isArray(sales)) {
      throw new Error("EasyCashier sales response did not contain an items array");
    }

    // Group each article's sales by store so both stores can be saved on one variant.
    const salesBySku = new Map();

    for (const sale of sales) {
      const sku = String(sale?.articleNumber ?? "").trim();
      const storeNumber = String(sale?.storeNumber ?? "").trim();
      const quantity = Number(sale?.quantity);

      if (!sku || !storeNumber) {
        continue;
      }

      if (sale?.quantity == null || sale.quantity === "" || !Number.isInteger(quantity)) {
        throw new Error(
          `EasyCashier returned an invalid quantity for article ${sku}, store ${storeNumber}`
        );
      }

      const salesByStore = salesBySku.get(sku) ?? {};
      salesByStore[storeNumber] = sale;
      salesBySku.set(sku, salesByStore);
    }

    const skus = [...salesBySku.keys()];

    if (skus.length === 0) {
      logger.info("EasyCashier returned no sales with an article number and store number");
      return {
        test: params.test,
        salesCount: sales.length,
        matchedVariantCount: 0,
        unmatchedSkus: [],
      };
    }

    const variants = [];

    for (let index = 0; index < skus.length; index += 100) {
      const matchingVariants = await api.shopifyProductVariant.findMany({
        first: 250,
        filter: {
          sku: { in: skus.slice(index, index + 100) },
        },
        select: {
          easyCashierInventorySyncState: true,
          id: true,
          shopId: true,
          sku: true,
        },
      });

      variants.push(...matchingVariants);
    }

    let inventoryAdjustmentCount = 0;

    for (const variant of variants) {
      const sku = String(variant.sku).trim();
      const currentSalesByStore = salesBySku.get(sku);
      const savedState = variant.easyCashierInventorySyncState ?? {};
      const savedSalesByStore = savedState.salesDate === salesDate
        ? savedState.salesByStore ?? {}
        : {};
      const inventoryChanges = [];

      for (const [storeNumber, currentSale] of Object.entries(currentSalesByStore)) {
        const currentQuantity = Number(currentSale.quantity);
        const savedQuantity = Number(savedSalesByStore[storeNumber]?.quantity ?? 0);
        const delta = calculateShopifyInventoryDelta({
          salesQuantity: currentQuantity,
          previouslySyncedSalesQuantity: savedQuantity,
        });

        if (delta !== 0) {
          inventoryChanges.push({
            delta,
            storeNumber,
            savedQuantity,
            currentQuantity,
          });
        }
      }

      if (inventoryChanges.length > 0) {
        logger.info(
          { inventoryChanges, sku, test: params.test },
          "Applying EasyCashier inventory changes to Shopify"
        );

        await adjustShopifyInventory({
          connections,
          variant,
          salesDate,
          inventoryChanges,
        });

        inventoryAdjustmentCount += inventoryChanges.length;
      }

      // Save only after Shopify succeeds so a failed request can be retried.
      await api.internal.shopifyProductVariant.update(variant.id, {
        easyCashierInventorySyncState: {
          salesDate,
          syncedAt: new Date().toISOString(),
          salesByStore: currentSalesByStore,
        },
      });
    }

    const matchedSkus = new Set(variants.map((variant) => String(variant.sku).trim()));
    const unmatchedSkus = skus.filter((sku) => !matchedSkus.has(sku));

    logger.info(
      {
        salesCount: sales.length,
        inventoryAdjustmentCount,
        matchedVariantCount: variants.length,
        unmatchedSkuCount: unmatchedSkus.length,
      },
      "EasyCashier inventory sync completed"
    );

    return {
      test: params.test,
      salesCount: sales.length,
      inventoryAdjustmentCount,
      matchedVariantCount: variants.length,
      unmatchedSkus,
    };
  } catch (error) {
    logger.error({ error: error.message }, "EasyCashier inventory sync failed");
    throw error;
  }
};

export const params = {
  test: { type: "boolean", default: false },
};

export const options = {
  timeoutMS: 900000,
  triggers: {
    api: true,
  },
};
