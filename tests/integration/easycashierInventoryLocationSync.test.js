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
          EASYCASHIER_SYNC_INVENTORY_FROM_SHOPIFY: "true",
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

  test("does not zero an EasyCashier store when Shopify omits that mapped inventory location", async () => {
    await runWithEasycashierHarness(
      {
        env: {
          EASYCASHIER_SYNC_INVENTORY_FROM_SHOPIFY: "true",
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
              id: "ec-article-partial-locations",
              articleNumber: "RAILROAD-TILES",
            },
          ]),
          jsonResponse({
            id: "ec-article-partial-locations",
            articleNumber: "RAILROAD-TILES",
            stockEntries: [
              { storeNumber: 3, quantity: 10 },
              { storeNumber: 1, quantity: 5 },
            ],
          }),
          jsonResponse({ id: "stock-change" }),
        ],
      },
      async ({ api, logger, connections, fetchCalls, logEntries }) => {
        const result = await sendEasyCashierProductPayload({
          api,
          params: {
            payload: {
              event: "updated",
              topic: "inventory_levels/update",
              shopId: "101583159644",
              shopifyProductId: "railroad-product",
              products: [
                {
                  artikelnummer: "RAILROAD-TILES",
                  inventoryByLocation: [
                    {
                      available: 9,
                      locationGid: "gid://shopify/Location/117367374172",
                      locationId: "117367374172",
                      locationName: "Sveavägen 118",
                    },
                  ],
                  inventoryQuantity: 9,
                  shopifyProductId: "railroad-product",
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

        assert.deepEqual(result, { success: true, productCount: 1 });
        assert.equal(fetchCalls.length, 3);

        const stockChange = JSON.parse(fetchCalls[2].options.body);
        assert.equal(fetchCalls[2].url, "https://easycashier.example/123/stock/decreaseStock");
        assert.equal(stockChange.storeNumber, 3);
        assert.deepEqual(stockChange.articles, [
          {
            articleNumber: "RAILROAD-TILES",
            quantity: 1,
            costPriceExcludingVat: 0,
          },
        ]);
        const sendingLog = logEntries.info.find((entry) => /Sending EasyCashier inventory update/i.test(entry[1]));
        assert.ok(sendingLog);
        assert.equal(sendingLog[0].source, "Shopify");
        assert.equal(sendingLog[0].destination, "EasyCashier");
        assert.equal(sendingLog[0].changeType, "decrease");
        assert.deepEqual(sendingLog[0].inventoryChanges[0], {
          articleNumber: "RAILROAD-TILES",
          productName: null,
          shopifyProductId: "railroad-product",
          shopifyVariantId: null,
          shopifyLocationId: "117367374172",
          easyCashierStoreNumber: 3,
          fromQuantity: 10,
          toQuantity: 9,
          delta: -1,
          requestQuantity: 1,
          direction: "decrease",
          fromQuantityWasAssumed: false,
        });

        const reconciledLog = logEntries.info.find((entry) => /Reconciled Shopify inventory levels/i.test(entry[1]));
        assert.ok(reconciledLog);
        assert.equal(reconciledLog[0].movements[0].currentQuantity, 10);
        assert.equal(reconciledLog[0].movements[0].desiredQuantity, 9);
      }
    );
  });

  test("initializes both mapped stores when EasyCashier returns no current stock", async () => {
    await runWithEasycashierHarness(
      {
        env: {
          EASYCASHIER_SYNC_INVENTORY_FROM_SHOPIFY: "true",
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
          jsonResponse([{ id: "ec-article-no-stock", articleNumber: "15678946869596" }]),
          jsonResponse({ id: "ec-article-no-stock", articleNumber: "15678946869596" }),
          jsonResponse([{ id: "ec-article-no-stock", articleNumber: "15678946869596" }]),
          jsonResponse({ id: "stock-change-store-3" }),
          jsonResponse({ id: "stock-change-store-1" }),
        ],
      },
      async ({ api, logger, connections, fetchCalls, logEntries }) => {
        const result = await sendEasyCashierProductPayload({
          api,
          params: {
            payload: {
              event: "updated",
              topic: "inventory_levels/update",
              shopId: "101583159644",
              shopifyProductId: "15678946869596",
              products: [
                {
                  artikelnummer: "15678946869596",
                  inventoryByLocation: [
                    {
                      available: 90,
                      locationId: "117367374172",
                      locationGid: "gid://shopify/Location/117367374172",
                      locationName: "Sveavägen 118",
                    },
                    {
                      available: 90,
                      locationId: "117367505244",
                      locationGid: "gid://shopify/Location/117367505244",
                      locationName: "Kungsholmstorg 8",
                    },
                  ],
                  inventoryQuantity: 90,
                  produktnamn: "Pokemon Abyss Eye Booster (M5)(Japansk)",
                  shopifyProductId: "15678946869596",
                  shopifyVariantId: "58295968203100",
                  shopifyVariantGid: "gid://shopify/ProductVariant/58295968203100",
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

        assert.deepEqual(result, { success: true, productCount: 1 });
        assert.equal(fetchCalls.length, 5);

        const stockRequests = fetchCalls
          .filter(({ url }) => url.endsWith("/stock/increaseStock"))
          .map(({ options }) => JSON.parse(options.body));
        assert.deepEqual(
          stockRequests.map((request) => ({
            storeNumber: request.storeNumber,
            quantity: request.articles[0].quantity,
          })),
          [
            { storeNumber: 3, quantity: 90 },
            { storeNumber: 1, quantity: 90 },
          ]
        );

        const assumptionLog = logEntries.warn.find((entry) =>
          /initializing mapped stores from zero/i.test(entry[1])
        );
        assert.ok(assumptionLog);
        assert.deepEqual(
          assumptionLog[0].assumptions.map(({ easyCashierStoreNumber, assumedFromQuantity, toQuantity }) => ({
            easyCashierStoreNumber,
            assumedFromQuantity,
            toQuantity,
          })),
          [
            { easyCashierStoreNumber: 3, assumedFromQuantity: 0, toQuantity: 90 },
            { easyCashierStoreNumber: 1, assumedFromQuantity: 0, toQuantity: 90 },
          ]
        );
      }
    );
  });

  test("sends only one EasyCashier update for duplicate inventory webhooks", async () => {
    await runWithEasycashierHarness(
      {
        env: {
          EASYCASHIER_SYNC_INVENTORY_FROM_SHOPIFY: "true",
          EASYCASHIER_STOCK_LOCATION_MAPPINGS: JSON.stringify([
            {
              easyCashierStoreNumber: 3,
              shopifyLocationId: "gid://shopify/Location/117367374172",
            },
          ]),
        },
        fetchResponses: [
          jsonResponse([{ id: "ec-article-duplicate", articleNumber: "DUPLICATE-TRANSFER" }]),
          jsonResponse({
            id: "ec-article-duplicate",
            articleNumber: "DUPLICATE-TRANSFER",
            stockEntries: [{ storeNumber: 3, quantity: -1 }],
          }),
          jsonResponse({ id: "stock-change" }),
          jsonResponse({
            id: "ec-article-duplicate",
            articleNumber: "DUPLICATE-TRANSFER",
            stockEntries: [{ storeNumber: 3, quantity: 4 }],
          }),
          jsonResponse({ id: "stock-change-2" }),
        ],
      },
      async ({ api, logger, connections, fetchCalls, logEntries, variantStates }) => {
        const params = {
          payload: {
            event: "updated",
            topic: "inventory_levels/update",
            shopId: "101583159644",
            shopifyProductId: "duplicate-transfer-product",
            products: [
              {
                artikelnummer: "DUPLICATE-TRANSFER",
                inventoryByLocation: [
                  {
                    available: 4,
                    locationId: "117367374172",
                    locationGid: "gid://shopify/Location/117367374172",
                    locationName: "Sveavägen 118",
                  },
                ],
                inventoryQuantity: 4,
                shopifyProductId: "duplicate-transfer-product",
                shopifyVariantId: "duplicate-transfer-variant",
                shopifyVariantGid: "gid://shopify/ProductVariant/duplicate-transfer-variant",
              },
            ],
          },
        };

        const first = await sendEasyCashierProductPayload({
          api,
          params,
          logger,
          connections,
          endpoint,
          endpointName: "edit",
          method: "PUT",
        });
        const second = await sendEasyCashierProductPayload({
          api,
          params,
          logger,
          connections,
          endpoint,
          endpointName: "edit",
          method: "PUT",
        });
        const changedParams = structuredClone(params);
        changedParams.payload.products[0].inventoryByLocation[0].available = 5;
        changedParams.payload.products[0].inventoryQuantity = 5;
        const changed = await sendEasyCashierProductPayload({
          api,
          params: changedParams,
          logger,
          connections,
          endpoint,
          endpointName: "edit",
          method: "PUT",
        });

        assert.deepEqual(first, { success: true, productCount: 1 });
        assert.deepEqual(second, { success: true, productCount: 1 });
        assert.deepEqual(changed, { success: true, productCount: 1 });
        assert.equal(fetchCalls.length, 5);
        assert.equal(fetchCalls.filter(({ url }) => url.endsWith("/stock/increaseStock")).length, 2);
        assert.equal(JSON.parse(fetchCalls[2].options.body).articles[0].quantity, 5);
        assert.equal(JSON.parse(fetchCalls[4].options.body).articles[0].quantity, 1);
        assert.equal(variantStates.get("duplicate-transfer-variant").locations["117367374172"].quantity, 5);
        assert.equal(
          logEntries.info.some((entry) => /Skipped duplicate Shopify inventory synchronization/i.test(entry[1])),
          true
        );
      }
    );
  });

  test("can explicitly disable Shopify inventory writes to EasyCashier", async () => {
    await runWithEasycashierHarness(
      {
        env: {
          EASYCASHIER_SYNC_INVENTORY_FROM_SHOPIFY: "false",
        },
        fetchResponses: [
          jsonResponse([
            {
              id: "ec-article-master-stock",
              articleNumber: "126589",
            },
          ]),
          jsonResponse({
            id: "ec-article-master-stock",
            articleNumber: "126589",
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
              shopifyProductId: "15553772912988",
              products: [
                {
                  artikelnummer: "126589",
                  inventoryByLocation: [
                    {
                      available: 4,
                      locationId: "117367374172",
                      locationName: "Sveavägen 118",
                    },
                  ],
                  inventoryQuantity: 4,
                  shopifyProductId: "15553772912988",
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

        assert.deepEqual(result, { success: true, productCount: 1 });
        assert.equal(fetchCalls.length, 2);
        assert.equal(fetchCalls.some(({ url }) => /\/stock\/(increase|decrease)Stock$/.test(url)), false);
      }
    );
  });
});
