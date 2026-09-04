import { applyParams, save, ActionOptions } from "gadget-server";
import { preventCrossShopDataAccess } from "gadget-server/shopify";

/** @type { ActionRun } */
export const run = async ({ params, record, logger, api, connections, trigger }) => {
  applyParams(params, record);
  await preventCrossShopDataAccess(params, record);
  await save(record);
};

/** @type { ActionOnSuccess } */
export const onSuccess = async ({ record, logger, api, trigger }) => {
  const product = trigger?.payload;
  const variants = product?.variants;

  if (!product || !Array.isArray(variants) || variants.length === 0) {
    logger.warn(
      {
        productId: product?.id ?? record.id,
        shopId: trigger?.shopId ?? record.shopId,
      },
      "Skipped EasyCashier product creation because the Shopify webhook contained no variants"
    );
    return;
  }

  const missingSkuVariantIds = variants
    .filter((variant) => variant?.sku == null || String(variant.sku).trim() === "")
    .map((variant) => variant?.id)
    .filter(Boolean);

  if (missingSkuVariantIds.length > 0) {
    logger.warn(
      {
        productId: product.id,
        shopId: trigger?.shopId ?? record.shopId,
        missingSkuVariantIds,
      },
      "Product can not be created in EasyCashier because one or more variants have no SKU"
    );
    return;
  }

  await api.enqueue(api.createProductSync, {
    shopId: String(trigger?.shopId ?? record.shopId),
    product,
  }, {
    queue: { name: "easycashier-sync", maxConcurrency: 1 },
  });

  logger.info(
    {
      productId: product.id,
      shopId: trigger?.shopId ?? record.shopId,
      variantCount: variants.length,
    },
    "Queued Shopify product variants for EasyCashier creation"
  );
};

/** @type { ActionOptions } */
export const options = {
  actionType: "create",
  triggers: {
    shopify: {
      triggerKey: "shopifyproduct-create",
    },
  },
};
