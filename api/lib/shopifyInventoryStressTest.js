export const SHOPIFY_INVENTORY_STRESS_ADJUSTMENT_COUNT = 500;
export const SHOPIFY_INVENTORY_STRESS_DELTA = 1;
export const SHOPIFY_INVENTORY_STRESS_CONFIRMATION =
  "INCREMENT_INVENTORY_AND_GET_SALES_500_TIMES";

const LOG_INTERVAL = 25;

const INVENTORY_CONTEXT_QUERY = `
  query ShopifyInventoryStressContext($variantId: ID!, $locationId: ID!) {
    productVariant(id: $variantId) {
      id
      sku
      product { id title }
      inventoryItem {
        id
        inventoryLevel(locationId: $locationId) {
          quantities(names: ["available"]) { name quantity }
        }
      }
    }
  }
`;

const ADJUST_INVENTORY_MUTATION = `
  mutation ShopifyInventoryStressIncrement(
    $input: InventoryAdjustQuantitiesInput!
    $idempotencyKey: String!
  ) {
    inventoryAdjustQuantities(input: $input) @idempotent(key: $idempotencyKey) {
      inventoryAdjustmentGroup {
        changes { name delta }
      }
      userErrors { field message }
    }
  }
`;

const unwrapGraphqlData = (result) => result?.data ?? result;

const formatErrors = (errors) =>
  errors.map((error) => {
    const field = Array.isArray(error?.field) ? `${error.field.join(".")}: ` : "";
    return `${field}${error?.message ?? String(error)}`;
  });

const assertNoGraphqlErrors = ({ result, userErrors = [], operationName }) => {
  const data = unwrapGraphqlData(result);
  const graphqlErrors = data?.errors ?? result?.errors ?? [];
  const errors = [...graphqlErrors, ...userErrors];

  if (errors.length > 0) {
    throw new Error(`${operationName} failed: ${formatErrors(errors).join(", ")}`);
  }

  return data;
};

export const toShopifyGid = (resource, value) => {
  const normalizedValue = String(value ?? "").trim();

  if (!normalizedValue) {
    throw new Error(`A Shopify ${resource} ID is required`);
  }

  return normalizedValue.startsWith("gid://")
    ? normalizedValue
    : `gid://shopify/${resource}/${normalizedValue}`;
};

const getInventoryContext = async ({ shopify, variantId, locationId }) => {
  const result = await shopify.graphql(INVENTORY_CONTEXT_QUERY, {
    variantId,
    locationId,
  });
  const data = assertNoGraphqlErrors({
    result,
    operationName: "Reading Shopify inventory",
  });
  const variant = data?.productVariant;
  const inventoryItem = variant?.inventoryItem;
  const inventoryLevel = inventoryItem?.inventoryLevel;
  const availableQuantity = inventoryLevel?.quantities?.find(
    (quantity) => quantity.name === "available"
  )?.quantity;

  if (!variant?.id || !inventoryItem?.id) {
    throw new Error(`Shopify variant ${variantId} or its inventory item was not found`);
  }

  if (!inventoryLevel || !Number.isInteger(availableQuantity)) {
    throw new Error(
      `Shopify variant ${variantId} is not stocked at location ${locationId}`
    );
  }

  return {
    availableQuantity,
    inventoryItemId: inventoryItem.id,
    productId: variant.product?.id ?? null,
    productTitle: variant.product?.title ?? null,
    sku: variant.sku ?? null,
    variantId: variant.id,
  };
};

/**
 * Increment one Shopify variant 500 separate times and fetch EasyCashier's
 * complete sales report after every increment. The run ID and iteration make
 * each inventory mutation safe if Gadget retries this worker.
 */
export const executeShopifyInventoryStressTest = async ({
  easycashierClient,
  locationId,
  logger,
  runId,
  shopify,
  variantId,
  adjustmentCount = SHOPIFY_INVENTORY_STRESS_ADJUSTMENT_COUNT,
}) => {
  if (!shopify?.graphql) {
    throw new Error("A Shopify GraphQL client is required for the stress test");
  }

  if (!easycashierClient?.getTodaysSalesData) {
    throw new Error("An EasyCashier client is required for the stress test");
  }

  if (!runId) {
    throw new Error("A run ID is required for the stress test");
  }

  const normalizedVariantId = toShopifyGid("ProductVariant", variantId);
  const normalizedLocationId = toShopifyGid("Location", locationId);
  const startingContext = await getInventoryContext({
    shopify,
    variantId: normalizedVariantId,
    locationId: normalizedLocationId,
  });
  let totalSalesRowsRead = 0;
  let lastSalesDate = null;

  for (let iteration = 1; iteration <= adjustmentCount; iteration += 1) {
    const result = await shopify.graphql(ADJUST_INVENTORY_MUTATION, {
      idempotencyKey: `shopify-inventory-stress:${runId}:${iteration}`,
      input: {
        name: "available",
        reason: "correction",
        referenceDocumentUri: `gid://easycashier-sync/InventoryStressTest/${runId}`,
        changes: [
          {
            changeFromQuantity: null,
            delta: SHOPIFY_INVENTORY_STRESS_DELTA,
            inventoryItemId: startingContext.inventoryItemId,
            locationId: normalizedLocationId,
          },
        ],
      },
    });
    const data = unwrapGraphqlData(result);
    const payload = data?.inventoryAdjustQuantities;

    assertNoGraphqlErrors({
      result,
      userErrors: payload?.userErrors ?? [],
      operationName: `Shopify inventory increment ${iteration}`,
    });

    if (!payload?.inventoryAdjustmentGroup) {
      throw new Error(`Shopify did not confirm inventory increment ${iteration}`);
    }

    // This is intentionally inside the loop: every Shopify adjustment is
    // followed by a real EasyCashier report request through the shared limiter.
    const salesResponse = await easycashierClient.getTodaysSalesData();
    const sales = salesResponse?.items;

    if (!Array.isArray(sales)) {
      throw new Error(`EasyCashier returned invalid sales data after increment ${iteration}`);
    }

    totalSalesRowsRead += sales.length;
    lastSalesDate = salesResponse.date ?? lastSalesDate;

    if (iteration % LOG_INTERVAL === 0 || iteration === adjustmentCount) {
      logger?.info(
        {
          adjustmentCount,
          completedAdjustments: iteration,
          lastSalesDate,
          runId,
          totalSalesRowsRead,
        },
        "Running Shopify inventory and EasyCashier sales stress test"
      );
    }
  }

  const endingContext = await getInventoryContext({
    shopify,
    variantId: normalizedVariantId,
    locationId: normalizedLocationId,
  });

  return {
    adjustmentCount,
    deltaPerAdjustment: SHOPIFY_INVENTORY_STRESS_DELTA,
    expectedTotalDelta: adjustmentCount * SHOPIFY_INVENTORY_STRESS_DELTA,
    finalAvailableQuantity: endingContext.availableQuantity,
    initialAvailableQuantity: startingContext.availableQuantity,
    lastSalesDate,
    locationId: normalizedLocationId,
    productId: startingContext.productId,
    productTitle: startingContext.productTitle,
    runId,
    salesRequestCount: adjustmentCount,
    sku: startingContext.sku,
    totalSalesRowsRead,
    variantId: normalizedVariantId,
  };
};
