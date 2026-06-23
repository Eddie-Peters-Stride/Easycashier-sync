import { enqueueShopifyProductEasyCashierSync, isProductWebhookTrigger } from "../lib/manageProduct.js";
import { sendEasyCashierProductPayload } from "../lib/easycashierApi.js";

export const params = {
  payload: { type: "object", additionalProperties: true },
};

/** @type { GlobalActionRun } */
export const run = async ({ params, logger, api, connections, trigger }) => {
  if (isProductWebhookTrigger(trigger)) {
    await enqueueShopifyProductEasyCashierSync({
      api,
      logger,
      trigger,
      fallbackEvent: "deleted",
    });

    return {
      success: true,
      queued: true,
    };
  }

  return await sendEasyCashierProductPayload({
    api,
    params,
    logger,
    connections,
    endpoint: "EASYCASHIER_API_BASE_URL/EASYCASHIER_COMPANY_ID/article",
    endpointName: "delete",
    method: "DELETE",
  });
};

/** @type { ActionOptions } */
export const options = {
  timeoutMS: 900000,
  triggers: {
    api: true,
    shopify: {
      triggerKey: "shopifyproduct-delete",
    },
  },
};
