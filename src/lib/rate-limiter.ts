type BucketState = {
  tokens: number;
  lastRefill: number;
};

const buckets = new Map<string, BucketState>();

/**
 * In-memory token bucket rate limiter.
 * @param key Unique identifier (IP, access key, or user ID)
 * @param maxTokens Maximum capacity (burst)
 * @param refillRatePerSec Tokens added per second
 * @returns { allowed: boolean, retryAfter: number }
 */
export function checkRateLimit(
  key: string,
  maxTokens = 60,
  refillRatePerSec = 10,
): { allowed: boolean; retryAfter: number } {
  const now = Date.now();
  let state = buckets.get(key);

  if (!state) {
    // Bound cardinality under distributed abuse; new clients share overflow capacity.
    if (buckets.size >= 10000 && key !== "overflow")
      return checkRateLimit("overflow", maxTokens, refillRatePerSec);
    state = { tokens: maxTokens - 1, lastRefill: now };
    buckets.set(key, state);
    return { allowed: true, retryAfter: 0 };
  }

  // Refill tokens based on elapsed time
  const elapsedSec = (now - state.lastRefill) / 1000;
  state.tokens = Math.min(maxTokens, state.tokens + elapsedSec * refillRatePerSec);
  state.lastRefill = now;

  if (state.tokens >= 1) {
    state.tokens -= 1;
    return { allowed: true, retryAfter: 0 };
  }

  const missing = 1 - state.tokens;
  const retryAfter = Math.ceil(missing / refillRatePerSec);
  return { allowed: false, retryAfter };
}

/** Clear old entries periodically to avoid memory growth */
if (typeof setInterval !== "undefined") {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of buckets.entries()) {
      if (now - v.lastRefill > 60_000) buckets.delete(k);
    }
  }, 60_000);
  if (timer.unref) timer.unref();
}
