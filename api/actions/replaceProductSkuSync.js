/** @type { ActionRun } */
export const run = async ({ params, logger, api }) => {
    const previousSku = params.previousSku == null ? "" : String(params.previousSku).trim();
    const product = params.product;

    if (!previousSku) {
        throw new Error("Missing previous Shopify SKU for EasyCashier replacement");
    }

    if (!Array.isArray(product?.variants) || product.variants.length !== 1) {
        throw new Error("EasyCashier SKU replacement requires exactly one Shopify variant");
    }

    const newSku = product.variants[0]?.sku == null
        ? ""
        : String(product.variants[0].sku).trim();

    if (!newSku) {
        throw new Error("Missing new Shopify SKU for EasyCashier replacement");
    }

    const deletion = await api.deleteProductSync({
        shopId: params.shopId,
        productId: String(product.id),
        productTitle: params.previousTitle || product.title,
        productSkus: [previousSku],
    });

    const creation = await api.createProductSync({
        shopId: params.shopId,
        product,
    });

    return { previousSku, newSku, deletion, creation };
};

export const params = {
    shopId: { type: "string" },
    previousSku: { type: "string" },
    previousTitle: { type: "string" },
    product: { type: "object", additionalProperties: true },
};

export const options = {
    timeoutMS: 900000,
};
