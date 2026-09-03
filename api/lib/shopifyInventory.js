const VARIANT_INVENTORY_QUERY = `
  query EasyCashierVariantInventory($id: ID!) {
    productVariant(id: $id) {
      inventoryItem { id }
    }
  }
`;

const ADJUST_INVENTORY_MUTATION = `
  mutation EasyCashierAdjustInventory(
    $input: InventoryAdjustQuantitiesInput!
    $idempotencyKey: String!
  ) {
    inventoryAdjustQuantities(input: $input) @idempotent(key: $idempotencyKey) {
      userErrors { message }
    }
  }
`;

/**
 * Apply one variant's EasyCashier sales differences to Shopify inventory.
 * The idempotency key makes retrying the same change safe.
 */
export const adjustShopifyInventory = async ({
  connections,
  variant,
  salesDate,
  inventoryChanges,
}) => {
  if (!variant.shopId) {
    throw new Error(`Shopify variant ${variant.id} has no shop`);
  }

  const shopify = await connections.shopify.forShopId(variant.shopId);
  const variantId = String(variant.id).startsWith("gid://")
    ? String(variant.id)
    : `gid://shopify/ProductVariant/${variant.id}`;

  const inventoryResult = await shopify.graphql(VARIANT_INVENTORY_QUERY, {
    id: variantId,
  });
  const inventoryData = inventoryResult?.data ?? inventoryResult;
  const inventoryErrors = inventoryData?.errors ?? inventoryResult?.errors ?? [];
  const inventoryItemId = inventoryData?.productVariant?.inventoryItem?.id;

  if (inventoryErrors.length > 0) {
    throw new Error(
      `Shopify inventory lookup failed: ${inventoryErrors.map((error) => error.message).join(", ")}`
    );
  }

  if (!inventoryItemId) {
    throw new Error(`Shopify inventory item was not found for variant ${variant.id}`);
  }

  const changes = inventoryChanges.map((change) => {
    const location = process.env[
      `EASYCASHIER_STORE_${change.storeNumber}_SHOPIFY_LOCATION_ID`
    ];

    if (!location) {
      throw new Error(
        `Missing Shopify location mapping for EasyCashier store ${change.storeNumber}`
      );
    }

    return {
      changeFromQuantity: null,
      delta: change.delta,
      inventoryItemId,
      locationId: location.startsWith("gid://")
        ? location
        : `gid://shopify/Location/${location}`,
    };
  });

  const quantityTransitions = inventoryChanges
    .map(
      (change) =>
        `store-${change.storeNumber}-${change.savedQuantity}-to-${change.currentQuantity}`
    )
    .join(":");

  // Retrying the same saved-to-current quantity change creates the same key.
  // A later quantity change creates a new key and is processed normally.
  const idempotencyKey =
    `easycashier:${salesDate}:${variant.shopId}:${variant.id}:${quantityTransitions}`;

  const adjustmentResult = await shopify.graphql(ADJUST_INVENTORY_MUTATION, {
    idempotencyKey,
    input: {
      name: "available",
      reason: "correction",
      referenceDocumentUri: `gid://easycashier-sync/SalesReport/${salesDate}/${variant.id}`,
      changes,
    },
  });
  const adjustmentData = adjustmentResult?.data ?? adjustmentResult;
  const graphqlErrors = adjustmentData?.errors ?? adjustmentResult?.errors ?? [];
  const userErrors = adjustmentData?.inventoryAdjustQuantities?.userErrors ?? [];

  if (graphqlErrors.length > 0 || userErrors.length > 0) {
    const messages = [...graphqlErrors, ...userErrors].map((error) => error.message);
    throw new Error(`Shopify inventory adjustment failed: ${messages.join(", ")}`);
  }
};
