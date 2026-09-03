import { EasycashierClient } from "../lib/EasycashierApiClient";

/** @type { ActionRun } */
export const run = async ({ params, logger, api, connections }) => {
  const easycashierClient = new EasycashierClient();
  try {
    const data = await easycashierClient.getTodaysSalesData();
    logger.info({ data }, "Inventory sync completed successfully");
  } catch (error) {
    logger.error({ error: error.message }, "Error syncing inventory from Easycashier");
  }
};


// Sync every 15 minutes
export const options = {
  triggers: {
    api: true,
    //scheduler: [{ cron: "*/15 * * * *" }],
  },
}