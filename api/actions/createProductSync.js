import { EasycashierClient } from "../lib/EasycashierApiClient";

/** @type { ActionRun } */
export const run = async ({ params, logger, api, connections }) => {
    const easycashierClient = new EasycashierClient();
    const product = params.product;
    logger.info(
        { shopId: params.shopId, product },
        "Starting product sync"
    );


    try {
        logger.info(JSON.stringify(params));
        const productPayload = {
            articleNumber: String(product.sku),
            description: product.title,
            barcode: String(product.ean),
            articleType: "PRODUCT",
            retailPriceIncludingVat: numberFromValue(product?.pris ?? product?.price, 0),
            costPriceExcludingVat: configuredNumber("EASYCASHIER_DEFAULT_COST_PRICE_EXCLUDING_VAT", 0),
            vat: 0.25,
            webshop: true,
            webshopArticleId: product.id,
        }

        logger.info("Product payload built successfully", { productPayload });

        const res = await easycashierClient.createProduct({ input: productPayload });
        logger.info("Product sync created successfully", { res });
    }
    catch (error) {
        logger.error("Error creating product sync", { error: error.message });
    }
};


export const params = {
    shopId: { type: "string" },
    product: { type: "json" },
};