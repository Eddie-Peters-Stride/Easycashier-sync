/**
 * Queue the inventory sync and return immediately.
 * All EasyCashier and Shopify requests run inside the queued worker action.
 * @type {ActionRun}
 */
export const run = async ({ api, logger }) => {
  const job = await api.enqueue(
    api.processEasyCashierInventorySync,
    {},
    {
      queue: {
        name: "easycashier-inventory-sync",
        maxConcurrency: 1,
      },
      priority: "HIGH",
      retries: {
        retryCount: 2,
      },
    }
  );

  logger.info(
    { jobId: job?.id ?? null },
    "Queued EasyCashier inventory sync"
  );

  return {
    queued: true,
    jobId: job?.id ?? null,
  };
};

export const options = {
  triggers: {
    api: true,
    // scheduler: [{ cron: "*/15 * * * *" }],
  },
};
