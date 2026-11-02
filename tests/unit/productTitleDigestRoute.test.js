import assert from "node:assert/strict";
import { test } from "node:test";
import { createRoute } from "../../api/routes/POST-product-title-digest.js";

const productId = "gid://shopify/Product/123";

async function invoke({ authorization = "Bearer flow-api-key", body = { productId }, result, authorized = true, authError = false } = {}) {
  let status = 200;
  let payload;
  let queried = false;
  const reply = {
    code(value) { status = value; return this; },
    send(value) { payload = value; return this; },
  };
  const logger = { info() {}, warn() {}, error() {} };
  const api = { shopifyShop: { maybeFindFirst: async () => ({ id: "shop-1" }) } };
  const connections = {
    shopify: {
      forShopId: async (id) => {
        assert.equal(id, "shop-1");
        return { graphql: async (_query, variables) => {
          queried = true;
          assert.deepEqual(variables, { productId });
          return result;
        } };
      },
    },
  };
  const route = createRoute((apiKey) => {
    assert.equal(apiKey, "flow-api-key");
    return { authorizeProductTitleDigest: async () => {
      if (authError) throw new Error("Invalid API key");
      return authorized;
    } };
  });
  await route({ request: { headers: { authorization }, body, ip: "127.0.0.1" }, reply, api, connections, logger });
  return { status, payload, queried };
}

test("requires a bearer API key before querying Shopify", async () => {
  const response = await invoke({ authorization: null });
  assert.equal(response.status, 401);
  assert.equal(response.queried, false);
});

test("requires the Shopify Flow role's action permission", async () => {
  const response = await invoke({ authorized: false });
  assert.equal(response.status, 403);
  assert.equal(response.queried, false);
});

test("rejects an invalid Gadget API key", async () => {
  const response = await invoke({ authError: true });
  assert.equal(response.status, 401);
  assert.equal(response.queried, false);
});

test("rejects a non-product GID", async () => {
  const response = await invoke({ body: { productId: "gid://shopify/Collection/123" } });
  assert.equal(response.status, 400);
  assert.equal(response.queried, false);
});

test("returns the original title and digest", async () => {
  const response = await invoke({ result: { data: { translatableResource: {
    resourceId: productId,
    translatableContent: [
      { key: "body_html", value: "Description", digest: "other" },
      { key: "title", value: "Svensk titel", digest: "title-digest" },
    ],
  } } } });
  assert.equal(response.status, 200);
  assert.deepEqual(response.payload, { productId, title: "Svensk titel", digest: "title-digest" });
});

test("reports a missing translatable product", async () => {
  const response = await invoke({ result: { data: { translatableResource: null } } });
  assert.equal(response.status, 404);
});

test("reports Shopify GraphQL errors", async () => {
  const response = await invoke({ result: { errors: [{ message: "Missing scope" }] } });
  assert.equal(response.status, 502);
});
