import { deleteRecord } from "gadget-server";
import { preventCrossShopDataAccess } from "gadget-server/shopify";

/** @type { ActionRun } */
export const run = async ({ params, record, logger, api, connections, trigger }) => {
  await preventCrossShopDataAccess(params, record);
  await deleteRecord(record);
};

/** @type { ActionOnSuccess } */
export const onSuccess = async ({ params, record, logger, api, connections, trigger }) => {
  await api.enqueue(api.deleteProductSync, {
    payload: {
      shopId: record.shopId,
      record,
      params
    }
  })
};

/** @type { ActionOptions } */
export const options = {
  actionType: "delete",
  triggers: {
    shopify: {
      triggerKey: "shopifyproduct-delete",
    },
  },
};
