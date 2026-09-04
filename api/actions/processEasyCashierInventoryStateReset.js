const PAGE_SIZE = 250;
const UPDATE_BATCH_SIZE = 50;

/** @type { ActionRun } */
export const run = async ({ api, logger }) => {
  const variantIds = [];
  let scannedVariantCount = 0;
  let page = await api.internal.shopifyProductVariant.findMany({
    first: PAGE_SIZE,
    filter: {
      easyCashierInventorySyncState: { isSet: true },
    },
    select: {
      id: true,
      easyCashierInventorySyncState: true,
    },
  });

  // Collect IDs before writing so cursor pagination is stable even though the
  // updates remove records from the isSet filter.
  while (true) {
    scannedVariantCount += page.length;

    for (const variant of page) {
      variantIds.push(variant.id);
    }

    if (!page.hasNextPage) {
      break;
    }

    page = await page.nextPage();
  }

  for (let index = 0; index < variantIds.length; index += UPDATE_BATCH_SIZE) {
    const batch = variantIds.slice(index, index + UPDATE_BATCH_SIZE);

    await Promise.all(
      batch.map((variantId) =>
        api.internal.shopifyProductVariant.update(variantId, {
          easyCashierInventorySyncState: null,
        })
      )
    );
  }

  logger.info(
    {
      resetVariantCount: variantIds.length,
      scannedVariantCount,
    },
    "Nightly EasyCashier inventory states reset"
  );

  return {
    resetVariantCount: variantIds.length,
    scannedVariantCount,
  };
};

/** @type { ActionOptions } */
export const options = {
  timeoutMS: 900000,
  triggers: {
    api: true,
  },
};
