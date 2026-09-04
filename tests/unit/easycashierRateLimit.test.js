import assert from "node:assert/strict";
import test from "node:test";

import {
  createEasyCashierRateLimiter,
  parseRetryAfterMs,
  takeSlidingWindowSlot,
} from "../../api/lib/easycashierRateLimit.js";

test("grants the first 250 requests immediately", () => {
  const now = 100_000;
  let requestTimestamps = [];

  for (let index = 0; index < 250; index += 1) {
    const decision = takeSlidingWindowSlot({ requestTimestamps, now });
    assert.equal(decision.granted, true);
    assert.equal(decision.retryAfterMs, 0);
    requestTimestamps = decision.requestTimestamps;
  }

  assert.equal(requestTimestamps.length, 250);
});

test("blocks request 251 until the oldest request leaves the window", () => {
  const now = 100_000;
  const requestTimestamps = Array.from({ length: 250 }, () => now - 10_000);

  const decision = takeSlidingWindowSlot({ requestTimestamps, now });

  assert.equal(decision.granted, false);
  assert.equal(decision.retryAfterMs, 50_000);
  assert.equal(decision.requestTimestamps.length, 250);
});

test("prunes expired and invalid timestamps before granting a slot", () => {
  const decision = takeSlidingWindowSlot({
    requestTimestamps: [39_999, 40_000, 50_000, "invalid", null, 100_001],
    now: 100_000,
  });

  assert.equal(decision.granted, true);
  assert.deepEqual(decision.requestTimestamps, [50_000, 100_000]);
});

test("uses a true rolling window instead of a fixed minute bucket", () => {
  const requestTimestamps = Array.from(
    { length: 250 },
    (_, index) => 40_001 + index
  );

  const blocked = takeSlidingWindowSlot({ requestTimestamps, now: 100_000 });
  assert.equal(blocked.granted, false);
  assert.equal(blocked.retryAfterMs, 1);

  const granted = takeSlidingWindowSlot({ requestTimestamps, now: 100_002 });
  assert.equal(granted.granted, true);
  assert.equal(granted.requestTimestamps.length, 249);
});

test("parses Retry-After seconds and HTTP dates", () => {
  assert.equal(parseRetryAfterMs("2.5", 100_000), 2_500);
  assert.equal(
    parseRetryAfterMs("Thu, 01 Jan 1970 00:01:45 GMT", 100_000),
    5_000
  );
  assert.equal(parseRetryAfterMs("not-a-date", 100_000), null);
});

test("waits outside the model action and retries slot acquisition", async () => {
  const sleeps = [];
  const acquisitions = [
    { granted: false, retryAfterMs: 500, requestsInWindow: 250 },
    { granted: true, retryAfterMs: 0, requestsInWindow: 249 },
  ];
  const api = {
    easyCashierRateLimitState: {
      maybeFindFirst: async () => ({ id: "state-1" }),
      acquireRequestSlot: async (id, variables) => {
        assert.equal(id, "state-1");
        assert.deepEqual(variables, {});
        return acquisitions.shift();
      },
    },
  };
  const limiter = createEasyCashierRateLimiter({
    api,
    sleep: async (milliseconds) => sleeps.push(milliseconds),
  });

  await limiter({ method: "GET", url: "/article" });

  assert.deepEqual(sleeps, [600]);
  assert.equal(acquisitions.length, 0);
});
