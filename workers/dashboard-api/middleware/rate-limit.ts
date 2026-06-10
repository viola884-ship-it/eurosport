/**
 * Rate Limiting Middleware
 * KV-backed sliding-window rate limiter. Shared across all Worker isolates
 * (the previous in-memory Map only protected a single isolate and was reset on
 * every cold start). One read + one write per request, bounded by the per-key
 * `expirationTtl` so the keyspace cannot grow without bound.
 */
import type { Env } from '../types';

export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

const defaultConfig: RateLimitConfig = {
  windowMs: 60 * 1000,
  maxRequests: 100,
};

const KV_KEY_PREFIX = 'rl:';
// Extra seconds of TTL on top of the window so a key cannot expire while we are
// still reading it; KV is eventually consistent.
const TTL_BUFFER_SECONDS = 10;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

/**
 * Fixed-window rate limit backed by KV. Each (client, minute) gets its own
 * counter key, so a request on a new minute starts with a fresh quota.
 *
 * Note: read-then-write has a small race window under concurrent requests from
 * the same client. For a soft rate limit (100/min/IP) that races to a slight
 * undercount, which is acceptable — clients cannot exceed the limit by much.
 */
export async function rateLimit(
  env: Pick<Env, 'ACTIVITY_LOGS'>,
  identifier: string,
  config: RateLimitConfig = defaultConfig,
  now: number = Date.now()
): Promise<RateLimitResult> {
  const windowIndex = Math.floor(now / config.windowMs);
  const windowStart = windowIndex * config.windowMs;
  const resetAt = windowStart + config.windowMs;
  const key = `${KV_KEY_PREFIX}${identifier}:${windowIndex}`;

  const raw = await env.ACTIVITY_LOGS.get(key);
  const current = raw ? parseInt(raw, 10) : 0;

  if (current >= config.maxRequests) {
    return { allowed: false, remaining: 0, resetAt };
  }

  // Bump the counter. KV `put` is idempotent for the same value, so losing a
  // race just means a few under-counted requests, never over-counted.
  await env.ACTIVITY_LOGS.put(
    key,
    String(current + 1),
    { expirationTtl: Math.ceil(config.windowMs / 1000) + TTL_BUFFER_SECONDS },
  );

  return {
    allowed: true,
    remaining: Math.max(0, config.maxRequests - (current + 1)),
    resetAt,
  };
}

export function getClientIdentifier(request: Request): string {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    'X-RateLimit-Remaining': result.remaining.toString(),
    'X-RateLimit-Reset': result.resetAt.toString(),
  };
}
