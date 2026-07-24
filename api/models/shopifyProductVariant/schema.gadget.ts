import type { GadgetModel } from "gadget-server";

// This file describes the schema for the "shopifyProductVariant" model, go to https://easycashier-sync.gadget.app/edit to view/edit your model in Gadget
// For more information on how to update this file http://docs.gadget.dev

export const schema: GadgetModel = {
  type: "gadget/model-schema/v2",
  storageKey: "DataModel-Shopify-ProductVariant",
  fields: {
    easyCashierInventorySyncState: {
      type: "json",
      storageKey: "3PRDSeuim9uq",
    },
  },
  shopify: {
    fields: {
      barcode: { searchIndex: false },
      compareAtPrice: { filterIndex: false, searchIndex: false },
      inventoryPolicy: { filterIndex: false, searchIndex: false },
      inventoryQuantity: { filterIndex: false, searchIndex: false },
      media: true,
      option1: { filterIndex: false },
      option2: { filterIndex: false },
      option3: { filterIndex: false },
      position: { searchIndex: false },
      price: { searchIndex: false },
      priceListPrice: true,
      product: { searchIndex: false },
      quantityPriceBreaks: true,
      shop: { searchIndex: false },
      shopifyCreatedAt: { filterIndex: false, searchIndex: false },
      shopifyUpdatedAt: { filterIndex: false, searchIndex: false },
      sku: true,
      taxable: { filterIndex: false, searchIndex: false },
      title: { filterIndex: false },
    },
  },
};
