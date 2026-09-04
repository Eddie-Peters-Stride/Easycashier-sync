import { EASYCASHIER_QUEUE } from "../lib/easycashierQueue.js";

/** @type { ActionRun } */
export const run = async ({ api, logger }) => {
  const job = await api.enqueue(
    api.processEasyCashierInventoryStateReset,
    {},
    {
      queue: EASYCASHIER_QUEUE,
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
      { every: "day", at: "00:00 UTC" },
    ],
  },
};
