

const normalizeShopifyVariant = (variant) => ({
  id: variant?.legacyResourceId == null ? idFromGid(variant?.id) : String(variant.legacyResourceId),
  gid: typeof variant?.id === "string" && variant.id.startsWith("gid://") ? variant.id : variant?.admin_graphql_api_id ?? null,
  sku: variant?.sku ?? null,
  price: typeof variant?.price === "object" ? variant.price?.amount : variant?.price ?? null,
  barcode: variant?.barcode ?? null,
  taxable: variant?.taxable ?? null,
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
export const fetchFreshShopifyProductRows = async ({ connections, payload }) => {
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

const optionalStringFromValue = (value) =>
  value == null || value === "" ? null : String(value);



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



const buildEasyCashierArticlePayload = (product) => {
  return {
    articleNumber: articleNumberFromProduct(product),
    description: product?.produktnamn ?? product?.title ?? product?.description ?? "",
    barcode: optionalStringFromValue(product?.ean ?? product?.barcode),
    barcode2: null,
    articleType: "PRODUCT",
    retailPriceIncludingVat: numberFromValue(product?.pris ?? product?.price, 0),
    costPriceExcludingVat: configuredNumber("EASYCASHIER_DEFAULT_COST_PRICE_EXCLUDING_VAT", 0),
    vat: vatRateFromProduct(product),
    accumulative: false,
    askForQuantity: false,
    addTextWhenSold: false,
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


  for (const [cacheKey, entry] of easyCashierArticleIdCache.entries()) {
    if (
      articleCacheKeys.has(cacheKey) ||
      (staleArticleId != null && String(entry?.easyCashierArticleId) === String(staleArticleId))
    ) {
      easyCashierArticleIdCache.delete(cacheKey);
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


const articleFromResponseJson = ({ json, articleNumbers }) => {
  if (!json) {
    return null;
  }

  const articles = findArticlesForArticleNumbers({ json, articleNumbers });

  return articles[0] ?? articleRecordsFromResponse(json)[0] ?? null;
};


const resolveEasyCashierEndpoint = ({ articleEndpoint, endpointTemplate, context }) => {
  const resolvedEndpoint = resolveEndpoint(applyTemplateString(endpointTemplate, context));

  if (/^https?:\/\//i.test(resolvedEndpoint)) {
    return resolvedEndpoint;
  }

  const articleRootEndpoint = articleEndpoint.replace(/\/article\/?$/i, "");

  return `${articleRootEndpoint}/${resolvedEndpoint.replace(/^\/+/, "")}`.replace(/([^:])\/{2,}/g, "$1/");
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
