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
const DEFAULT_EASYCASHIER_RATE_LIMIT_REQUESTS_PER_MINUTE = 300;
const DEFAULT_EASYCASHIER_ARTICLE_LOOKUP_PAGE_SIZE = 250;
const DEFAULT_SHOPIFY_LOCATION_PAGE_SIZE = 20;
const STOCK_QUANTITY_CHANGE_TOLERANCE = 0.000001;

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


// When more locations needs to be supported, add them to the EASYCASHIER_STOCK_LOCATION_MAPPINGS environment variable as a JSON array of objects with easyCashierStoreNumber and shopifyLocationName or shopifyLocationId properties, e.g.:
// EASYCASHIER_STOCK_LOCATION_MAPPINGS='[{"easyCashierStoreNumber": 1, "shopifyLocationName": "Kungsholmstorg 8"}, {"easyCashierStoreNumber": 2, "shopifyLocationId": "gid://shopify/Location/123456789"}]'
const DEFAULT_EASYCASHIER_STOCK_LOCATION_MAPPINGS = [
  { easyCashierStoreNumber: 1, shopifyLocationName: "Kungsholmstorg 8" },
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
    payload?.artikelnummer ??
    payload?.sku ??
    payload?.articleNumber ??
    null;

  if (!sku) {
    return null;
  }

  return {
    shopifyProductId: payload?.shopifyProductId == null ? null : String(payload.shopifyProductId),
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

const articleNumbersForLookup = (product) => {
  const articleNumber = optionalArticleNumberFromProduct(product);

  if (!articleNumber) {
    throw new Error("Missing Shopify SKU in EasyCashier product payload");
  }

  return [articleNumber];
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
  article?.sku ??
  article?.SKU;

const articleId = (article) => article?.id ?? article?.articleId ?? article?.article_id ?? article?.uuid;

const articleLookupValues = (article) =>
  [
    articleNumber(article),
  ]
    .filter((value) => value != null && value !== "")
    .map((value) => String(value).trim());

const findArticlesForArticleNumbers = ({ json, articleNumbers }) => {
  const records = articleRecordsFromResponse(json);
  const lookupArticleNumbers = articleNumbers.map((articleNumber) => String(articleNumber).trim());

  return records
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
};

const articleLookupPagination = (json) => {
  if (!json || typeof json !== "object") {
    return null;
  }

  const pageSize = Number.isFinite(Number(json.size)) && Number(json.size) > 0
    ? Number(json.size)
    : DEFAULT_EASYCASHIER_ARTICLE_LOOKUP_PAGE_SIZE;
  const currentPage = Number.isFinite(Number(json.number))
    ? Number(json.number)
    : Number.isFinite(Number(json.page))
      ? Number(json.page)
      : null;
  const totalPages = Number.isFinite(Number(json.totalPages)) ? Number(json.totalPages) : null;

  if (currentPage != null && totalPages != null) {
    return {
      currentPage,
      pageSize,
      hasNextPage: currentPage + 1 < totalPages,
    };
  }

  if (currentPage != null && typeof json.last === "boolean") {
    return {
      currentPage,
      pageSize,
      hasNextPage: json.last === false,
    };
  }

  return null;
};

const fetchEasyCashierArticleLookupPage = async ({ lookupEndpoint, articleNumbers, logger }) => {
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
        lookupEndpoint,
      },
      "EasyCashier article lookup failed"
    );
    throw new Error(`EasyCashier article lookup failed with status ${response.status}`);
  }

  return {
    responseBody,
    articles: findArticlesForArticleNumbers({ json: responseBody.json, articleNumbers }),
    pagination: articleLookupPagination(responseBody.json),
  };
};

const resolveEasyCashierArticles = async ({ articleEndpoint, articleNumbers, logger }) => {
  const firstPage = await fetchEasyCashierArticleLookupPage({
    lookupEndpoint: articleEndpoint,
    articleNumbers,
    logger,
  });

  if (firstPage.articles.length > 0) {
    return firstPage.articles;
  }

  let pagination = firstPage.pagination;

  while (pagination?.hasNextPage) {
    const nextPageNumber = pagination.currentPage + 1;
    const pagedLookup = await fetchEasyCashierArticleLookupPage({
      lookupEndpoint: endpointWithQueryParams(articleEndpoint, {
        page: nextPageNumber,
        size: pagination.pageSize,
      }),
      articleNumbers,
      logger,
    });

    if (pagedLookup.articles.length > 0) {
      return pagedLookup.articles;
    }

    pagination = pagedLookup.pagination;
  }

  const error = new Error(`No EasyCashier article found for SKU lookup value(s) ${articleNumbers.join(", ")}`);
  error.code = ARTICLE_NOT_FOUND_CODE;
  throw error;
};

const resolveEasyCashierArticleId = async ({ articleEndpoint, articleNumbers, logger }) => {
  const articles = await resolveEasyCashierArticles({ articleEndpoint, articleNumbers, logger });
  const id = articleId(articles[0]);

  if (!id) {
    const error = new Error(`No EasyCashier article id found for SKU lookup value(s) ${articleNumbers.join(", ")}`);
    error.code = ARTICLE_NOT_FOUND_CODE;
    throw error;
  }

  return id;
};

const resolveEasyCashierArticle = async ({ articleEndpoint, articleNumbers, logger }) => {
  const articles = await resolveEasyCashierArticles({ articleEndpoint, articleNumbers, logger });

  return articles[0];
};

const articleIdFromResponseBodyText = (responseBodyText) => {
  const responseJson = parseJsonText(responseBodyText);

  if (!responseJson) {
    return null;
  }

  return articleId(responseJson) == null ? null : String(articleId(responseJson));
};

const easyCashierArticleIdFromSyncLog = (log) => {
  const requests = Array.isArray(log?.details?.requests) ? log.details.requests : [];

  for (let index = requests.length - 1; index >= 0; index -= 1) {
    const request = requests[index];
    const responseBodyArticleId = articleIdFromResponseBodyText(request?.responseBody);

    if (responseBodyArticleId) {
      return responseBodyArticleId;
    }
  }

  return null;
};

const resolveRequestEndpoint = async ({ api, articleEndpoint, endpointName, payload, product, logger }) => {
  if (endpointName === "delete") {
    if (product?.easycashierArticleId) {
      return `${articleEndpoint}/${encodeURIComponent(product.easycashierArticleId)}`;
    }

    const articleNumbers = articleNumbersForLookup(product);
    const easyCashierArticleId = await resolveEasyCashierArticleId({
      articleEndpoint,
      articleNumbers,
      logger,
    });

    return `${articleEndpoint}/${encodeURIComponent(easyCashierArticleId)}`;
  }

  const articleNumbers = articleNumbersForLookup(product);

  try {
    const easyCashierArticleId = await resolveEasyCashierArticleId({
      articleEndpoint,
      articleNumbers,
      logger,
    });

    return `${articleEndpoint}/${encodeURIComponent(easyCashierArticleId)}`;
  } catch (error) {
    if (error?.code !== ARTICLE_NOT_FOUND_CODE) {
      throw error;
    }
  }

  return articleEndpoint;
};

const createDuplicateArticleError = ({ requestEndpointName, responseStatus, responseBodyText }) => {
  if (requestEndpointName !== "create" || responseStatus !== 400) {
    return false;
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

  return messages.some((message) => /already exists/i.test(message));
};

const expandDeleteProductsWithEasyCashierMatches = async ({ articleEndpoint, products, logger }) => {
  const expandedProducts = [];

  for (const product of products) {
    if (product?.easycashierArticleId) {
      expandedProducts.push(product);
      continue;
    }

    const articleNumbers = articleNumbersForLookup(product);
    let matchingArticles = [];

    try {
      matchingArticles = await resolveEasyCashierArticles({
        articleEndpoint,
        articleNumbers,
        logger,
      });
    } catch (error) {
      if (error?.code !== ARTICLE_NOT_FOUND_CODE) {
        throw error;
      }
    }

    const easyCashierArticleIds = matchingArticles
      .map((article) => articleId(article))
      .filter((easycashierArticleId) => easycashierArticleId != null && easycashierArticleId !== "");

    if (easyCashierArticleIds.length === 0) {
      logger.info(
        {
          shopifyProductId: product?.shopifyProductId ?? null,
          articleNumbers,
        },
        "Skipped EasyCashier delete because no live article matched"
      );
      continue;
    }

    expandedProducts.push(
      ...easyCashierArticleIds.map((easycashierArticleId) => ({
        ...product,
        easycashierArticleId: String(easycashierArticleId),
      }))
    );
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

const currentEasyCashierQuantityForStore = ({ article, storeNumber, allowArticleStockQuantity }) => {
  const matchingStockEntry = stockEntriesFromArticle(article).find(
    (stockEntry) => stockEntry.storeNumber === storeNumber && stockEntry.quantity != null
  );

  if (matchingStockEntry) {
    return optionalNumberFromValue(matchingStockEntry.quantity);
  }

  if (!allowArticleStockQuantity) {
    return null;
  }

  return stockQuantityFromArticle(article);
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

const buildStockChangeMovements = ({ product, article }) => {
  const desiredStockLevels = desiredStockLevelsForProduct(product);
  const allowArticleStockQuantity = desiredStockLevels.length === 1;
  const requestArticleNumber = articleNumberFromProduct(product);

  return desiredStockLevels
    .map((stockLevel) => {
      const currentQuantity = currentEasyCashierQuantityForStore({
        article,
        storeNumber: stockLevel.storeNumber,
        allowArticleStockQuantity,
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

const syncEasyCashierInventory = async ({ articleEndpoint, product, responseBody, syncDetails, logger }) => {
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
    });
  }

  const movements = buildStockChangeMovements({ product, article: easyCashierArticle });

  if (movements.length === 0) {
    return 0;
  }

  await sendStockChanges({
    articleEndpoint,
    movements,
    product,
    syncDetails,
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

      response = await fetchEasyCashier(resolvedEndpoint, {
        ...requestOptions,
      });
      responseBody = await response.text();
      requestDetails.responseStatus = response.status;
      requestDetails.responseBody = textForLog(responseBody);
      syncDetails.requests.push(requestDetails);

      const deleteAlreadyMissing = requestMethod === "DELETE" && response.status === 404;

      if (createDuplicateArticleError({
        requestEndpointName,
        responseStatus: response.status,
        responseBodyText: responseBody,
      })) {
        const retryEndpoint = await resolveRequestEndpoint({
          api,
          articleEndpoint,
          endpointName,
          payload,
          product,
          logger,
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
        });
        requestDetails.inventoryMovementCount = inventoryMovementCount;
        syncDetails.inventoryMovementCount = (syncDetails.inventoryMovementCount ?? 0) + inventoryMovementCount;
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
