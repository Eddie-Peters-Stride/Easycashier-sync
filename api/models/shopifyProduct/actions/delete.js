import { deleteRecord } from "gadget-server";
import { preventCrossShopDataAccess } from "gadget-server/shopify";
import { enqueueShopifyProductEasyCashierSync, isProductWebhookTrigger } from "../../../lib/manageProduct.js";

const skipsGadgetProductStorage = (trigger) =>
  ["shopify_webhook", "shopify_sync", "shopify_webhook_reconciliation"].includes(trigger?.type);

/** @type { ActionRun } */
export const run = async ({ params, record, logger, api, connections, trigger }) => {
  if (skipsGadgetProductStorage(trigger)) {
    return;
  }

  await preventCrossShopDataAccess(params, record);
  await deleteRecord(record);
};

/** @type { ActionOnSuccess } */
export const onSuccess = async ({ params, record, logger, api, connections, trigger }) => {
  if (isProductWebhookTrigger(trigger)) {
    return;
  }

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
};
