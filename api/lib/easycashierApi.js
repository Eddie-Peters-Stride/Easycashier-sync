const authHeaders = () => {
  const headers = {
    "Content-Type": "application/json",
  };

  if (process.env.EASYCASHIER_API_TOKEN) {
    headers["X-Api-Key"] = `${process.env.EASYCASHIER_API_TOKEN}`;
  }

  return headers;
};

const ARTICLE_NOT_FOUND_CODE = "EASYCASHIER_ARTICLE_NOT_FOUND";

const textForLog = (value, maxLength = 2000) => {
  if (value == null) {
    return null;
  }

  const text = typeof value === "string" ? value : JSON.stringify(value);

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}...`;
};

const errorMessageForLog = (error) => error?.message ?? String(error);

const createProductSyncLog = async ({
  api,
  payload,
  status,
  details = null,
  errorMessage = null,
  easycashierArticleNumber = null,
}) => {
  await api.internal.easycashierProductSyncLog.create({
    event: payload?.event ?? null,
    shopId: payload?.shopId ?? null,
    shopifyProductId: payload?.shopifyProductId ?? null,
    status,
    details,
    errorMessage,
    easycashierArticleNumber,
  });
};

const recordProductSyncFailure = async ({ api, payload, logger, error, details, easycashierArticleNumber }) => {
  try {
    await createProductSyncLog({
      api,
      payload,
      status: "failed",
      details,
      errorMessage: errorMessageForLog(error),
      easycashierArticleNumber,
    });
  } catch (logError) {
    logger.error(
      {
        error: logError,
        originalError: error,
        event: payload?.event,
        productId: payload?.shopifyProductId,
      },
      "Failed to record EasyCashier product sync failure"
    );
  }
};

const resolveEndpoint = (endpoint) => {
  const missingEnvVars = new Set();
  const resolvedEndpoint = endpoint.replace(/\bEASYCASHIER_[A-Z0-9_]+\b/g, (envVarName) => {
    const value = process.env[envVarName];

    if (!value) {
      missingEnvVars.add(envVarName);
      return envVarName;
    }

    return value;
  });

  if (missingEnvVars.size > 0) {
    throw new Error(`Missing EasyCashier environment variable(s): ${Array.from(missingEnvVars).join(", ")}`);
  }

  return resolvedEndpoint.replace(/([^:])\/{2,}/g, "$1/");
};

const DEFAULT_VAT_RATE = 25;

const configuredVatRate = () => {
  const rawRate = process.env.SHOPIFY_PRODUCT_DEFAULT_VAT_RATE;
  const parsedRate = rawRate == null ? DEFAULT_VAT_RATE : Number.parseFloat(rawRate);

  return Number.isFinite(parsedRate) ? parsedRate : DEFAULT_VAT_RATE;
};

const vatForTaxable = (taxable) => {
  if (taxable === false) {
    return 0;
  }

  return configuredVatRate();
};

const idFromGid = (gid) => {
  if (typeof gid !== "string") {
    return null;
  }

  return gid.split("/").pop() || null;
};

const productGidFromPayload = (payload) => {
  if (payload?.shopifyProductGid) {
    return payload.shopifyProductGid;
  }

  if (payload?.admin_graphql_api_id) {
    return payload.admin_graphql_api_id;
  }

  if (payload?.shopifyProductId) {
    if (String(payload.shopifyProductId).startsWith("gid://")) {
      return payload.shopifyProductId;
    }

    return `gid://shopify/Product/${payload.shopifyProductId}`;
  }

  return null;
};

const normalizeShopifyVariant = (variant) => ({
  id: variant?.legacyResourceId == null ? idFromGid(variant?.id) : String(variant.legacyResourceId),
  gid: typeof variant?.id === "string" && variant.id.startsWith("gid://") ? variant.id : variant?.admin_graphql_api_id ?? null,
  sku: variant?.sku ?? null,
  price: typeof variant?.price === "object" ? variant.price?.amount : variant?.price ?? null,
  barcode: variant?.barcode ?? null,
  taxable: variant?.taxable ?? null,
  inventoryQuantity: variant?.inventoryQuantity ?? null,
});

const productRowsFromPayload = (payload) => {
  if (!Array.isArray(payload?.products)) {
    return [];
  }

  return payload.products;
};

const deleteProductRowFromPayload = (payload) => {
  const firstProductRow = productRowsFromPayload(payload)[0] ?? {};
  const shopifyProductId = payload?.shopifyProductId ?? firstProductRow?.shopifyProductId ?? payload?.productId ?? payload?.id;

  if (!shopifyProductId) {
    throw new Error("Missing Shopify product id in EasyCashier delete payload");
  }

  return {
    shopifyProductId: String(shopifyProductId),
    shopifyVariantId: firstProductRow?.shopifyVariantId ?? null,
    shopifyVariantGid: firstProductRow?.shopifyVariantGid ?? null,
    artikelnummer: firstProductRow?.artikelnummer ?? firstProductRow?.sku ?? null,
    produktnamn: payload?.produktnamn ?? firstProductRow?.produktnamn ?? null,
    pris: firstProductRow?.pris ?? null,
    ean: firstProductRow?.ean ?? null,
    moms: firstProductRow?.moms ?? null,
  };
};

const buildProductRows = ({ productId, productName, variants }) => {
  return variants.map((variant) => ({
    shopifyProductId: productId,
    shopifyVariantId: variant.id,
    shopifyVariantGid: variant.gid,
    artikelnummer: variant.sku,
    produktnamn: productName,
    pris: variant.price,
    ean: variant.barcode,
    moms: vatForTaxable(variant.taxable),
    inventoryQuantity: variant.inventoryQuantity,
  }));
};

const shopifyClientForPayload = async ({ connections, payload }) => {
  if (connections?.shopify?.current) {
    return connections.shopify.current;
  }

  if (payload?.shopId && connections?.shopify?.forShopId) {
    return await connections.shopify.forShopId(payload.shopId);
  }

  return null;
};

const parseShopifyGraphqlResult = (result) => {
  const data = result?.data ?? result;
  const errors = data?.errors ?? result?.errors;

  if (Array.isArray(errors) && errors.length > 0) {
    throw new Error(`Shopify product lookup failed: ${errors.map((error) => error.message).join(", ")}`);
  }

  return data;
};

const fetchFreshShopifyProductRows = async ({ connections, payload }) => {
  const productGid = productGidFromPayload(payload);

  if (!productGid) {
    throw new Error("Missing Shopify product id in EasyCashier product payload");
  }

  const shopify = await shopifyClientForPayload({ connections, payload });

  if (!shopify) {
    throw new Error("Missing Shopify connection for EasyCashier product sync");
  }

  const query = `
    query EasyCashierProduct($id: ID!, $variantCursor: String) {
      product(id: $id) {
        id
        legacyResourceId
        title
        variants(first: 250, after: $variantCursor) {
          nodes {
            id
            legacyResourceId
            sku
            barcode
            taxable
            price
            inventoryQuantity
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  `;
  const variants = [];
  let product = null;
  let variantCursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const result = await shopify.graphql(query, {
      id: productGid,
      variantCursor,
    });
    const data = parseShopifyGraphqlResult(result);

    product = data?.product;

    if (!product) {
      throw new Error(`Shopify product ${productGid} was not found`);
    }

    variants.push(...(product.variants?.nodes ?? []).map(normalizeShopifyVariant));
    hasNextPage = product.variants?.pageInfo?.hasNextPage === true;
    variantCursor = product.variants?.pageInfo?.endCursor ?? null;
  }

  if (variants.length === 0) {
    throw new Error(`No Shopify variants found for product ${productGid}`);
  }

  return buildProductRows({
    productId: product.legacyResourceId == null ? idFromGid(product.id) : String(product.legacyResourceId),
    productName: product.title ?? payload?.produktnamn ?? null,
    variants,
  });
};

const productRowsForRequest = async ({ endpointName, payload, connections }) => {
  if (endpointName === "delete") {
    return [deleteProductRowFromPayload(payload)];
  }

  const payloadRows = productRowsFromPayload(payload);

  if (payloadRows.length > 0) {
    return payloadRows;
  }

  return await fetchFreshShopifyProductRows({
    connections,
    payload,
  });
};

const articleNumberFromProduct = (product) => {
  const articleNumber = product?.shopifyProductId ?? product?.articleNumber ?? product?.artikelnummer ?? product?.sku;

  if (!articleNumber) {
    throw new Error("Missing Shopify product id or SKU in EasyCashier product payload");
  }

  return String(articleNumber);
};

function optionalNumberFromValue(value) {
  if (value == null || value === "") {
    return null;
  }

  const number = Number(String(value).replace(",", "."));

  return Number.isFinite(number) ? number : value;
}

const inventoryQuantityFromProduct = (product) =>
  optionalNumberFromValue(
    product?.inventoryQuantity ??
      product?.inventory_quantity ??
      product?.available ??
      product?.stockQuantity ??
      product?.quantity
  );

const productDetailsForLog = (product) => ({
  shopifyProductId: product?.shopifyProductId ?? null,
  shopifyVariantId: product?.shopifyVariantId ?? null,
  articleNumber: articleNumberFromProduct(product),
  sku: product?.artikelnummer ?? product?.sku ?? null,
  name: product?.produktnamn ?? product?.title ?? product?.description ?? null,
  price: product?.pris ?? product?.price ?? null,
  ean: product?.ean ?? product?.barcode ?? null,
  vat: product?.moms ?? null,
  inventoryQuantity: inventoryQuantityFromProduct(product),
});

const articleNumbersForLookup = (product) => {
  const articleNumbers = [
    product?.shopifyProductId,
    product?.articleNumber,
    product?.artikelnummer,
    product?.sku,
  ]
    .filter((articleNumber) => articleNumber != null && articleNumber !== "")
    .map((articleNumber) => String(articleNumber));

  const uniqueArticleNumbers = [...new Set(articleNumbers)];

  if (uniqueArticleNumbers.length === 0) {
    throw new Error("Missing Shopify product id or SKU in EasyCashier product payload");
  }

  return uniqueArticleNumbers;
};

const numberFromValue = (value, defaultValue = 0) => {
  if (value == null || value === "") {
    return defaultValue;
  }

  const number = Number.parseFloat(String(value).replace(",", "."));

  return Number.isFinite(number) ? number : defaultValue;
};

const vatRateFromProduct = (product) => {
  const vat = numberFromValue(product?.moms, 0);

  return vat > 1 ? vat / 100 : vat;
};

const configuredNumber = (envVarName, defaultValue) => {
  const value = process.env[envVarName];

  return numberFromValue(value, defaultValue);
};

const configuredString = (envVarName, defaultValue) => process.env[envVarName] || defaultValue;

const buildStockEntry = (product) => {
  const stockEntry = {
    storeNumber: configuredNumber("EASYCASHIER_STORE_NUMBER", 1),
  };
  const inventoryQuantity = inventoryQuantityFromProduct(product);

  if (inventoryQuantity != null) {
    stockEntry[configuredString("EASYCASHIER_STOCK_ENTRY_QUANTITY_FIELD", "quantity")] = inventoryQuantity;
  }

  return stockEntry;
};

const buildEasyCashierArticlePayload = (product) => {
  const inventoryQuantity = inventoryQuantityFromProduct(product);

  return {
    articleNumber: articleNumberFromProduct(product),
    description: product?.produktnamn ?? product?.title ?? product?.description ?? "",
    barcode: optionalNumberFromValue(product?.ean ?? product?.barcode),
    barcode2: null,
    articleType: "PRODUCT",
    retailPriceIncludingVat: numberFromValue(product?.pris ?? product?.price, 0),
    costPriceExcludingVat: configuredNumber("EASYCASHIER_DEFAULT_COST_PRICE_EXCLUDING_VAT", 0),
    vat: vatRateFromProduct(product),
    accumulative: false,
    askForQuantity: false,
    addTextWhenSold: false,
    stockItem: inventoryQuantity != null,
    storageArea: null,
    supplierArticleNumber: "",
    articleGroupId: null,
    accountNumber: configuredNumber("EASYCASHIER_ACCOUNT_NUMBER", 3051),
    supplierNumber: null,
    webshop: false,
    webshopArticleId: null,
    erp: false,
    erpArticleId: null,
    specialOfferStartDate: null,
    specialOfferStopDate: null,
    specialOfferDiscount: null,
    specialOfferDiscountType: null,
    articleStorePrices: [],
    stockEntries: [buildStockEntry(product)],
    averageCostPriceExcludingVat: 0,
  };
};

const parseJsonResponse = async (response) => {
  const text = await response.text();

  if (!text) {
    return { text, json: null };
  }

  try {
    return { text, json: JSON.parse(text) };
  } catch (_) {
    return { text, json: null };
  }
};

const articleRecordsFromResponse = (json) => {
  if (Array.isArray(json)) {
    return json;
  }

  if (!json || typeof json !== "object") {
    return [];
  }

  for (const key of ["data", "items", "results", "articles", "records", "content"]) {
    const value = json[key];

    if (Array.isArray(value)) {
      return value;
    }

    if (value && typeof value === "object") {
      const nestedRecords = articleRecordsFromResponse(value);

      if (nestedRecords.length > 0) {
        return nestedRecords;
      }
    }
  }

  return [json];
};

const articleNumber = (article) =>
  article?.articleNumber ??
  article?.article_number ??
  article?.artikelnummer ??
  article?.sku ??
  article?.SKU;

const articleId = (article) => article?.id ?? article?.articleId ?? article?.article_id ?? article?.uuid;

const findArticleIdForArticleNumbers = ({ json, articleNumbers }) => {
  const records = articleRecordsFromResponse(json);
  const matchingRecord = records.find((article) => {
    const easyCashierArticleNumber = articleNumber(article);

    return (
      easyCashierArticleNumber != null &&
      articleNumbers.some((articleNumber) => String(easyCashierArticleNumber).trim() === String(articleNumber).trim())
    );
  });
  const id = articleId(matchingRecord);

  if (!id) {
    const error = new Error(`No EasyCashier article id found for Shopify article number(s) ${articleNumbers.join(", ")}`);
    error.code = ARTICLE_NOT_FOUND_CODE;
    throw error;
  }

  return id;
};

const shouldCreateMissingArticle = ({ endpointName, error }) =>
  endpointName === "edit" && error?.code === ARTICLE_NOT_FOUND_CODE;

const resolveEasyCashierArticleId = async ({ articleEndpoint, articleNumbers, logger }) => {
  const lookupEndpoint = articleEndpoint;
  const response = await fetch(lookupEndpoint, {
    method: "GET",
    headers: authHeaders(),
  });
  const responseBody = await parseJsonResponse(response);

  if (!response.ok) {
    logger.error(
      {
        status: response.status,
        responseBody: responseBody.text.slice(0, 1000),
        articleNumbers,
      },
      "EasyCashier article lookup failed"
    );
    throw new Error(`EasyCashier article lookup failed with status ${response.status}`);
  }

  return findArticleIdForArticleNumbers({ json: responseBody.json, articleNumbers });
};

const resolveRequestEndpoint = async ({ articleEndpoint, endpointName, product, logger }) => {
  if (endpointName === "edit") {
    const articleNumbers = articleNumbersForLookup(product);
    const easyCashierArticleId = await resolveEasyCashierArticleId({
      articleEndpoint,
      articleNumbers,
      logger,
    });

    return `${articleEndpoint}/${encodeURIComponent(easyCashierArticleId)}`;
  }

  if (endpointName === "delete") {
    return `${articleEndpoint}/${encodeURIComponent(product.shopifyProductId)}`;
  }

  return articleEndpoint;
};

export const sendEasyCashierProductPayload = async ({
  api,
  params,
  logger,
  connections,
  endpoint,
  endpointName,
  method = "POST",
}) => {
  const payload = params?.payload ?? {};
  const syncDetails = {
    endpointName,
    method,
    event: payload?.event ?? null,
    shopifyProductId: payload?.shopifyProductId ?? null,
    requests: [],
  };
  let easycashierArticleNumber = null;

  try {
    const articleEndpoint = resolveEndpoint(endpoint);
    const products = await productRowsForRequest({ endpointName, payload, connections });
    syncDetails.productCount = products.length;

    for (const product of products) {
      let resolvedEndpoint;
      let requestMethod = method;
      let requestEndpointName = endpointName;
      const requestDetails = {
        requestedEndpointName: endpointName,
        sourceProduct: productDetailsForLog(product),
      };

      try {
        resolvedEndpoint = await resolveRequestEndpoint({
          articleEndpoint,
          endpointName,
          product,
          logger,
        });
      } catch (error) {
        if (!shouldCreateMissingArticle({ endpointName, error })) {
          requestDetails.error = errorMessageForLog(error);
          syncDetails.requests.push(requestDetails);
          throw error;
        }

        resolvedEndpoint = articleEndpoint;
        requestMethod = "POST";
        requestEndpointName = "create";

        logger.info(
          {
            articleNumber: articleNumberFromProduct(product),
            originalEndpointName: endpointName,
            fallbackEndpointName: requestEndpointName,
          },
          "EasyCashier article was missing for Shopify product; creating article instead"
        );
      }

      const articlePayload = requestMethod === "DELETE" ? null : buildEasyCashierArticlePayload(product);
      const requestArticleNumber = articlePayload?.articleNumber ?? articleNumberFromProduct(product);
      easycashierArticleNumber ??= requestArticleNumber;
      requestDetails.endpointName = requestEndpointName;
      requestDetails.method = requestMethod;
      requestDetails.endpoint = resolvedEndpoint;
      requestDetails.easycashierArticleNumber = requestArticleNumber;

      const requestOptions = {
        method: requestMethod,
        headers: authHeaders(),
      };

      if (requestMethod !== "DELETE") {
        requestDetails.easycashierPayload = articlePayload;
        requestOptions.body = JSON.stringify(articlePayload);
      }

      const response = await fetch(resolvedEndpoint, {
        ...requestOptions,
      });
      const responseBody = await response.text();
      requestDetails.responseStatus = response.status;
      requestDetails.responseBody = textForLog(responseBody);
      syncDetails.requests.push(requestDetails);

      if (!response.ok) {
        const error = new Error(
          `EasyCashier product ${requestEndpointName} API request failed with status ${response.status}`
        );
        logger.error(
          {
            endpointName: requestEndpointName,
            originalEndpointName: endpointName,
            status: response.status,
            responseBody: responseBody.slice(0, 1000),
            event: payload?.event,
            productId: payload?.shopifyProductId,
            articleNumber: articleNumberFromProduct(product),
          },
          "EasyCashier product API rejected Shopify product payload"
        );
        throw error;
      }
    }

    await createProductSyncLog({
      api,
      payload,
      status: "success",
      details: syncDetails,
      easycashierArticleNumber,
    });

    logger.info(
      {
        endpointName,
        event: payload?.event,
        productId: payload?.shopifyProductId,
        productCount: products.length,
      },
      "Sent Shopify product payload to EasyCashier"
    );

    return { success: true, productCount: products.length };
  } catch (error) {
    syncDetails.errorMessage = errorMessageForLog(error);
    await recordProductSyncFailure({
      api,
      payload,
      logger,
      error,
      details: syncDetails,
      easycashierArticleNumber,
    });
    throw error;
  }
};
