import { sendEasyCashierBulkProductImport } from "../lib/easycashierApi.js";

export const params = {
  payload: { type: "object", additionalProperties: true },
};

/** @type { GlobalActionRun } */
export const run = async ({ params, logger, connections, signal }) => {
  const payload = params?.payload ?? {};
  const shopId = payload?.shopId == null ? null : String(payload.shopId);
  const batchNumber = Number(payload?.batchNumber);
  const batchCount = Number(payload?.batchCount);
  const hasBatchProgress =
    Number.isFinite(batchNumber) && batchNumber > 0 && Number.isFinite(batchCount) && batchCount > 0;
  const productIds = Array.isArray(payload?.productIds)
    ? payload.productIds
      .map((productId) => (productId == null ? null : String(productId)))
      .filter((productId) => productId != null && productId !== "")
    : [];

  if (!shopId || productIds.length === 0) {
    throw new Error("Missing Shopify product ids for EasyCashier bulk sync job");
  }

  const result = await sendEasyCashierBulkProductImport({
    logger,
    connections,
    shopId,
    productIds,
    signal,
    batchNumber: hasBatchProgress ? batchNumber : null,
    batchCount: hasBatchProgress ? batchCount : null,
  });

  return {
    shopId,
    productIds,
    batchNumber: hasBatchProgress ? batchNumber : null,
    batchCount: hasBatchProgress ? batchCount : null,
    status: result.uploadAttempted ? "completed" : "skipped",
    success: result.uploadAttempted,
    importedProductCount: result.successProductIds.length,
    failedProductCount: result.failedProductIds.length,
    importedRowCount: result.importedRowCount,
  };
};

/** @type { ActionOptions } */
export const options = {
  triggers: { api: true },
  timeoutMS: 900000, // supported maximum timeout (15 minutes)
};
