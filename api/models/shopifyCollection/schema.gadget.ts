import type { GadgetModel } from "gadget-server";

// This file describes the schema for the "shopifyCollection" model, go to https://easycashier-sync.gadget.app/edit to view/edit your model in Gadget
// For more information on how to update this file http://docs.gadget.dev

export const schema: GadgetModel = {
  type: "gadget/model-schema/v2",
  storageKey: "DataModel-Shopify-Collection",
  fields: {},
  shopify: {
    fields: {
      appliedDisjunctively: {
        filterIndex: false,
        searchIndex: false,
      },
      body: { filterIndex: false, searchIndex: false },
      collectionType: { filterIndex: false, searchIndex: false },
      handle: { filterIndex: false },
      image: { filterIndex: false, searchIndex: false },
      products: true,
      publishedAt: { searchIndex: false },
      publishedScope: { searchIndex: false },
      rules: { filterIndex: false, searchIndex: false },
      shop: { searchIndex: false },
      shopifyUpdatedAt: { filterIndex: false, searchIndex: false },
      sortOrder: { filterIndex: false, searchIndex: false },
      templateSuffix: { filterIndex: false, searchIndex: false },
      title: { filterIndex: false },
    },
  },
};
