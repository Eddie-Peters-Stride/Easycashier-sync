import { ActionOptions } from "gadget-server";
import { sendEasyCashierProductPayload } from "../lib/easycashierApi.js";

const EASYCASHIER_PRODUCT_SYNC_ENDPOINT = "EASYCASHIER_API_BASE_URL/EASYCASHIER_COMPANY_ID/article";
const SHOPIFY_PRODUCT_PAGE_SIZE = 250;
const SYNC_ALL_EVENT = "sync-all";
const EASYCASHIER_SYNC_QUEUE = { name: "easycashier-sync", maxConcurrency: 1 };

export const params = {
  shopId: { type: "string" },
  progressLogId: { type: "string" },
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

const createProgressDetails = () => ({
  startedAt: new Date().toISOString(),
  finishedAt: null,
  totalProducts: null,
  processedProducts: 0,
  successProducts: 0,
  failureProducts: 0,
  failedProductIds: [],
});

const snapshotProgressDetails = (details) => ({
  ...details,
  failedProductIds: [...details.failedProductIds],
});

const errorMessageForLog = (error) => error?.message ?? String(error);

const safeUpdateProgressLog = async ({ api, logger, progressLogId, status, details, errorMessage = null }) => {
  if (!progressLogId) {
    return;
  }

  try {
    await api.internal.easycashierProductSyncLog.update(progressLogId, {
      status,
      details: snapshotProgressDetails(details),
      errorMessage,
    });
  } catch (error) {
    logger.error(
      {
        error,
        progressLogId,
        status,
      },
      "Failed to update EasyCashier full sync progress"
    );
  }
};

const collectShopifyProductIds = async ({ api, shopId }) => {
  const productIds = [];

  let after = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const productPage = await api.internal.shopifyProduct.findMany({
      filter: { shopId: { equals: shopId } },
      select: { id: true },
      first: SHOPIFY_PRODUCT_PAGE_SIZE,
      after: after ?? undefined,
      sort: { id: "Ascending" },
    });

    if (productPage.length === 0) {
      break;
    }

    for (const product of productPage) {
      const productId = product?.id == null ? null : String(product.id);

      if (productId) {
        productIds.push(productId);
      }
    }

    hasNextPage = productPage.pagination.pageInfo.hasNextPage === true;
    after = productPage.pagination.pageInfo.endCursor ?? null;
  }

  return productIds;
};

const syncSingleProduct = async ({ api, connections, logger, shopId, productId }) => {
  await sendEasyCashierProductPayload({
    api,
    params: {
      payload: {
        event: "updated",
        shopId,
        shopifyProductId: productId,
      },
    },
    logger,
    connections,
    endpoint: EASYCASHIER_PRODUCT_SYNC_ENDPOINT,
    endpointName: "edit",
    method: "PUT",
  });
};

const startFullSync = async ({ api, logger, shopId }) => {
  const progressDetails = createProgressDetails();
  const progressLog = await api.internal.easycashierProductSyncLog.create({
    event: SYNC_ALL_EVENT,
    shopId,
    status: "preparing",
    details: progressDetails,
  });

  try {
    const backgroundAction = await api.enqueue(
      api.syncAllProductsToEasyCashier,
      { shopId, progressLogId: progressLog.id },
      {
        queue: EASYCASHIER_SYNC_QUEUE,
        shopifyShop: shopId,
        retries: { retryCount: 2, initialInterval: 2000 },
      }
    );

    logger.info(
      {
        shopId,
        progressLogId: progressLog.id,
        backgroundActionId: backgroundAction.id,
      },
      "Queued EasyCashier full product sync"
    );

    return {
      shopId,
      progressLogId: progressLog.id,
      backgroundActionId: backgroundAction.id,
    };
  } catch (error) {
    progressDetails.finishedAt = new Date().toISOString();

    await safeUpdateProgressLog({
      api,
      logger,
      progressLogId: progressLog.id,
      status: "failed",
      details: progressDetails,
      errorMessage: errorMessageForLog(error),
    });

    throw error;
  }
};

const runFullSync = async ({ api, logger, connections, shopId, progressLogId }) => {
  const progressDetails = createProgressDetails();

  await safeUpdateProgressLog({
    api,
    logger,
    progressLogId,
    status: "preparing",
    details: progressDetails,
  });

  let productIds = [];

  try {
    productIds = await collectShopifyProductIds({ api, shopId });
  } catch (error) {
    progressDetails.finishedAt = new Date().toISOString();

    await safeUpdateProgressLog({
      api,
      logger,
      progressLogId,
      status: "failed",
      details: progressDetails,
      errorMessage: errorMessageForLog(error),
    });

    throw error;
  }

  progressDetails.totalProducts = productIds.length;

  await safeUpdateProgressLog({
    api,
    logger,
    progressLogId,
    status: "running",
    details: progressDetails,
  });

  for (const productId of productIds) {
    progressDetails.processedProducts += 1;

    try {
      await syncSingleProduct({
        api,
        connections,
        logger,
        shopId,
        productId,
      });
      progressDetails.successProducts += 1;
    } catch (error) {
      progressDetails.failureProducts += 1;

      if (progressDetails.failedProductIds.length < 10) {
        progressDetails.failedProductIds.push(productId);
      }

      logger.error(
        {
          error,
          shopId,
          productId,
          progressLogId,
        },
        "Failed to sync Shopify product to EasyCashier"
      );
    }

    await safeUpdateProgressLog({
      api,
      logger,
      progressLogId,
      status: "running",
      details: progressDetails,
    });
  }

  progressDetails.finishedAt = new Date().toISOString();

  await safeUpdateProgressLog({
    api,
    logger,
    progressLogId,
    status: "completed",
    details: progressDetails,
  });

  logger.info(
    {
      shopId,
      progressLogId,
      processedCount: progressDetails.processedProducts,
      successCount: progressDetails.successProducts,
      failureCount: progressDetails.failureProducts,
    },
    "Completed EasyCashier full product sync"
  );

  return {
    shopId,
    progressLogId,
    processedCount: progressDetails.processedProducts,
    successCount: progressDetails.successProducts,
    failureCount: progressDetails.failureProducts,
    failedProductIds: progressDetails.failedProductIds,
  };
};

/** @type { GlobalActionRun } */
export const run = async ({ params, logger, api, connections }) => {
  const shopId = shopIdFromContext({ params, connections });

  if (!shopId) {
    throw new Error("Missing Shopify shop id for EasyCashier full sync");
  }

  if (!params?.progressLogId) {
    return await startFullSync({ api, logger, shopId });
  }

  logger.info({ shopId, progressLogId: params.progressLogId }, "Starting EasyCashier full product sync");

  return await runFullSync({
    api,
    logger,
    connections,
    shopId,
    progressLogId: String(params.progressLogId),
  });
};

/** @type { ActionOptions } */
export const options = {
  triggers: { api: true },
};
