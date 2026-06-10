import { describe, it, expect, beforeEach } from 'vitest';
import { rateLimit, getClientIdentifier, rateLimitHeaders } from '../../workers/dashboard-api/middleware/rate-limit';
import type { Env } from '../../workers/dashboard-api/types';

/**
 * In-memory KV stand-in. Cloudflare KV's API surface we depend on:
 * - `get(key)` returns string | null
 * - `put(key, value, { expirationTtl })` returns Promise<void>
 * - `delete(key)` returns Promise<void>
 * We model TTL by stamping an absolute `expiresAt` and treating expired keys
 * as missing on read. We use real `Date.now()` for TTL bookkeeping (the rate
 * limiter also stamps the counter's `expirationTtl` in seconds, which is
 * relative-to-now), but we use a caller-supplied `now` for the window math.
 */
function makeMockKV() {
  const store = new Map<string, { value: string; expiresAt: number | null }>();
  return {
    async get(key: string): Promise<string | null> {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
      const expiresAt = opts?.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : null;
      store.set(key, { value, expiresAt });
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
    // Test helpers
    _peek(key: string) { return store.get(key); },
    _size() { return store.size; },
  };
}

function makeEnv(kv: ReturnType<typeof makeMockKV>): Env {
  // We only exercise the rate-limit path, so the other bindings can be no-op stubs.
  return {
    ACTIVITY_LOGS: kv as unknown as KVNamespace,
    DB: {} as D1Database,
    ASSETS: { fetch: async () => new Response(null, { status: 404 }) },
  };
}

// Pick a `now` that is exactly on a window boundary so window-aligned math
// (windowStart, resetAt) is easy to assert against. WINDOW_MS * 16 = 960_000.
const WINDOW_MS = 60_000;
const MAX = 100;
const WINDOW_ALIGNED_NOW = WINDOW_MS * 16;

describe('rateLimit (KV-backed)', () => {
  let kv: ReturnType<typeof makeMockKV>;
  let env: Env;

  beforeEach(() => {
    kv = makeMockKV();
    env = makeEnv(kv);
  });

  it('allows the first request and decrements the remaining quota', async () => {
    const r = await rateLimit(env, 'ip-1', { windowMs: WINDOW_MS, maxRequests: MAX }, WINDOW_ALIGNED_NOW);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(MAX - 1);
    expect(r.resetAt).toBe(WINDOW_ALIGNED_NOW + WINDOW_MS);
  });

  it('increments the counter in KV on each allowed request', async () => {
    await rateLimit(env, 'ip-2', { windowMs: WINDOW_MS, maxRequests: MAX }, WINDOW_ALIGNED_NOW);
    await rateLimit(env, 'ip-2', { windowMs: WINDOW_MS, maxRequests: MAX }, WINDOW_ALIGNED_NOW);
    const counter = await kv.get(`rl:ip-2:16`); // WINDOW_ALIGNED_NOW / WINDOW_MS = 16
    expect(counter).toBe('2');
  });

  it('refuses requests once the per-window quota is exhausted', async () => {
    // Pre-fill KV with the max so the next request tips us over.
    const windowIndex = WINDOW_ALIGNED_NOW / WINDOW_MS;
    await kv.put(`rl:ip-3:${windowIndex}`, String(MAX), { expirationTtl: 70 });

    const r = await rateLimit(env, 'ip-3', { windowMs: WINDOW_MS, maxRequests: MAX }, WINDOW_ALIGNED_NOW);
    expect(r.allowed).toBe(false);
    expect(r.remaining).toBe(0);
    expect(r.resetAt).toBe(WINDOW_ALIGNED_NOW + WINDOW_MS);
  });

  it('starts a fresh quota in a new window', async () => {
    // Pre-fill the first window to the cap.
    const firstWindow = WINDOW_ALIGNED_NOW / WINDOW_MS;
    await kv.put(`rl:ip-4:${firstWindow}`, String(MAX), { expirationTtl: 70 });

    // Cross into the next minute.
    const nextWindowTs = (firstWindow + 1) * WINDOW_MS;
    const r = await rateLimit(env, 'ip-4', { windowMs: WINDOW_MS, maxRequests: MAX }, nextWindowTs);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(MAX - 1);
  });

  it('writes the new key with an expirationTtl slightly larger than the window', async () => {
    const before = Date.now();
    await rateLimit(env, 'ip-5', { windowMs: WINDOW_MS, maxRequests: MAX }, WINDOW_ALIGNED_NOW);
    const entry = kv._peek('rl:ip-5:16');
    expect(entry).toBeDefined();
    // The fix uses Math.ceil(windowMs/1000) + 10 seconds of buffer.
    // Mock KV stamps expiresAt = Date.now() + expirationTtl*1000, so we compare
    // against real wall-clock and allow a 1s slop on each side.
    expect(entry?.expiresAt).not.toBeNull();
    const ttlFromNow = (entry?.expiresAt ?? 0) - before;
    expect(ttlFromNow).toBeGreaterThanOrEqual(WINDOW_MS);
    expect(ttlFromNow).toBeLessThanOrEqual(WINDOW_MS + 11_000);
  });

  it('keeps counters isolated per client identifier', async () => {
    await rateLimit(env, 'ip-A', { windowMs: WINDOW_MS, maxRequests: MAX }, WINDOW_ALIGNED_NOW);
    await rateLimit(env, 'ip-B', { windowMs: WINDOW_MS, maxRequests: MAX }, WINDOW_ALIGNED_NOW);
    await rateLimit(env, 'ip-B', { windowMs: WINDOW_MS, maxRequests: MAX }, WINDOW_ALIGNED_NOW);
    const a = await kv.get(`rl:ip-A:${WINDOW_ALIGNED_NOW / WINDOW_MS}`);
    const b = await kv.get(`rl:ip-B:${WINDOW_ALIGNED_NOW / WINDOW_MS}`);
    expect(a).toBe('1');
    expect(b).toBe('2');
  });
});

describe('getClientIdentifier', () => {
  it('returns the Cloudflare-provided client IP', () => {
    const req = new Request('https://example.com/', {
      headers: { 'CF-Connecting-IP': '203.0.113.42' },
    });
    expect(getClientIdentifier(req)).toBe('203.0.113.42');
  });

  it('falls back to "unknown" when the header is absent', () => {
    const req = new Request('https://example.com/');
    expect(getClientIdentifier(req)).toBe('unknown');
  });
});

describe('rateLimitHeaders', () => {
  it('serialises remaining and reset as headers', () => {
    const headers = rateLimitHeaders({ allowed: true, remaining: 42, resetAt: 1_700_000_000_000 });
    expect(headers).toEqual({
      'X-RateLimit-Remaining': '42',
      'X-RateLimit-Reset': '1700000000000',
    });
  });
});
