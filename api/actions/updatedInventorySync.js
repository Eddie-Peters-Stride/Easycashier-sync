import { ActionOptions } from "gadget-server";
import { enqueueShopifyInventoryLevelEasyCashierSync } from "../lib/manageProduct.js";

/** @type { GlobalActionRun } */
export const run = async ({ logger, api, connections, trigger }) => {
  await enqueueShopifyInventoryLevelEasyCashierSync({
    api,
    logger,
    connections,
    trigger,
  });

  return { success: true };
};

/** @type { ActionOptions } */
export const options = {
  timeoutMS: 900000,
  triggers: {
    api: true,
    shopify: {
      triggerKey: "shopifyinventorylevel-update",
    },
  },
};
