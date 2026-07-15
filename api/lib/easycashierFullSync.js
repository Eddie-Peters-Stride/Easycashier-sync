const SHOPIFY_PRODUCT_PAGE_SIZE = 250;
export const EASYCASHIER_SYNC_BATCH_SIZE = 250;
const EASYCASHIER_SYNC_QUEUE = { name: "easycashier-sync", maxConcurrency: 1 };

const configuredNumber = (envVarName, defaultValue) => {
  const rawValue = process.env[envVarName];
  const parsedValue = rawValue == null ? defaultValue : Number.parseInt(rawValue, 10);

  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : defaultValue;
};

export const EASYCASHIER_BULK_SYNC_QUEUE = {
  // Each job performs many Shopify GraphQL requests. Serialize by default so
  // Gadget's per-shop connection and rate-limit tracker are not contended.
  name: "easycashier-bulk-sync",
  maxConcurrency: configuredNumber("EASYCASHIER_BULK_SYNC_QUEUE_CONCURRENCY", 1),
};

const abortErrorForSync = () => {
  const error = new Error("EasyCashier full sync was cancelled");
  error.name = "AbortError";
  return error;
};

export const isRecordNotFoundError = (error) =>
  error?.code === "GGT_RECORD_NOT_FOUND" || String(error?.message ?? "").includes("GGT_RECORD_NOT_FOUND");

export const errorMessageForLog = (error) => error?.message ?? String(error);

export const isAbortError = (error) => error?.name === "AbortError" || error?.code === "ABORT_ERR";

export const chunkValues = (values, chunkSize) => {
  const list = Array.isArray(values) ? values : [];
  const size = Number.isFinite(Number(chunkSize)) && Number(chunkSize) > 0 ? Number(chunkSize) : list.length || 1;
  const chunks = [];

  for (let index = 0; index < list.length; index += size) {
    chunks.push(list.slice(index, index + size));
  }

  return chunks;
};

const throwIfAborted = (signal) => {
  if (typeof signal?.throwIfAborted === "function") {
    signal.throwIfAborted();
    return;
  }

  if (signal?.aborted) {
    throw abortErrorForSync();
  }
};

const idFromGid = (gid) => {
  if (typeof gid !== "string") {
    return null;
  }

  return gid.split("/").pop() || null;
};

const shopifyClientForShop = async ({ connections, shopId }) => {
  if (connections?.shopify?.current) {
    return connections.shopify.current;
  }

  if (shopId && connections?.shopify?.forShopId) {
    return await connections.shopify.forShopId(shopId);
  }

  return null;
};

const parseShopifyGraphqlResult = (result) => {
  const data = result?.data ?? result;
  const errors = data?.errors ?? result?.errors;

  if (Array.isArray(errors) && errors.length > 0) {
    throw new Error(`Shopify product list lookup failed: ${errors.map((error) => error.message).join(", ")}`);
  }

  return data;
};

export const collectShopifyProductIds = async ({ connections, shopId, signal }) => {
  const shopify = await shopifyClientForShop({ connections, shopId });

  if (!shopify) {
    throw new Error("Missing Shopify connection for EasyCashier full sync");
  }

  const query = `
    query EasyCashierProductIds($productCursor: String) {
      products(first: ${SHOPIFY_PRODUCT_PAGE_SIZE}, after: $productCursor) {
        nodes {
          id
          legacyResourceId
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;
  const productIds = [];
  let productCursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    throwIfAborted(signal);

    const result = await shopify.graphql(query, { productCursor });
    const data = parseShopifyGraphqlResult(result);
    const productPage = data?.products;

    for (const product of productPage?.nodes ?? []) {
      const productId =
        product?.legacyResourceId == null ? idFromGid(product?.id) : String(product.legacyResourceId);

      if (productId) {
        productIds.push(productId);
      }
    }

    hasNextPage = productPage?.pageInfo?.hasNextPage === true;
    productCursor = productPage?.pageInfo?.endCursor ?? null;
    throwIfAborted(signal);
  }

  return productIds;
};

export const EASYCASHIER_SYNC_PAGE_SIZE = SHOPIFY_PRODUCT_PAGE_SIZE;
export { EASYCASHIER_SYNC_QUEUE };
