import { applyParams, save, ActionOptions } from "gadget-server";
import { preventCrossShopDataAccess } from "gadget-server/shopify";

/** @type { ActionRun } */
export const run = async ({ params, record, logger, api, connections, trigger }) => {
  applyParams(params, record);
  await preventCrossShopDataAccess(params, record);
  await save(record);
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
