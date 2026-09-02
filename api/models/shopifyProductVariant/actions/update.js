import { applyParams, save, ActionOptions } from "gadget-server";
import { preventCrossShopDataAccess } from "gadget-server/shopify";

/** @type { ActionRun } */
export const run = async ({ params, record, logger, api, connections }) => {
  const previousSku = record.sku;

  applyParams(params, record);
  record.__easyCashierPreviousSku = previousSku;

  await preventCrossShopDataAccess(params, record);
  params.__easyCashierPreviousSku = previousSku;
  await save(record);
};

/** @type { ActionOnSuccess } */
export const onSuccess = async ({ params, record, logger, api, connections, trigger }) => {

};

/** @type { ActionOptions } */
export const options = { actionType: "update" };
