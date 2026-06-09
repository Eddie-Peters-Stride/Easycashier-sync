import type { GadgetModel } from "gadget-server";

// This file describes the schema for the "shopifyCatalog" model, go to https://easycashier-sync.gadget.app/edit to view/edit your model in Gadget
// For more information on how to update this file http://docs.gadget.dev

export const schema: GadgetModel = {
  type: "gadget/model-schema/v2",
  storageKey: "DataModel-Shopify-Catalog",
  fields: {},
  searchIndex: false,
  shopify: {
    fields: {
      priceList: true,
      shop: { searchIndex: false },
      status: { filterIndex: false, searchIndex: false },
      title: { filterIndex: false, searchIndex: false },
      type: { filterIndex: false, searchIndex: false },
    },
  },
};
