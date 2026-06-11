import { deleteRecord, ActionOptions } from "gadget-server";
import { preventCrossShopDataAccess } from "gadget-server/shopify";
import { enqueueShopifyProductVariantDeleteEasyCashierSync } from "../../../lib/manageProduct.js";

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
  await enqueueShopifyProductVariantDeleteEasyCashierSync({
    api,
    logger,
    trigger,
    record,
    deletedVariant: params.__easyCashierDeletedVariant ?? record.__easyCashierDeletedVariant,
  });
};

/** @type { ActionOptions } */
export const options = { actionType: "delete" };
