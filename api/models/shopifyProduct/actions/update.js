import { applyParams, save, ActionOptions } from "gadget-server";
import { preventCrossShopDataAccess } from "gadget-server/shopify";
import { enqueueShopifyProductEasyCashierSync } from "../../../lib/manageProduct.js";

/** @type { ActionRun } */
export const run = async ({ params, record, logger, api, connections, trigger }) => {
  applyParams(params, record);
  await preventCrossShopDataAccess(params, record);
  await save(record);
};

/** @type { ActionOnSuccess } */
export const onSuccess = async ({ params, record, logger, api, connections, trigger }) => {
  const titleChanged = record.changed("title");

  if (titleChanged) {
    await api.enqueue(api.createProductSync, {
      payload: {
        shopId: record.shopId,
        record,
        params
      }
    })
  }
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
