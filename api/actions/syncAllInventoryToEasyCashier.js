import {
  EASYCASHIER_INVENTORY_SYNC_QUEUE,
} from "../lib/easycashierFullSync.js";
import { shopifyInventorySyncToEasyCashierEnabled } from "../lib/easycashierApi.js";

export const params = {
  shopId: { type: "string" },
  shopifyProductIds: { type: "array", items: { type: "string" } },
};

const MAX_SCOPED_PRODUCT_IDS = 20;

const scopedProductIdsFromParams = (params) => {
  if (params?.shopifyProductIds == null) return null;
  if (!Array.isArray(params.shopifyProductIds)) {
    throw new Error("shopifyProductIds must be an array of Shopify product ids");
  }

  const productIds = [...new Set(
    params.shopifyProductIds
      .map((productId) => (productId == null ? "" : String(productId).trim()))
      .filter(Boolean)
  )];

  if (productIds.length === 0) {
    throw new Error("shopifyProductIds must contain at least one Shopify product id");
  }

  if (productIds.length > MAX_SCOPED_PRODUCT_IDS) {
    throw new Error(`shopifyProductIds supports at most ${MAX_SCOPED_PRODUCT_IDS} products per test run`);
  }

  return productIds;
};

/** @type { GlobalActionRun } */
export const run = async ({ params, logger, api, connections }) => {
  const shopId = params?.shopId ?? connections?.shopify?.currentShopId ?? null;
  const shopifyProductIds = scopedProductIdsFromParams(params);

  if (!shopId) throw new Error("Missing Shopify shop id for EasyCashier full inventory sync");

  if (!shopifyInventorySyncToEasyCashierEnabled()) {
    logger.info({ shopId }, "Skipped EasyCashier full inventory sync because inventory syncing is disabled");
    return {
      shopId: String(shopId),
      status: "skipped",
      backgroundActionId: null,
      shopifyProductIds,
    };
  }

  const runId = `${String(shopId)}:${Date.now().toString(36)}`;
  const handle = await api.enqueue(
    api.syncEasyCashierInventoryBatch,
    {
      payload: {
        shopId: String(shopId),
        runId,
        shopifyProductIds,
      },
    },
    {
      id: `${runId}:inventory:1`,
      queue: EASYCASHIER_INVENTORY_SYNC_QUEUE,
      shopifyShop: String(shopId),
      retries: {
        retryCount: 5,
        initialInterval: 2000,
        maxInterval: 60000,
        backoffFactor: 2,
        randomizeInterval: true,
      },
    }
  );

  logger.info(
    {
      shopId,
      runId,
      backgroundActionId: handle?.id ?? null,
      scopedProductCount: shopifyProductIds?.length ?? null,
    },
    shopifyProductIds
      ? "Queued scoped EasyCashier inventory bulk sync"
      : "Queued EasyCashier full inventory sync"
  );

  return {
    shopId: String(shopId),
    status: "queued",
    backgroundActionId: handle?.id == null ? null : String(handle.id),
    shopifyProductIds,
  };
};

/** @type { ActionOptions } */
export const options = {
  triggers: { api: true },
  timeoutMS: 900000,
};
