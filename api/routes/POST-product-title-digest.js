import { Client } from "@gadget-client/easycashier-sync";

const SHOP_DOMAIN = "dragonslair-se.myshopify.com";
const PRODUCT_GID = /^gid:\/\/shopify\/Product\/[1-9]\d*$/;

const TITLE_DIGEST_QUERY = `
  query ProductTitleDigest($productId: ID!) {
    translatableResource(resourceId: $productId) {
      resourceId
      translatableContent {
        key
        value
        digest
      }
    }
  }
`;

export const createRoute = (makeClient = (apiKey) => new Client({ authenticationMode: { apiKey } })) => async ({ request, reply, api, connections, logger }) => {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || !/^Bearer \S+$/.test(authorization)) {
    logger.warn({ ip: request.ip }, "Unauthorized product title digest request");
    return reply.code(401).send({ error: "Unauthorized" });
  }

  try {
    const check = await makeClient(authorization.slice(7)).authorizeProductTitleDigest();
    if (check !== true) {
      logger.warn({ ip: request.ip }, "API key lacks product title digest permission");
      return reply.code(403).send({ error: "Forbidden" });
    }
  } catch (error) {
    logger.warn({ ip: request.ip, message: error?.message ?? String(error) }, "Gadget rejected product title digest API key");
    return reply.code(401).send({ error: "Unauthorized" });
  }

  const productId = request.body?.productId;
  if (typeof productId !== "string" || !PRODUCT_GID.test(productId)) {
    return reply.code(400).send({ error: "productId must be a Shopify Product GID" });
  }

  try {
    const shop = await api.shopifyShop.maybeFindFirst({
      filter: { myshopifyDomain: { equals: SHOP_DOMAIN } },
      select: { id: true },
    });
    if (!shop) {
      logger.error({ shopDomain: SHOP_DOMAIN }, "Shopify shop is not installed");
      return reply.code(503).send({ error: "Shopify shop is unavailable" });
    }

    const shopify = await connections.shopify.forShopId(shop.id);
    const response = await shopify.graphql(TITLE_DIGEST_QUERY, { productId });
    const data = response?.data ?? response;
    const errors = data?.errors ?? response?.errors;
    if (Array.isArray(errors) && errors.length > 0) {
      logger.error({ productId, messages: errors.map((entry) => entry.message) }, "Shopify translatable resource query failed");
      return reply.code(502).send({ error: "Shopify query failed" });
    }

    const resource = data?.translatableResource;
    if (!resource || resource.resourceId !== productId) {
      logger.info({ productId }, "Translatable product resource was not found");
      return reply.code(404).send({ error: "Translatable product resource not found" });
    }

    const title = resource.translatableContent?.find((entry) => entry.key === "title");
    if (typeof title?.value !== "string" || !title.digest) {
      logger.warn({ productId }, "Product title or digest is missing");
      return reply.code(404).send({ error: "Product title digest not found" });
    }

    logger.info({ productId }, "Product title digest retrieved");
    return reply.code(200).send({ productId, title: title.value, digest: title.digest });
  } catch (error) {
    logger.error({ productId, message: error?.message ?? String(error) }, "Product title digest request failed");
    return reply.code(502).send({ error: "Unable to retrieve product title digest" });
  }
};

export default createRoute();
