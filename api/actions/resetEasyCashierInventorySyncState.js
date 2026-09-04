/** @type { ActionRun } */
export const run = async ({ api, logger }) => {
  const job = await api.enqueue(
    api.processEasyCashierInventoryStateReset,
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
    "Queued nightly EasyCashier inventory state reset"
  );

  return {
    queued: true,
    skipped: false,
    jobId: job?.id ?? null,
  };
};

/** @type { ActionOptions } */
export const options = {
  triggers: {
    api: false,
    scheduler: [
      { every: "day", at: "24:00 UTC" },
    ],
  },
};
