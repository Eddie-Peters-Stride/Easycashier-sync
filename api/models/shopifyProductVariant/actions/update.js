import { applyParams, save, ActionOptions } from "gadget-server";
import { preventCrossShopDataAccess } from "gadget-server/shopify";
import { enqueueShopifyProductVariantInventoryEasyCashierSync } from "../../../lib/manageProduct.js";

/** @type { ActionRun } */
export const run = async ({ params, record, logger, api, connections }) => {
  applyParams(params, record);
  await preventCrossShopDataAccess(params, record);
  await save(record);
};

/** @type { ActionOnSuccess } */
export const onSuccess = async ({ params, record, logger, api, connections, trigger }) => {
  await enqueueShopifyProductVariantInventoryEasyCashierSync({
    api,
    logger,
    trigger,
    record,
  });
};

/** @type { ActionOptions } */
export const options = { actionType: "update" };
