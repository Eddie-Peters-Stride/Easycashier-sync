import { sendEasyCashierProductPayload } from "../lib/easycashierApi.js";

const EASYCASHIER_PRODUCT_SYNC_ENDPOINT = "EASYCASHIER_API_BASE_URL/EASYCASHIER_COMPANY_ID/article";

export const params = {
  payload: { type: "object", additionalProperties: true },
};

/** @type { GlobalActionRun } */
export const run = async ({ params, logger, api, connections }) => {
  const payload = params?.payload ?? {};
  const shopId = payload?.shopId == null ? null : String(payload.shopId);
  const productId = payload?.shopifyProductId == null ? null : String(payload.shopifyProductId);

  if (!shopId || !productId) {
    throw new Error("Missing Shopify product details for EasyCashier product sync");
  }

  const result = await sendEasyCashierProductPayload({
    api,
    params: {
      payload,
    },
    logger,
    connections,
    endpoint: EASYCASHIER_PRODUCT_SYNC_ENDPOINT,
    endpointName: "edit",
    method: "PUT",
  });

  return {
    shopId,
    productId,
    status: "success",
    ...result,
  };
};

/** @type { ActionOptions } */
export const options = {
  triggers: { api: true },
  timeoutMS: 900000, // 15 minutes
};
