import type { GadgetModel } from "gadget-server";

// This file describes the schema for the "easycashierProductSyncLog" model, go to https://easycashier-sync.gadget.app/edit to view/edit your model in Gadget
// For more information on how to update this file http://docs.gadget.dev

export const schema: GadgetModel = {
  type: "gadget/model-schema/v2",
  storageKey: "qkNORcXiRy4p",
  fields: {
    details: { type: "json", storageKey: "InaWirkrYjy1" },
    easycashierArticleNumber: {
      type: "string",
      storageKey: "4ljiQl4exMB7",
    },
    errorMessage: { type: "string", storageKey: "wEGg3R0YhA3Z" },
    event: { type: "string", storageKey: "NzQhxN7am_uV" },
    shopId: { type: "string", storageKey: "NQyqEgij8I9F" },
    shopifyProductId: { type: "string", storageKey: "ijni5lxf0Q3l" },
    status: { type: "string", storageKey: "02ygmeAYn-Xn" },
  },
};
