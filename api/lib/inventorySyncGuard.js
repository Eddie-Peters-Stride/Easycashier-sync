const INVENTORY_SYNC_DEDUP_TTL_MS = 30 * 60 * 1000;

const stateLocations = (state) =>
  state && typeof state === "object" && state.locations && typeof state.locations === "object"
    ? state.locations
    : {};

const variantIdFromProduct = (product) => {
  if (product?.shopifyVariantId != null && product.shopifyVariantId !== "") {
    return String(product.shopifyVariantId);
  }

  const gid = product?.shopifyVariantGid;
  return typeof gid === "string" && gid.includes("/") ? gid.split("/").pop() : null;
};

const locationKey = (stockLevel) =>
  stockLevel?.shopifyLocationId != null
    ? String(stockLevel.shopifyLocationId)
    : `store:${String(stockLevel?.storeNumber ?? "unknown")}`;

const completedState = ({ stockLevels, now }) => ({
  version: 2,
  locations: Object.fromEntries(
    stockLevels.map((stockLevel) => [
      locationKey(stockLevel),
      {
        status: "completed",
        storeNumber: Number(stockLevel.storeNumber),
        quantity: Number(stockLevel.desiredQuantity),
        completedAt: now,
        expiresAt: now + INVENTORY_SYNC_DEDUP_TTL_MS,
      },
    ])
  ),
});

const variantState = async ({ api, variantId }) => {
  const variant = await api.shopifyProductVariant.findOne(String(variantId), {
    select: {
      id: true,
      easyCashierInventorySyncState: true,
    },
  });

  return variant?.easyCashierInventorySyncState ?? null;
};

export const isDuplicateEasyCashierInventorySync = async ({ api, product, stockLevels, now = Date.now() }) => {
  const variantId = variantIdFromProduct(product);

  if (!variantId || !Array.isArray(stockLevels) || stockLevels.length === 0) {
    return false;
  }

  const state = await variantState({ api, variantId });
  const locations = stateLocations(state);

  return stockLevels.every((stockLevel) => {
    const completed = locations[locationKey(stockLevel)];

    return (
      completed?.status === "completed" &&
      Number(completed.expiresAt) > now &&
      Number(completed.storeNumber) === Number(stockLevel.storeNumber) &&
      Number(completed.quantity) === Number(stockLevel.desiredQuantity)
    );
  });
};

export const recordCompletedEasyCashierInventorySync = async ({
  api,
  product,
  stockLevels,
  logger,
  now = Date.now(),
}) => {
  const variantId = variantIdFromProduct(product);

  if (!variantId || !Array.isArray(stockLevels) || stockLevels.length === 0) {
    return;
  }

  const existingState = await variantState({ api, variantId });
  const locations = { ...stateLocations(existingState) };

  for (const stockLevel of stockLevels) {
    locations[locationKey(stockLevel)] = {
      status: "completed",
      storeNumber: Number(stockLevel.storeNumber),
      quantity: Number(stockLevel.desiredQuantity),
      completedAt: now,
      expiresAt: now + INVENTORY_SYNC_DEDUP_TTL_MS,
    };
  }

  await api.internal.shopifyProductVariant.update(String(variantId), {
    easyCashierInventorySyncState: {
      version: 2,
      locations,
    },
  });

  logger.info(
    {
      variantId,
      stockLevels: stockLevels.map(({ storeNumber, desiredQuantity, shopifyLocationId }) => ({
        storeNumber,
        desiredQuantity,
        shopifyLocationId,
      })),
    },
    "Recorded completed EasyCashier inventory synchronization"
  );
};

export const recordCompletedEasyCashierInventorySyncBatch = async ({
  api,
  productsWithStockLevels,
  logger,
  now = Date.now(),
}) => {
  const updates = (Array.isArray(productsWithStockLevels) ? productsWithStockLevels : [])
    .map(({ product, stockLevels }) => {
      const variantId = variantIdFromProduct(product);

      if (!variantId || !Array.isArray(stockLevels) || stockLevels.length === 0) return null;

      return {
        id: variantId,
        easyCashierInventorySyncState: completedState({ stockLevels, now }),
      };
    })
    .filter(Boolean);

  if (updates.length === 0) return;

  // Gadget's Internal API for Shopify-managed models exposes update, but not
  // bulkUpdate/updateMany. Keep these raw state writes serial to avoid
  // triggering public variant actions or contending with Gadget's request-rate
  // tracker. Full-catalog inventory runs do not call this marker writer.
  for (const update of updates) {
    const { id, ...values } = update;
    await api.internal.shopifyProductVariant.update(id, values);
  }

  logger.info(
    { variantCount: updates.length },
    "Recorded completed EasyCashier inventory synchronization batch"
  );
};
