import { applyParams, save, ActionOptions } from "gadget-server";
import { preventCrossShopDataAccess } from "gadget-server/shopify";

/** @type { ActionRun } */
export const run = async ({ params, record, logger, api, connections, trigger }) => {
  const previousTitle = record.title;
  const existingVariants = await api.shopifyProductVariant.findMany({
    first: 250,
    filter: { productId: { equals: String(record.id) } },
    select: { id: true },
  });
  const existingVariantIds = [];
  let variantPage = existingVariants;

  while (true) {
    existingVariantIds.push(...variantPage.map((variant) => String(variant.id)));

    if (!variantPage.hasNextPage) {
      break;
    }

    variantPage = await variantPage.nextPage();
  }

  params.__easyCashierExistingVariantIds = existingVariantIds;
  params.__easyCashierPreviousTitle = previousTitle;
  record.__easyCashierExistingVariantIds = existingVariantIds;
  record.__easyCashierPreviousTitle = previousTitle;
  applyParams(params, record);
  await preventCrossShopDataAccess(params, record);
  await save(record);
};

/** @type { ActionOnSuccess } */
export const onSuccess = async ({ params, record, logger, api, trigger }) => {
  const product = trigger?.payload;
  const variants = product?.variants;

  if (!product || !Array.isArray(variants) || variants.length === 0) {
    return;
  }

  const existingVariantIds = new Set(
    record.__easyCashierExistingVariantIds ?? []
  );
  const newVariants = variants.filter(
    (variant) => !existingVariantIds.has(String(variant.id))
  );

  if (newVariants.length > 0) {
    await api.enqueue(api.createProductSync, {
      shopId: String(trigger?.shopId ?? record.shopId),
      product: { ...product, variants: newVariants },
    }, {
      queue: { name: "easycashier-sync", maxConcurrency: 1 },
      id: `create-product-sync-${product.id}`,
      priority: "DEFAULT",
      retries: { retryCount: 2 },
    });

    logger.info(
      {
        productId: product.id,
        variantIds: newVariants.map((variant) => variant.id),
      },
      "Queued new Shopify variants for EasyCashier creation"
    );
  }

  if (!record.changed("title")) {
    return;
  }

  for (const variant of variants) {
    const sku = variant?.sku == null ? "" : String(variant.sku).trim();

    if (!sku) {
      continue;
    }

    await api.enqueue(api.updateProductSync, {
      shopId: String(trigger?.shopId ?? record.shopId),
      productId: String(product.id),
      productTitle: params.__easyCashierPreviousTitle ?? record.__easyCashierPreviousTitle,
      lookupArticleNumber: sku,
      changes: { description: product.title ?? "" },
    }, {
      queue: { name: "easycashier-sync", maxConcurrency: 1 },
      id: `update-product-sync-${product.id}-${sku}`,
      priority: "DEFAULT",
      retries: { retryCount: 2 },
    });
  }

  logger.info(
    {
      productId: product.id,
      articleNumbers: variants.map((variant) => variant.sku).filter(Boolean),
    },
    "Queued Shopify product title update to EasyCashier"
  );
};

/** @type { ActionOptions } */
export const options = {
  actionType: "update",
  triggers: {
    shopify: {
      triggerKey: "shopifyproduct-update",
    },
  },
};
