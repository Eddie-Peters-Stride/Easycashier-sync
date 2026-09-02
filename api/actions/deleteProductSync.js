import { EasycashierClient } from "../lib/EasycashierApiClient";


/** @type { ActionRun } */
export const run = async ({ params, logger, api, connections }) => {
    const easycashierClient = new EasycashierClient();

    try {
        const productData = await easycashierClient.deleteProduct({ input: params });
        return productData;
    } catch (error) {
        logger.error("Error deleting product sync", { error: error.message });
        throw error;
    }
};


export const params = {
    shopId: { type: "string" },
    productId: { type: "string" },
    easyCashierArticleId: { type: "string" },
};