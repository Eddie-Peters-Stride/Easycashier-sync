import { randomUUID } from "node:crypto";
import { EASYCASHIER_QUEUE } from "../lib/easycashierQueue.js";
import {
  SHOPIFY_INVENTORY_STRESS_ADJUSTMENT_COUNT,
  SHOPIFY_INVENTORY_STRESS_CONFIRMATION,
} from "../lib/shopifyInventoryStressTest.js";

export const run: ActionRun = async ({ params, logger, api, connections }) => {
  if (process.env.GADGET_ENV === "production") {
    throw new Error("The Shopify inventory stress test cannot run in production");
  }

  const shopId = String(params.shopId ?? "").trim();
  const variantId = String(params.variantId ?? "").trim();
  const locationId = String(params.locationId ?? "").trim();

  if (!shopId || !variantId || !locationId) {
    throw new Error("The stress test requires shopId, variantId, and locationId");
  }

  if (params.confirmation !== SHOPIFY_INVENTORY_STRESS_CONFIRMATION) {
    throw new Error(
      `Set confirmation to ${SHOPIFY_INVENTORY_STRESS_CONFIRMATION} to run this destructive test`
    );
  }

  const runId = randomUUID();
  const targetKey = `${shopId}-${variantId.split("/").pop()}-${locationId.split("/").pop()}`;
  const job = await api.enqueue(
    api.processShopifyInventoryStressTest,
    {
      confirmation: SHOPIFY_INVENTORY_STRESS_CONFIRMATION,
      locationId,
      runId,
      shopId,
      variantId,
    },
    {
      id: `shopify-inventory-stress-${targetKey}`,
      queue: EASYCASHIER_QUEUE,
      retries: { retryCount: 1 },
    }
  );

  logger.info(
    { jobId: job?.id ?? null, locationId, runId, shopId, variantId },
    "Queued Shopify inventory and EasyCashier sales stress test"
  );

  return {
    queued: true,
    adjustmentCount: SHOPIFY_INVENTORY_STRESS_ADJUSTMENT_COUNT,
    jobId: job?.id ?? null,
    locationId,
    runId,
    salesRequestCount: SHOPIFY_INVENTORY_STRESS_ADJUSTMENT_COUNT,
    shopId,
    variantId,
  };
};

export const params = {
  confirmation: { type: "string" },
  locationId: { type: "string" },
  shopId: { type: "string" },
  variantId: { type: "string" },
};

export const options = {
  triggers: { api: true },
};
