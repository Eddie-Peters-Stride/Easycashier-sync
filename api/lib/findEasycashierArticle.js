const normalize = (value) => value == null ? "" : String(value).trim();
const normalizeTitle = (value) => normalize(value).toLocaleLowerCase("sv-SE");

const requireItems = (response) => {
    if (!Array.isArray(response?.items)) {
        throw new Error("EasyCashier products response did not contain an items array");
    }

    return response.items;
};

/**
 * Find an EasyCashier article by exact SKU, falling back to an exact title match.
 * Ambiguous title matches are deliberately not selected.
 */
export const findEasycashierArticle = async ({
    client,
    articleNumber,
    productTitle,
    webshopArticleId,
}) => {
    const normalizedArticleNumber = normalize(articleNumber);
    const skuItems = requireItems(await client.getProducts({
        searchValue: normalizedArticleNumber,
    }));
    const skuArticle = skuItems.find(
        (item) => normalize(item.articleNumber) === normalizedArticleNumber
    );

    if (skuArticle) {
        return { article: skuArticle, matchedBy: "articleNumber", ambiguous: false };
    }

    const normalizedProductTitle = normalizeTitle(productTitle);

    if (!normalizedProductTitle) {
        return { article: null, matchedBy: null, ambiguous: false };
    }

    const titleItems = requireItems(await client.getProducts({
        searchValue: normalize(productTitle),
    }));
    let titleMatches = titleItems.filter(
        (item) => normalizeTitle(item.description) === normalizedProductTitle
    );
    const normalizedWebshopArticleId = normalize(webshopArticleId);

    if (normalizedWebshopArticleId) {
        const webshopMatches = titleMatches.filter(
            (item) => normalize(item.webshopArticleId) === normalizedWebshopArticleId
        );

        if (webshopMatches.length > 0) {
            titleMatches = webshopMatches;
        }
    }

    if (titleMatches.length !== 1) {
        return {
            article: null,
            matchedBy: null,
            ambiguous: titleMatches.length > 1,
            titleMatchCount: titleMatches.length,
        };
    }

    return { article: titleMatches[0], matchedBy: "description", ambiguous: false };
};
