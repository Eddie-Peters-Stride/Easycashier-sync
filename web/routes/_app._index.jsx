import { Fragment, useState } from "react";
import { useFindMany } from "@gadgetinc/react";
import { api } from "../api";

const PAGE_SIZE = 10;

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

const statusClassName = (status) => `sync-log-status sync-log-status-${String(status ?? "unknown").toLowerCase()}`;

const articleNumberForLog = (log) =>
  log.easycashierArticleNumber ?? log.details?.requests?.[0]?.easycashierArticleNumber ?? "";

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

export default function Index() {
  const [cursorStack, setCursorStack] = useState([]);
  const [expandedLogId, setExpandedLogId] = useState(null);
  const currentCursor = cursorStack[cursorStack.length - 1];
  const queryOptions = {
    first: PAGE_SIZE,
    live: currentCursor == null,
    sort: { createdAt: "Descending" },
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
    queryOptions.after = currentCursor;
  }

  const [{ data: logs, fetching, error }] = useFindMany(api.easycashierProductSyncLog, {
    ...queryOptions,
  });
  const pageInfo = logs?.pagination?.pageInfo;
  const pageNumber = cursorStack.length + 1;

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

  return (
    <s-page heading="EasyCashier">
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
