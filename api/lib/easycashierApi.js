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
const DEFAULT_EASYCASHIER_RATE_LIMIT_REQUESTS_PER_MINUTE = 300;
const DEFAULT_SHOPIFY_LOCATION_PAGE_SIZE = 20;

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const configuredEasyCashierRequestsPerMinute = () => {
  const rawValue = process.env.EASYCASHIER_RATE_LIMIT_REQUESTS_PER_MINUTE;
  const parsedValue =
    rawValue == null ? DEFAULT_EASYCASHIER_RATE_LIMIT_REQUESTS_PER_MINUTE : Number.parseInt(rawValue, 10);

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return DEFAULT_EASYCASHIER_RATE_LIMIT_REQUESTS_PER_MINUTE;
  }

  return parsedValue;
};

const easyCashierRequestIntervalMs = () =>
  Math.ceil(60000 / configuredEasyCashierRequestsPerMinute());

const fetchEasyCashier = async (url, options) => {
  // These background actions run in a single dedicated queue, so pausing
  // before each request keeps the whole EasyCashier sync stream below the
  // 300 requests/minute cap.
  await sleep(easyCashierRequestIntervalMs());

  return await fetch(url, options);
};

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

const normalizeLocationKey = (value) => {
  if (value == null) {
    return null;
  }

  const normalizedValue = String(value).trim().toLowerCase();

  return normalizedValue === "" ? null : normalizedValue;
};

const normalizeStoreNumber = (value) => {
  const parsedValue = Number.parseInt(String(value), 10);

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    throw new Error(`Invalid EasyCashier store number: ${value}`);
  }

  return parsedValue;
};

const normalizeEasyCashierStockLocationMapping = (mapping) => {
  const easyCashierStoreNumber = normalizeStoreNumber(
    mapping?.easyCashierStoreNumber ?? mapping?.storeNumber ?? mapping?.storeId
  );
  const shopifyLocationName = normalizeLocationKey(mapping?.shopifyLocationName ?? mapping?.locationName);
  const shopifyLocationIdRaw = mapping?.shopifyLocationId ?? mapping?.locationId ?? mapping?.shopifyLocationGid;
  const shopifyLocationId =
    shopifyLocationIdRaw == null ? null : idFromGid(String(shopifyLocationIdRaw)) ?? String(shopifyLocationIdRaw);

  if (shopifyLocationName == null && shopifyLocationId == null) {
    throw new Error("Each EasyCashier stock location mapping must include a Shopify location name or id");
  }

  return {
    easyCashierStoreNumber,
    shopifyLocationId,
    shopifyLocationName,
  };
};


//When more locations needs to be supported, add them to the EASYCASHIER_STOCK_LOCATION_MAPPINGS environment variable as a JSON array of objects with easyCashierStoreNumber and shopifyLocationName or shopifyLocationId properties, e.g.:
// EASYCASHIER_STOCK_LOCATION_MAPPINGS='[{"easyCashierStoreNumber": 1, "shopifyLocationName": "Kungsholmstorg 8"}, {"easyCashierStoreNumber": 2, "shopifyLocationId": "gid://shopify/Location/123456789"}]'
const EASYCASHIER_STOCK_LOCATION_MAPPINGS = [
  { easyCashierStoreNumber: 1, shopifyLocationName: "Kungsholmstorg 8" },
].map(normalizeEasyCashierStockLocationMapping);

const availableQuantityFromInventoryLevel = (inventoryLevel) => {
  const availableQuantity = inventoryLevel?.quantities?.find((quantity) => quantity?.name === "available")?.quantity;

  if (availableQuantity == null || availableQuantity === "") {
    return null;
  }

  const numericQuantity = Number(availableQuantity);

  return Number.isFinite(numericQuantity) ? numericQuantity : availableQuantity;
};

const normalizeInventoryLevels = (inventoryLevels) => {
  if (!Array.isArray(inventoryLevels)) {
    return [];
  }

  return inventoryLevels
    .map((inventoryLevel) => ({
      locationId: idFromGid(inventoryLevel?.location?.id),
      locationGid: inventoryLevel?.location?.id ?? null,
      locationName: inventoryLevel?.location?.name ?? null,
      available: availableQuantityFromInventoryLevel(inventoryLevel),
    }))
    .filter((inventoryLevel) => inventoryLevel.locationId != null || inventoryLevel.locationName != null);
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
  inventoryByLocation: normalizeInventoryLevels(variant?.inventoryItem?.inventoryLevels?.nodes),
});

const productRowsFromPayload = (payload) => {
  if (!Array.isArray(payload?.products)) {
    return [];
  }

  return payload.products;
};

const variantLookupValuesFromPayload = (payload) => {
  const values = [
    payload?.shopifyVariantId,
    payload?.shopifyVariantGid,
    idFromGid(payload?.shopifyVariantGid),
  ];

  return new Set(values.filter((value) => value != null && value !== "").map((value) => String(value)));
};

const filterProductRowsForPayloadVariant = (products, payload) => {
  const variantLookupValues = variantLookupValuesFromPayload(payload);

  if (variantLookupValues.size === 0) {
    return products;
  }

  const matchingProducts = products.filter(
    (product) =>
      variantLookupValues.has(String(product?.shopifyVariantId)) ||
      variantLookupValues.has(String(product?.shopifyVariantGid)) ||
      variantLookupValues.has(String(idFromGid(product?.shopifyVariantGid)))
  );

  if (matchingProducts.length === 0) {
    throw new Error(`No Shopify variant rows matched ${Array.from(variantLookupValues).join(", ")}`);
  }

  return matchingProducts;
};

const deleteProductRowFromPayload = (payload) => {
  const firstProductRow = productRowsFromPayload(payload)[0] ?? {};
  const shopifyProductId = payload?.shopifyProductId ?? firstProductRow?.shopifyProductId ?? payload?.productId ?? payload?.id;
  const sku =
    firstProductRow?.artikelnummer ??
    firstProductRow?.sku ??
    payload?.artikelnummer ??
    payload?.sku ??
    payload?.articleNumber ??
    null;

  if (!sku && shopifyProductId == null) {
    throw new Error("Missing Shopify product id or SKU in EasyCashier delete payload");
  }

  return {
    shopifyProductId: shopifyProductId == null ? null : String(shopifyProductId),
    shopifyVariantId: firstProductRow?.shopifyVariantId ?? null,
    shopifyVariantGid: firstProductRow?.shopifyVariantGid ?? null,
    artikelnummer: sku,
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
    inventoryByLocation: variant.inventoryByLocation,
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
            inventoryItem {
              inventoryLevels(first: ${DEFAULT_SHOPIFY_LOCATION_PAGE_SIZE}) {
                nodes {
                  location {
                    id
                    name
                  }
                  quantities(names: ["available"]) {
                    name
                    quantity
                  }
                }
              }
            }
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
  const payloadRowsIncludeLocationInventory =
    payloadRows.length > 0 &&
    payloadRows.every((product) => Array.isArray(product?.inventoryByLocation));

  if (payloadRowsIncludeLocationInventory) {
    return payloadRows;
  }

  const freshProductRows = await fetchFreshShopifyProductRows({
    connections,
    payload,
  });

  return filterProductRowsForPayloadVariant(freshProductRows, payload);
};

const optionalArticleNumberFromProduct = (product) => {
  const articleNumber = product?.artikelnummer ?? product?.sku ?? product?.articleNumber;

  return articleNumber == null || articleNumber === "" ? null : String(articleNumber);
};

const articleNumberFromProduct = (product) => {
  const articleNumber = optionalArticleNumberFromProduct(product);

  if (!articleNumber) {
    throw new Error("Missing Shopify SKU in EasyCashier product payload");
  }

  return articleNumber;
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
  articleNumber: optionalArticleNumberFromProduct(product),
  sku: product?.artikelnummer ?? product?.sku ?? null,
  name: product?.produktnamn ?? product?.title ?? product?.description ?? null,
  price: product?.pris ?? product?.price ?? null,
  ean: product?.ean ?? product?.barcode ?? null,
  vat: product?.moms ?? null,
  inventoryQuantity: inventoryQuantityFromProduct(product),
  inventoryByLocation: Array.isArray(product?.inventoryByLocation) ? product.inventoryByLocation : null,
});

const articleNumbersForLookup = (product, { includeShopifyProductId = true } = {}) => {
  const articleNumbers = [
    product?.artikelnummer,
    product?.sku,
    product?.articleNumber,
    includeShopifyProductId ? product?.shopifyProductId : null,
  ]
    .filter((articleNumber) => articleNumber != null && articleNumber !== "")
    .map((articleNumber) => String(articleNumber));

  const uniqueArticleNumbers = [...new Set(articleNumbers)];

  if (uniqueArticleNumbers.length === 0) {
    throw new Error("Missing Shopify SKU in EasyCashier product payload");
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

const configuredStockEntryQuantityField = () =>
  configuredString("EASYCASHIER_STOCK_ENTRY_QUANTITY_FIELD", "quantity");

const buildStockEntry = ({ storeNumber, quantity }) => {
  const stockEntry = {
    storeNumber,
  };

  if (quantity != null) {
    stockEntry[configuredStockEntryQuantityField()] = quantity;
  }

  return stockEntry;
};

const inventoryByLocationFromProduct = (product) =>
  Array.isArray(product?.inventoryByLocation) ? product.inventoryByLocation : [];

const inventoryQuantityForMappedLocation = (product, mapping) => {
  const matchingLocation = inventoryByLocationFromProduct(product).find((inventoryLevel) => {
    if (mapping.shopifyLocationId && inventoryLevel?.locationId === mapping.shopifyLocationId) {
      return true;
    }

    if (mapping.shopifyLocationName && normalizeLocationKey(inventoryLevel?.locationName) === mapping.shopifyLocationName) {
      return true;
    }

    return false;
  });

  return matchingLocation?.available ?? 0;
};

const buildStockEntries = (product) => {
  const locationInventories = inventoryByLocationFromProduct(product);
  const hasLocationInventoryField = Object.prototype.hasOwnProperty.call(product ?? {}, "inventoryByLocation");
  const inventoryQuantity = inventoryQuantityFromProduct(product);

  if (hasLocationInventoryField && (locationInventories.length > 0 || inventoryQuantity != null)) {
    return EASYCASHIER_STOCK_LOCATION_MAPPINGS.map((mapping) =>
      buildStockEntry({
        storeNumber: mapping.easyCashierStoreNumber,
        quantity: inventoryQuantityForMappedLocation(product, mapping),
      })
    );
  }

  return [
    buildStockEntry({
      storeNumber: configuredNumber("EASYCASHIER_STORE_NUMBER", 1),
      quantity: inventoryQuantity,
    }),
  ];
};

const stockQuantityFromEntries = (stockEntries, fallbackQuantity) => {
  let hasQuantity = false;
  const quantityField = configuredStockEntryQuantityField();
  const totalQuantity = stockEntries.reduce((total, stockEntry) => {
    const quantity = optionalNumberFromValue(stockEntry?.[quantityField]);

    if (quantity == null || !Number.isFinite(Number(quantity))) {
      return total;
    }

    hasQuantity = true;
    return total + Number(quantity);
  }, 0);

  return hasQuantity ? totalQuantity : fallbackQuantity;
};

const buildEasyCashierArticlePayload = (product) => {
  const inventoryQuantity = inventoryQuantityFromProduct(product);
  const stockEntries = buildStockEntries(product);
  const stockQuantity = stockQuantityFromEntries(stockEntries, inventoryQuantity);

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
    stockItem: inventoryQuantity != null || stockEntries.length > 0,
    stockQuantity,
    storageArea: null,
    supplierArticleNumber: "",
    articleGroupId: null,
    accountNumber: configuredNumber("EASYCASHIER_ACCOUNT_NUMBER", 3051),
    supplierNumber: null,
    webshop: true,
    webshopArticleId: product?.shopifyProductId == null ? null : String(product.shopifyProductId),
    erp: false,
    erpArticleId: null,
    specialOfferStartDate: null,
    specialOfferStopDate: null,
    specialOfferDiscount: null,
    specialOfferDiscountType: null,
    articleStorePrices: [],
    stockEntries,
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

const articleLookupValues = (article) =>
  [
    articleNumber(article),
    article?.webshopArticleId,
    article?.webshop_article_id,
    article?.webShopArticleId,
    article?.webshopId,
    article?.webshop_id,
  ]
    .filter((value) => value != null && value !== "")
    .map((value) => String(value).trim());

const findArticlesForArticleNumbers = ({ json, articleNumbers }) => {
  const records = articleRecordsFromResponse(json);
  const lookupArticleNumbers = articleNumbers.map((articleNumber) => String(articleNumber).trim());

  return records.filter((article) => {
    const easyCashierLookupValues = articleLookupValues(article);

    return (
      easyCashierLookupValues.length > 0 &&
      easyCashierLookupValues.some((easyCashierLookupValue) => lookupArticleNumbers.includes(easyCashierLookupValue))
    );
  });
};

const shouldCreateMissingArticle = ({ endpointName, error }) =>
  endpointName === "edit" && error?.code === ARTICLE_NOT_FOUND_CODE;

const resolveEasyCashierArticles = async ({ articleEndpoint, articleNumbers, logger }) => {
  const lookupEndpoint = articleEndpoint;
  const response = await fetchEasyCashier(lookupEndpoint, {
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

  const articles = findArticlesForArticleNumbers({ json: responseBody.json, articleNumbers });

  if (articles.length === 0) {
    const error = new Error(`No EasyCashier article found for Shopify lookup value(s) ${articleNumbers.join(", ")}`);
    error.code = ARTICLE_NOT_FOUND_CODE;
    throw error;
  }

  return articles;
};

const resolveEasyCashierArticleId = async ({ articleEndpoint, articleNumbers, logger }) => {
  const articles = await resolveEasyCashierArticles({ articleEndpoint, articleNumbers, logger });
  const id = articleId(articles[0]);

  if (!id) {
    const error = new Error(`No EasyCashier article id found for Shopify lookup value(s) ${articleNumbers.join(", ")}`);
    error.code = ARTICLE_NOT_FOUND_CODE;
    throw error;
  }

  return id;
};

const resolveRequestEndpoint = async ({ articleEndpoint, endpointName, product, logger }) => {
  if (endpointName === "edit") {
    const articleNumbers = articleNumbersForLookup(product, { includeShopifyProductId: false });
    const easyCashierArticleId = await resolveEasyCashierArticleId({
      articleEndpoint,
      articleNumbers,
      logger,
    });

    return `${articleEndpoint}/${encodeURIComponent(easyCashierArticleId)}`;
  }

  if (endpointName === "delete") {
    if (product?.easycashierArticleId) {
      return `${articleEndpoint}/${encodeURIComponent(product.easycashierArticleId)}`;
    }

    const articleNumbers = articleNumbersForLookup(product, {
      includeShopifyProductId: optionalArticleNumberFromProduct(product) == null,
    });
    const easyCashierArticleId = await resolveEasyCashierArticleId({
      articleEndpoint,
      articleNumbers,
      logger,
    });

    return `${articleEndpoint}/${encodeURIComponent(easyCashierArticleId)}`;
  }

  return articleEndpoint;
};

const expandDeleteProductsWithEasyCashierMatches = async ({ articleEndpoint, products, logger }) => {
  const expandedProducts = [];

  for (const product of products) {
    if (product?.easycashierArticleId || optionalArticleNumberFromProduct(product)) {
      expandedProducts.push(product);
      continue;
    }

    const articleNumbers = articleNumbersForLookup(product);
    const matchingArticles = await resolveEasyCashierArticles({
      articleEndpoint,
      articleNumbers,
      logger,
    });

    expandedProducts.push(
      ...matchingArticles.map((article) => ({
        ...product,
        artikelnummer: articleNumber(article) ?? product?.artikelnummer ?? null,
        easycashierArticleId: articleId(article) ?? null,
      }))
    );
  }

  return expandedProducts;
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
    let products = await productRowsForRequest({ endpointName, payload, connections });

    if (endpointName === "delete") {
      products = await expandDeleteProductsWithEasyCashierMatches({
        articleEndpoint,
        products,
        logger,
      });
    }

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
      const requestArticleNumber =
        articlePayload?.articleNumber ?? optionalArticleNumberFromProduct(product) ?? product?.shopifyProductId ?? null;
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

      const response = await fetchEasyCashier(resolvedEndpoint, {
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
            articleNumber: requestArticleNumber,
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
