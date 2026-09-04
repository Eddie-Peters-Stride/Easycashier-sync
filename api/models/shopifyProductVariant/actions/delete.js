import { deleteRecord, ActionOptions } from "gadget-server";
import { preventCrossShopDataAccess } from "gadget-server/shopify";
import { EASYCASHIER_QUEUE } from "../../../lib/easycashierQueue.js";

/** @type { ActionRun } */
export const run = async ({ params, record, logger, api, connections }) => {
  const deletedVariant = {
    id: record.id,
    sku: record.sku,
    productId: record.productId,
    shopId: record.shopId,
  };

  await preventCrossShopDataAccess(params, record);
  params.__easyCashierDeletedVariant = deletedVariant;
  record.__easyCashierDeletedVariant = deletedVariant;
  await deleteRecord(record);
};

/** @type { ActionOnSuccess } */
export const onSuccess = async ({ params, record, logger, api, connections, trigger }) => {
  const deletedVariant = params.__easyCashierDeletedVariant ?? record.__easyCashierDeletedVariant;
  const sku = deletedVariant?.sku == null ? "" : String(deletedVariant.sku).trim();

  if (!sku) {
    logger.warn(
      {
        productId: deletedVariant?.productId,
        variantId: deletedVariant?.id,
      },
      "Skipped EasyCashier variant deletion because the Shopify SKU was missing"
    );
    return;
  }

  await api.enqueue(api.deleteProductSync, {
    shopId: String(deletedVariant.shopId),
    productId: String(deletedVariant.productId),
    productTitle: trigger?.payload?.title,
    productSkus: [sku],
  }, {
    queue: EASYCASHIER_QUEUE,
    id: `delete-product-sync-${deletedVariant.productId}-${sku}`,
    priority: "DEFAULT",
    retries: { retryCount: 2 },
  });

  logger.info(
    {
      productId: deletedVariant.productId,
      variantId: deletedVariant.id,
      sku,
    },
    "Queued deleted Shopify variant for EasyCashier deletion"
  );
};

/** @type { ActionOptions } */
export const options = { actionType: "delete" };
