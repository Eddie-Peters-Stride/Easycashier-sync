import { EasycashierClient } from "../lib/EasycashierApiClient";
import { findEasycashierArticle } from "../lib/findEasycashierArticle";
import { createEasyCashierRateLimiter } from "../lib/easycashierRateLimit.js";

const normalizeSku = (value) => value == null ? "" : String(value).trim();

/** @type { ActionRun } */
export const run = async ({ params, logger, api, connections }) => {
    const easycashierClient = new EasycashierClient({
        rateLimiter: createEasyCashierRateLimiter({ api, logger }),
        logger,
    });
    const productSkus = [...new Set(
        (Array.isArray(params.productSkus) ? params.productSkus : [])
            .map(normalizeSku)
            .filter(Boolean)
    )];

    if (productSkus.length === 0) {
        throw new Error("Missing Shopify product SKUs for EasyCashier deletion");
    }

    try {
        const deleted = [];
        const missingSkus = [];

        for (const sku of productSkus) {
            const lookup = await findEasycashierArticle({
                client: easycashierClient,
                articleNumber: sku,
                productTitle: params.productTitle,
                webshopArticleId: params.productId,
            });
            const article = lookup.article;

            if (!article) {
                missingSkus.push(sku);

                if (lookup.ambiguous) {
                    logger.warn(
                        {
                            productId: params.productId,
                            sku,
                            productTitle: params.productTitle,
                            titleMatchCount: lookup.titleMatchCount,
                        },
                        "Refused ambiguous EasyCashier title fallback during deletion"
                    );
                }
                continue;
            }

            const response = await easycashierClient.deleteProduct({
                input: { articleNumber: article.articleNumber },
            });
            deleted.push({
                articleNumber: article.articleNumber,
                matchedBy: lookup.matchedBy,
                response,
            });
        }

        if (missingSkus.length > 0) {
            logger.warn(
                {
                    productId: params.productId,
                    missingSkus,
                },
                "No EasyCashier article matched one or more deleted Shopify product SKUs"
            );
        }

        return { deleted, missingSkus };
    } catch (error) {
        const status = error?.response?.status;
        logger.error(
            {
                message: error?.message ?? String(error),
                status,
                productId: params.productId,
                productSkus,
            },
            "Error deleting product sync"
        );
        throw new Error(
            `EasyCashier product deletion failed${status ? ` with status ${status}` : ""}: ${error?.message ?? String(error)}`
        );
    }
};


export const params = {
    shopId: { type: "string" },
    productId: { type: "string" },
    productTitle: { type: "string" },
    productSkus: { type: "array", items: { type: "string" } },
};

export const options = {
    timeoutMS: 900000,
};
