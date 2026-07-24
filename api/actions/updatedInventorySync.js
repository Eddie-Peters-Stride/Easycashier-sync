import { ActionOptions } from "gadget-server";
import { enqueueShopifyInventoryLevelEasyCashierSync } from "../lib/manageProduct.js";
import { shopifyInventorySyncToEasyCashierEnabled } from "../lib/easycashierApi.js";

/** @type { GlobalActionRun } */
export const run = async ({ logger, api, connections, trigger }) => {
  if (!shopifyInventorySyncToEasyCashierEnabled()) {
    logger.info(
      {
        inventoryItemId: trigger?.payload?.inventory_item_id ?? null,
        locationId: trigger?.payload?.location_id ?? null,
      },
      "Skipped Shopify inventory sync because it is disabled by configuration"
    );
    return { success: true, skipped: true };
  }

  await enqueueShopifyInventoryLevelEasyCashierSync({
    api,
    logger,
    connections,
    trigger,
  });

  return { success: true, skipped: false };
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
