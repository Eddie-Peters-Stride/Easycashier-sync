import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { sendEasyCashierProductPayload } from "../../api/lib/easycashierApi.js";
import { jsonResponse, runWithEasycashierHarness } from "../support/easycashierTestHelpers.js";

const endpoint = "EASYCASHIER_API_BASE_URL/EASYCASHIER_COMPANY_ID/article";
const articleEndpoint = "https://easycashier.example/123/article";

describe("Shopify inventory to Easycashier inventory sync", () => {
  test("maps Sveavagen to the configured Easycashier store number by Shopify location id", async () => {
    await runWithEasycashierHarness(
      {
        env: {
          EASYCASHIER_STOCK_LOCATION_MAPPINGS: JSON.stringify([
            {
              easyCashierStoreNumber: 3,
              shopifyLocationId: "gid://shopify/Location/117367374172",
            },
            {
              easyCashierStoreNumber: 1,
              shopifyLocationId: "gid://shopify/Location/117367505244",
            },
          ]),
        },
        fetchResponses: [
          jsonResponse([
            {
              id: "ec-article-sveavagen",
              articleNumber: "62835",
            },
          ]),
          jsonResponse({
            id: "ec-article-sveavagen",
            articleNumber: "62835",
            stockEntries: [
              {
                storeNumber: 3,
                storeName: "Sveavägen",
                quantity: 0,
                orderPoint: 0,
              },
              {
                storeNumber: 1,
                storeName: "Kungsholmtorg",
                quantity: 0,
                orderPoint: 0,
              },
            ],
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
            payload: {
              event: "updated",
              topic: "inventory_levels/update",
              shopId: "101583159644",
              shopDomain: "dragonslair-se.myshopify.com",
              shopifyProductId: "15553626931548",
              shopifyProductGid: "gid://shopify/Product/15553626931548",
              produktnamn: "(41x63mm) Board Game Sleeves - Non-Glare: MINI",
              products: [
                {
                  artikelnummer: "62835",
                  ean: "5706569104252",
                  inventoryByLocation: [
                    {
                      available: 182,
                      locationGid: "gid://shopify/Location/117367374172",
                      locationId: "117367374172",
                      locationName: "Sveavägen 118",
                    },
                    {
                      available: 0,
                      locationGid: "gid://shopify/Location/117367505244",
                      locationId: "117367505244",
                      locationName: "Kungsholmstorg 8",
                    },
                  ],
                  inventoryQuantity: 182,
                  moms: 25,
                  pris: "25.00",
                  produktnamn: "(41x63mm) Board Game Sleeves - Non-Glare: MINI",
                  shopifyProductId: "15553626931548",
                  shopifyVariantGid: "gid://shopify/ProductVariant/57440523321692",
                  shopifyVariantId: "57440523321692",
                },
              ],
            },
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
        assert.equal(fetchCalls[0].url, `${articleEndpoint}?articleNumber=62835`);
        assert.equal(fetchCalls[1].options.method, "PUT");
        assert.equal(fetchCalls[1].url, `${articleEndpoint}/ec-article-sveavagen`);
        assert.equal(fetchCalls[2].options.method, "POST");
        assert.equal(fetchCalls[2].url, "https://easycashier.example/123/stock/increaseStock");

        const stockChange = JSON.parse(fetchCalls[2].options.body);
        assert.equal(stockChange.storeNumber, 3);
        assert.equal(stockChange.articles.length, 1);
        assert.equal(stockChange.articles[0].articleNumber, "62835");
        assert.equal(stockChange.articles[0].quantity, 182);
      }
    );
  });
});
