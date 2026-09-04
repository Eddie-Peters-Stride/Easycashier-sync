import { save } from "gadget-server";
import { takeSlidingWindowSlot } from "../../../lib/easycashierRateLimit.js";

/** @type { ActionRun } */
export const run = async ({ record }) => {
  const decision = takeSlidingWindowSlot({
    requestTimestamps: record.requestTimestamps,
  });

  record.requestTimestamps = decision.requestTimestamps;
  await save(record);

  return {
    granted: decision.granted,
    retryAfterMs: decision.retryAfterMs,
    requestsInWindow: decision.requestTimestamps.length,
  };
};

/** @type { ActionOptions } */
export const options = {
  actionType: "update",
  returnType: true,
};
