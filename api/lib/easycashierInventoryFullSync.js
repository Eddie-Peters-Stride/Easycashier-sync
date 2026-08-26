import { configuredEasyCashierStockLocationMappings } from "./easycashierApi.js";
import { EASYCASHIER_INVENTORY_PAGE_SIZE } from "./easycashierFullSync.js";

const idFromGid = (gid) =>
  typeof gid === "string" ? gid.split("/").pop() || null : null;

const normalizeLocationName = (value) =>
  value == null ? null : String(value).trim().toLowerCase() || null;

const availableQuantity = (inventoryLevel) => {
  const value = inventoryLevel?.quantities?.find(({ name }) => name === "available")?.quantity;
  const number = value == null || value === "" ? null : Number(value);
  return Number.isFinite(number) ? number : null;
};

const parseShopifyGraphqlResult = (result) => {
  const data = result?.data ?? result;
  const errors = data?.errors ?? result?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    throw new Error(`Shopify inventory lookup failed: ${errors.map(({ message }) => message).join(", ")}`);
  }
  return data;
};

const shopifyClientForShop = async ({ connections, shopId }) => {
  if (connections?.shopify?.current) return connections.shopify.current;
  if (shopId && connections?.shopify?.forShopId) return await connections.shopify.forShopId(shopId);
  return null;
};

const resolveMappedLocations = async ({ shopify }) => {
  const mappings = configuredEasyCashierStockLocationMappings();
  const needsLocationLookup = mappings.some(({ shopifyLocationId }) => !shopifyLocationId);
  let locationsByName = new Map();

  if (needsLocationLookup) {
    const result = await shopify.graphql(`
      query EasyCashierMappedLocations {
        locations(first: 250) { nodes { id name } }
      }
    `);
    const locations = parseShopifyGraphqlResult(result)?.locations?.nodes ?? [];
    locationsByName = new Map(locations.map((location) => [normalizeLocationName(location?.name), location]));
  }

  const resolvedLocations = mappings
    .map((mapping) => {
      if (mapping.shopifyLocationId) {
        return {
          id: `gid://shopify/Location/${mapping.shopifyLocationId}`,
          legacyId: String(mapping.shopifyLocationId),
          name: mapping.shopifyLocationName,
        };
      }

      const location = locationsByName.get(mapping.shopifyLocationName);
      return location
        ? { id: location.id, legacyId: idFromGid(location.id), name: location.name }
        : null;
    })
    .filter(Boolean);
  const uniqueLocations = [...new Map(resolvedLocations.map((location) => [location.id, location])).values()];

  if (uniqueLocations.length === 0) {
    throw new Error("None of the configured Shopify inventory locations could be resolved");
  }
  return uniqueLocations;
};

const inventoryLevelFields = (locations) => locations.map((_, index) => `
  location${index}: inventoryLevel(locationId: $location${index}) {
    location { id name }
    quantities(names: ["available"]) { name quantity }
  }
`).join("\n");

const inventoryPageQuery = (locations) => `
  query EasyCashierInventoryPage(
    $cursor: String
    ${locations.map((_, index) => `$location${index}: ID!`).join("\n")}
  ) {
    productVariants(first: ${EASYCASHIER_INVENTORY_PAGE_SIZE}, after: $cursor) {
      nodes {
        id
        legacyResourceId
        sku
        inventoryQuantity
        product { id legacyResourceId title }
        inventoryItem {
          id
          sku
          ${inventoryLevelFields(locations)}
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const productRowFromVariant = ({ variant, locations }) => ({
  shopifyProductId: variant.product?.legacyResourceId == null
    ? idFromGid(variant.product?.id)
    : String(variant.product.legacyResourceId),
  shopifyVariantId: variant.legacyResourceId == null
    ? idFromGid(variant.id)
    : String(variant.legacyResourceId),
  shopifyVariantGid: variant.id ?? null,
  artikelnummer: variant.sku ?? variant.inventoryItem?.sku ?? null,
  produktnamn: variant.product?.title ?? null,
  inventoryQuantity: variant.inventoryQuantity ?? null,
  inventoryByLocation: locations.map((location, index) => {
    const inventoryLevel = variant.inventoryItem?.[`location${index}`];
    if (!inventoryLevel) return null;
    return {
      locationId: idFromGid(inventoryLevel.location?.id) ?? location.legacyId,
      locationGid: inventoryLevel.location?.id ?? location.id,
      locationName: inventoryLevel.location?.name ?? location.name,
      available: availableQuantity(inventoryLevel),
    };
  }).filter(Boolean),
});

export const fetchAllShopifyInventoryRows = async ({ connections, shopId, signal }) => {
  const shopify = await shopifyClientForShop({ connections, shopId });
  if (!shopify) throw new Error("Missing Shopify connection for EasyCashier full inventory sync");

  const locations = await resolveMappedLocations({ shopify });
  const query = inventoryPageQuery(locations);
  const locationVariables = Object.fromEntries(locations.map((location, index) => [`location${index}`, location.id]));
  const products = [];
  let cursor = null;
  let pageCount = 0;

  while (true) {
    if (typeof signal?.throwIfAborted === "function") signal.throwIfAborted();
    const result = await shopify.graphql(query, { cursor, ...locationVariables });
    const page = parseShopifyGraphqlResult(result)?.productVariants;
    if (!page) throw new Error("Shopify inventory lookup did not return a productVariants page");

    products.push(...(page.nodes ?? []).map((variant) => productRowFromVariant({ variant, locations })));
    pageCount += 1;
    if (page.pageInfo?.hasNextPage !== true) break;

    cursor = page.pageInfo?.endCursor ?? null;
    if (!cursor) throw new Error("Shopify inventory page has a next page but no end cursor");
  }

  return { products, pageCount, locationCount: locations.length };
};
