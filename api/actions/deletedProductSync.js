import { ActionOptions } from "gadget-server";
import { sendEasyCashierProductPayload } from "../lib/easycashierApi.js";

export const params = {
  payload: { type: "object", additionalProperties: true },
};

/** @type { GlobalActionRun } */
export const run = async ({ params, logger, api, connections }) => {
  return await sendEasyCashierProductPayload({
    api,
    params,
    logger,
    connections,
    endpoint: "EASYCASHIER_API_BASE_URL/EASYCASHIER_COMPANY_ID/article",
    endpointName: "delete",
    method: "DELETE",
  });
};

/** @type { ActionOptions } */
export const options = {
  timeoutMS: 900000,
  triggers: { api: true },
};
