import { useEffect, useState } from "react";
import { useLoaderData } from "react-router";
import { api } from "../api";

const extractBackgroundActionId = (result) =>
  result?.backgroundAction?.id ??
  result?.backgroundActionId ??
  result?.id ??
  null;

const extractBatchBackgroundActionIds = (result) => {
  const candidates = [
    result?.batchBackgroundActionIds,
    result?.result?.batchBackgroundActionIds,
    result?.backgroundAction?.result?.batchBackgroundActionIds,
    result?.backgroundAction?.batchBackgroundActionIds,
  ];

  const batchBackgroundActionIds = candidates.find(Array.isArray) ?? [];

  return batchBackgroundActionIds
    .map((backgroundActionId) =>
      backgroundActionId == null ? null : String(backgroundActionId),
    )
    .filter((backgroundActionId) => backgroundActionId != null && backgroundActionId !== "");
};

export const loader = async ({ context }) => {
  const shopId =
    context.session?.shopId ??
    context.connections?.shopify?.currentShopId ??
    null;

  return {
    shopId: shopId == null ? null : String(shopId),
  };
};

export default function Index() {
  const { shopId } = useLoaderData();
  const [syncingAll, setSyncingAll] = useState(false);
  const [syncCanceling, setSyncCanceling] = useState(false);
  const [activeBackgroundActionId, setActiveBackgroundActionId] =
    useState(null);
  const [activeBatchBackgroundActionIds, setActiveBatchBackgroundActionIds] =
    useState([]);
  const [syncAllNotice, setSyncAllNotice] = useState(null);
  const isSyncActive =
    activeBackgroundActionId != null || activeBatchBackgroundActionIds.length > 0;

  useEffect(() => {
    if (activeBatchBackgroundActionIds.length === 0) {
      return;
    }

    let cancelled = false;

    const waitForBatchJobs = async () => {
      try {
        const settledResults = await Promise.allSettled(
          activeBatchBackgroundActionIds.map((backgroundActionId) =>
            api.handle(api.syncEasyCashierBulkProducts, backgroundActionId).result(),
          ),
        );

        if (cancelled) {
          return;
        }

        const hasFailures = settledResults.some(
          (result) => result.status === "rejected",
        );

        setActiveBackgroundActionId(null);
        setActiveBatchBackgroundActionIds([]);
        setSyncAllNotice({
          type: hasFailures ? "error" : "success",
          message: hasFailures
            ? "EasyCashier bulk sync finished with errors."
            : "EasyCashier bulk sync completed.",
        });
      } catch (error) {
        if (cancelled) {
          return;
        }

        setActiveBackgroundActionId(null);
        setActiveBatchBackgroundActionIds([]);
        setSyncAllNotice({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    };

    void waitForBatchJobs();

    return () => {
      cancelled = true;
    };
  }, [activeBatchBackgroundActionIds]);

  const syncAllProducts = async () => {
    if (!shopId || syncingAll || isSyncActive) {
      return;
    }

    setSyncingAll(true);
    setSyncAllNotice(null);

    try {
      const backgroundAction = await api.syncAllProductsToEasyCashier({
        shopId,
      });
      const backgroundActionId = extractBackgroundActionId(backgroundAction);
      const batchBackgroundActionIds = extractBatchBackgroundActionIds(backgroundAction);

      setActiveBackgroundActionId(
        batchBackgroundActionIds.length > 0
          ? null
          : backgroundActionId == null
            ? null
            : String(backgroundActionId),
      );
      setActiveBatchBackgroundActionIds(batchBackgroundActionIds);
      setSyncAllNotice({
        type: "success",
        message: backgroundActionId
          ? `Queued background sync ${backgroundActionId}.`
          : "Queued background sync.",
      });
    } catch (error) {
      setSyncAllNotice({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSyncingAll(false);
    }
  };

  const cancelSyncAllProducts = async () => {
    if (!shopId || !isSyncActive || syncCanceling) {
      return;
    }

    setSyncCanceling(true);
    setSyncAllNotice(null);

    try {
      const cancelOperations = [];

      if (activeBackgroundActionId) {
        cancelOperations.push(
          api.syncAllProductsToEasyCashier({
            shopId,
            backgroundActionId: activeBackgroundActionId,
          }),
        );
      }

      cancelOperations.push(
        ...activeBatchBackgroundActionIds.map((backgroundActionId) =>
          api.handle(api.syncEasyCashierBulkProducts, backgroundActionId).cancel(),
        ),
      );

      await Promise.allSettled(cancelOperations);

      setSyncAllNotice({
        type: "success",
        message:
          activeBatchBackgroundActionIds.length > 0
            ? `Cancellation requested for ${activeBatchBackgroundActionIds.length} batch jobs.`
            : `Cancellation requested for background sync ${activeBackgroundActionId}.`,
      });
      setActiveBackgroundActionId(null);
      setActiveBatchBackgroundActionIds([]);
    } catch (error) {
      setSyncAllNotice({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSyncCanceling(false);
    }
  };

  const syncAllStatusMessage =
    syncAllNotice?.message ??
    (!shopId
      ? "Open the app from a connected Shopify shop to enable syncing."
      : null);
  const syncButtonLabel = syncingAll
    ? "Queueing..."
    : isSyncActive
      ? "Sync running..."
      : "Sync all";
  const isSyncBlocked = !shopId || syncingAll || syncCanceling || isSyncActive;
  const cancelButtonLabel = syncCanceling ? "Cancelling..." : "Cancel sync";

  return (
    <s-page heading="EasyCashier">
      <s-section heading="Sync all products">
        <div className="sync-all-panel">
          <div className="sync-all-copy">
            <div className="sync-all-eyebrow">Shopify to EasyCashier</div>
            <p className="sync-all-text">
              Queue a background job that walks every Shopify product, fetches
              the live variants and inventory data, and syncs each product into
              EasyCashier in small bulk batches.
            </p>

            {activeBatchBackgroundActionIds.length > 0 ? (
              <p className="sync-all-text sync-all-text-muted">
                Active background batches: {activeBatchBackgroundActionIds.length}
              </p>
            ) : activeBackgroundActionId ? (
              <p className="sync-all-text sync-all-text-muted">
                Active background action: {activeBackgroundActionId}
              </p>
            ) : null}
          </div>
          <div className="sync-all-actions">
            <div className="sync-all-action-buttons">
              <button
                type="button"
                className="sync-all-button"
                onClick={syncAllProducts}
                disabled={isSyncBlocked}
                title={
                  !shopId
                    ? "No active Shopify shop context is available"
                    : isSyncActive
                      ? "A background sync is already running"
                    : "Sync all Shopify products to EasyCashier"
                }
              >
                {syncButtonLabel}
              </button>
              {isSyncActive ? (
                <button
                  type="button"
                  className="sync-all-button sync-all-button-secondary"
                  onClick={cancelSyncAllProducts}
                  disabled={syncCanceling}
                >
                  {cancelButtonLabel}
                </button>
              ) : null}
            </div>
            {syncAllStatusMessage ? (
              <div
                className={`sync-all-status ${
                  syncAllNotice?.type === "error"
                    ? "sync-all-status-error"
                    : "sync-all-status-success"
                }`}
                aria-live={
                  syncAllNotice?.type === "error" ? "assertive" : "polite"
                }
              >
                {syncAllStatusMessage}
              </div>
            ) : null}
          </div>
        </div>
      </s-section>
    </s-page>
  );
}
