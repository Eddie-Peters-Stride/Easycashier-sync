import { applyParams, save, ActionOptions } from "gadget-server";
import { preventCrossShopDataAccess } from "gadget-server/shopify";

/** @type { ActionRun } */
export const run = async ({ params, record, logger, api, connections, trigger }) => {
  applyParams(params, record);
  await preventCrossShopDataAccess(params, record);
  await save(record);
};

/** @type { ActionOnSuccess } */
export const onSuccess = async ({ params, record, logger, api, connections, trigger }) => {
  await api.enqueue(api.createProductSync, {
    payload: {
      shopId: record.shopId,
      product: trigger.payload,
    }
  })
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
