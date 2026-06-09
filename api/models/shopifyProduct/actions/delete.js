import { deleteRecord, ActionOptions } from "gadget-server";
import { preventCrossShopDataAccess } from "gadget-server/shopify";
import { enqueueShopifyProductEasyCashierSync } from "../../../lib/manageProduct.js";

/** @type { ActionRun } */
export const run = async ({ params, record, logger, api, connections }) => {
  await preventCrossShopDataAccess(params, record);
  await deleteRecord(record);
};

/** @type { ActionOnSuccess } */
export const onSuccess = async ({ params, record, logger, api, connections, trigger }) => {
  console.log(JSON.stringify(trigger));
  console.log(JSON.stringify(params));
  console.log(JSON.stringify(record));


  await enqueueShopifyProductEasyCashierSync({
    api,
    logger,
    trigger,
    record,
    fallbackEvent: "deleted",
  });
};

/** @type { ActionOptions } */
export const options = {
  actionType: "delete",
  triggers: {
    shopify: {
      triggerKey: "shopifyproduct-delete",
    },
  },
};
