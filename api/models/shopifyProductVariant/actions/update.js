import { applyParams, save, ActionOptions } from "gadget-server";
import { preventCrossShopDataAccess } from "gadget-server/shopify";
import { enqueueShopifyProductVariantInventoryEasyCashierSync } from "../../../lib/manageProduct.js";

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
  await enqueueShopifyProductVariantInventoryEasyCashierSync({
    api,
    logger,
    trigger,
    record,
    previousSku: params.__easyCashierPreviousSku ?? record.__easyCashierPreviousSku,
  });
};

/** @type { ActionOptions } */
export const options = { actionType: "update" };
