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
  if (trigger?.type !== "shopify_webhook") {
    return null;
  }

  return trigger.payload ?? null;
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
  inventoryQuantity: variant.inventory_quantity ?? variant.inventoryQuantity ?? null,
});

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
    inventoryQuantity: variant.inventoryQuantity,
    inventoryByLocation: variant.inventoryByLocation,
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
    retries: { retryCount: 1, initialInterval: 2000 },
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
  if (isProductWebhookTrigger(trigger)) {
    const payload = buildShopifyProductEasyCashierPayload({
      trigger,
      event: productEventForTrigger(trigger, fallbackEvent),
    });

    await enqueueShopifyProductEasyCashierPayload({ api, logger, payload });
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

const availableInventoryFromPayload = (payload) => {
  const quantity = payload?.available ?? payload?.inventory_quantity ?? payload?.inventoryQuantity ?? null;

  if (quantity == null || quantity === "") {
    return null;
  }

  const number = Number(quantity);

  return Number.isFinite(number) ? number : quantity;
};

const normalizeSkuValue = (sku) => {
  if (sku == null) {
    return null;
  }

  const normalizedSku = String(sku).trim();

  return normalizedSku === "" ? null : normalizedSku;
};

const normalizeShopifyVariantForInventory = (variant, inventoryQuantity) => ({
  id: variant?.legacyResourceId == null ? idFromGid(variant?.id) : String(variant.legacyResourceId),
  gid: variant?.id ?? null,
  sku: variant?.sku ?? null,
  price: typeof variant?.price === "object" ? variant.price?.amount : variant?.price ?? null,
  barcode: variant?.barcode ?? null,
  taxable: variant?.taxable ?? null,
  inventoryQuantity: inventoryQuantity ?? variant?.inventoryQuantity ?? null,
  inventoryByLocation: normalizeInventoryLevels(variant?.inventoryItem?.inventoryLevels?.nodes),
});

const buildInventoryWebhookPayload = ({ trigger, product, variant, inventoryQuantity }) => {
  const normalizedVariant = normalizeShopifyVariantForInventory(variant, inventoryQuantity);
  const productName = product?.title ?? null;
  const shopifyProductId = product?.legacyResourceId == null ? idFromGid(product?.id) : String(product.legacyResourceId);

  return {
    event: "updated",
    topic: trigger?.topic ?? null,
    shopId: trigger?.shopId ?? null,
    shopDomain: trigger?.shopDomain ?? null,
    shopifyProductId,
    shopifyProductGid: product?.id ?? null,
    produktnamn: productName,
    products: buildRows([normalizedVariant], productName, shopifyProductId),
  };
};

const fetchVariantForInventoryItem = async ({ connections, trigger, inventoryItemGid }) => {
  const shopify = await shopifyClientForTrigger({ connections, trigger });

  if (!shopify) {
    throw new Error("Missing Shopify connection for EasyCashier inventory sync");
  }

  const query = `
    query EasyCashierInventoryItem($id: ID!) {
      inventoryItem(id: $id) {
        id
        legacyResourceId
        sku
        variant {
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
          product {
            id
            legacyResourceId
            title
          }
        }
      }
    }
  `;
  const result = await shopify.graphql(query, { id: inventoryItemGid });
  const data = parseShopifyGraphqlResult(result, "Shopify inventory item lookup");
  const variant = data?.inventoryItem?.variant;

  if (!variant?.product) {
    throw new Error(`No Shopify variant found for inventory item ${inventoryItemGid}`);
  }

  return {
    product: variant.product,
    variant: {
      ...variant,
      sku: variant.sku ?? data.inventoryItem?.sku ?? null,
    },
  };
};

const inventoryItemGidFromPayload = (payload) =>
  graphqlGid("InventoryItem", payload?.inventory_item_id ?? payload?.inventoryItemId);

export const enqueueShopifyInventoryLevelEasyCashierSync = async ({ api, logger, connections, trigger }) => {
  if (trigger?.type !== "shopify_webhook" || trigger.topic !== "inventory_levels/update") {
    return;
  }

  const payload = trigger.payload ?? {};
  const inventoryItemGid = inventoryItemGidFromPayload(payload);

  if (!inventoryItemGid) {
    logger.warn(
      {
        topic: trigger.topic,
        payload,
      },
      "Skipped EasyCashier inventory sync because Shopify webhook did not include an inventory item id"
    );
    return;
  }

  const { product, variant } = await fetchVariantForInventoryItem({
    connections,
    trigger,
    inventoryItemGid,
  });

  const easyCashierPayload = buildInventoryWebhookPayload({
    trigger,
    product,
    variant,
    inventoryQuantity: availableInventoryFromPayload(payload),
  });

  await enqueueShopifyProductEasyCashierPayload({ api, logger, payload: easyCashierPayload });
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

export const enqueueShopifyProductVariantInventoryEasyCashierSync = async ({
  api,
  logger,
  trigger,
  record,
  previousSku,
}) => {
  const skuChangeQueued = await enqueueShopifyProductVariantSkuChangeEasyCashierSync({
    api,
    logger,
    trigger,
    record,
    previousSku,
  });

  if (skuChangeQueued) {
    return;
  }

  const inventoryChanged =
    typeof record?.changed === "function" ? record.changed("inventoryQuantity") : record?.inventoryQuantity != null;

  if (!inventoryChanged || isProductWebhookTrigger(trigger)) {
    return;
  }

  if (!record?.productId) {
    logger.warn(
      {
        variantId: record?.id ?? null,
        shopId: record?.shopId ?? trigger?.shopId ?? null,
      },
      "Skipped EasyCashier variant sync because the Shopify product id was missing"
    );
    return;
  }

  const payload = {
    event: "updated",
    topic: trigger?.topic ?? null,
    shopId: record?.shopId ?? trigger?.shopId ?? null,
    shopDomain: trigger?.shopDomain ?? null,
    shopifyProductId: String(record.productId),
    shopifyProductGid: graphqlGid("Product", record.productId),
    produktnamn: null,
    products: [],
  };

  await enqueueShopifyProductEasyCashierPayload({ api, logger, payload });
};
