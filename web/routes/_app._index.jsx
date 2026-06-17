import { Fragment, useEffect, useState } from "react";
import { useFindMany } from "@gadgetinc/react";
import { useLoaderData } from "react-router";
import { api } from "../api";

const PAGE_SIZE = 10;
const SYNC_ALL_EVENT = "sync-all";
const numberFormatter = new Intl.NumberFormat();

const formatTime = (value) => {
  if (!value) {
    return "";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(value));
};

const formatJson = (value) => {
  if (value == null) {
    return "";
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch (_) {
    return String(value);
  }
};

const formatCount = (value) => numberFormatter.format(Number(value ?? 0));

const formatOptionalCount = (value) => (value == null ? "—" : formatCount(value));

const statusClassName = (status) => `sync-log-status sync-log-status-${String(status ?? "unknown").toLowerCase()}`;

const articleNumberForLog = (log) =>
  log.easycashierArticleNumber ?? log.details?.requests?.[0]?.easycashierArticleNumber ?? "";

export const loader = async ({ context }) => {
  const shopId = context.session?.shopId ?? context.connections?.shopify?.currentShopId ?? null;

  return {
    shopId: shopId == null ? null : String(shopId),
  };
};

function SyncLogDetails({ log }) {
  const requests = Array.isArray(log.details?.requests) ? log.details.requests : [];

  return (
    <div className="sync-log-detail-panel">
      {log.errorMessage && (
        <div className="sync-log-error-block">
          <div className="sync-log-detail-label">Error</div>
          <div>{log.errorMessage}</div>
        </div>
      )}

      {requests.length > 0 ? (
        requests.map((request, index) => {
          const changedData = request.easycashierPayload ?? request.sourceProduct;

          return (
            <div className="sync-log-request" key={`${request.easycashierArticleNumber ?? "request"}-${index}`}>
              <div className="sync-log-request-meta">
                <span>{request.endpointName ?? request.requestedEndpointName}</span>
                <span>{request.method}</span>
                <span>{request.responseStatus ? `HTTP ${request.responseStatus}` : ""}</span>
              </div>
              <div className="sync-log-detail-grid">
                <div>
                  <div className="sync-log-detail-label">Changed data</div>
                  <pre>{formatJson(changedData)}</pre>
                </div>
                <div>
                  <div className="sync-log-detail-label">Source product</div>
                  <pre>{formatJson(request.sourceProduct)}</pre>
                </div>
                {(request.responseBody || request.error) && (
                  <div>
                    <div className="sync-log-detail-label">Response</div>
                    <pre>{request.error ?? request.responseBody}</pre>
                  </div>
                )}
              </div>
            </div>
          );
        })
      ) : log.details ? (
        <pre>{formatJson(log.details)}</pre>
      ) : (
        <div>No details stored</div>
      )}
    </div>
  );
}

function SyncProgressCard({ syncRun }) {
  if (!syncRun) {
    return null;
  }

  const details = syncRun.details ?? {};
  const totalProducts = details.totalProducts == null ? null : Number(details.totalProducts);
  const processedProducts = Number(details.processedProducts ?? 0);
  const successProducts = Number(details.successProducts ?? 0);
  const failureProducts = Number(details.failureProducts ?? 0);
  const failedProductIds = Array.isArray(details.failedProductIds) ? details.failedProductIds : [];
  const remainingProducts = totalProducts == null ? null : Math.max(totalProducts - processedProducts, 0);
  const percent =
    totalProducts == null ? 0 : totalProducts > 0 ? Math.min(100, Math.round((processedProducts / totalProducts) * 100)) : 100;

  const isCompleted = syncRun.status === "completed";
  const isFailed = syncRun.status === "failed";
  const hasFailures = failureProducts > 0;
  const statusLabel = (() => {
    if (isFailed) {
      return "Failed";
    }

    if (isCompleted && hasFailures) {
      return "Completed with failures";
    }

    if (isCompleted) {
      return "Completed";
    }

    if (syncRun.status === "running") {
      return "Syncing";
    }

    if (syncRun.status === "preparing") {
      return "Preparing";
    }

    return String(syncRun.status ?? "Unknown");
  })();

  const progressStatusClassName = (() => {
    if (isCompleted && hasFailures) {
      return "sync-progress-status sync-progress-status-warning";
    }

    return `sync-progress-status sync-progress-status-${String(syncRun.status ?? "unknown").toLowerCase()}`;
  })();

  const progressBarClassName = (() => {
    if (isCompleted && hasFailures) {
      return "sync-progress-bar-fill sync-progress-bar-fill-warning";
    }

    return `sync-progress-bar-fill sync-progress-bar-fill-${String(syncRun.status ?? "unknown").toLowerCase()}`;
  })();

  const progressText =
    totalProducts == null
      ? "Counting Shopify products before the sync starts."
      : `Processed ${formatCount(processedProducts)} of ${formatCount(totalProducts)} products.`;

  return (
    <div className="sync-progress-card">
      <div className="sync-progress-header">
        <div className="sync-progress-copy">
          <div className="sync-progress-eyebrow">Latest sync run</div>
          <h3 className="sync-progress-title">EasyCashier product sync</h3>
        </div>
        <span className={progressStatusClassName}>{statusLabel}</span>
      </div>

      <div
        className="sync-progress-bar"
        role="progressbar"
        aria-label="EasyCashier product sync progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={progressText}
      >
        <div className={progressBarClassName} style={{ width: `${percent}%` }} />
      </div>

      <div className="sync-progress-summary">{progressText}</div>
      <div className="sync-progress-meta">Last updated {formatTime(syncRun.updatedAt)}</div>

      <div className="sync-progress-metrics">
        <div className="sync-progress-metric">
          <span className="sync-progress-metric-value">{formatOptionalCount(totalProducts)}</span>
          <span className="sync-progress-metric-label">Total products</span>
        </div>
        <div className="sync-progress-metric">
          <span className="sync-progress-metric-value">{formatCount(processedProducts)}</span>
          <span className="sync-progress-metric-label">Processed</span>
        </div>
        <div className="sync-progress-metric">
          <span className="sync-progress-metric-value">{formatCount(successProducts)}</span>
          <span className="sync-progress-metric-label">Succeeded</span>
        </div>
        <div className="sync-progress-metric">
          <span className="sync-progress-metric-value">{formatCount(failureProducts)}</span>
          <span className="sync-progress-metric-label">Failed</span>
        </div>
        <div className="sync-progress-metric">
          <span className="sync-progress-metric-value">{formatOptionalCount(remainingProducts)}</span>
          <span className="sync-progress-metric-label">Remaining</span>
        </div>
      </div>

      {isCompleted && totalProducts === 0 ? (
        <div className="sync-progress-note">No Shopify products were found for this shop.</div>
      ) : null}

      {hasFailures && failedProductIds.length > 0 ? (
        <div className="sync-progress-failed-list">
          <div className="sync-progress-failed-list-label">Failed product IDs</div>
          <div>{failedProductIds.join(", ")}</div>
        </div>
      ) : null}

      {isFailed && syncRun.errorMessage ? <div className="sync-progress-error">{syncRun.errorMessage}</div> : null}
    </div>
  );
}

export default function Index() {
  const { shopId } = useLoaderData();
  const [cursorStack, setCursorStack] = useState([]);
  const [expandedLogId, setExpandedLogId] = useState(null);
  const [syncingAll, setSyncingAll] = useState(false);
  const [pendingSyncLogId, setPendingSyncLogId] = useState(null);
  const [syncAllNotice, setSyncAllNotice] = useState(null);
  const currentCursor = cursorStack[cursorStack.length - 1];
  const syncRunQueryOptions = {
    first: 1,
    live: true,
    pause: !shopId,
    sort: { createdAt: "Descending" },
    filter: {
      shopId: { equals: shopId },
      event: { equals: SYNC_ALL_EVENT },
    },
    select: {
      id: true,
      status: true,
      errorMessage: true,
      details: true,
      createdAt: true,
      updatedAt: true,
    },
  };
  const logQueryOptions = {
    first: PAGE_SIZE,
    live: currentCursor == null,
    pause: !shopId,
    sort: { createdAt: "Descending" },
    filter: {
      shopId: { equals: shopId },
      event: { notEquals: SYNC_ALL_EVENT },
    },
    select: {
      id: true,
      event: true,
      shopifyProductId: true,
      easycashierArticleNumber: true,
      status: true,
      errorMessage: true,
      details: true,
      createdAt: true,
    },
  };

  if (currentCursor) {
    logQueryOptions.after = currentCursor;
  }

  const [{ data: syncRuns, error: syncRunError }] = useFindMany(api.easycashierProductSyncLog, {
    ...syncRunQueryOptions,
  });
  const [{ data: logs, fetching, error }] = useFindMany(api.easycashierProductSyncLog, {
    ...logQueryOptions,
  });
  const syncRun = syncRuns?.[0] ?? null;
  const pageInfo = logs?.pagination?.pageInfo;
  const pageNumber = cursorStack.length + 1;

  useEffect(() => {
    if (pendingSyncLogId && syncRun?.id === pendingSyncLogId) {
      setPendingSyncLogId(null);
    }
  }, [pendingSyncLogId, syncRun?.id]);

  const goToNextPage = () => {
    if (!pageInfo?.endCursor) {
      return;
    }

    setExpandedLogId(null);
    setCursorStack((cursors) => [...cursors, pageInfo.endCursor]);
  };

  const goToPreviousPage = () => {
    setExpandedLogId(null);
    setCursorStack((cursors) => cursors.slice(0, -1));
  };

  const syncAllProducts = async () => {
    if (!shopId || syncingAll) {
      return;
    }

    setSyncingAll(true);
    setSyncAllNotice(null);

    try {
      const backgroundAction = await api.syncAllProductsToEasyCashier({ shopId });

      setPendingSyncLogId(backgroundAction?.progressLogId ?? null);
      setSyncAllNotice({
        type: "success",
        message: `Queued background sync ${backgroundAction?.backgroundActionId ?? backgroundAction?.id ?? "job"}. Watch the progress card above.`,
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
  const syncAllStatusMessage =
    syncAllNotice?.message ?? (!shopId ? "Open the app from a connected Shopify shop to enable syncing." : null);
  const syncRunDisabled = ["queued", "preparing", "running"].includes(String(syncRun?.status ?? "").toLowerCase());
  const syncStartPending = pendingSyncLogId != null && syncRun?.id !== pendingSyncLogId;
  const syncButtonLabel = syncingAll ? "Queueing..." : syncRunDisabled || syncStartPending ? "Syncing..." : "Sync all";

  return (
    <s-page heading="EasyCashier">
      <s-section heading="Sync all products">
        {syncRunError ? <div className="sync-progress-error sync-progress-error-inline">Unable to load sync progress.</div> : null}
        {syncRun ? <SyncProgressCard syncRun={syncRun} /> : null}
        <div className="sync-all-panel">
          <div className="sync-all-copy">
            <div className="sync-all-eyebrow">Shopify to EasyCashier</div>
            <p className="sync-all-text">
              Queue a background job that walks every Shopify product, fetches the live variants and inventory data,
              and syncs each product into EasyCashier one at a time.
            </p>
            <p className="sync-all-text sync-all-text-muted">
              The job runs through the dedicated EasyCashier queue so the API stays within the configured request
              limit.
            </p>
          </div>
          <div className="sync-all-actions">
            <button
              type="button"
              className="sync-all-button"
              onClick={syncAllProducts}
              disabled={!shopId || syncingAll || syncRunDisabled || syncStartPending}
              title={!shopId ? "No active Shopify shop context is available" : "Sync all Shopify products to EasyCashier"}
            >
              {syncButtonLabel}
            </button>
            {syncAllStatusMessage ? (
              <div
                className={`sync-all-status ${
                  syncAllNotice?.type === "error" ? "sync-all-status-error" : "sync-all-status-success"
                }`}
                aria-live={syncAllNotice?.type === "error" ? "assertive" : "polite"}
              >
                {syncAllStatusMessage}
              </div>
            ) : null}
          </div>
        </div>
      </s-section>
      <s-section heading="Product sync logs">
        <div className="sync-log-toolbar">
          <span>Page {pageNumber}</span>
          <div className="sync-log-pagination">
            <button type="button" onClick={goToPreviousPage} disabled={cursorStack.length === 0 || fetching}>
              Previous
            </button>
            <button type="button" onClick={goToNextPage} disabled={!pageInfo?.hasNextPage || fetching}>
              Next
            </button>
          </div>
        </div>
        <div className="sync-log-table-wrap">
          <table className="sync-log-table">
            <thead>
              <tr>
                <th>Event</th>
                <th>Product ID</th>
                <th>Article no.</th>
                <th>Status</th>
                <th>Time</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {fetching && (
                <tr>
                  <td colSpan={6}>Loading...</td>
                </tr>
              )}
              {error && (
                <tr>
                  <td colSpan={6}>Unable to load sync logs</td>
                </tr>
              )}
              {!fetching && !error && logs?.length === 0 && (
                <tr>
                  <td colSpan={6}>No product syncs yet</td>
                </tr>
              )}
              {!fetching &&
                !error &&
                logs?.map((log) => {
                  const expanded = expandedLogId === log.id;

                  return (
                    <Fragment key={log.id}>
                      <tr className={expanded ? "sync-log-row-expanded" : ""}>
                        <td>{log.event}</td>
                        <td>{log.shopifyProductId}</td>
                        <td>{articleNumberForLog(log)}</td>
                        <td>
                          <span className={statusClassName(log.status)}>{log.status}</span>
                        </td>
                        <td>{formatTime(log.createdAt)}</td>
                        <td>
                          <button
                            type="button"
                            className="sync-log-toggle"
                            onClick={() => setExpandedLogId(expanded ? null : log.id)}
                          >
                            {expanded ? "Hide" : "View"}
                          </button>
                        </td>
                      </tr>
                      {expanded && (
                        <tr className="sync-log-detail-row">
                          <td className="sync-log-detail-cell" colSpan={6}>
                            <SyncLogDetails log={log} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
            </tbody>
          </table>
        </div>
      </s-section>
    </s-page>
  );
}
