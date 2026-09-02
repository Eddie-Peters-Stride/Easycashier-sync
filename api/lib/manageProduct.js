const PRODUCT_WEBHOOK_EVENTS = {
  "products/create": "created",
  "products/update": "updated",
  "products/delete": "deleted",
};

const DEFAULT_VAT_RATE = 25;
const EASYCASHIER_SYNC_QUEUE = {
  name: "easycashier-sync",
  maxConcurrency: 1,
};
const DEFAULT_SHOPIFY_LOCATION_PAGE_SIZE = 20;

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

const rawWebhookPayload = (trigger) => {
  return trigger?.payload ?? null;
};

export const isProductWebhookTrigger = (trigger) =>
  trigger?.type === "shopify_webhook" && PRODUCT_WEBHOOK_EVENTS[trigger.topic] != null;

export const productEventForTrigger = (trigger, fallbackEvent) =>
  PRODUCT_WEBHOOK_EVENTS[trigger?.topic] ?? fallbackEvent;

// Shopify product price edits surface through the variants relation, not a
// top-level product price field.
export const shopifyProductUpdateNeedsSync = (record) =>
  Boolean(record?.changes("title")?.changed || record?.changes("variants")?.changed);

const normalizeRawVariant = (variant) => ({
  id: variant.id == null ? null : String(variant.id),
  gid: variant.admin_graphql_api_id ?? null,
  sku: variant.sku ?? null,
  price: variant.price ?? null,
  barcode: variant.barcode ?? null,
  taxable: variant.taxable ?? null,
  position: variant.position ?? null,
});



const variantsFromWebhook = (trigger) => {
  const payload = rawWebhookPayload(trigger);

  if (!Array.isArray(payload?.variants)) {
    return [];
  }

  return payload.variants.map(normalizeRawVariant);
};

const productNameForPayload = (trigger) => {
  const payload = rawWebhookPayload(trigger);

  return payload?.title ?? null;
};

const productIdForPayload = (trigger) => {
  const payload = rawWebhookPayload(trigger);

  return payload?.id == null ? null : String(payload.id);
};

const productGidForPayload = (trigger) => {
  const payload = rawWebhookPayload(trigger);

  return payload?.admin_graphql_api_id ?? null;
};

const buildRows = (variants, productName, shopifyProductId) => {
  return variants.map((variant) => ({
    shopifyProductId,
    shopifyVariantId: variant.id,
    shopifyVariantGid: variant.gid,
    artikelnummer: variant.sku,
    produktnamn: productName,
    pris: variant.price,
    ean: variant.barcode,
    moms: vatForTaxable(variant.taxable),
  }));
};

export const buildShopifyProductEasyCashierPayload = ({ trigger, event }) => {
  const variants = variantsFromWebhook(trigger);
  const productName = productNameForPayload(trigger);
  const shopifyProductId = productIdForPayload(trigger);
  const products =
    event === "deleted" && variants.length === 0
      ? shopifyProductId == null
        ? []
        : [
          {
            shopifyProductId,
            shopifyVariantId: null,
            shopifyVariantGid: null,
            artikelnummer: null,
            produktnamn: productName,
          },
        ]
      : buildRows(variants, productName, shopifyProductId);

  return {
    event,
    topic: trigger?.topic ?? null,
    shopId: trigger?.shopId ?? null,
    shopDomain: trigger?.shopDomain ?? null,
    shopifyProductId,
    shopifyProductGid: productGidForPayload(trigger),
    produktnamn: productName,
    products,
  };
};

const productGidFromRecord = (record) => {
  if (typeof record?.id === "string" && record.id.startsWith("gid://")) {
    return record.id;
  }

  if (record?.id != null) {
    return `gid://shopify/Product/${record.id}`;
  }

  return null;
};

const buildShopifyProductRecordEasyCashierPayload = ({ record, trigger, event }) => ({
  event,
  topic: trigger?.topic ?? null,
  shopId: record?.shopId ?? trigger?.shopId ?? null,
  shopDomain: trigger?.shopDomain ?? null,
  shopifyProductId: record?.id == null ? null : String(record.id),
  shopifyProductGid: productGidFromRecord(record),
  produktnamn: record?.title ?? null,
  products: [],
});

export const enqueueShopifyProductEasyCashierPayload = async ({ api, logger, payload }) => {
  if (!payload) {
    return;
  }

  const actionsByEvent = {
    created: api.createdProductSync,
    updated: api.updatedProductSync,
    deleted: api.deletedProductSync,
  };
  const action = actionsByEvent[payload.event];

  if (!action) {
    throw new Error(`Unsupported Shopify product EasyCashier sync event: ${payload.event}`);
  }

  await api.enqueue(action, { payload }, {
    // EasyCashier rate limiting is enforced in the sender, so all sync jobs
    // must share a single queue to keep that guard global.
    queue: EASYCASHIER_SYNC_QUEUE,
    priority: "high",
    id: `${payload.shopifyProductId?.split('/')?.pop()}-${Math.floor(Math.random() * 100000)}`,
    // Associating the job with its shop lets Gadget coordinate Shopify API
    // usage and rate-limit state for background work.
    shopifyShop: payload.shopId,
    retries: {
      retryCount: 5,
      initialInterval: 10000
    },
  });

  logger.info(
    {
      event: payload.event,
      productId: payload.shopifyProductId,
      variantCount: payload.products.length,
    },
    "Queued Shopify product sync to EasyCashier"
  );
};

export const enqueueShopifyProductEasyCashierSync = async ({ api, logger, trigger, record, fallbackEvent }) => {
  if (fallbackEvent !== "deleted") {
    const missingSkuVariantIds = await missingSkuVariantIdsForProductSync({
      api,
      trigger,
      record,
    });

    if (missingSkuVariantIds.length > 0) {
      logger.warn(
        {
          event: fallbackEvent,
          topic: trigger?.topic ?? null,
          shopId: record?.shopId ?? trigger?.shopId ?? null,
          productId: record?.id ?? trigger?.payload?.id ?? null,
          missingSkuVariantIds,
        },
        "Product can not be created without sku"
      );
      return;
    }
  }

  if (isProductWebhookTrigger(trigger)) {
    const payload = buildShopifyProductEasyCashierPayload({
      trigger,
      event: productEventForTrigger(trigger, fallbackEvent),
    });
    //await enqueueShopifyProductEasyCashierPayload({ api, logger, payload });
    return;
  }

  if (!record) {
    return;
  }

  const payload = buildShopifyProductRecordEasyCashierPayload({
    record,
    trigger,
    event: fallbackEvent,
  });

  await enqueueShopifyProductEasyCashierPayload({ api, logger, payload });
};

const idFromGid = (gid) => {
  if (typeof gid !== "string") {
    return null;
  }

  return gid.split("/").pop() || null;
};

const graphqlGid = (type, id) => {
  if (!id) {
    return null;
  }

  const stringId = String(id);

  if (stringId.startsWith("gid://")) {
    return stringId;
  }

  return `gid://shopify/${type}/${stringId}`;
};

const parseShopifyGraphqlResult = (result, lookupName) => {
  const data = result?.data ?? result;
  const errors = data?.errors ?? result?.errors;

  if (Array.isArray(errors) && errors.length > 0) {
    throw new Error(`${lookupName} failed: ${errors.map((error) => error.message).join(", ")}`);
  }

  return data;
};

const shopifyClientForTrigger = async ({ connections, trigger }) => {
  if (connections?.shopify?.current) {
    return connections.shopify.current;
  }

  if (trigger?.shopId && connections?.shopify?.forShopId) {
    return await connections.shopify.forShopId(trigger.shopId);
  }

  return null;
};



const normalizeSkuValue = (sku) => {
  if (sku == null) {
    return null;
  }

  const normalizedSku = String(sku).trim();

  return normalizedSku === "" ? null : normalizedSku;
};

const variantIdentifierFromPayload = (variant) => {
  const identifier =
    variant?.shopifyVariantId ??
    idFromGid(variant?.shopifyVariantGid) ??
    idFromGid(variant?.admin_graphql_api_id) ??
    variant?.legacyResourceId ??
    variant?.id;

  return identifier == null || identifier === "" ? null : String(identifier);
};

const missingSkuVariantIdsFromPayload = (payload) => {
  if (!Array.isArray(payload?.variants)) {
    return [];
  }

  return payload.variants
    .filter((variant) => normalizeSkuValue(variant?.sku) == null)
    .map(variantIdentifierFromPayload)
    .filter((variantId) => variantId != null && variantId !== "");
};

const missingSkuVariantIdsForProductSync = async ({ api, trigger, record }) => {
  const payloadVariantIds = missingSkuVariantIdsFromPayload(trigger?.payload);

  if (payloadVariantIds.length > 0) {
    return payloadVariantIds;
  }

  if (!record?.id || typeof api?.shopifyProductVariant?.findMany !== "function") {
    return [];
  }

  const variants = await api.shopifyProductVariant.findMany({
    filter: {
      productId: {
        equals: String(record.id),
      },
    },
  });

  return (Array.isArray(variants) ? variants : [])
    .filter((variant) => normalizeSkuValue(variant?.sku) == null)
    .map((variant) => (variant?.id == null ? null : String(variant.id)))
    .filter((variantId) => variantId != null && variantId !== "");
};


const buildVariantSkuChangeBasePayload = ({ trigger, record, oldSku, newSku }) => ({
  topic: trigger?.topic ?? null,
  shopId: record?.shopId ?? trigger?.shopId ?? null,
  shopDomain: trigger?.shopDomain ?? null,
  shopifyProductId: record?.productId == null ? null : String(record.productId),
  shopifyProductGid: graphqlGid("Product", record?.productId),
  shopifyVariantId: record?.id == null ? null : String(record.id),
  shopifyVariantGid: graphqlGid("ProductVariant", record?.id),
  produktnamn: null,
  skuChange: {
    oldSku,
    newSku,
  },
});

const variantSnapshotValue = (record, snapshot, field) => snapshot?.[field] ?? record?.[field] ?? null;

export const enqueueShopifyProductVariantDeleteEasyCashierSync = async ({
  api,
  logger,
  trigger,
  record,
  deletedVariant,
}) => {
  const sku = normalizeSkuValue(variantSnapshotValue(record, deletedVariant, "sku"));
  const productId = variantSnapshotValue(record, deletedVariant, "productId");
  const variantId = variantSnapshotValue(record, deletedVariant, "id");
  const shopId = variantSnapshotValue(record, deletedVariant, "shopId") ?? trigger?.shopId ?? null;

  if (!sku) {
    logger.warn(
      {
        variantId,
        productId,
        shopId,
      },
      "Skipped EasyCashier variant delete because the Shopify variant SKU was missing"
    );
    return;
  }

  const payload = {
    event: "deleted",
    topic: trigger?.topic ?? null,
    shopId,
    shopDomain: trigger?.shopDomain ?? null,
    shopifyProductId: productId == null ? null : String(productId),
    shopifyProductGid: graphqlGid("Product", productId),
    shopifyVariantId: variantId == null ? null : String(variantId),
    shopifyVariantGid: graphqlGid("ProductVariant", variantId),
    produktnamn: null,
    products: [
      {
        shopifyProductId: productId == null ? null : String(productId),
        shopifyVariantId: variantId == null ? null : String(variantId),
        shopifyVariantGid: graphqlGid("ProductVariant", variantId),
        artikelnummer: sku,
      },
    ],
  };

  await enqueueShopifyProductEasyCashierPayload({ api, logger, payload });

  logger.info(
    {
      variantId,
      productId,
      sku,
    },
    "Queued EasyCashier variant delete sync"
  );
};

const enqueueShopifyProductVariantSkuChangeEasyCashierSync = async ({
  api,
  logger,
  trigger,
  record,
  previousSku,
}) => {
  const skuChanged = typeof record?.changed === "function" ? record.changed("sku") : previousSku !== undefined;
  const oldSku = normalizeSkuValue(previousSku);
  const newSku = normalizeSkuValue(record?.sku);

  if (!skuChanged || oldSku === newSku) {
    return false;
  }

  const basePayload = buildVariantSkuChangeBasePayload({
    trigger,
    record,
    oldSku,
    newSku,
  });

  if (newSku) {
    if (!record?.productId) {
      logger.warn(
        {
          variantId: record?.id ?? null,
          newSku,
          shopId: record?.shopId ?? trigger?.shopId ?? null,
        },
        "Skipped EasyCashier SKU change create because the Shopify product id was missing"
      );
    } else {
      await enqueueShopifyProductEasyCashierPayload({
        api,
        logger,
        payload: {
          ...basePayload,
          event: "updated",
          products: [],
        },
      });
    }
  }

  if (oldSku) {
    await enqueueShopifyProductEasyCashierPayload({
      api,
      logger,
      payload: {
        ...basePayload,
        event: "deleted",
        products: [
          {
            shopifyProductId: basePayload.shopifyProductId,
            shopifyVariantId: basePayload.shopifyVariantId,
            shopifyVariantGid: basePayload.shopifyVariantGid,
            artikelnummer: oldSku,
          },
        ],
      },
    });
  }

  logger.info(
    {
      variantId: record?.id ?? null,
      productId: record?.productId ?? null,
      oldSku,
      newSku,
    },
    "Queued EasyCashier SKU change sync"
  );

  return true;
};
