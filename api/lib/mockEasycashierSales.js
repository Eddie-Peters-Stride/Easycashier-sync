/**
 * Sales fixture captured from EasyCashier's grouped-by-article sales report.
 *
 * The supplied report did not include storeNumber, which the inventory sync
 * needs to select a Shopify location. Store 1 is used because it has a
 * configured EASYCASHIER_STORE_1_SHOPIFY_LOCATION_ID mapping.
 */
export const mockTodaysSalesData = {
  items: [
    { articleNumber: "12121212", quantity: -5, storeNumber: "1" },
    { articleNumber: "12121212", quantity: -10, storeNumber: "3" },
    { articleNumber: "8269222674501", quantity: 3, storeNumber: "1" },
    { articleNumber: "8269222674501", quantity: 1, storeNumber: "3" },
  ],
};

