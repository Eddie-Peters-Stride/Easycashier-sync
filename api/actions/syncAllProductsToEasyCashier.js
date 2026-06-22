import {
  collectShopifyProductIds,
  chunkValues,
  EASYCASHIER_SYNC_BATCH_SIZE,
  EASYCASHIER_BULK_SYNC_QUEUE,
  errorMessageForLog,
  isAbortError,
  isRecordNotFoundError,
} from "../lib/easycashierFullSync.js";

export const params = {
  shopId: { type: "string" },
  backgroundActionId: { type: "string" },
};

const shopIdFromContext = ({ params, connections }) => {
  if (params?.shopId) {
    return String(params.shopId);
  }

  if (connections?.shopify?.currentShopId != null) {
    return String(connections.shopify.currentShopId);
  }

  return null;
};

const cancelQueuedSync = async ({ api, logger, shopId, backgroundActionId }) => {
  try {
    await api.handle(api.syncAllProductsToEasyCashier, backgroundActionId).cancel();
  } catch (error) {
    if (!isRecordNotFoundError(error)) {
      throw error;
    }

    logger.warn(
      {
        shopId,
        backgroundActionId,
      },
      "Skipped cancelling EasyCashier full product sync because the background action no longer exists"
    );
  }

  logger.info(
    {
      shopId,
      backgroundActionId,
    },
    "Cancelled EasyCashier full product sync"
  );

  return {
    shopId,
    backgroundActionId,
    status: "cancelled",
  };
};

const startQueuedSync = async ({ api, logger, connections, shopId, signal }) => {
  try {
    const productIds = await collectShopifyProductIds({ connections, shopId, signal });
    const productBatches = chunkValues(productIds, EASYCASHIER_SYNC_BATCH_SIZE);
    const syncRunId = `${shopId}:${Date.now().toString(36)}`;
    const batchBackgroundActionIds = [];

    if (productIds.length === 0) {
      logger.info(
        {
          shopId,
        },
        "Completed EasyCashier full product sync without any products to process"
      );

      return {
        shopId,
        status: "completed",
        totalProducts: 0,
        queuedBatchCount: 0,
        batchBackgroundActionIds: [],
      };
    }

    for (const [batchIndex, batchProductIds] of productBatches.entries()) {
      const batchNumber = batchIndex + 1;

      const batchHandle = await api.enqueue(
        api.syncEasyCashierBulkProducts,
        {
          payload: {
            shopId,
            productIds: batchProductIds,
            batchNumber,
            batchCount: productBatches.length,
          },
        },
        {
          id: `${syncRunId}:batch:${batchIndex}`,
          queue: EASYCASHIER_BULK_SYNC_QUEUE,
          shopifyShop: shopId,
          retries: { retryCount: 1, initialInterval: 2000 },
        }
      );

      if (batchHandle?.id) {
        batchBackgroundActionIds.push(String(batchHandle.id));
      }
    }

    logger.info(
      {
        shopId,
        queuedBatchCount: productBatches.length,
        queuedProductCount: productIds.length,
      },
      "Queued EasyCashier full product sync jobs"
    );

    return {
      shopId,
      status: productIds.length === 0 ? "completed" : "queued",
      totalProducts: productIds.length,
      queuedBatchCount: productBatches.length,
      batchBackgroundActionIds,
    };
  } catch (error) {
    if (isAbortError(error)) {
      logger.info(
        {
          shopId,
        },
        "Cancelled EasyCashier full product sync"
      );
    } else {
      logger.error(
        {
          shopId,
          errorMessage: errorMessageForLog(error),
        },
        "Failed to queue EasyCashier full product sync"
      );
    }

    throw error;
  }
};

/** @type { GlobalActionRun } */
export const run = async ({ params, logger, api, connections, signal }) => {
  const shopId = shopIdFromContext({ params, connections });

  if (!shopId) {
    throw new Error("Missing Shopify shop id for EasyCashier full sync");
  }

  if (params?.backgroundActionId) {
    return await cancelQueuedSync({
      api,
      logger,
      shopId,
      backgroundActionId: String(params.backgroundActionId),
    });
  }

  return await startQueuedSync({ api, logger, connections, shopId, signal });
};

/** @type { ActionOptions } */
export const options = {
  triggers: { api: true },
  timeoutMS: 900000,
};
