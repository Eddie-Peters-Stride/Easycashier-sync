import type { GadgetModel } from "gadget-server";

// This file describes the schema for the "shopifyPriceList" model, go to https://easycashier-sync.gadget.app/edit to view/edit your model in Gadget
// For more information on how to update this file http://docs.gadget.dev

export const schema: GadgetModel = {
  type: "gadget/model-schema/v2",
  storageKey: "DataModel-Shopify-PriceList",
  fields: {},
  searchIndex: false,
  shopify: {
    fields: {
      catalog: { searchIndex: false },
      currency: { filterIndex: false, searchIndex: false },
      fixedPricesCount: { filterIndex: false, searchIndex: false },
      name: { filterIndex: false, searchIndex: false },
      parent: { filterIndex: false, searchIndex: false },
      prices: true,
      quantityPriceBreaks: true,
      shop: { searchIndex: false },
    },
  },
};
