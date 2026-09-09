import { EasycashierClient } from "../lib/EasycashierApiClient.js";
import { createEasyCashierRateLimiter } from "../lib/easycashierRateLimit.js";
import {
  adjustShopifyInventory,
  calculateShopifyInventoryDelta,
} from "../lib/shopifyInventory.js";

const getErrorMessage = (error) => error?.message ?? String(error);

const findShopifyVariants = async ({ api, filter, select, logger, lookupValues, lookupType }) => {
  try {
    return await api.shopifyProductVariant.findMany({
      first: 250,
      filter,
      select,
    });
  } catch (error) {
    logger.error(
      {
        error: getErrorMessage(error),
        lookupType,
        lookupValues,
      },
      "Shopify variant lookup failed"
    );
    return null;
  }
};

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

    const matchedVariants = [];
    const lookupFailedSkus = new Set();

    for (let index = 0; index < skus.length; index += 100) {
      const lookupValues = skus.slice(index, index + 100);
      const select = {
        barcode: true,
        easyCashierInventorySyncState: true,
        id: true,
        shopId: true,
        sku: true,
      };

      // Prefer Shopify SKU matches. Barcode (EAN in EasyCashier) is only a
      // fallback for article numbers that had no SKU match.
      const skuMatches = await findShopifyVariants({
        api,
        filter: {
          sku: { in: lookupValues },
        },
        logger,
        lookupType: "sku",
        lookupValues,
        select,
      });

      // Do not fall back to barcode when the SKU lookup failed: we cannot
      // prove that a SKU match does not exist in that case.
      if (skuMatches === null) {
        lookupValues.forEach((lookupValue) => lookupFailedSkus.add(lookupValue));
        continue;
      }

      const skuMatchedValues = new Set(
        skuMatches.map((variant) => String(variant.sku ?? "").trim())
      );

      for (const variant of skuMatches) {
        matchedVariants.push({
          lookupValue: String(variant.sku).trim(),
          variant,
        });
      }

      const barcodeFallbackValues = lookupValues.filter(
        (lookupValue) => !skuMatchedValues.has(lookupValue)
      );

      if (barcodeFallbackValues.length > 0) {
        const barcodeMatches = await findShopifyVariants({
          api,
          filter: {
            barcode: { in: barcodeFallbackValues },
          },
          logger,
          lookupType: "barcode",
          lookupValues: barcodeFallbackValues,
          select,
        });

        if (barcodeMatches === null) {
          barcodeFallbackValues.forEach((lookupValue) => lookupFailedSkus.add(lookupValue));
          continue;
        }

        for (const variant of barcodeMatches) {
          matchedVariants.push({
            lookupValue: String(variant.barcode).trim(),
            variant,
          });
        }
      }
    }

    let inventoryAdjustmentCount = 0;
    const updatedProducts = [];
    const failedProducts = [];

    for (const { lookupValue, variant } of matchedVariants) {
      const productContext = {
        easyCashierArticleNumber: lookupValue,
        shopId: variant.shopId,
        sku: variant.sku ?? null,
        barcode: variant.barcode ?? null,
        variantId: String(variant.id),
      };

      try {
        const currentSalesByStore = salesBySku.get(lookupValue);
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

        updatedProducts.push({
          ...productContext,
          inventoryChangeCount: inventoryChanges.length,
          inventoryChanges,
        });
        logger.info(
          {
            ...productContext,
            inventoryChangeCount: inventoryChanges.length,
            inventoryChanges,
          },
          "EasyCashier inventory product updated"
        );
      } catch (error) {
        const failure = { ...productContext, error: error.message };
        failedProducts.push(failure);
        logger.error(failure, "EasyCashier inventory product not updated");
      }
    }

    const matchedSkus = new Set(matchedVariants.map(({ lookupValue }) => lookupValue));
    const unmatchedSkus = skus.filter(
      (sku) => !matchedSkus.has(sku) && !lookupFailedSkus.has(sku)
    );

    logger.info(
      {
        salesCount: sales.length,
        inventoryAdjustmentCount,
        matchedVariantCount: matchedVariants.length,
        unmatchedSkuCount: unmatchedSkus.length,
        lookupFailedSkuCount: lookupFailedSkus.size,
        updatedProductCount: updatedProducts.length,
        failedProductCount: failedProducts.length,
      },
      "EasyCashier inventory sync completed"
    );

    return {
      test: params.test,
      salesCount: sales.length,
      inventoryAdjustmentCount,
      matchedVariantCount: matchedVariants.length,
      unmatchedSkus,
      lookupFailedSkus: [...lookupFailedSkus],
      updatedProducts,
      failedProducts,
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
