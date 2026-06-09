import type { GadgetModel } from "gadget-server";

// This file describes the schema for the "shopifyProductOption" model, go to https://easycashier-sync.gadget.app/edit to view/edit your model in Gadget
// For more information on how to update this file http://docs.gadget.dev

export const schema: GadgetModel = {
  type: "gadget/model-schema/v2",
  storageKey: "DataModel-Shopify-ProductOption",
  fields: {},
  searchIndex: false,
  shopify: {
    fields: {
      name: { filterIndex: false, searchIndex: false },
      position: { filterIndex: false, searchIndex: false },
      product: { searchIndex: false },
      shop: { searchIndex: false },
      values: { filterIndex: false, searchIndex: false },
    },
  },
};
