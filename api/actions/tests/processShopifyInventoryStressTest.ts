import { EasycashierClient } from "../../lib/EasycashierApiClient.js";
import { createEasyCashierRateLimiter } from "../../lib/easycashierRateLimit.js";
import {
  SHOPIFY_INVENTORY_STRESS_ADJUSTMENT_COUNT,
  SHOPIFY_INVENTORY_STRESS_CONFIRMATION,
  executeShopifyInventoryStressTest,
} from "../../lib/shopifyInventoryStressTest.js";

export const run: ActionRun = async ({ params, logger, api, connections }) => {
  if (process.env.GADGET_ENV === "production") {
    throw new Error("The Shopify inventory stress test cannot run in production");
  }

  const shopId = String(params.shopId ?? "").trim();
  const variantId = String(params.variantId ?? "").trim();
  const locationId = String(params.locationId ?? "").trim();
  const runId = String(params.runId ?? "").trim();

  if (!shopId || !variantId || !locationId || !runId) {
    throw new Error("The stress-test worker is missing its target or run ID");
  }

  if (params.confirmation !== SHOPIFY_INVENTORY_STRESS_CONFIRMATION) {
    throw new Error("The stress-test worker requires explicit destructive-test confirmation");
  }

  const shopify = await connections.shopify.forShopId(shopId);
  const easycashierClient = new EasycashierClient({
    rateLimiter: createEasyCashierRateLimiter({ api, logger }),
    logger,
  });

  logger.info(
    {
      adjustmentCount: SHOPIFY_INVENTORY_STRESS_ADJUSTMENT_COUNT,
      locationId,
      runId,
      shopId,
      variantId,
    },
    "Starting Shopify inventory and EasyCashier sales stress test"
  );

  const result = await executeShopifyInventoryStressTest({
    easycashierClient,
    locationId,
    logger,
    runId,
    shopify,
    variantId,
  });

  logger.info(result, "Completed Shopify inventory and EasyCashier sales stress test");
  return result;
};

export const params = {
  confirmation: { type: "string" },
  locationId: { type: "string" },
  runId: { type: "string" },
  shopId: { type: "string" },
  variantId: { type: "string" },
};

export const options = {
  timeoutMS: 900000,
  triggers: { api: true },
};
