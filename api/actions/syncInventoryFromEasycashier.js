import { EasycashierClient } from "../lib/EasycashierApiClient";

/** @type { ActionRun } */
export const run = async ({ params, logger, api, connections }) => {
  const easycashierClient = new EasycashierClient();
  try {
    const data = await easycashierClient.syncInventoryFromEasycashier({ input: params });
    logger.info("Inventory sync completed successfully", { data });
  } catch (error) {
    logger.error("Error syncing inventory from Easycashier", { error: error.message });
  }
};


// Sync every 15 minutes
export const options = {
  triggers: {
    api: true,
    //scheduler: [{ cron: "*/15 * * * *" }],
  },
}