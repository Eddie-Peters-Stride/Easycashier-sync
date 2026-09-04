import { EasycashierClient } from "../lib/EasycashierApiClient";
import { findEasycashierArticle } from "../lib/findEasycashierArticle";

const normalizeSku = (value) => value == null ? "" : String(value).trim();

/** @type { ActionRun } */
export const run = async ({ params, logger, api, connections }) => {
    const easycashierClient = new EasycashierClient();
    const lookupArticleNumber = normalizeSku(params.lookupArticleNumber);

    if (!lookupArticleNumber) {
        throw new Error("Missing article number for EasyCashier product update");
    }

    try {
        const lookup = await findEasycashierArticle({
            client: easycashierClient,
            articleNumber: lookupArticleNumber,
            productTitle: params.productTitle,
            webshopArticleId: params.productId,
        });
        const article = lookup.article;

        if (!article) {
            logger.warn(
                {
                    lookupArticleNumber,
                    productTitle: params.productTitle,
                    ambiguousTitleMatch: lookup.ambiguous,
                    titleMatchCount: lookup.titleMatchCount,
                    changes: params.changes,
                },
                "Skipped EasyCashier product update because neither SKU nor a unique title matched"
            );
            return { updated: false, lookupArticleNumber };
        }

        const updatedArticle = {
            ...article,
            ...params.changes,
        };
        const productPayload = {
            articleNumber: updatedArticle.articleNumber,
            description: updatedArticle.description,
            barcode: updatedArticle.barcode,
            barcode2: updatedArticle.barcode2,
            articleType: updatedArticle.articleType,
            retailPriceIncludingVat: updatedArticle.retailPriceIncludingVat,
            costPriceExcludingVat: updatedArticle.costPriceExcludingVat,
            averageCostPriceExcludingVat: updatedArticle.averageCostPriceExcludingVat,
            accountNumber: updatedArticle.accountNumber,
            vat: updatedArticle.vat,
            webshop: updatedArticle.webshop,
            webshopArticleId: updatedArticle.webshopArticleId,
            erp: updatedArticle.erp,
            erpArticleId: updatedArticle.erpArticleId,
            specialOfferStartDate: updatedArticle.specialOfferStartDate,
            specialOfferStopDate: updatedArticle.specialOfferStopDate,
            specialOfferDiscount: updatedArticle.specialOfferDiscount,
            specialOfferDiscountType: updatedArticle.specialOfferDiscountType,
            articleStorePrices: updatedArticle.articleStorePrices,
            accumulative: updatedArticle.accumulative,
            askForQuantity: updatedArticle.askForQuantity,
            addTextWhenSold: updatedArticle.addTextWhenSold,
            stockItem: updatedArticle.stockItem,
            storageArea: updatedArticle.storageArea,
            supplierArticleNumber: updatedArticle.supplierArticleNumber,
            articleGroupId: updatedArticle.articleGroupId,
            supplierNumber: updatedArticle.supplierNumber,
            stockEntries: updatedArticle.stockEntries,
        };

        const response = await easycashierClient.updateProduct({
            id: article.id,
            input: productPayload,
        });

        logger.info(
            {
                lookupArticleNumber,
                matchedBy: lookup.matchedBy,
                changes: params.changes,
            },
            "Updated EasyCashier product fields"
        );

        return { updated: true, lookupArticleNumber, response };
    } catch (error) {
        const status = error?.response?.status;
        const responseData = error?.response?.data;

        logger.error(
            {
                lookupArticleNumber,
                changes: params.changes,
                status,
                responseData,
                message: error?.message ?? String(error),
            },
            "EasyCashier product update failed"
        );

        throw new Error(
            `EasyCashier product update failed${status ? ` with status ${status}` : ""}: ${
                typeof responseData === "string"
                    ? responseData
                    : responseData?.message ?? error?.message ?? String(error)
            }`
        );
    }
};


export const params = {
    shopId: { type: "string" },
    productId: { type: "string" },
    productTitle: { type: "string" },
    lookupArticleNumber: { type: "string" },
    changes: { type: "object", additionalProperties: true },
};
