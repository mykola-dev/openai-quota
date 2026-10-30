import assert from "node:assert/strict"
import { test } from "node:test"
import { formatQuota, formatResetCountdown, parseRetryAfter, parseUsageResponse } from "../src/usage.js"

test("quota parsing clamps percentages and handles missing windows", () => {
  const value = parseUsageResponse({ rate_limit: { primary_window: { used_percent: 120 } } }, 0)
  assert.equal(value.primaryRemaining, 0)
  assert.equal(value.secondaryRemaining, null)
  assert.throws(() => parseUsageResponse({}))
  assert.throws(() => parseUsageResponse({ rate_limit: { primary_window: { used_percent: Infinity } } }))
})

test("reset parsing prefers absolute Unix seconds and falls back to relative seconds", () => {
  const value = parseUsageResponse({ rate_limit: {
    primary_window: { used_percent: 25, reset_at: 100, reset_after_seconds: 20 },
    secondary_window: { used_percent: 10, reset_at: -1, reset_after_seconds: 60 },
  } }, 10_000)
  assert.equal(value.primaryResetAt, 100_000)
  assert.equal(value.secondaryResetAt, 70_000)
})

test("countdowns round up minutes, floor days, and never become negative", () => {
  assert.equal(formatResetCountdown(1, 0), "00:01")
  assert.equal(formatResetCountdown(60_001, 0), "00:02")
  assert.equal(formatResetCountdown(4 * 86_400_000, 0), "4d")
  assert.equal(formatResetCountdown(0, 1), "00:00")
  assert.equal(formatResetCountdown(null, 0), "—")
  assert.equal(formatQuota({ primaryRemaining: 75, secondaryRemaining: null, fetchedAt: 0 }, 0), "OpenAI: 75%/—")
})

test("Retry-After accepts seconds and HTTP dates and rejects invalid input", () => {
  assert.equal(parseRetryAfter("120", 1_000), 121_000)
  assert.equal(parseRetryAfter("Thu, 01 Jan 1970 00:02:00 GMT", 1_000), 120_000)
  assert.equal(parseRetryAfter("invalid", 0), null)
  assert.equal(parseRetryAfter(null, 0), null)
})
