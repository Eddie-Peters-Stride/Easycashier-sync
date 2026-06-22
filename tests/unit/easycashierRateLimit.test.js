import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { configuredEasyCashierRequestsPerMinute } from "../../api/lib/easycashierApi.js";
import { setTestEnv } from "../support/easycashierTestHelpers.js";

describe("EasyCashier request rate limit", () => {
  test("caps the configured request rate at 300 per minute", () => {
    const restoreEnv = setTestEnv({
      EASYCASHIER_RATE_LIMIT_REQUESTS_PER_MINUTE: "600",
    });

    try {
      assert.equal(configuredEasyCashierRequestsPerMinute(), 300);
    } finally {
      restoreEnv();
    }
  });

  test("falls back to 300 when the configured request rate is invalid", () => {
    const restoreEnv = setTestEnv({
      EASYCASHIER_RATE_LIMIT_REQUESTS_PER_MINUTE: "not-a-number",
    });

    try {
      assert.equal(configuredEasyCashierRequestsPerMinute(), 300);
    } finally {
      restoreEnv();
    }
  });
});
