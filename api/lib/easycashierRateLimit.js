export const EASYCASHIER_RATE_LIMIT = 250;
export const EASYCASHIER_RATE_LIMIT_WINDOW_MS = 60_000;

const RATE_LIMIT_STATE_KEY = "easycashier-api";
const WAIT_BUFFER_MS = 100;

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const normalizeRequestTimestamps = (requestTimestamps, now, windowMs) => {
  if (!Array.isArray(requestTimestamps)) {
    return [];
  }

  const cutoff = now - windowMs;

  return requestTimestamps
    .map(Number)
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp > cutoff && timestamp <= now)
    .sort((left, right) => left - right);
};

/**
 * Make one deterministic sliding-window decision. This pure function is shared
 * by the Gadget model action and unit tests.
 */
export const takeSlidingWindowSlot = ({
  requestTimestamps,
  now = Date.now(),
  limit = EASYCASHIER_RATE_LIMIT,
  windowMs = EASYCASHIER_RATE_LIMIT_WINDOW_MS,
}) => {
  const activeTimestamps = normalizeRequestTimestamps(requestTimestamps, now, windowMs);

  if (activeTimestamps.length < limit) {
    return {
      granted: true,
      retryAfterMs: 0,
      requestTimestamps: [...activeTimestamps, now],
    };
  }

  return {
    granted: false,
    retryAfterMs: Math.max(1, activeTimestamps[0] + windowMs - now),
    requestTimestamps: activeTimestamps,
  };
};

const findRateLimitState = async (api) =>
  await api.easyCashierRateLimitState.maybeFindFirst({
    filter: { key: { equals: RATE_LIMIT_STATE_KEY } },
    select: { id: true },
  });

const getOrCreateRateLimitState = async (api) => {
  const existingState = await findRateLimitState(api);

  if (existingState) {
    return existingState;
  }

  try {
    return await api.easyCashierRateLimitState.create({
      key: RATE_LIMIT_STATE_KEY,
      requestTimestamps: [],
    });
  } catch (error) {
    // Another worker may have initialized the unique singleton concurrently.
    const concurrentlyCreatedState = await findRateLimitState(api);

    if (concurrentlyCreatedState) {
      return concurrentlyCreatedState;
    }

    throw error;
  }
};

/**
 * Build a durable EasyCashier request limiter for one Gadget action.
 *
 * The shared background queue serializes callers, while the model action
 * persists each decision transactionally. The caller waits outside that
 * transaction and tries again when the oldest request leaves the window.
 */
export const createEasyCashierRateLimiter = ({ api, logger, sleep = delay }) => {
  if (!api) {
    throw new Error("A Gadget API client is required for EasyCashier rate limiting");
  }

  let statePromise;

  return async ({ method, url } = {}) => {
    statePromise ??= getOrCreateRateLimitState(api).catch((error) => {
      statePromise = undefined;
      throw error;
    });
    const state = await statePromise;

    while (true) {
      const decision = await api.easyCashierRateLimitState.acquireRequestSlot(state.id, {});

      if (decision.granted) {
        return;
      }

      const waitMs = Math.max(1, Number(decision.retryAfterMs) || 1) + WAIT_BUFFER_MS;

      logger?.info(
        {
          method,
          url,
          waitMs,
          requestsInWindow: decision.requestsInWindow,
        },
        "EasyCashier request budget exhausted; waiting for a sliding-window slot"
      );

      await sleep(waitMs);
    }
  };
};

/** Parse EasyCashier's Retry-After response header into milliseconds. */
export const parseRetryAfterMs = (value, now = Date.now()) => {
  if (value == null || value === "") {
    return null;
  }

  const seconds = Number(value);

  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000);
  }

  const retryAt = Date.parse(String(value));
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - now) : null;
};
