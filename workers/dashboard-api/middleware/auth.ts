/**
 * Authentication Middleware
 * Handles password validation, session cookie management, and login lockout
 */

import type { Env } from '../types';

const SESSION_COOKIE = 'dashboard_session';

const LOGIN_LOCKOUT_PREFIX = 'lockout:';
const LOCKOUT_MAX_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

interface SessionData {
  authenticated: boolean;
  timestamp: number;
}

interface LockoutEntry {
  attempts: number;
  lockedUntil: number;
}

export async function authMiddleware(
  request: Request,
  _env: Env
): Promise<{ authorized: boolean; response?: Response }> {
  if (request.url.includes('/dashboard-api/login')) {
    return { authorized: true };
  }

  const sessionToken = request.headers.get('X-Session-Token');
  if (sessionToken) {
    try {
      const sessionData = JSON.parse(atob(sessionToken)) as SessionData;
      const now = Date.now();
      const thirtyMinutes = 30 * 60 * 1000;
      if (now - sessionData.timestamp <= thirtyMinutes) {
        return { authorized: true };
      }
    } catch {
      // Fall through to cookie check
    }
  }

  const sessionCookie = request.headers.get('Cookie');
  if (!sessionCookie) {
    return { authorized: false };
  }

  const cookies = parseCookies(sessionCookie);
  const sessionValue = cookies[SESSION_COOKIE];

  if (!sessionValue) {
    return { authorized: false };
  }

  try {
    const sessionData = JSON.parse(base64Decode(sessionValue)) as SessionData;
    const now = Date.now();
    const thirtyMinutes = 30 * 60 * 1000;

    if (now - sessionData.timestamp > thirtyMinutes) {
      return { authorized: false };
    }

    return { authorized: true };
  } catch {
    return { authorized: false };
  }
}

export async function checkLoginLockout(
  env: Env,
  identifier: string
): Promise<{ locked: boolean; remainingAttempts: number; lockedUntil?: number }> {
  const key = `${LOGIN_LOCKOUT_PREFIX}${identifier}`;
  const entryStr = await env.ACTIVITY_LOGS.get(key);

  if (!entryStr) {
    return { locked: false, remainingAttempts: LOCKOUT_MAX_ATTEMPTS };
  }

  try {
    const entry: LockoutEntry = JSON.parse(entryStr);
    const now = Date.now();

    if (now < entry.lockedUntil) {
      return { locked: true, remainingAttempts: 0, lockedUntil: entry.lockedUntil };
    }

    await env.ACTIVITY_LOGS.delete(key);
    return { locked: false, remainingAttempts: LOCKOUT_MAX_ATTEMPTS };
  } catch {
    return { locked: false, remainingAttempts: LOCKOUT_MAX_ATTEMPTS };
  }
}

export async function recordFailedLogin(
  env: Env,
  identifier: string
): Promise<{ locked: boolean; remainingAttempts: number; lockedUntil?: number }> {
  const key = `${LOGIN_LOCKOUT_PREFIX}${identifier}`;
  const now = Date.now();

  let entry: LockoutEntry;
  const existingStr = await env.ACTIVITY_LOGS.get(key);

  if (existingStr) {
    try {
      const existing: LockoutEntry = JSON.parse(existingStr);
      if (now < existing.lockedUntil) {
        return { locked: true, remainingAttempts: 0, lockedUntil: existing.lockedUntil };
      }
      entry = { attempts: existing.attempts + 1, lockedUntil: 0 };
    } catch {
      entry = { attempts: 1, lockedUntil: 0 };
    }
  } else {
    entry = { attempts: 1, lockedUntil: 0 };
  }

  if (entry.attempts >= LOCKOUT_MAX_ATTEMPTS) {
    entry.lockedUntil = now + LOCKOUT_DURATION_MS;
    await env.ACTIVITY_LOGS.put(key, JSON.stringify(entry));
    return { locked: true, remainingAttempts: 0, lockedUntil: entry.lockedUntil };
  }

  await env.ACTIVITY_LOGS.put(key, JSON.stringify(entry));
  return { locked: false, remainingAttempts: LOCKOUT_MAX_ATTEMPTS - entry.attempts };
}

export async function clearLoginLockout(env: Env, identifier: string): Promise<void> {
  const key = `${LOGIN_LOCKOUT_PREFIX}${identifier}`;
  await env.ACTIVITY_LOGS.delete(key);
}

export function createSessionCookie(sessionData: SessionData): string {
  const encoded = base64Encode(JSON.stringify(sessionData));
  return `${SESSION_COOKIE}=${encoded}; HttpOnly; Path=/; Max-Age=${30 * 60}; SameSite=Lax`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0`;
}

function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  cookieHeader.split(';').forEach((cookie) => {
    const [name, ...valueParts] = cookie.trim().split('=');
    if (name) {
      cookies[name] = valueParts.join('=');
    }
  });
  return cookies;
}

function base64Encode(str: string): string {
  return btoa(str);
}

function base64Decode(str: string): string {
  return atob(str);
}

export async function validateCredentials(
  env: Env,
  password: string
): Promise<boolean> {
  // Refuse ALL logins when the secret is missing — never fall back to a default password
  // (the previous `|| 'changeme'` fallback would silently accept the literal string "changeme"
  // for any caller that guessed it, which is a critical exposure if the secret was ever unset).
  if (!env.DASHBOARD_PASSWORD) {
    console.error('DASHBOARD_PASSWORD secret is not set; refusing authentication. Set it with `wrangler secret put DASHBOARD_PASSWORD`.');
    return false;
  }
  return password === env.DASHBOARD_PASSWORD;
}

export function getLoginIdentifier(request: Request): string {
  return request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
}