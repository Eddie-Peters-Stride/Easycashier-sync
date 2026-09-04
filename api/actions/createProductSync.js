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
        const normalizeSku = (value) => value == null ? "" : String(value).trim();
        const processedSkus = new Set();
        const responses = [];

        for (const variant of variants) {
            const sku = normalizeSku(variant?.sku);

            if (!sku) {
                throw new Error(`Missing SKU for Shopify variant ${variant?.id ?? "unknown"}`);
            }

            if (processedSkus.has(sku)) {
                logger.info(
                    { productId: product.id, variantId: variant.id, sku },
                    "Skipped duplicate Shopify variant SKU during EasyCashier article creation"
                );
                continue;
            }

            const productsResponse = await easycashierClient.getProducts({
                searchValue: sku,
            });

            if (!Array.isArray(productsResponse?.items)) {
                throw new Error("EasyCashier products response did not contain an items array");
            }

            const existingArticle = productsResponse.items.find(
                (article) => normalizeSku(article.articleNumber) === sku
            );

            if (existingArticle) {
                logger.info(
                    { productId: product.id, variantId: variant.id, sku },
                    "Skipped EasyCashier article creation because the SKU already exists"
                );
                processedSkus.add(sku);
                continue;
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
            processedSkus.add(sku);
        }

        logger.info(
            {
                productId: product.id,
                variantCount: variants.length,
                createdVariantCount: responses.length,
            },
            "Shopify product variants created successfully in EasyCashier"
        );

        return { created: responses };
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
