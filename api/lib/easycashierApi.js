const authHeaders = ({ contentType = "application/json" } = {}) => {
  const headers = {};

  if (contentType) {
    headers["Content-Type"] = contentType;
  }

  if (process.env.EASYCASHIER_API_TOKEN) {
    headers[process.env.EASYCASHIER_API_AUTH_HEADER_NAME || "X-Api-Key"] = `${process.env.EASYCASHIER_API_TOKEN}`;
  }

  return headers;
};

const ARTICLE_NOT_FOUND_CODE = "EASYCASHIER_ARTICLE_NOT_FOUND";
const SHOPIFY_PRODUCT_NOT_FOUND_CODE = "SHOPIFY_PRODUCT_NOT_FOUND";
const DEFAULT_EASYCASHIER_RATE_LIMIT_REQUESTS_PER_MINUTE = 300;
const DEFAULT_EASYCASHIER_RATE_LIMIT_RETRY_COUNT = 3;
const DEFAULT_EASYCASHIER_RATE_LIMIT_RETRY_BASE_MS = 2000;
const DEFAULT_EASYCASHIER_ARTICLE_ID_CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_EASYCASHIER_ARTICLE_LOOKUP_PAGE_SIZE = 500;
const DEFAULT_EASYCASHIER_ARTICLE_LOOKUP_PAGE_SIZE = MAX_EASYCASHIER_ARTICLE_LOOKUP_PAGE_SIZE;
const DEFAULT_SHOPIFY_LOCATION_PAGE_SIZE = 20;
const STOCK_QUANTITY_CHANGE_TOLERANCE = 0.000001;
const DEFAULT_EASYCASHIER_ARTICLE_LOOKUP_QUERY_FIELDS = [
  "articleNumber",
  "artikelnummer",
  "sku",
  "webshopArticleId",
  "q",
  "search",
];
const easyCashierArticleIdCache = new Map();
const easyCashierStockQuantityCache = new Map();

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

export const configuredEasyCashierRequestsPerMinute = () => {
  const rawValue = process.env.EASYCASHIER_RATE_LIMIT_REQUESTS_PER_MINUTE;
  const parsedValue =
    rawValue == null ? DEFAULT_EASYCASHIER_RATE_LIMIT_REQUESTS_PER_MINUTE : Number.parseInt(rawValue, 10);

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return DEFAULT_EASYCASHIER_RATE_LIMIT_REQUESTS_PER_MINUTE;
  }

  return Math.min(parsedValue, DEFAULT_EASYCASHIER_RATE_LIMIT_REQUESTS_PER_MINUTE);
};

const configuredEasyCashierRateLimitRetryCount = () => {
  const rawValue = process.env.EASYCASHIER_RATE_LIMIT_RETRY_COUNT;
  const parsedValue =
    rawValue == null ? DEFAULT_EASYCASHIER_RATE_LIMIT_RETRY_COUNT : Number.parseInt(rawValue, 10);

  return Number.isFinite(parsedValue) && parsedValue >= 0 ? parsedValue : DEFAULT_EASYCASHIER_RATE_LIMIT_RETRY_COUNT;
};

const configuredEasyCashierRateLimitRetryBaseMs = () => {
  const rawValue = process.env.EASYCASHIER_RATE_LIMIT_RETRY_BASE_MS;
  const parsedValue =
    rawValue == null ? DEFAULT_EASYCASHIER_RATE_LIMIT_RETRY_BASE_MS : Number.parseInt(rawValue, 10);

  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : DEFAULT_EASYCASHIER_RATE_LIMIT_RETRY_BASE_MS;
};

const configuredEasyCashierArticleIdCacheTtlMs = () => {
  const rawValue = process.env.EASYCASHIER_ARTICLE_ID_CACHE_TTL_MS;
  const parsedValue =
    rawValue == null ? DEFAULT_EASYCASHIER_ARTICLE_ID_CACHE_TTL_MS : Number.parseInt(rawValue, 10);

  return Number.isFinite(parsedValue) && parsedValue > 0 ? parsedValue : DEFAULT_EASYCASHIER_ARTICLE_ID_CACHE_TTL_MS;
};

const easyCashierRequestIntervalMs = () =>
  Math.ceil(60000 / configuredEasyCashierRequestsPerMinute());

const retryAfterDelayMs = (response, attemptNumber) => {
  const retryAfterHeader = response.headers.get("retry-after");

  if (retryAfterHeader) {
    const retryAfterSeconds = Number.parseFloat(retryAfterHeader);

    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
      return Math.ceil(retryAfterSeconds * 1000);
    }

    const retryAfterDateMs = Date.parse(retryAfterHeader);

    if (Number.isFinite(retryAfterDateMs)) {
      const delayMs = retryAfterDateMs - Date.now();

      if (delayMs > 0) {
        return delayMs;
      }
    }
  }

  return configuredEasyCashierRateLimitRetryBaseMs() * Math.max(1, 2 ** (attemptNumber - 1));
};

const fetchEasyCashier = async (url, options) => {
  const maxRetryCount = configuredEasyCashierRateLimitRetryCount();

  for (let attemptNumber = 0; ; attemptNumber += 1) {
    // Pausing before each request smooths out bursts, but concurrent queues
    // can still overlap, so we also retry 429s below.
    await sleep(easyCashierRequestIntervalMs());

    const response = await fetch(url, options);

    if (response.status !== 429 || attemptNumber >= maxRetryCount) {
      return response;
    }

    await sleep(retryAfterDelayMs(response, attemptNumber + 1));
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


// When more locations needs to be supported, add them to the EASYCASHIER_STOCK_LOCATION_MAPPINGS environment variable as a JSON array of objects with easyCashierStoreNumber and shopifyLocationName or shopifyLocationId properties, e.g.:
// EASYCASHIER_STOCK_LOCATION_MAPPINGS='[{"easyCashierStoreNumber": 1, "shopifyLocationName": "Kungsholmstorg 8"}, {"easyCashierStoreNumber": 3, "shopifyLocationName": "Sveavägen 118"}]'
const DEFAULT_EASYCASHIER_STOCK_LOCATION_MAPPINGS = [
  { easyCashierStoreNumber: 1, shopifyLocationName: "Kungsholmstorg 8" },
  { easyCashierStoreNumber: 3, shopifyLocationName: "Sveavägen 118" },
];

const configuredEasyCashierStockLocationMappings = () => {
  const rawMappings = process.env.EASYCASHIER_STOCK_LOCATION_MAPPINGS;
  let mappings = DEFAULT_EASYCASHIER_STOCK_LOCATION_MAPPINGS;

  if (rawMappings != null && rawMappings !== "") {
    try {
      mappings = JSON.parse(rawMappings);
    } catch (_) {
      throw new Error("Invalid JSON in EASYCASHIER_STOCK_LOCATION_MAPPINGS");
    }
  }

  if (!Array.isArray(mappings)) {
    throw new Error("EASYCASHIER_STOCK_LOCATION_MAPPINGS must be a JSON array");
  }

  return mappings.map(normalizeEasyCashierStockLocationMapping);
};

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

const optionalVariantIdentifierFromProduct = (product) => {
  const variantIdentifier = product?.shopifyVariantId ?? idFromGid(product?.shopifyVariantGid);

  return variantIdentifier == null || variantIdentifier === "" ? null : String(variantIdentifier);
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
  const sku =
    firstProductRow?.artikelnummer ??
    firstProductRow?.sku ??
    firstProductRow?.articleNumber ??
    optionalVariantIdentifierFromProduct(firstProductRow) ??
    payload?.artikelnummer ??
    payload?.sku ??
    payload?.articleNumber ??
    optionalVariantIdentifierFromProduct(payload) ??
    null;
  const shopifyProductId = firstProductRow?.shopifyProductId ?? payload?.shopifyProductId ?? payload?.id ?? null;

  if (!sku && shopifyProductId == null) {
    return null;
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

const createShopifyProductNotFoundError = (productGid) => {
  const error = new Error(`Shopify product ${productGid} was not found`);
  error.code = SHOPIFY_PRODUCT_NOT_FOUND_CODE;
  return error;
};

const isShopifyProductNotFoundError = (error) =>
  error?.code === SHOPIFY_PRODUCT_NOT_FOUND_CODE ||
  /Shopify product .* was not found/i.test(error?.message ?? "");

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
      throw createShopifyProductNotFoundError(productGid);
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
    const deleteProductRow = deleteProductRowFromPayload(payload);

    return deleteProductRow == null ? [] : [deleteProductRow];
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
  const articleNumber =
    product?.artikelnummer ??
    product?.sku ??
    product?.articleNumber ??
    optionalVariantIdentifierFromProduct(product);

  return articleNumber == null || articleNumber === "" ? null : String(articleNumber);
};

const optionalShopifySkuFromProduct = (product) => {
  const sku = product?.artikelnummer ?? product?.sku;

  return sku == null || sku === "" ? null : String(sku);
};

const isMissingShopifySkuProduct = (product) => optionalShopifySkuFromProduct(product) == null;

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
  sku: optionalShopifySkuFromProduct(product),
  name: product?.produktnamn ?? product?.title ?? product?.description ?? null,
  price: product?.pris ?? product?.price ?? null,
  ean: product?.ean ?? product?.barcode ?? null,
  vat: product?.moms ?? null,
  inventoryQuantity: inventoryQuantityFromProduct(product),
  inventoryByLocation: Array.isArray(product?.inventoryByLocation) ? product.inventoryByLocation : null,
});

const articleNumbersForLookup = (product) => {
  const articleNumber = optionalArticleNumberFromProduct(product);

  if (!articleNumber) {
    throw new Error("Missing Shopify SKU in EasyCashier product payload");
  }

  return [articleNumber];
};

const deletePayloadFromShopifyProductPayload = (payload) => {
  const deleteProductRow = deleteProductRowFromPayload(payload);

  if (!deleteProductRow) {
    return null;
  }

  return {
    event: "deleted",
    topic: "products/delete",
    shopId: payload?.shopId ?? null,
    shopDomain: payload?.shopDomain ?? null,
    shopifyProductId: deleteProductRow.shopifyProductId,
    shopifyProductGid:
      payload?.shopifyProductGid ??
      (deleteProductRow.shopifyProductId == null
        ? null
        : `gid://shopify/Product/${deleteProductRow.shopifyProductId}`),
    produktnamn: payload?.produktnamn ?? deleteProductRow?.produktnamn ?? null,
    products: [deleteProductRow],
  };
};

const deleteLookupValuesForProduct = (product) => {
  const lookupValues = [];
  const articleNumber = optionalArticleNumberFromProduct(product);

  if (articleNumber) {
    lookupValues.push(articleNumber);
  }

  if (product?.shopifyProductId != null && product.shopifyProductId !== "") {
    lookupValues.push(String(product.shopifyProductId));
  }

  return [...new Set(lookupValues)];
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

const configuredOptionalString = (envVarName) => {
  const value = process.env[envVarName];

  return value == null || value === "" ? null : value;
};

const configuredStringList = (envVarName, defaultValue) => {
  const value = configuredOptionalString(envVarName);

  if (!value) {
    return defaultValue;
  }

  const parsedValue = parseJsonText(value);
  const list = Array.isArray(parsedValue) ? parsedValue : value.split(",");

  return list
    .map((item) => String(item).trim())
    .filter((item) => item !== "");
};

const configuredArticleLookupQueryFields = () =>
  configuredStringList("EASYCASHIER_ARTICLE_LOOKUP_QUERY_FIELDS", DEFAULT_EASYCASHIER_ARTICLE_LOOKUP_QUERY_FIELDS);

const applyTemplateString = (template, context) =>
  String(template).replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, key) => {
    const value = context[key];

    return value == null ? "" : String(value);
  });

const applyTemplateValue = (value, context) => {
  if (Array.isArray(value)) {
    return value.map((item) => applyTemplateValue(item, context));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, applyTemplateValue(item, context)])
    );
  }

  if (typeof value !== "string") {
    return value;
  }

  const exactPlaceholder = value.match(/^\{\{\s*([A-Za-z0-9_]+)\s*\}$/);

  if (exactPlaceholder) {
    return context[exactPlaceholder[1]] ?? null;
  }

  return applyTemplateString(value, context);
};

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
    return configuredEasyCashierStockLocationMappings().map((mapping) =>
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

const hasTrackableInventory = (product) =>
  inventoryQuantityFromProduct(product) != null ||
  inventoryByLocationFromProduct(product).some((inventoryLevel) => inventoryLevel?.available != null);

const buildEasyCashierArticlePayload = (product) => {
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
    stockItem: hasTrackableInventory(product),
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
    averageCostPriceExcludingVat: 0,
  };
};

const parseJsonText = (text) => {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
};

const parseJsonResponse = async (response) => {
  const text = await response.text();

  return { text, json: parseJsonText(text) };
};

const endpointWithQueryParams = (endpoint, params) => {
  const url = new URL(endpoint);

  for (const [key, value] of Object.entries(params)) {
    if (value == null) {
      continue;
    }

    url.searchParams.set(key, String(value));
  }

  return url.toString();
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
  article?.articleNo ??
  article?.article_no ??
  article?.articleNr ??
  article?.article_nr ??
  article?.number ??
  article?.sku ??
  article?.SKU;

const articleId = (article) =>
  article?.id ?? article?.articleId ?? article?.article_id ?? article?.articleUuid ?? article?.article_uuid ?? article?.uuid;

const webshopArticleIdFromArticle = (article) =>
  article?.webshopArticleId ??
  article?.webshopArticleID ??
  article?.webshop_article_id ??
  article?.webshopArtikelId ??
  article?.webshop_artikel_id ??
  article?.webshopId ??
  article?.webshop_id;

const easyCashierArticleIdCacheKey = ({ articleEndpoint, fieldName, fieldValue }) =>
  `${articleEndpoint}|${fieldName}|${String(fieldValue).trim()}`;

const easyCashierArticleIdCacheEntry = (cacheKey) => {
  const entry = easyCashierArticleIdCache.get(cacheKey);

  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= Date.now()) {
    easyCashierArticleIdCache.delete(cacheKey);
    return null;
  }

  return entry;
};

const easyCashierStockQuantityCacheKey = ({ articleEndpoint, fieldName, fieldValue, storeNumber }) =>
  `${articleEndpoint}|stock|${fieldName}|${String(fieldValue).trim()}|${storeNumber}`;

const easyCashierStockQuantityCacheEntry = (cacheKey) => {
  const entry = easyCashierStockQuantityCache.get(cacheKey);

  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= Date.now()) {
    easyCashierStockQuantityCache.delete(cacheKey);
    return null;
  }

  return entry;
};

const easyCashierProductLookupCacheValues = ({ product }) => {
  const lookupValues = [];
  const articleNumber = optionalArticleNumberFromProduct(product);

  if (articleNumber) {
    lookupValues.push({
      fieldName: "articleNumber",
      fieldValue: String(articleNumber),
    });
  }

  if (product?.shopifyProductId != null && product.shopifyProductId !== "") {
    lookupValues.push({
      fieldName: "webshopArticleId",
      fieldValue: String(product.shopifyProductId),
    });
  }

  return lookupValues;
};

const cachedEasyCashierQuantityForStore = ({ articleEndpoint, product, storeNumber }) => {
  for (const lookupValue of easyCashierProductLookupCacheValues({ product })) {
    const entry = easyCashierStockQuantityCacheEntry(
      easyCashierStockQuantityCacheKey({
        articleEndpoint,
        ...lookupValue,
        storeNumber,
      })
    );

    if (entry?.quantity != null && Number.isFinite(Number(entry.quantity))) {
      return Number(entry.quantity);
    }
  }

  return null;
};

const cacheEasyCashierStockLevels = ({ articleEndpoint, product, stockLevels }) => {
  const lookupValues = easyCashierProductLookupCacheValues({ product });

  if (lookupValues.length === 0 || !Array.isArray(stockLevels) || stockLevels.length === 0) {
    return;
  }

  const expiresAt = Date.now() + configuredEasyCashierArticleIdCacheTtlMs();

  for (const stockLevel of stockLevels) {
    if (stockLevel?.storeNumber == null || stockLevel?.desiredQuantity == null) {
      continue;
    }

    const normalizedQuantity = Number(stockLevel.desiredQuantity);

    if (!Number.isFinite(normalizedQuantity)) {
      continue;
    }

    for (const lookupValue of lookupValues) {
      easyCashierStockQuantityCache.set(
        easyCashierStockQuantityCacheKey({
          articleEndpoint,
          ...lookupValue,
          storeNumber: stockLevel.storeNumber,
        }),
        {
          quantity: normalizedQuantity,
          expiresAt,
        }
      );
    }
  }
};

const cachedEasyCashierArticleId = ({ articleEndpoint, product }) => {
  for (const lookupValue of easyCashierProductLookupCacheValues({ product })) {
    const entry = easyCashierArticleIdCacheEntry(
      easyCashierArticleIdCacheKey({
        articleEndpoint,
        ...lookupValue,
      })
    );

    if (entry?.easyCashierArticleId) {
      return entry.easyCashierArticleId;
    }
  }

  return null;
};

const cacheEasyCashierArticleId = ({ articleEndpoint, product, article }) => {
  const easyCashierArticleId = articleId(article);

  if (!easyCashierArticleId) {
    return;
  }

  const cacheValues = [
    optionalArticleNumberFromProduct(product),
    articleNumber(article),
  ]
    .filter((value) => value != null && value !== "")
    .map((value) => ({
      fieldName: "articleNumber",
      fieldValue: String(value),
    }));

  const webshopArticleId =
    product?.shopifyProductId != null && product.shopifyProductId !== ""
      ? String(product.shopifyProductId)
      : webshopArticleIdFromArticle(article);

  if (webshopArticleId != null && webshopArticleId !== "") {
    cacheValues.push({
      fieldName: "webshopArticleId",
      fieldValue: String(webshopArticleId),
    });
  }

  const expiresAt = Date.now() + configuredEasyCashierArticleIdCacheTtlMs();

  for (const cacheValue of cacheValues) {
    easyCashierArticleIdCache.set(
      easyCashierArticleIdCacheKey({
        articleEndpoint,
        ...cacheValue,
      }),
      {
        easyCashierArticleId: String(easyCashierArticleId),
        expiresAt,
      }
    );
  }
};

const invalidateEasyCashierArticleCaches = ({ articleEndpoint, product, staleArticleId }) => {
  const lookupValues = easyCashierProductLookupCacheValues({ product });
  const articleCacheKeys = new Set(
    lookupValues.map((lookupValue) =>
      easyCashierArticleIdCacheKey({
        articleEndpoint,
        ...lookupValue,
      })
    )
  );
  const stockCacheKeyPrefixes = lookupValues.map(
    ({ fieldName, fieldValue }) =>
      `${articleEndpoint}|stock|${fieldName}|${String(fieldValue).trim()}|`
  );

  for (const [cacheKey, entry] of easyCashierArticleIdCache.entries()) {
    if (
      articleCacheKeys.has(cacheKey) ||
      (staleArticleId != null && String(entry?.easyCashierArticleId) === String(staleArticleId))
    ) {
      easyCashierArticleIdCache.delete(cacheKey);
    }
  }

  for (const cacheKey of easyCashierStockQuantityCache.keys()) {
    if (stockCacheKeyPrefixes.some((prefix) => cacheKey.startsWith(prefix))) {
      easyCashierStockQuantityCache.delete(cacheKey);
    }
  }
};

const articleLookupValues = (article) =>
  [
    articleNumber(article),
    webshopArticleIdFromArticle(article),
  ]
    .filter((value) => value != null && value !== "")
    .map((value) => String(value).trim());

const findArticlesForArticleNumbers = ({ json, articleNumbers, assumeFilteredByArticleNumber = false }) => {
  const records = articleRecordsFromResponse(json);
  const lookupArticleNumbers = articleNumbers.map((articleNumber) => String(articleNumber).trim());
  const matchingRecords = records
    .map((article, responseIndex) => {
      const easyCashierLookupValues = articleLookupValues(article);
      const lookupIndex = easyCashierLookupValues.reduce((bestIndex, easyCashierLookupValue) => {
        const candidateIndex = lookupArticleNumbers.indexOf(easyCashierLookupValue);

        return candidateIndex >= 0 && candidateIndex < bestIndex ? candidateIndex : bestIndex;
      }, Number.POSITIVE_INFINITY);

      return {
        article,
        lookupIndex,
        responseIndex,
      };
    })
    .filter(({ lookupIndex }) => lookupIndex !== Number.POSITIVE_INFINITY)
    .sort((a, b) => a.lookupIndex - b.lookupIndex || a.responseIndex - b.responseIndex)
    .map(({ article }) => article);

  if (matchingRecords.length > 0) {
    return matchingRecords;
  }

  if (assumeFilteredByArticleNumber && records.length === 1 && articleId(records[0]) != null) {
    return records;
  }

  return [];
};

const broadArticleLookupQueryFields = new Set(["q", "query", "search"]);

const articleLookupCandidates = ({ articleEndpoint, articleNumbers, includeQueryLookups }) => {
  const candidates = [];

  if (includeQueryLookups) {
    for (const requestArticleNumber of articleNumbers) {
      for (const queryField of configuredArticleLookupQueryFields()) {
        candidates.push({
          lookupEndpoint: endpointWithQueryParams(articleEndpoint, {
            [queryField]: requestArticleNumber,
          }),
          assumeFilteredByArticleNumber: !broadArticleLookupQueryFields.has(queryField),
          optional: true,
        });
      }
    }
  }

  candidates.push({
    lookupEndpoint: pagedArticleListLookupEndpoint(articleEndpoint),
    assumeFilteredByArticleNumber: false,
    optional: false,
  });

  return candidates;
};

const articleLookupDebugContext = ({ articleEndpoint, product, includeQueryLookups }) => {
  const articleNumbers = articleNumbersForLookup(product);

  return {
    articleEndpoint,
    articleNumbers,
    lookupQueryFields: configuredArticleLookupQueryFields(),
    includeQueryLookups,
    lookupCandidates: articleLookupCandidates({
      articleEndpoint,
      articleNumbers,
      includeQueryLookups,
    }).map(({ lookupEndpoint, assumeFilteredByArticleNumber, optional }) => ({
      lookupEndpoint,
      assumeFilteredByArticleNumber,
      optional,
    })),
  };
};

const numericQueryParamFromEndpoint = (lookupEndpoint, parameterNames) => {
  if (!lookupEndpoint) {
    return null;
  }

  try {
    const url = new URL(lookupEndpoint);

    for (const parameterName of parameterNames) {
      const value = url.searchParams.get(parameterName);

      if (Number.isFinite(Number(value))) {
        return Number(value);
      }
    }
  } catch (_) {
    return null;
  }

  return null;
};

const normalizedArticleLookupPageSize = (value, fallbackValue = DEFAULT_EASYCASHIER_ARTICLE_LOOKUP_PAGE_SIZE) => {
  const parsedValue = Number(value);

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return fallbackValue;
  }

  return Math.min(Math.trunc(parsedValue), MAX_EASYCASHIER_ARTICLE_LOOKUP_PAGE_SIZE);
};

const pagedArticleListLookupEndpoint = (
  articleEndpoint,
  pageNumber = 1,
  itemsPerPage = DEFAULT_EASYCASHIER_ARTICLE_LOOKUP_PAGE_SIZE
) =>
  endpointWithQueryParams(articleEndpoint, {
    itemsPerPage: normalizedArticleLookupPageSize(itemsPerPage),
    pageNumber,
    sortColumn: "articleNumber",
    sortDirection: "asc",
  });

const articleLookupPagination = (json, lookupEndpoint) => {
  if (!json || typeof json !== "object") {
    return null;
  }

  const paginationSource =
    (json.metaInformation && typeof json.metaInformation === "object" ? json.metaInformation : null) ??
    (json.meta && typeof json.meta === "object" ? json.meta : null) ??
    (json.pagination && typeof json.pagination === "object" ? json.pagination : null) ??
    json;
  const requestedPageSize = numericQueryParamFromEndpoint(lookupEndpoint, ["itemsPerPage", "size", "limit"]);
  const currentPage = Number.isFinite(Number(paginationSource.number))
    ? Number(paginationSource.number)
    : Number.isFinite(Number(paginationSource.page))
      ? Number(paginationSource.page)
      : Number.isFinite(Number(paginationSource.pageNumber))
        ? Number(paginationSource.pageNumber)
        : Number.isFinite(Number(paginationSource.currentPage))
          ? Number(paginationSource.currentPage)
          : numericQueryParamFromEndpoint(lookupEndpoint, ["pageNumber", "page", "currentPage"]);
  const totalPages = Number.isFinite(Number(paginationSource.totalPages)) ? Number(paginationSource.totalPages) : null;
  const usesOneBasedPageNumbers =
    Number.isFinite(Number(paginationSource.currentPage)) || Number.isFinite(Number(paginationSource.pageNumber));
  const hasNextPage =
    currentPage != null && totalPages != null
      ? usesOneBasedPageNumbers
        ? currentPage < totalPages
        : currentPage + 1 < totalPages
      : currentPage != null && typeof paginationSource.last === "boolean"
        ? paginationSource.last === false
        : null;
  const pageSizeFromResponse =
    Number.isFinite(Number(json.itemsPerPage)) && Number(json.itemsPerPage) > 0
      ? Number(json.itemsPerPage)
      : Number.isFinite(Number(json.size)) && Number(json.size) > 0
        ? Number(json.size)
        : hasNextPage
          ? articleRecordsFromResponse(json).length || null
          : null;
  const pageSize = normalizedArticleLookupPageSize(
    requestedPageSize ?? pageSizeFromResponse,
    DEFAULT_EASYCASHIER_ARTICLE_LOOKUP_PAGE_SIZE
  );

  if (currentPage != null && totalPages != null && hasNextPage != null) {
    return {
      currentPage,
      pageSize,
      hasNextPage,
    };
  }

  if (currentPage != null && typeof paginationSource.last === "boolean") {
    return {
      currentPage,
      pageSize,
      hasNextPage: paginationSource.last === false,
    };
  }

  return null;
};

const fetchEasyCashierArticleLookupPage = async ({
  lookupEndpoint,
  articleNumbers,
  logger,
  assumeFilteredByArticleNumber = false,
  optional = false,
}) => {
  const response = await fetchEasyCashier(lookupEndpoint, {
    method: "GET",
    headers: authHeaders(),
  });
  const responseBody = await parseJsonResponse(response);

  if (!response.ok) {
    if (optional && [400, 404].includes(response.status)) {
      return {
        lookupEndpoint,
        status: response.status,
        responseBody,
        articles: [],
        pagination: null,
      };
    }

    logger.error(
      {
        status: response.status,
        responseBody: responseBody.text.slice(0, 1000),
        articleNumbers,
        lookupEndpoint,
      },
      "EasyCashier article lookup failed"
    );
    throw new Error(`EasyCashier article lookup failed with status ${response.status}`);
  }

  return {
    lookupEndpoint,
    status: response.status,
    responseBody,
    articles: findArticlesForArticleNumbers({
      json: responseBody.json,
      articleNumbers,
      assumeFilteredByArticleNumber,
    }),
    pagination: articleLookupPagination(responseBody.json, lookupEndpoint),
  };
};

const fetchLookupCandidateArticles = async ({
  candidate,
  articleEndpoint,
  articleNumbers,
  logger,
}) => {
  const lookupResponses = [];

  const recordLookupResponse = (lookupPage) => {
    lookupResponses.push({
      lookupEndpoint: lookupPage.lookupEndpoint,
      status: lookupPage.status,
      responseBody: textForLog(lookupPage.responseBody.text, 4000),
      pagination: lookupPage.pagination,
    });
  };

  const firstPage = await fetchEasyCashierArticleLookupPage({
    lookupEndpoint: candidate.lookupEndpoint,
    articleNumbers,
    logger,
    assumeFilteredByArticleNumber: candidate.assumeFilteredByArticleNumber,
    optional: candidate.optional,
  });
  recordLookupResponse(firstPage);

  if (firstPage.articles.length > 0) {
    return {
      articles: firstPage.articles,
      lookupResponses: [],
    };
  }

  let pagination = firstPage.pagination;

  while (pagination?.hasNextPage) {
    const nextPageNumber = pagination.currentPage + 1;
    const pagedLookup = await fetchEasyCashierArticleLookupPage({
      lookupEndpoint: endpointWithQueryParams(candidate.lookupEndpoint, {
        pageNumber: nextPageNumber,
        itemsPerPage: pagination.pageSize,
      }),
      articleNumbers,
      logger,
      assumeFilteredByArticleNumber: candidate.assumeFilteredByArticleNumber,
      optional: candidate.optional,
    });
    recordLookupResponse(pagedLookup);

    if (pagedLookup.articles.length > 0) {
      return {
        articles: pagedLookup.articles,
        lookupResponses: [],
      };
    }

    pagination = pagedLookup.pagination;
  }

  return {
    articles: [],
    lookupResponses,
  };
};

const resolveEasyCashierArticles = async ({ articleEndpoint, articleNumbers, logger, includeQueryLookups = false }) => {
  const failedLookupResponses = [];

  for (const candidate of articleLookupCandidates({ articleEndpoint, articleNumbers, includeQueryLookups })) {
    const { articles, lookupResponses } = await fetchLookupCandidateArticles({
      candidate,
      articleEndpoint,
      articleNumbers,
      logger,
    });

    if (articles.length > 0) {
      return articles;
    }

    if (lookupResponses.length > 0) {
      failedLookupResponses.push({
        lookupEndpoint: candidate.lookupEndpoint,
        assumeFilteredByArticleNumber: candidate.assumeFilteredByArticleNumber,
        optional: candidate.optional,
        responses: lookupResponses,
      });
    }
  }

  logger.warn(
    {
      articleEndpoint,
      articleNumbers,
      includeQueryLookups,
      lookupQueryFields: configuredArticleLookupQueryFields(),
      lookupResponses: failedLookupResponses,
    },
    "EasyCashier article lookup did not return a matching article"
  );

  const error = new Error(`No EasyCashier article found for SKU lookup value(s) ${articleNumbers.join(", ")}`);
  error.code = ARTICLE_NOT_FOUND_CODE;
  throw error;
};

const resolveEasyCashierArticleId = async ({ articleEndpoint, articleNumbers, logger, includeQueryLookups = false }) => {
  const articles = await resolveEasyCashierArticles({
    articleEndpoint,
    articleNumbers,
    logger,
    includeQueryLookups,
  });
  const id = articleId(articles[0]);

  if (!id) {
    const error = new Error(`No EasyCashier article id found for SKU lookup value(s) ${articleNumbers.join(", ")}`);
    error.code = ARTICLE_NOT_FOUND_CODE;
    throw error;
  }

  return id;
};

const resolveEasyCashierArticle = async ({ articleEndpoint, articleNumbers, logger, includeQueryLookups = false }) => {
  const articles = await resolveEasyCashierArticles({
    articleEndpoint,
    articleNumbers,
    logger,
    includeQueryLookups,
  });

  return articles[0];
};

const resolveKnownEasyCashierArticleId = ({ product }) => {
  const explicitArticleId = product?.easycashierArticleId ?? null;

  if (explicitArticleId != null && explicitArticleId !== "") {
    return String(explicitArticleId);
  }

  return null;
};

const resolveRequestEndpoint = async ({
  api,
  articleEndpoint,
  endpointName,
  payload,
  product,
  logger,
  includeQueryLookups = endpointName !== "create",
}) => {
  if (endpointName === "delete") {
    const knownEasyCashierArticleId = resolveKnownEasyCashierArticleId({ product });

    if (knownEasyCashierArticleId) {
      return `${articleEndpoint}/${encodeURIComponent(knownEasyCashierArticleId)}`;
    }

    const articleLookupValues = deleteLookupValuesForProduct(product);

    if (articleLookupValues.length === 0) {
      throw new Error("Missing Shopify product id in EasyCashier delete payload");
    }

    const easyCashierArticleId = await resolveEasyCashierArticleId({
      articleEndpoint,
      articleNumbers: articleLookupValues,
      logger,
      includeQueryLookups,
    });

    return `${articleEndpoint}/${encodeURIComponent(easyCashierArticleId)}`;
  }

  const knownEasyCashierArticleId = resolveKnownEasyCashierArticleId({ product });

  if (knownEasyCashierArticleId) {
    return `${articleEndpoint}/${encodeURIComponent(knownEasyCashierArticleId)}`;
  }

  const cachedArticleId = cachedEasyCashierArticleId({ articleEndpoint, product });

  if (cachedArticleId) {
    return `${articleEndpoint}/${encodeURIComponent(cachedArticleId)}`;
  }

  const articleNumbers = articleNumbersForLookup(product);

  try {
    const easyCashierArticleId = await resolveEasyCashierArticleId({
      articleEndpoint,
      articleNumbers,
      logger,
      includeQueryLookups,
    });

    cacheEasyCashierArticleId({
      articleEndpoint,
      product,
      article: {
        id: easyCashierArticleId,
        articleNumber: articleNumbers[0],
        webshopArticleId: product?.shopifyProductId ?? null,
      },
    });

    return `${articleEndpoint}/${encodeURIComponent(easyCashierArticleId)}`;
  } catch (error) {
    if (error?.code !== ARTICLE_NOT_FOUND_CODE) {
      throw error;
    }
  }

  return articleEndpoint;
};

const createDuplicateArticleInfo = ({ requestEndpointName, responseStatus, responseBodyText }) => {
  if (requestEndpointName !== "create" || responseStatus !== 400) {
    return null;
  }

  const responseJson = parseJsonText(responseBodyText);
  const messages = [
    responseJson?.error?.message,
    responseJson?.message,
    responseJson?.error_description,
    responseBodyText,
  ]
    .filter((message) => message != null && message !== "")
    .map((message) => String(message));

  const duplicateMessage = messages.find((message) => /already exists/i.test(message));

  if (!duplicateMessage) {
    return null;
  }

  return {
    articleNumber: duplicateMessage.match(/Article number\s+"([^"]+)"/i)?.[1] ?? null,
    message: duplicateMessage,
  };
};

const expandDeleteProductsWithEasyCashierMatches = async ({ api, payload, articleEndpoint, products, logger }) => {
  const expandedProducts = [];

  for (const product of products) {
    const knownEasyCashierArticleId = resolveKnownEasyCashierArticleId({ product });

    if (knownEasyCashierArticleId) {
      expandedProducts.push(product);
      continue;
    }

    const articleLookupValues = deleteLookupValuesForProduct(product);
    let matchingArticles = [];

    try {
      if (articleLookupValues.length === 0) {
        logger.info(
          {
            shopifyProductId: product?.shopifyProductId ?? null,
          },
          "Skipped EasyCashier delete because no Shopify product id was available"
        );
        continue;
      }

      matchingArticles = await resolveEasyCashierArticles({
        articleEndpoint,
        articleNumbers: articleLookupValues,
        logger,
        includeQueryLookups: true,
      });
    } catch (error) {
      if (error?.code !== ARTICLE_NOT_FOUND_CODE) {
        throw error;
      }
    }

    const matchingDeleteProducts = matchingArticles
      .map((article) => {
        const easycashierArticleId = articleId(article);

        if (easycashierArticleId == null || easycashierArticleId === "") {
          return null;
        }

        return {
          ...product,
          easycashierArticleId: String(easycashierArticleId),
          artikelnummer: articleNumber(article) ?? product?.artikelnummer ?? null,
        };
      })
      .filter(Boolean);

    if (matchingDeleteProducts.length === 0) {
      logger.info(
        {
          shopifyProductId: product?.shopifyProductId ?? null,
          articleNumbers: articleLookupValues,
        },
        "Skipped EasyCashier delete because no live article matched"
      );
      continue;
    }

    expandedProducts.push(...matchingDeleteProducts);
  }

  return expandedProducts;
};

const stockQuantityFromArticle = (article) =>
  optionalNumberFromValue(
    article?.stockQuantity ??
    article?.stock_quantity ??
    article?.quantity ??
    article?.available ??
    article?.availableQuantity ??
    article?.stock
  );

const nestedStoreNumberFromValue = (value) =>
  value && typeof value === "object"
    ? value.storeNumber ?? value.store_number ?? value.number ?? value.id ?? value.storeId ?? value.store_id
    : value;

const storeNumberFromStockEntry = (stockEntry) => {
  const storeNumber =
    stockEntry?.storeNumber ??
    stockEntry?.store_number ??
    stockEntry?.storeId ??
    stockEntry?.store_id ??
    nestedStoreNumberFromValue(stockEntry?.store);

  if (storeNumber == null || storeNumber === "") {
    return null;
  }

  const parsedStoreNumber = Number.parseInt(String(storeNumber), 10);

  return Number.isFinite(parsedStoreNumber) ? parsedStoreNumber : null;
};

const quantityFromStockEntry = (stockEntry) =>
  optionalNumberFromValue(
    stockEntry?.[configuredStockEntryQuantityField()] ??
    stockEntry?.quantity ??
    stockEntry?.stockQuantity ??
    stockEntry?.stock_quantity ??
    stockEntry?.available ??
    stockEntry?.availableQuantity ??
    stockEntry?.balance
  );

const stockEntryCollectionsFromArticle = (article) => [
  article?.stockEntries,
  article?.stock_entries,
  article?.stockLevels,
  article?.stock_levels,
  article?.articleStockEntries,
  article?.article_stock_entries,
  article?.articleStocks,
  article?.article_stocks,
  article?.stocks,
];

const stockEntriesFromArticle = (article) => {
  const stockEntryCollection = stockEntryCollectionsFromArticle(article).find(Array.isArray);

  if (!stockEntryCollection) {
    return [];
  }

  return stockEntryCollection
    .map((stockEntry) => ({
      storeNumber: storeNumberFromStockEntry(stockEntry),
      quantity: quantityFromStockEntry(stockEntry),
    }))
    .filter((stockEntry) => stockEntry.storeNumber != null || stockEntry.quantity != null);
};

const articleHasStockData = (article) =>
  stockQuantityFromArticle(article) != null || stockEntriesFromArticle(article).length > 0;

const articleFromResponseJson = ({ json, articleNumbers }) => {
  if (!json) {
    return null;
  }

  const articles = findArticlesForArticleNumbers({ json, articleNumbers });

  return articles[0] ?? articleRecordsFromResponse(json)[0] ?? null;
};

const currentEasyCashierQuantityForStore = ({
  articleEndpoint,
  product,
  article,
  storeNumber,
  allowArticleStockQuantity,
  defaultQuantity = null,
}) => {
  const stockEntries = stockEntriesFromArticle(article);
  const matchingStockEntry = stockEntries.find(
    (stockEntry) => stockEntry.storeNumber === storeNumber && stockEntry.quantity != null
  );

  if (matchingStockEntry) {
    return optionalNumberFromValue(matchingStockEntry.quantity);
  }

  const cachedQuantity = cachedEasyCashierQuantityForStore({
    articleEndpoint,
    product,
    storeNumber,
  });

  if (cachedQuantity != null) {
    return cachedQuantity;
  }

  // EasyCashier can omit per-store rows until a location has been initialized.
  // When the article already exposes store-specific stock entries, a missing
  // row for the requested store should be treated as zero instead of blocking
  // the sync.
  if (stockEntries.some((stockEntry) => stockEntry.storeNumber != null)) {
    return 0;
  }

  if (!allowArticleStockQuantity) {
    return defaultQuantity;
  }

  const articleStockQuantity = stockQuantityFromArticle(article);

  return articleStockQuantity != null ? articleStockQuantity : defaultQuantity;
};

const desiredStockLevelsForProduct = (product) => {
  const quantityField = configuredStockEntryQuantityField();

  return buildStockEntries(product)
    .map((stockEntry) => {
      const desiredQuantity = optionalNumberFromValue(stockEntry?.[quantityField]);

      return {
        storeNumber: stockEntry?.storeNumber,
        desiredQuantity:
          desiredQuantity == null || !Number.isFinite(Number(desiredQuantity)) ? null : Number(desiredQuantity),
      };
    })
    .filter((stockLevel) => stockLevel.storeNumber != null && stockLevel.desiredQuantity != null);
};

const stockQuantityChanged = (delta) => Math.abs(delta) > STOCK_QUANTITY_CHANGE_TOLERANCE;

const STOCK_CHANGE_TYPES = {
  increase: "increase",
  decrease: "decrease",
};

const resolveEasyCashierEndpoint = ({ articleEndpoint, endpointTemplate, context }) => {
  const resolvedEndpoint = resolveEndpoint(applyTemplateString(endpointTemplate, context));

  if (/^https?:\/\//i.test(resolvedEndpoint)) {
    return resolvedEndpoint;
  }

  const articleRootEndpoint = articleEndpoint.replace(/\/article\/?$/i, "");

  return `${articleRootEndpoint}/${resolvedEndpoint.replace(/^\/+/, "")}`.replace(/([^:])\/{2,}/g, "$1/");
};

const stockChangeTypeForDelta = (delta) => (delta > 0 ? STOCK_CHANGE_TYPES.increase : STOCK_CHANGE_TYPES.decrease);

const stockChangeEndpoint = (changeType) =>
  configuredOptionalString(
    changeType === STOCK_CHANGE_TYPES.increase
      ? "EASYCASHIER_STOCK_INCREASE_ENDPOINT"
      : "EASYCASHIER_STOCK_DECREASE_ENDPOINT"
  ) ?? (changeType === STOCK_CHANGE_TYPES.increase ? "/stock/increaseStock" : "/stock/decreaseStock");

const stockChangeComment = () => {
  const comment = configuredOptionalString("EASYCASHIER_STOCK_CHANGE_COMMENT");

  return comment == null ? null : comment;
};

const stockChangeEndpointContext = ({ group }) => ({
  easycashier_company_id: process.env.EASYCASHIER_COMPANY_ID ?? null,
  easyCashierCompanyId: process.env.EASYCASHIER_COMPANY_ID ?? null,
  companyId: process.env.EASYCASHIER_COMPANY_ID ?? null,
  storeNumber: group.storeNumber,
  changeType: group.changeType,
});

const buildStockChangeMovements = ({ articleEndpoint, product, article, allowMissingCurrentStock = false }) => {
  const desiredStockLevels = desiredStockLevelsForProduct(product);
  const allowArticleStockQuantity = desiredStockLevels.length === 1;
  const requestArticleNumber = articleNumberFromProduct(product);

  return desiredStockLevels
    .map((stockLevel) => {
      const currentQuantity = currentEasyCashierQuantityForStore({
        articleEndpoint,
        product,
        article,
        storeNumber: stockLevel.storeNumber,
        allowArticleStockQuantity,
        defaultQuantity: allowMissingCurrentStock ? 0 : null,
      });

      if (currentQuantity == null || !Number.isFinite(Number(currentQuantity))) {
        throw new Error(
          `Could not determine current EasyCashier stock for article ${requestArticleNumber} in store ${stockLevel.storeNumber}`
        );
      }

      const delta = stockLevel.desiredQuantity - Number(currentQuantity);

      return {
        articleNumber: requestArticleNumber,
        changeType: stockChangeTypeForDelta(delta),
        storeNumber: stockLevel.storeNumber,
        currentQuantity: Number(currentQuantity),
        desiredQuantity: stockLevel.desiredQuantity,
        delta,
        quantity: Math.abs(delta),
      };
    })
    .filter((movement) => stockQuantityChanged(movement.delta));
};

const stockChangeRequestKey = (movement) => `${movement.changeType}:${movement.storeNumber}`;

const buildStockChangeRequestGroups = (movements) => {
  const groups = new Map();

  for (const movement of movements) {
    const key = stockChangeRequestKey(movement);
    const group = groups.get(key) ?? {
      changeType: movement.changeType,
      storeNumber: movement.storeNumber,
      movements: [],
    };

    group.movements.push(movement);
    groups.set(key, group);
  }

  return [...groups.values()];
};

const buildStockChangePayload = ({ group }) => ({
  storeNumber: group.storeNumber,
  articles: group.movements.map((movement) => ({
    articleNumber: movement.articleNumber,
    quantity: movement.quantity,
    costPriceExcludingVat: configuredNumber("EASYCASHIER_DEFAULT_COST_PRICE_EXCLUDING_VAT", 0),
  })),
  comment: stockChangeComment(),
});

const sendStockChangeRequest = async ({ articleEndpoint, group, product, syncDetails }) => {
  const endpoint = resolveEasyCashierEndpoint({
    articleEndpoint,
    endpointTemplate: stockChangeEndpoint(group.changeType),
    context: stockChangeEndpointContext({ group }),
  });
  const payload = buildStockChangePayload({ group });
  const requestDetails = {
    requestedEndpointName: "stock-change",
    endpointName: `stock-${group.changeType}`,
    method: "POST",
    endpoint,
    sourceProduct: productDetailsForLog(product),
    stockChange: {
      type: group.changeType,
      storeNumber: group.storeNumber,
      movements: group.movements,
    },
    easycashierPayload: payload,
  };
  const response = await fetchEasyCashier(endpoint, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(payload),
  });
  const responseBody = await parseJsonResponse(response);
  requestDetails.responseStatus = response.status;
  requestDetails.responseBody = textForLog(responseBody.text);
  requestDetails.responseJson = responseBody.json;
  syncDetails.requests.push(requestDetails);

  if (!response.ok) {
    throw new Error(`EasyCashier stock ${group.changeType} API request failed with status ${response.status}`);
  }
};

const sendStockChanges = async ({ articleEndpoint, movements, product, syncDetails }) => {
  for (const group of buildStockChangeRequestGroups(movements)) {
    await sendStockChangeRequest({
      articleEndpoint,
      group,
      product,
      syncDetails,
    });
  }
};

const syncEasyCashierInventory = async ({
  articleEndpoint,
  product,
  responseBody,
  syncDetails,
  logger,
  allowMissingCurrentStock = false,
}) => {
  const desiredStockLevels = desiredStockLevelsForProduct(product);

  if (desiredStockLevels.length === 0) {
    return 0;
  }

  const articleNumbers = articleNumbersForLookup(product);
  let easyCashierArticle = articleFromResponseJson({
    json: parseJsonText(responseBody),
    articleNumbers,
  });

  if (!articleHasStockData(easyCashierArticle)) {
    easyCashierArticle = await resolveEasyCashierArticle({
      articleEndpoint,
      articleNumbers,
      logger,
      includeQueryLookups: true,
    });
  }

  const movements = buildStockChangeMovements({
    articleEndpoint,
    product,
    article: easyCashierArticle,
    allowMissingCurrentStock,
  });

  if (movements.length === 0) {
    cacheEasyCashierStockLevels({
      articleEndpoint,
      product,
      stockLevels: desiredStockLevels,
    });
    return 0;
  }

  await sendStockChanges({
    articleEndpoint,
    movements,
    product,
    syncDetails,
  });

  cacheEasyCashierStockLevels({
    articleEndpoint,
    product,
    stockLevels: desiredStockLevels,
  });

  return movements.length;
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

  try {
    const articleEndpoint = resolveEndpoint(endpoint);
    let products;

    try {
      products = await productRowsForRequest({ endpointName, payload, connections });
    } catch (error) {
      const deletePayload =
        endpointName !== "delete" && isShopifyProductNotFoundError(error)
          ? deletePayloadFromShopifyProductPayload(payload)
          : null;

      if (!deletePayload) {
        throw error;
      }

      logger.info(
        {
          endpointName,
          event: payload?.event ?? null,
          productId: payload?.shopifyProductId ?? null,
        },
        "Shopify product was missing during EasyCashier sync; falling back to EasyCashier delete by Shopify product id"
      );

      return await sendEasyCashierProductPayload({
        api,
        params: {
          payload: deletePayload,
        },
        logger,
        connections,
        endpoint,
        endpointName: "delete",
        method: "DELETE",
      });
    }

    if (endpointName === "delete") {
      products = await expandDeleteProductsWithEasyCashierMatches({
        api,
        payload,
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
      let response;
      let responseBody;
      const requestDetails = {
        requestedEndpointName: endpointName,
        sourceProduct: productDetailsForLog(product),
      };

      try {
        resolvedEndpoint = await resolveRequestEndpoint({
          api,
          articleEndpoint,
          endpointName,
          payload,
          product,
          logger,
        });
      } catch (error) {
        requestDetails.error = errorMessageForLog(error);
        syncDetails.requests.push(requestDetails);
        throw error;
      }

      if (endpointName === "delete") {
        requestMethod = "DELETE";
        requestEndpointName = "delete";
      } else if (resolvedEndpoint === articleEndpoint) {
        requestMethod = "POST";
        requestEndpointName = "create";
      } else {
        requestMethod = "PUT";
        requestEndpointName = "edit";
      }

      const articlePayload = requestMethod === "DELETE" ? null : buildEasyCashierArticlePayload(product);
      const requestArticleNumber = articlePayload?.articleNumber ?? optionalArticleNumberFromProduct(product) ?? null;
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

      response = await fetchEasyCashier(resolvedEndpoint, {
        ...requestOptions,
      });
      responseBody = await response.text();
      requestDetails.responseStatus = response.status;
      requestDetails.responseBody = textForLog(responseBody);
      syncDetails.requests.push(requestDetails);

      const deleteAlreadyMissing = requestMethod === "DELETE" && response.status === 404;
      const editArticleMissing = requestMethod === "PUT" && response.status === 404;

      if (editArticleMissing) {
        const staleArticleId = decodeURIComponent(resolvedEndpoint.split("/").pop() ?? "");

        invalidateEasyCashierArticleCaches({
          articleEndpoint,
          product,
          staleArticleId,
        });

        logger.warn(
          {
            endpointName: requestEndpointName,
            originalEndpointName: endpointName,
            status: response.status,
            event: payload?.event,
            productId: payload?.shopifyProductId,
            articleNumber: requestArticleNumber,
            staleArticleId,
          },
          "EasyCashier article resolved for update no longer exists; retrying as create"
        );

        const recoveryRequestDetails = {
          requestedEndpointName: endpointName,
          endpointName: "create",
          method: "POST",
          endpoint: articleEndpoint,
          easycashierArticleNumber: requestArticleNumber,
          sourceProduct: productDetailsForLog(product),
          easycashierPayload: articlePayload,
          recoveredFromMissingArticleId: staleArticleId,
        };

        response = await fetchEasyCashier(articleEndpoint, {
          ...requestOptions,
          method: "POST",
        });
        responseBody = await response.text();
        recoveryRequestDetails.responseStatus = response.status;
        recoveryRequestDetails.responseBody = textForLog(responseBody);
        syncDetails.requests.push(recoveryRequestDetails);

        requestMethod = "POST";
        requestEndpointName = "create";
        resolvedEndpoint = articleEndpoint;
        requestDetails.recoveredMissingEditAsCreate = true;
      }

      const duplicateArticleInfo = createDuplicateArticleInfo({
        requestEndpointName,
        responseStatus: response.status,
        responseBodyText: responseBody,
      });

      if (duplicateArticleInfo) {
        const retryEndpoint = await resolveRequestEndpoint({
          api,
          articleEndpoint,
          endpointName,
          payload,
          product,
          logger,
          includeQueryLookups: true,
        });

        if (retryEndpoint !== articleEndpoint) {
          const retryRequestDetails = {
            requestedEndpointName: endpointName,
            endpointName: "edit",
            method: "PUT",
            endpoint: retryEndpoint,
            easycashierArticleNumber: requestArticleNumber,
            sourceProduct: productDetailsForLog(product),
            easycashierPayload: articlePayload,
          };

          response = await fetchEasyCashier(retryEndpoint, {
            ...requestOptions,
            method: "PUT",
          });
          responseBody = await response.text();
          retryRequestDetails.responseStatus = response.status;
          retryRequestDetails.responseBody = textForLog(responseBody);
          syncDetails.requests.push(retryRequestDetails);

          if (response.ok) {
            requestMethod = "PUT";
            requestEndpointName = "edit";
            resolvedEndpoint = retryEndpoint;
            requestDetails.retryRecoveredAsUpdate = true;
          }
        } else {
          requestDetails.duplicateArticleAlreadyExists = true;
          requestDetails.duplicateArticleMessage = duplicateArticleInfo.message;
          requestDetails.retryLookupFailed = true;
          syncDetails.unresolvedDuplicateCreateCount = (syncDetails.unresolvedDuplicateCreateCount ?? 0) + 1;

          logger.warn(
            {
              endpointName: requestEndpointName,
              originalEndpointName: endpointName,
              status: response.status,
              event: payload?.event,
              productId: payload?.shopifyProductId,
              articleNumber: duplicateArticleInfo.articleNumber ?? requestArticleNumber,
              sourceProduct: productDetailsForLog(product),
              ...articleLookupDebugContext({
                articleEndpoint,
                product,
                includeQueryLookups: true,
              }),
            },
            "EasyCashier article already exists but could not be resolved for update; skipping this product"
          );
          continue;
        }
      }

      if (!response.ok && !deleteAlreadyMissing) {
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

      if (deleteAlreadyMissing) {
        logger.info(
          {
            endpointName: requestEndpointName,
            originalEndpointName: endpointName,
            status: response.status,
            event: payload?.event,
            productId: payload?.shopifyProductId,
            articleNumber: requestArticleNumber,
          },
          "EasyCashier delete reported missing article, treating as success"
        );
      }

      if (requestMethod !== "DELETE") {
        const inventoryMovementCount = await syncEasyCashierInventory({
          articleEndpoint,
          product,
          responseBody,
          syncDetails,
          logger,
          allowMissingCurrentStock: requestEndpointName === "create",
        });
        requestDetails.inventoryMovementCount = inventoryMovementCount;
        syncDetails.inventoryMovementCount = (syncDetails.inventoryMovementCount ?? 0) + inventoryMovementCount;
      }

      if (requestMethod !== "DELETE") {
        const responseArticle = articleFromResponseJson({
          json: parseJsonText(responseBody),
          articleNumbers: articleNumbersForLookup(product),
        });

        if (responseArticle) {
          cacheEasyCashierArticleId({
            articleEndpoint,
            product,
            article: responseArticle,
          });
        } else if (resolvedEndpoint !== articleEndpoint) {
          cacheEasyCashierArticleId({
            articleEndpoint,
            product,
            article: {
              id: decodeURIComponent(resolvedEndpoint.split("/").pop() ?? ""),
              articleNumber: requestArticleNumber,
              webshopArticleId: product?.shopifyProductId ?? null,
            },
          });
        }
      }
    }

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
    logger.error(
      {
        endpointName,
        event: payload?.event,
        productId: payload?.shopifyProductId,
        error,
        errorMessage: errorMessageForLog(error),
      },
      "Failed to send Shopify product payload to EasyCashier"
    );
    throw error;
  }
};

const BULK_IMPORT_HEADERS = [
  "Artikelnummer",
  "Benämning",
  "Försäljningspris (inkl. moms)",
  "Moms",
  "Kontonummer",
  "Artikeltyp",
  "Streckkod",
  "Streckkod 2",
  "Artikelgrupp",
  "Inköpspris (exkl. moms)",
  "Genomsnittligt inköpspris (exkl. moms)",
  "Lagervara",
  "Beställningspunkt",
  "Beställningsantal",
  "Lagerplats",
  "Lösvikt",
  "Ackumulativ",
  "Fråga efter antal",
  "Text vid försäljning",
  "Leverantörs artikelnummer",
  "Leverantörsnummer",
  "Används ej",
  "Extrapris startdatum",
  "Extrapris slutdatum",
  "Extrapris rabatt",
  "Webshop",
  "Webshop artikel id",
];

const csvValue = (value) => {
  if (value == null || value === "") {
    return "";
  }

  if (typeof value === "boolean") {
    return value ? "1" : "";
  }

  return String(value);
};

const csvEscape = (value) => {
  const text = csvValue(value);

  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
};

const csvLine = (values) => values.map((value) => csvEscape(value)).join(",");

const csvStorageAreaForProductRows = (productRows) => {
  const storageAreas = [];
  const seenStorageAreaKeys = new Set();

  for (const productRow of productRows ?? []) {
    for (const inventoryLevel of productRow?.inventoryByLocation ?? []) {
      const locationName = inventoryLevel?.locationName ?? inventoryLevel?.locationId ?? null;

      if (!locationName) {
        continue;
      }

      const storageArea = `${locationName}: ${inventoryLevel?.available ?? 0}`;

      if (seenStorageAreaKeys.has(storageArea)) {
        continue;
      }

      seenStorageAreaKeys.add(storageArea);
      storageAreas.push(storageArea);
    }
  }

  return storageAreas.length > 0 ? storageAreas.join(", ") : "-";
};

const bulkArticleRowFromPayload = ({ articlePayload, storageArea }) => [
  articlePayload.articleNumber,
  articlePayload.description,
  articlePayload.retailPriceIncludingVat,
  articlePayload.vat,
  articlePayload.accountNumber,
  articlePayload.articleType === "SERVICE" ? "Tjänst" : "Produkt",
  articlePayload.barcode,
  "",
  "",
  "",
  "",
  articlePayload.stockItem,
  0,
  0,
  storageArea,
  articlePayload.freeWeight,
  articlePayload.accumulative,
  articlePayload.askForQuantity,
  articlePayload.addTextWhenSold,
  articlePayload.supplierArticleNumber,
  articlePayload.supplierNumber,
  false,
  "",
  "",
  "",
  articlePayload.webshop,
  articlePayload.webshopArticleId,
];

const configuredBulkImportStoreNumbers = () => {
  const mappings = configuredEasyCashierStockLocationMappings();
  const mappedStoreNumbers = mappings
    .map((mapping) => mapping.easyCashierStoreNumber)
    .filter((storeNumber) => storeNumber != null && Number.isFinite(Number(storeNumber)));

  if (mappedStoreNumbers.length > 0) {
    return [...new Set(mappedStoreNumbers.map((storeNumber) => Number(storeNumber)))];
  }

  return [configuredNumber("EASYCASHIER_STORE_NUMBER", 1)];
};

const isMissingShopifySkuError = (error) =>
  errorMessageForLog(error).includes("Missing Shopify SKU in EasyCashier product payload");

export const isShopifyNetworkError = (error) => {
  const message = errorMessageForLog(error);

  return (
    error?.name === "CombinedError" ||
    error?.name === "RequestError" ||
    error?.name === "TimeoutError" ||
    error?.code === "ETIMEDOUT" ||
    error?.code === "ECONNRESET" ||
    error?.code === "ECONNREFUSED" ||
    message.includes("[Network]") ||
    message.includes("Bad Gateway") ||
    message.includes("failed to update shopify rate limit") ||
    message.includes("Timeout awaiting 'request'")
  );
};

export const sendEasyCashierBulkProductImport = async ({
  logger,
  connections,
  shopId,
  productIds,
  signal,
  batchNumber = null,
  batchCount = null,
}) => {
  const normalizedProductIds = (Array.isArray(productIds) ? productIds : [])
    .map((productId) => (productId == null ? null : String(productId)))
    .filter((productId) => productId != null && productId !== "");
  const normalizedBatchNumber =
    Number.isFinite(Number(batchNumber)) && Number(batchNumber) > 0 ? Number(batchNumber) : null;
  const normalizedBatchCount =
    Number.isFinite(Number(batchCount)) && Number(batchCount) > 0 ? Number(batchCount) : null;
  const batchProgress = {
    batchNumber: normalizedBatchNumber,
    batchCount: normalizedBatchCount,
  };
  const batchLabel =
    normalizedBatchNumber != null && normalizedBatchCount != null
      ? `${normalizedBatchNumber}/${normalizedBatchCount}`
      : null;

  if (normalizedProductIds.length === 0) {
    return {
      successProductIds: [],
      failedProductIds: [],
      importedRowCount: 0,
      uploadAttempted: false,
    };
  }

  logger.info(
    {
      shopId,
      ...batchProgress,
      productCount: normalizedProductIds.length,
    },
    batchLabel
      ? `Starting EasyCashier bulk sync batch ${batchLabel}`
      : "Starting EasyCashier bulk sync batch"
  );

  const articleRows = [];
  const successProductIds = [];
  const failedProductIds = [];
  const articleEndpoint = resolveEndpoint("EASYCASHIER_API_BASE_URL/EASYCASHIER_COMPANY_ID/article");
  const importEndpoint = resolveEndpoint("EASYCASHIER_API_BASE_URL/EASYCASHIER_COMPANY_ID/import/articles");

  for (const productId of normalizedProductIds) {
    if (typeof signal?.throwIfAborted === "function") {
      signal.throwIfAborted();
    } else if (signal?.aborted) {
      throw new Error("EasyCashier bulk sync was cancelled");
    }

    try {
      const productRows = await fetchFreshShopifyProductRows({
        connections,
        payload: {
          shopId,
          shopifyProductId: productId,
        },
      });

      if (!Array.isArray(productRows) || productRows.length === 0) {
        throw new Error(`No Shopify variants found for product ${productId}`);
      }

      const missingSkuRows = productRows.filter(isMissingShopifySkuProduct);

      if (missingSkuRows.length > 0) {
        logger.warn(
          {
            shopId,
            ...batchProgress,
            productId,
            missingSkuVariantIds: missingSkuRows
              .map((productRow) => optionalVariantIdentifierFromProduct(productRow))
              .filter((variantId) => variantId != null),
            fallbackArticleNumbers: missingSkuRows
              .map((productRow) => optionalArticleNumberFromProduct(productRow))
              .filter((articleNumber) => articleNumber != null),
          },
          batchLabel
            ? `Shopify product is missing SKU for EasyCashier bulk import; using variant id fallback (${batchLabel})`
            : "Shopify product is missing SKU for EasyCashier bulk import; using variant id fallback"
        );
      }

      const storageArea = csvStorageAreaForProductRows(productRows);
      const productArticleRows = productRows.map((productRow) => {
        const articlePayload = buildEasyCashierArticlePayload(productRow);

        return bulkArticleRowFromPayload({
          articlePayload,
          storageArea,
        });
      });

      articleRows.push(...productArticleRows);
      successProductIds.push(productId);
    } catch (error) {
      if (isMissingShopifySkuError(error)) {
        failedProductIds.push(productId);
        logger.warn(
          {
            shopId,
            ...batchProgress,
            productId,
            errorMessage: errorMessageForLog(error),
          },
          batchLabel
            ? `Skipped Shopify product in EasyCashier bulk import because SKU is missing (${batchLabel})`
            : "Skipped Shopify product in EasyCashier bulk import because SKU is missing"
        );
        continue;
      }

      if (isShopifyNetworkError(error)) {
        logger.error(
          {
            error,
            shopId,
            ...batchProgress,
            productId,
            errorMessage: errorMessageForLog(error),
          },
          batchLabel
            ? `Transient Shopify failure while fetching product rows; retrying EasyCashier bulk import (${batchLabel})`
            : "Transient Shopify failure while fetching product rows; retrying EasyCashier bulk import"
        );
        throw error;
      }

      failedProductIds.push(productId);

      logger.error(
        {
          error,
          shopId,
          ...batchProgress,
          productId,
          errorMessage: errorMessageForLog(error),
        },
        batchLabel
          ? `Failed to prepare Shopify product rows for EasyCashier bulk import (${batchLabel})`
          : "Failed to prepare Shopify product rows for EasyCashier bulk import"
      );
    }
  }

  if (articleRows.length === 0) {
    return {
      successProductIds,
      failedProductIds,
      importedRowCount: 0,
      uploadAttempted: false,
    };
  }

  const csvBody = [csvLine(BULK_IMPORT_HEADERS), ...articleRows.map((row) => csvLine(row))].join("\n");
  const fileName = `EC4_export_${Date.now()}.csv`;
  const formData = new FormData();

  formData.append("storeNumbers", configuredBulkImportStoreNumbers().join(","));
  formData.append("file", new Blob([csvBody], { type: "text/csv" }), fileName);

  const response = await fetchEasyCashier(importEndpoint, {
    method: "POST",
    headers: authHeaders({ contentType: null }),
    body: formData,
    signal,
  });
  const responseBody = await parseJsonResponse(response);

  if (!response.ok) {
    logger.error(
      {
        shopId,
        productCount: successProductIds.length,
        importedRowCount: articleRows.length,
        status: response.status,
        responseBody: textForLog(responseBody.text),
      },
      "EasyCashier bulk article import failed"
    );
    throw new Error(`EasyCashier bulk article import failed with status ${response.status}`);
  }

  logger.info(
    {
      shopId,
      ...batchProgress,
      productCount: successProductIds.length,
      failedProductCount: failedProductIds.length,
      importedRowCount: articleRows.length,
      status: response.status,
      endpoint: articleEndpoint,
      importEndpoint,
    },
    batchLabel
      ? `Imported Shopify products to EasyCashier in bulk (${batchLabel})`
      : "Imported Shopify products to EasyCashier in bulk"
  );

  return {
    successProductIds,
    failedProductIds,
    importedRowCount: articleRows.length,
    uploadAttempted: true,
    responseStatus: response.status,
    responseBody: responseBody.text,
  };
};
