import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { sendEasyCashierProductPayload } from "../../api/lib/easycashierApi.js";
import {
  jsonResponse,
  makeShopifyProductGraphqlResponse,
  runWithEasycashierHarness,
  textResponse,
} from "../support/easycashierTestHelpers.js";

const endpoint = "EASYCASHIER_API_BASE_URL/EASYCASHIER_COMPANY_ID/article";
const articleEndpoint = "https://easycashier.example/123/article";

const payloadFor = ({ productId, shopId = "shop-1", event }) => ({
  shopId,
  shopifyProductId: String(productId),
  event,
});

describe("Shopify to Easycashier product sync", () => {
  test("createdProductSync creates an article and increases inventory when Shopify stock is higher", async () => {
    await runWithEasycashierHarness(
      {
        shopifyResponses: [
          makeShopifyProductGraphqlResponse({
            productId: 111,
            variantId: 222,
            sku: "SKU-1",
            inventoryQuantity: 5,
            locationAvailable: 5,
          }),
        ],
        fetchResponses: [
          jsonResponse([]),
          jsonResponse({
            id: "ec-article-1",
            articleNumber: "SKU-1",
            stockQuantity: 2,
          }),
          jsonResponse({
            id: "ec-article-1",
            articleNumber: "SKU-1",
            stockQuantity: 2,
          }),
        ],
      },
      async ({ api, logger, connections, fetchCalls }) => {
        const result = await sendEasyCashierProductPayload({
          api,
          params: {
            payload: payloadFor({
              productId: 111,
              event: "created",
            }),
          },
          logger,
          connections,
          endpoint,
          endpointName: "create",
          method: "POST",
        });

        assert.deepEqual(result, {
          success: true,
          productCount: 1,
        });

        assert.equal(fetchCalls.length, 3);
        assert.equal(fetchCalls[0].options.method, "GET");
        assert.equal(
          fetchCalls[0].url,
          `${articleEndpoint}?itemsPerPage=500&pageNumber=1&sortColumn=articleNumber&sortDirection=asc`
        );
        assert.equal(fetchCalls[1].options.method, "POST");
        assert.equal(fetchCalls[1].url, articleEndpoint);
        assert.equal(fetchCalls[2].options.method, "POST");
        assert.equal(fetchCalls[2].url, "https://easycashier.example/123/stock/increaseStock");

        const createdArticle = JSON.parse(fetchCalls[1].options.body);
        assert.equal(createdArticle.articleNumber, "SKU-1");
        assert.equal(createdArticle.stockItem, true);
        assert.equal(createdArticle.description, "Test Product");

        const stockChange = JSON.parse(fetchCalls[2].options.body);
        assert.equal(stockChange.storeNumber, 1);
        assert.equal(stockChange.articles.length, 1);
        assert.equal(stockChange.articles[0].articleNumber, "SKU-1");
        assert.equal(stockChange.articles[0].quantity, 3);
      }
    );
  });

  test("updatedProductSync updates an article and decreases inventory when Shopify stock is lower", async () => {
    await runWithEasycashierHarness(
      {
        shopifyResponses: [
          makeShopifyProductGraphqlResponse({
            productId: 112,
            variantId: 223,
            sku: "SKU-2",
            inventoryQuantity: 3,
            locationAvailable: 3,
          }),
        ],
        fetchResponses: [
          jsonResponse([
            {
              id: "ec-article-2",
              articleNumber: "SKU-2",
              stockQuantity: 10,
            },
          ]),
          jsonResponse({
            id: "ec-article-2",
            articleNumber: "SKU-2",
            stockQuantity: 10,
          }),
          jsonResponse({
            id: "stock-change",
          }),
        ],
      },
      async ({ api, logger, connections, fetchCalls }) => {
        const result = await sendEasyCashierProductPayload({
          api,
          params: {
            payload: payloadFor({
              productId: 112,
              event: "updated",
            }),
          },
          logger,
          connections,
          endpoint,
          endpointName: "edit",
          method: "PUT",
        });

        assert.deepEqual(result, {
          success: true,
          productCount: 1,
        });

        assert.equal(fetchCalls.length, 3);
        assert.equal(fetchCalls[0].options.method, "GET");
        assert.equal(fetchCalls[0].url, `${articleEndpoint}?articleNumber=SKU-2`);
        assert.equal(fetchCalls[1].options.method, "PUT");
        assert.equal(fetchCalls[1].url, `${articleEndpoint}/ec-article-2`);
        assert.equal(fetchCalls[2].options.method, "POST");
        assert.equal(fetchCalls[2].url, "https://easycashier.example/123/stock/decreaseStock");

        const updatedArticle = JSON.parse(fetchCalls[1].options.body);
        assert.equal(updatedArticle.articleNumber, "SKU-2");
        assert.equal(updatedArticle.stockItem, true);

        const stockChange = JSON.parse(fetchCalls[2].options.body);
        assert.equal(stockChange.storeNumber, 1);
        assert.equal(stockChange.articles[0].articleNumber, "SKU-2");
        assert.equal(stockChange.articles[0].quantity, 7);

      }
    );
  });

  test("updatedProductSync uses direct SKU lookup when EasyCashier's default article list misses the article", async () => {
    await runWithEasycashierHarness(
      {
        shopifyResponses: [
          makeShopifyProductGraphqlResponse({
            productId: 118,
            variantId: 228,
            sku: "SKU-DIRECT",
            inventoryQuantity: 4,
            locationAvailable: 4,
          }),
        ],
        fetchResponses: [
          jsonResponse({
            id: "ec-article-direct",
            articleNumber: "SKU-DIRECT",
            stockQuantity: 4,
          }),
          jsonResponse({
            id: "ec-article-direct",
            articleNumber: "SKU-DIRECT",
            stockQuantity: 4,
          }),
        ],
      },
      async ({ api, logger, connections, fetchCalls }) => {
        const result = await sendEasyCashierProductPayload({
          api,
          params: {
            payload: payloadFor({
              productId: 118,
              event: "updated",
            }),
          },
          logger,
          connections,
          endpoint,
          endpointName: "edit",
          method: "PUT",
        });

        assert.deepEqual(result, {
          success: true,
          productCount: 1,
        });

        assert.equal(fetchCalls.length, 2);
        assert.equal(fetchCalls[0].options.method, "GET");
        assert.equal(fetchCalls[0].url, `${articleEndpoint}?articleNumber=SKU-DIRECT`);
        assert.equal(fetchCalls[1].options.method, "PUT");
        assert.equal(fetchCalls[1].url, `${articleEndpoint}/ec-article-direct`);
      }
    );
  });

  test("updatedProductSync paginates through EasyCashier article pages until it finds the matching SKU", async () => {
    await runWithEasycashierHarness(
      {
        env: {
          EASYCASHIER_ARTICLE_LOOKUP_QUERY_FIELDS: "articleNumber",
        },
        shopifyResponses: [
          makeShopifyProductGraphqlResponse({
            productId: 120,
            variantId: 230,
            sku: "166509",
            inventoryQuantity: 1,
            locationAvailable: 1,
          }),
        ],
        fetchResponses: [
          jsonResponse([]),
          jsonResponse({
            items: [
              {
                id: "ec-article-other",
                articleNumber: "3",
                stockQuantity: 0,
              },
            ],
            metaInformation: {
              currentPage: 1,
              totalPages: 2,
              totalResources: 2,
            },
          }),
          jsonResponse({
            items: [
              {
                id: "ec-article-166509",
                articleNumber: "166509",
                stockQuantity: 1,
              },
            ],
            metaInformation: {
              currentPage: 2,
              totalPages: 2,
              totalResources: 2,
            },
          }),
          jsonResponse({
            id: "ec-article-166509",
            articleNumber: "166509",
            stockQuantity: 1,
          }),
        ],
      },
      async ({ api, logger, connections, fetchCalls }) => {
        const result = await sendEasyCashierProductPayload({
          api,
          params: {
            payload: payloadFor({
              productId: 120,
              event: "updated",
            }),
          },
          logger,
          connections,
          endpoint,
          endpointName: "edit",
          method: "PUT",
        });

        assert.deepEqual(result, {
          success: true,
          productCount: 1,
        });

        assert.equal(fetchCalls.length, 4);
        assert.equal(fetchCalls[0].options.method, "GET");
        assert.equal(fetchCalls[0].url, `${articleEndpoint}?articleNumber=166509`);
        assert.equal(fetchCalls[1].options.method, "GET");
        const pagedLookupUrl = new URL(fetchCalls[1].url);
        assert.equal(pagedLookupUrl.origin + pagedLookupUrl.pathname, articleEndpoint);
        assert.equal(pagedLookupUrl.searchParams.get("pageNumber"), "1");
        assert.equal(pagedLookupUrl.searchParams.get("itemsPerPage"), "500");
        assert.equal(fetchCalls[2].options.method, "GET");
        const secondPagedLookupUrl = new URL(fetchCalls[2].url);
        assert.equal(secondPagedLookupUrl.origin + secondPagedLookupUrl.pathname, articleEndpoint);
        assert.equal(secondPagedLookupUrl.searchParams.get("pageNumber"), "2");
        assert.equal(secondPagedLookupUrl.searchParams.get("itemsPerPage"), "500");
        assert.equal(fetchCalls[3].options.method, "PUT");
        assert.equal(fetchCalls[3].url, `${articleEndpoint}/ec-article-166509`);
      }
    );
  });

  test("updatedProductSync retries EasyCashier article lookup after a 429 rate-limit response", async () => {
    await runWithEasycashierHarness(
      {
        shopifyResponses: [
          makeShopifyProductGraphqlResponse({
            productId: 121,
            variantId: 231,
            sku: "104105",
            inventoryQuantity: 4,
            locationAvailable: 4,
          }),
        ],
        fetchResponses: [
          jsonResponse({
            error: {
              code: 429,
              message: "Too Many Requests",
            },
          }, 429),
          jsonResponse([
            {
              id: "ec-article-104105",
              articleNumber: "104105",
              stockQuantity: 4,
            },
          ]),
          jsonResponse({
            id: "ec-article-104105",
            articleNumber: "104105",
            stockQuantity: 4,
          }),
        ],
      },
      async ({ api, logger, connections, fetchCalls }) => {
        const result = await sendEasyCashierProductPayload({
          api,
          params: {
            payload: payloadFor({
              productId: 121,
              event: "updated",
            }),
          },
          logger,
          connections,
          endpoint,
          endpointName: "edit",
          method: "PUT",
        });

        assert.deepEqual(result, {
          success: true,
          productCount: 1,
        });

        assert.equal(fetchCalls.length, 3);
        assert.equal(fetchCalls[0].options.method, "GET");
        assert.equal(fetchCalls[0].url, `${articleEndpoint}?articleNumber=104105`);
        assert.equal(fetchCalls[1].options.method, "GET");
        assert.equal(fetchCalls[1].url, `${articleEndpoint}?articleNumber=104105`);
        assert.equal(fetchCalls[2].options.method, "PUT");
        assert.equal(fetchCalls[2].url, `${articleEndpoint}/ec-article-104105`);
      }
    );
  });

  test("updatedProductSync reuses a cached EasyCashier article id on later updates for the same product", async () => {
    await runWithEasycashierHarness(
      {
        shopifyResponses: [
          makeShopifyProductGraphqlResponse({
            productId: 122,
            variantId: 232,
            sku: "CACHE-1",
            inventoryQuantity: 4,
            locationAvailable: 4,
          }),
          makeShopifyProductGraphqlResponse({
            productId: 122,
            variantId: 232,
            sku: "CACHE-1",
            inventoryQuantity: 4,
            locationAvailable: 4,
          }),
        ],
        fetchResponses: [
          jsonResponse({
            id: "ec-article-cache",
            articleNumber: "CACHE-1",
            stockQuantity: 4,
          }),
          jsonResponse({
            id: "ec-article-cache",
            articleNumber: "CACHE-1",
            stockQuantity: 4,
          }),
          jsonResponse({
            id: "ec-article-cache",
            articleNumber: "CACHE-1",
            stockQuantity: 4,
          }),
        ],
      },
      async ({ api, logger, connections, fetchCalls }) => {
        const firstResult = await sendEasyCashierProductPayload({
          api,
          params: {
            payload: payloadFor({
              productId: 122,
              event: "updated",
            }),
          },
          logger,
          connections,
          endpoint,
          endpointName: "edit",
          method: "PUT",
        });

        const secondResult = await sendEasyCashierProductPayload({
          api,
          params: {
            payload: payloadFor({
              productId: 122,
              event: "updated",
            }),
          },
          logger,
          connections,
          endpoint,
          endpointName: "edit",
          method: "PUT",
        });

        assert.deepEqual(firstResult, {
          success: true,
          productCount: 1,
        });
        assert.deepEqual(secondResult, {
          success: true,
          productCount: 1,
        });

        assert.equal(fetchCalls.length, 3);
        assert.equal(fetchCalls[0].options.method, "GET");
        assert.equal(fetchCalls[0].url, `${articleEndpoint}?articleNumber=CACHE-1`);
        assert.equal(fetchCalls[1].options.method, "PUT");
        assert.equal(fetchCalls[1].url, `${articleEndpoint}/ec-article-cache`);
        assert.equal(fetchCalls[2].options.method, "PUT");
        assert.equal(fetchCalls[2].url, `${articleEndpoint}/ec-article-cache`);
      }
    );
  });

  test("updatedProductSync skips unresolved duplicate creates instead of failing the background action", async () => {
    await runWithEasycashierHarness(
      {
        env: {
          EASYCASHIER_ARTICLE_LOOKUP_QUERY_FIELDS: "articleNumber",
        },
        shopifyResponses: [
          makeShopifyProductGraphqlResponse({
            productId: 119,
            variantId: 229,
            sku: "52807",
            inventoryQuantity: 103,
            locationAvailable: 103,
          }),
        ],
        fetchResponses: [
          jsonResponse({
            payload: {
              articleNumber: "52807",
            },
          }),
          jsonResponse({
            payload: {
              articleNumber: "52807",
            },
          }),
          jsonResponse({
            error: {
              code: 400,
              message: 'Article number "52807" already exists',
            },
          }, 400),
          jsonResponse({
            payload: {
              articleNumber: "52807",
            },
          }),
          jsonResponse({
            payload: {
              articleNumber: "52807",
            },
          }),
        ],
      },
      async ({ api, logger, connections, fetchCalls, logEntries }) => {
        const result = await sendEasyCashierProductPayload({
          api,
          params: {
            payload: payloadFor({
              productId: 119,
              event: "updated",
            }),
          },
          logger,
          connections,
          endpoint,
          endpointName: "edit",
          method: "PUT",
        });

        assert.deepEqual(result, {
          success: true,
          productCount: 1,
        });

        assert.equal(fetchCalls.length, 5);
        assert.equal(fetchCalls[0].options.method, "GET");
        assert.equal(fetchCalls[0].url, `${articleEndpoint}?articleNumber=52807`);
        assert.equal(
          fetchCalls[1].url,
          `${articleEndpoint}?itemsPerPage=500&pageNumber=1&sortColumn=articleNumber&sortDirection=asc`
        );
        assert.equal(fetchCalls[2].options.method, "POST");
        assert.equal(fetchCalls[3].options.method, "GET");
        assert.equal(fetchCalls[3].url, `${articleEndpoint}?articleNumber=52807`);
        assert.equal(
          fetchCalls[4].url,
          `${articleEndpoint}?itemsPerPage=500&pageNumber=1&sortColumn=articleNumber&sortDirection=asc`
        );
        assert.ok(
          logEntries.warn.some(
            ([context, message]) =>
              /did not return a matching article/i.test(message) &&
              JSON.stringify(context).includes('"responseBody":"{\\"payload\\":{\\"articleNumber\\":\\"52807\\"}}"')
          )
        );
        assert.ok(
          logEntries.warn.some(([, message]) => /already exists but could not be resolved/i.test(message))
        );
      }
    );
  });

  test("deletedProductSync deletes the article without changing stock", async () => {
    await runWithEasycashierHarness(
      {
        fetchResponses: [
          jsonResponse([
            {
              id: "ec-article-3",
              articleNumber: "SKU-3",
            },
          ]),
          textResponse("deleted"),
        ],
      },
      async ({ api, logger, connections, fetchCalls }) => {
        const result = await sendEasyCashierProductPayload({
          api,
          params: {
            payload: {
              ...payloadFor({
                productId: 113,
                event: "deleted",
              }),
              sku: "SKU-3",
            },
          },
          logger,
          connections,
          endpoint,
          endpointName: "delete",
          method: "DELETE",
        });

        assert.deepEqual(result, {
          success: true,
          productCount: 1,
        });

        assert.equal(fetchCalls.length, 2);
        assert.equal(fetchCalls[0].options.method, "GET");
        assert.equal(fetchCalls[1].options.method, "DELETE");
        assert.equal(fetchCalls[1].url, `${articleEndpoint}/ec-article-3`);

      }
    );
  });

  test("createdProductSync falls back to the Shopify variant id when SKU is missing", async () => {
    await runWithEasycashierHarness(
      {
        shopifyResponses: [
          makeShopifyProductGraphqlResponse({
            productId: 114,
            variantId: 224,
            sku: null,
            inventoryQuantity: 5,
            locationAvailable: 5,
          }),
        ],
        fetchResponses: [
          jsonResponse([]),
          jsonResponse({
            id: "ec-article-4",
            articleNumber: "224",
            stockQuantity: 0,
          }),
          jsonResponse({
            id: "stock-change",
          }),
        ],
      },
      async ({ api, logger, connections, fetchCalls }) => {
        const result = await sendEasyCashierProductPayload({
          api,
          params: {
            payload: payloadFor({
              productId: 114,
              event: "created",
            }),
          },
          logger,
          connections,
          endpoint,
          endpointName: "create",
          method: "POST",
        });

        assert.deepEqual(result, {
          success: true,
          productCount: 1,
        });

        assert.equal(fetchCalls.length, 3);
        assert.equal(fetchCalls[0].options.method, "GET");
        assert.equal(fetchCalls[1].options.method, "POST");
        assert.equal(fetchCalls[2].options.method, "POST");

        const createdArticle = JSON.parse(fetchCalls[1].options.body);
        assert.equal(createdArticle.articleNumber, "224");
      }
    );
  });

  test("deletedProductSync is a no-op when the SKU is missing", async () => {
    await runWithEasycashierHarness(
      {
        fetchResponses: [],
      },
      async ({ api, logger, connections, fetchCalls }) => {
        const result = await sendEasyCashierProductPayload({
          api,
          params: {
            payload: payloadFor({
              productId: 115,
              event: "deleted",
            }),
          },
          logger,
          connections,
          endpoint,
          endpointName: "delete",
          method: "DELETE",
        });

        assert.deepEqual(result, {
          success: true,
          productCount: 0,
        });

        assert.equal(fetchCalls.length, 0);
      }
    );
  });
});
