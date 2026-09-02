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
                articleType: "PRODUCT",
                retailPriceIncludingVat: variant.price || 0,
                vat: variant.taxable === false ? 0 : 0.25,
                webshop: true,
                webshopArticleId: product.id == null ? null : String(product.id),
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
        logger.error(
            {
                error,
                shopId: params.shopId,
                productId: params.product?.id,
            },
            "Error creating product sync"
        );
        throw error;
    }
};


export const params = {
    shopId: { type: "string" },
    product: { type: "object", additionalProperties: true },
};
