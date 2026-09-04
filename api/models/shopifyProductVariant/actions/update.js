import { applyParams, save, ActionOptions } from "gadget-server";
import { preventCrossShopDataAccess } from "gadget-server/shopify";
import { EASYCASHIER_QUEUE } from "../../../lib/easycashierQueue.js";

/** @type { ActionRun } */
export const run = async ({ params, record, logger, api, connections }) => {
  const previousSku = record.sku;

  applyParams(params, record);
  record.__easyCashierPreviousSku = previousSku;

  await preventCrossShopDataAccess(params, record);
  params.__easyCashierPreviousSku = previousSku;
  await save(record);
};

/** @type { ActionOnSuccess } */
export const onSuccess = async ({ params, record, logger, api, connections, trigger }) => {
  const skuChanged = record.changed("sku");
  const barcodeChanged = record.changed("barcode");
  const priceChanged = record.changed("price");

  if (!skuChanged && !barcodeChanged && !priceChanged) {
    return;
  }

  if (skuChanged) {
    const previousSkuValue = params.__easyCashierPreviousSku ?? record.__easyCashierPreviousSku;
    const previousSku = previousSkuValue == null ? "" : String(previousSkuValue).trim();
    const newSku = record.sku == null ? "" : String(record.sku).trim();
    const shopId = String(record.shopId ?? trigger?.shopId);

    if (!newSku) {
      if (previousSku) {
        await api.enqueue(api.deleteProductSync, {
          shopId,
          productId: String(record.productId),
          productTitle: trigger?.payload?.title,
          productSkus: [previousSku],
        }, {
          queue: EASYCASHIER_QUEUE,
          id: `delete-product-sync-${record.productId}-${previousSku}`,
          priority: "DEFAULT",
          retries: { retryCount: 2 },
        });
      }

      logger.warn(
        { variantId: record.id, previousSku },
        "Deleted the previous EasyCashier article without creating a replacement because the new Shopify SKU is empty"
      );
      return;
    }

    if (previousSku !== newSku) {
      const webhookProduct = trigger?.payload;
      const productId = webhookProduct?.id ?? record.productId;
      let productTitle = webhookProduct?.title;

      if (productTitle == null && productId != null) {
        const storedProduct = await api.shopifyProduct.findOne(String(productId), {
          select: { id: true, title: true },
        });
        productTitle = storedProduct.title;
      }

      const webhookVariant = Array.isArray(webhookProduct?.variants)
        ? webhookProduct.variants.find((variant) => String(variant.id) === String(record.id))
        : null;
      const product = {
        id: productId,
        title: productTitle ?? "",
        variants: [{
          ...webhookVariant,
          id: record.id,
          sku: newSku,
          barcode: record.barcode,
          price: record.price,
        }],
      };

      if (previousSku) {
        await api.enqueue(api.replaceProductSkuSync, {
          shopId,
          previousSku,
          previousTitle: productTitle,
          product,
        }, {
          queue: EASYCASHIER_QUEUE,
          id: `replace-product-sku-sync-${product.id}-${previousSku}-${newSku}`,
          priority: "DEFAULT",
          retries: { retryCount: 2 },
        });
      } else {
        await api.enqueue(api.createProductSync, {
          shopId,
          product,
        }, {
          queue: EASYCASHIER_QUEUE,
          id: `create-product-sync-${product.id}`,
          priority: "DEFAULT",
          retries: { retryCount: 2 },
        });
      }

      logger.info(
        {
          variantId: record.id,
          previousSku,
          newSku,
        },
        previousSku
          ? "Queued EasyCashier article replacement after Shopify SKU change"
          : "Queued EasyCashier article creation after Shopify SKU was assigned"
      );
      return;
    }
  }

  const previousSku = params.__easyCashierPreviousSku ?? record.__easyCashierPreviousSku;
  const lookupArticleNumber = previousSku == null ? "" : String(previousSku).trim();

  if (!lookupArticleNumber) {
    logger.warn(
      { variantId: record.id },
      "Skipped EasyCashier variant update because the Shopify SKU was missing"
    );
    return;
  }

  const changes = {};

  if (barcodeChanged) {
    changes.barcode = record.barcode == null ? null : String(record.barcode);
  }

  if (priceChanged) {
    changes.retailPriceIncludingVat = record.price;
  }

  if (Object.keys(changes).length === 0) {
    return;
  }

  await api.enqueue(api.updateProductSync, {
    shopId: String(record.shopId ?? trigger?.shopId),
    productId: String(record.productId),
    productTitle: trigger?.payload?.title,
    lookupArticleNumber,
    changes,
  }, {
    queue: EASYCASHIER_QUEUE,
    id: `update-product-sync-${record.productId}-${lookupArticleNumber}`,
    priority: "DEFAULT",
    retries: { retryCount: 2 },
  });

  logger.info(
    {
      variantId: record.id,
      lookupArticleNumber,
      changedFields: Object.keys(changes),
    },
    "Queued changed Shopify variant fields for EasyCashier update"
  );
};

/** @type { ActionOptions } */
export const options = { actionType: "update" };
