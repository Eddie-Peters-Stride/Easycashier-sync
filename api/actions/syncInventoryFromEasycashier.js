import { EASYCASHIER_QUEUE } from "../lib/easycashierQueue.js";

/**
 * Queue the inventory sync and return immediately.
 * All EasyCashier and Shopify requests run inside the queued worker action.
 * @type {ActionRun}
 */
export const run = async ({ api, logger, params }) => {
  const job = await api.enqueue(
    api.processEasyCashierInventorySync,
    { test: params.test },
    {
      queue: EASYCASHIER_QUEUE,
      priority: "HIGH",
      retries: {
        retryCount: 2,
      },
    }
  );

  logger.info(
    { jobId: job?.id ?? null, test: params.test },
    "Queued EasyCashier inventory sync"
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

export const options = {
  triggers: {
    api: true,
    // scheduler: [{ cron: "*/15 * * * *" }],
  },
};
