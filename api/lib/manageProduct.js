const PRODUCT_WEBHOOK_EVENTS = {
  "products/create": "created",
  "products/update": "updated",
  "products/delete": "deleted",
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

  return {
    event,
    topic: trigger?.topic ?? null,
    shopId: trigger?.shopId ?? null,
    shopDomain: trigger?.shopDomain ?? null,
    shopifyProductId,
    shopifyProductGid: productGidForPayload(trigger),
    produktnamn: productName,
    products: buildRows(variants, productName, shopifyProductId),
  };
};

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
    queue: { name: "variant-bulk-updates", maxConcurrency: 5 },
    retries: { retryCount: 2, initialInterval: 2000 },
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

export const enqueueShopifyProductEasyCashierSync = async ({ api, logger, trigger, fallbackEvent }) => {
  if (!isProductWebhookTrigger(trigger)) {
    return;
  }

  const payload = buildShopifyProductEasyCashierPayload({
    trigger,
    event: productEventForTrigger(trigger, fallbackEvent),
  });

  await enqueueShopifyProductEasyCashierPayload({ api, logger, payload });
};
