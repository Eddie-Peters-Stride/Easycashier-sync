import { EasycashierClient } from "../lib/EasycashierApiClient";

/** @type { ActionRun } */
export const run = async ({ params, logger }) => {
    try {
        const product = params.product;
        const variants = product?.variants;

        if (!Array.isArray(variants) || variants.length === 0) {
            throw new Error("Missing Shopify product variants for EasyCashier product creation");
        }

        const easycashierClient = new EasycashierClient();
        const responses = [];

        for (const variant of variants) {
            const sku = variant?.sku == null ? "" : String(variant.sku).trim();

            if (!sku) {
                throw new Error(`Missing SKU for Shopify variant ${variant?.id ?? "unknown"}`);
            }

            const productPayload = {
                articleNumber: sku,
                description: product.title ?? "",
                barcode: variant.barcode == null ? null : String(variant.barcode),
                barcode2: null,
                articleType: "PRODUCT",
                retailPriceIncludingVat: variant.price,
                costPriceExcludingVat: variant.price,
                averageCostPriceExcludingVat: variant.price,
                accountNumber: 3051,
                vat: 0.25,
                webshop: true,
                webshopArticleId: product.id == null ? null : String(product.id),
                erp: false,
                erpArticleId: null,
                specialOfferStartDate: null,
                specialOfferStopDate: null,
                specialOfferDiscount: null,
                specialOfferDiscountType: null,
                articleStorePrices: [],
                accumulative: false,
                askForQuantity: false,
                addTextWhenSold: false,
                stockItem: false,
                storageArea: null,
                supplierArticleNumber: "",
                articleGroupId: null,
                supplierNumber: null,
                stockEntries: [],
            };

            logger.info(
                {
                    shopId: params.shopId,
                    productId: product.id,
                    variantId: variant.id,
                    productPayload,
                },
                "Creating Shopify product variant in EasyCashier"
            );

            const response = await easycashierClient.createProduct({ input: productPayload });
            responses.push({ variantId: variant.id, response });
        }

        logger.info(
            {
                productId: product.id,
                variantCount: variants.length,
            },
            "Product variants created successfully in EasyCashier"
        );

        return responses;
    }
    catch (error) {
        const status = error?.response?.status;
        logger.error(
            {
                message: error?.message ?? String(error),
                code: error?.code,
                status,
                responseData: error?.response?.data,
                shopId: params.shopId,
                productId: params.product?.id,
            },
            "Error creating product sync"
        );

        // Axios errors contain the request configuration, including the API
        // token header. Throw a sanitized error so Gadget can retry the job
        // without writing credentials to its automatic error logs.
        throw new Error(
            `EasyCashier product creation failed${status ? ` with status ${status}` : ""}: ${error?.message ?? String(error)}`
        );
    }
};


export const params = {
    shopId: { type: "string" },
    product: { type: "object", additionalProperties: true },
};
