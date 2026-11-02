import { randomUUID } from "node:crypto";
import { EASYCASHIER_QUEUE } from "../lib/easycashierQueue.js";

/**
 * Queue the inventory sync and return immediately.
 * All EasyCashier and Shopify requests run inside the queued worker action.
 * @type {ActionRun}
 */
export const run = async ({ api, logger, params }) => {
  const backgroundActionId = `easycashier-inventory-sync-${randomUUID()}`;
  const job = await api.enqueue(
    api.processEasyCashierInventorySync,
    { test: params.test },
    {
      id: backgroundActionId,
      queue: EASYCASHIER_QUEUE,
      priority: "HIGH",
      retries: {
        retryCount: 2,
      },
    }
  );


  return {
    queued: true,
    jobId: job?.id ?? null,
    test: params.test,
  };
};

export const params = {
  test: { type: "boolean", default: false },
};

// Synk between 08:00 and 22:55 every 5 mminutes
export const options = {
  triggers: {
    api: true,
    scheduler: [{ cron: "*/5 * * * *" }],
  },
};
