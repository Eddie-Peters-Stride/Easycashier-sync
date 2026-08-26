import {
  fetchEasyCashierInventorySnapshot,
  fetchFreshShopifyProductRows,
  sendEasyCashierInventoryBatch,
  sendEasyCashierInventoryFromSnapshot,
} from "../lib/easycashierApi.js";
import { fetchAllShopifyInventoryRows } from "../lib/easycashierInventoryFullSync.js";

export const params = {
  payload: { type: "object", additionalProperties: true },
};

const fetchScopedProductRows = async ({ connections, shopId, shopifyProductIds, signal }) => {
  const products = [];

  // Keep Shopify calls serial just like the full product importer. Gadget's
  // per-shop rate-limit tracker can otherwise be contended by a test scope.
  for (const shopifyProductId of shopifyProductIds) {
    if (typeof signal?.throwIfAborted === "function") signal.throwIfAborted();

    products.push(...await fetchFreshShopifyProductRows({
      connections,
      payload: { shopId, shopifyProductId },
    }));
  }

  return products;
};

/** @type { GlobalActionRun } */
export const run = async ({ params, logger, api, connections, signal }) => {
  const payload = params?.payload ?? {};
  const shopId = payload.shopId == null ? null : String(payload.shopId);
  const runId = payload.runId == null ? null : String(payload.runId);
  const shopifyProductIds = Array.isArray(payload.shopifyProductIds)
    ? payload.shopifyProductIds.map(String)
    : null;

  if (!shopId || !runId) throw new Error("Missing full inventory sync batch context");

  let result;
  let shopifyPageCount = null;
  let easyCashierSnapshotRequestCount = null;

  if (shopifyProductIds) {
    const products = await fetchScopedProductRows({ connections, shopId, shopifyProductIds, signal });
    result = await sendEasyCashierInventoryBatch({
      api,
      logger,
      products,
      signal,
      recordCompletion: false,
    });
  } else {
    // The two read-only snapshots are independent, so fetch them concurrently.
    // Both remain in memory only for this background action.
    const [shopifyInventory, easyCashierSnapshot] = await Promise.all([
      fetchAllShopifyInventoryRows({ connections, shopId, signal }),
      fetchEasyCashierInventorySnapshot({ logger, signal }),
    ]);
    shopifyPageCount = shopifyInventory.pageCount;
    easyCashierSnapshotRequestCount = easyCashierSnapshot.requestCount;
    result = await sendEasyCashierInventoryFromSnapshot({
      logger,
      products: shopifyInventory.products,
      snapshot: easyCashierSnapshot,
      signal,
    });
  }

  logger.info(
    {
      shopId,
      runId,
      scopedProductCount: shopifyProductIds?.length ?? null,
      shopifyPageCount,
      easyCashierSnapshotRequestCount,
      ...result,
    },
    "Completed EasyCashier full inventory sync"
  );

  return {
    shopId,
    runId,
    status: "completed",
    shopifyProductIds,
    shopifyPageCount,
    easyCashierSnapshotRequestCount,
    ...result,
  };
};

/** @type { ActionOptions } */
export const options = {
  triggers: { api: true },
  timeoutMS: 900000,
};
