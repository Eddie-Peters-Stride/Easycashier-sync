import { EasycashierClient } from "../lib/EasycashierApiClient";


/** @type { ActionRun } */
export const run = async ({ params, logger, api, connections }) => {
    const easycashierClient = new EasycashierClient();
    const productData = await easycashierClient.updateProduct({ input: params });
    return productData;
};


export const params = {
    shopId: { type: "string" },
    productId: { type: "string" },
};