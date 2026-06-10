/**
 * Dashboard API Entry Point
 * Router, CORS, error handling
 */

import type { Env, OrderSummary, OrderDetail } from './types';
import { authMiddleware, createSessionCookie, clearSessionCookie, validateCredentials, checkLoginLockout, recordFailedLogin, clearLoginLockout, getLoginIdentifier } from './middleware/auth';
import { loggingMiddleware } from './middleware/logging';
import { rateLimit, getClientIdentifier, rateLimitHeaders } from './middleware/rate-limit';

const HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Session-Token',
  'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Expose-Headers': 'X-Session-Token',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');

    const CORS_HEADERS = {
      ...HEADERS,
      'Access-Control-Allow-Origin': origin || '*',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const rateResult = await rateLimit(env, getClientIdentifier(request));
    if (!rateResult.allowed) {
      return jsonResponse({ error: 'Rate limit exceeded' }, 429, HEADERS);
    }

    if (url.pathname === '/dashboard-api/login' && request.method === 'POST') {
      const clientIp = getLoginIdentifier(request);
      const lockoutStatus = await checkLoginLockout(env, clientIp);

      if (lockoutStatus.locked) {
        const retryAfter = Math.ceil((lockoutStatus.lockedUntil! - Date.now()) / 1000);
        return jsonResponse({ error: 'Account locked due to too many failed attempts', retryAfter }, 429, CORS_HEADERS);
      }

      const body = await request.json().catch(() => ({}));
      const { password } = body as { password?: string };

      if (!password || !(await validateCredentials(env, password))) {
        const failStatus = await recordFailedLogin(env, clientIp);
        if (failStatus.locked) {
          return jsonResponse({ error: 'Invalid credentials. Account locked due to too many failed attempts', retryAfter: 900 }, 429, CORS_HEADERS);
        }
        return jsonResponse({ error: 'Invalid credentials', remainingAttempts: failStatus.remainingAttempts }, 401, CORS_HEADERS);
      }

      await clearLoginLockout(env, clientIp);

      const sessionData = { authenticated: true, timestamp: Date.now() };
      const sessionCookie = createSessionCookie(sessionData);
      const token = btoa(JSON.stringify(sessionData));
      const responseHeaders = new Headers(CORS_HEADERS);
      responseHeaders.set('Set-Cookie', sessionCookie);
      responseHeaders.set('X-Session-Token', token);
      return new Response(JSON.stringify({ success: true, token }), { status: 200, headers: responseHeaders });
    }

    if (url.pathname === '/dashboard-api/logout' && request.method === 'POST') {
      const clearCookie = clearSessionCookie();
      return jsonResponse({ success: true }, 200, { ...HEADERS, 'Set-Cookie': clearCookie });
    }

    if (url.pathname === '/favicon.ico') {
      try {
        const svgRequest = new Request(url.origin + '/favicon.svg');
        const asset = await env.ASSETS.fetch(svgRequest);
        if (asset.status < 400) return asset;
      } catch (e) {}
      return new Response(null, { status: 204 });
    }

    if (url.pathname.startsWith('/dashboard/')) {
      try {
        const asset = await env.ASSETS.fetch(request);
        if (asset.status < 400) {
          return asset;
        }
      } catch (e) {
        console.error('Asset fetch error:', e);
      }
      return jsonResponse({ error: 'Not found' }, 404, HEADERS);
    }

    const { authorized, response: authResponse } = await authMiddleware(request, env);
    if (!authorized) {
      return authResponse || jsonResponse({ error: 'Unauthorized' }, 401, HEADERS);
    }

    try {
      const path = url.pathname.replace('/dashboard-api', '') || '/';

      if (path === '/orders' && request.method === 'GET') {
        return handleOrdersList(request, env, url, HEADERS);
      }

      if (path.match(/^\/orders\/[^/]+$/) && request.method === 'GET') {
        const displayId = path.split('/')[2] ?? '';
        return handleOrderDetail(request, displayId, env, HEADERS);
      }

      if (path.match(/^\/orders\/[^/]+\/status$/) && request.method === 'PATCH') {
        const displayId = path.split('/')[2] ?? '';
        return handleOrderStatus(displayId, request, env, HEADERS);
      }

      if (path.match(/^\/orders\/[^/]+\/message$/) && request.method === 'POST') {
        const displayId = path.split('/')[2] ?? '';
        return handleOrderMessage(displayId, request, env, HEADERS);
      }

      if (url.pathname.match(/^\/customers\/[^/]+$/) && request.method === 'GET') {
        const customerId = parseInt(path.split('/')[2] ?? '', 10);
        if (isNaN(customerId)) return jsonResponse({ error: 'Invalid customer id' }, 400, HEADERS);
        return handleCustomerDetail(request, customerId, env, HEADERS);
      }

      if (path === '/activity-logs' && request.method === 'GET') {
        return handleActivityLogs(request, env, url, HEADERS);
      }

      return jsonResponse({ error: 'Not found' }, 404, HEADERS);
    } catch (error) {
      console.error('API Error:', error);
      return jsonResponse({ error: 'Internal server error' }, 500, HEADERS);
    }
  },
};

async function handleOrdersList(request: Request, env: Env, url: URL, headers: Record<string, string>): Promise<Response> {
  try {
    await loggingMiddleware(request, env, { action: 'view_order', targetType: 'api', targetId: 'list' });
  } catch (e) {
    console.error('Logging error:', e);
  }

  try {
    const status = url.searchParams.get('status') || undefined;
    const limit = parseInt(url.searchParams.get('limit') || '50', 10);
    const offset = parseInt(url.searchParams.get('offset') || '0', 10);

    const orders = await getOrders(env.DB, { status, limit, offset });
    const total = await getOrdersCount(env.DB, { status });

    return jsonResponse({ orders, total, limit, offset }, 200, { ...headers, ...rateLimitHeaders({ allowed: true, remaining: 99, resetAt: 0 }) });
  } catch (err) {
    console.error('getOrders error:', err);
    return jsonResponse({ error: String(err) }, 500, headers);
  }
}

async function handleOrderDetail(request: Request, displayId: string, env: Env, headers: Record<string, string>): Promise<Response> {
  try {
    await loggingMiddleware(request, env, { action: 'view_order', targetType: 'order', targetId: displayId });
  } catch (e) {
    console.error('Logging error:', e);
  }

  const order = await getOrderByDisplayId(env.DB, displayId);
  if (!order) {
    return jsonResponse({ error: 'Order not found' }, 404, headers);
  }

  return jsonResponse({ order }, 200, headers);
}

async function handleOrderStatus(displayId: string, request: Request, env: Env, headers: Record<string, string>): Promise<Response> {
  const body = await request.json().catch(() => ({}));
  const { status } = body as { status?: string };

  if (!status) {
    return jsonResponse({ error: 'Status is required' }, 400, headers);
  }

  const validStatuses = ['new', 'confirmed', 'processing', 'shipped', 'completed', 'cancelled'];
  if (!validStatuses.includes(status)) {
    return jsonResponse({ error: 'Invalid status' }, 400, headers);
  }

  try {
    await loggingMiddleware(request, env, { action: 'update_status', targetType: 'order', targetId: displayId, details: { status } });
  } catch (e) {
    console.error('Logging error:', e);
  }

  const result = await updateOrderStatus(env.DB, displayId, status);
  if (!result.order) {
    return jsonResponse({ error: 'Order not found' }, 404, headers);
  }

  // Notify the customer via Telegram (best-effort; failure does not fail the PATCH)
  let notificationSent = false;
  if (result.telegramId) {
    try {
      notificationSent = await sendTelegramStatusNotification(env, result.telegramId, displayId, status);
    } catch (e) {
      console.error('Telegram notification error:', e);
    }
  } else {
    console.warn(`Cannot notify customer for order ${displayId}: no telegram_id on file`);
  }

  return jsonResponse({ success: true, order: result.order, notification_sent: notificationSent }, 200, headers);
}

async function handleOrderMessage(displayId: string, request: Request, env: Env, headers: Record<string, string>): Promise<Response> {
  const body = await request.json().catch(() => ({}));
  const { message } = body as { message?: string };

  if (!message) {
    return jsonResponse({ error: 'Message is required' }, 400, headers);
  }

  try {
    await loggingMiddleware(request, env, { action: 'send_message', targetType: 'order', targetId: displayId, details: { messageLength: message.length } });
  } catch (e) {
    console.error('Logging error:', e);
  }

  const order = await getOrderByDisplayId(env.DB, displayId);
  if (!order) {
    return jsonResponse({ error: 'Order not found' }, 404, headers);
  }

  const telegramId = order.customer?.telegram_id;
  if (!telegramId) {
    return jsonResponse({ error: 'Customer has no Telegram ID' }, 400, headers);
  }

  if (!env.TELEGRAM_BOT_TOKEN) {
    return jsonResponse({ error: 'TELEGRAM_BOT_TOKEN secret is not set' }, 500, headers);
  }

  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: telegramId, text: message }),
    });
    const data = await r.json() as { ok: boolean; result?: { message_id: number } };
    if (!data.ok || !data.result) {
      console.error('Telegram sendMessage failed:', data);
      return jsonResponse({ error: 'Telegram API rejected the message' }, 502, headers);
    }
    return jsonResponse({ success: true, message_id: data.result.message_id }, 200, headers);
  } catch (e) {
    console.error('handleOrderMessage fetch error:', e);
    return jsonResponse({ error: 'Failed to reach Telegram API' }, 502, headers);
  }
}

async function handleCustomerDetail(request: Request, customerId: number, env: Env, headers: Record<string, string>): Promise<Response> {
  try {
    await loggingMiddleware(request, env, { action: 'api_call', targetType: 'customer', targetId: customerId.toString() });
  } catch (e) {
    console.error('Logging error:', e);
  }

  const customer = await getCustomerById(env.DB, customerId);
  if (!customer) {
    return jsonResponse({ error: 'Customer not found' }, 404, headers);
  }

  const orders = await getOrdersByCustomer(env.DB, customerId);
  return jsonResponse({ customer, orders }, 200, headers);
}

async function handleActivityLogs(_request: Request, env: Env, url: URL, headers: Record<string, string>): Promise<Response> {
  const action = url.searchParams.get('action') || undefined;
  const actor = url.searchParams.get('actor') || undefined;
  const from = url.searchParams.get('from') || undefined;
  const to = url.searchParams.get('to') || undefined;
  const limit = parseInt(url.searchParams.get('limit') || '50', 10);
  const offset = parseInt(url.searchParams.get('offset') || '0', 10);

  const logs = await getActivityLogs(env, { action, actor, from, to, limit, offset });
  return jsonResponse(logs, 200, headers);
}

function jsonResponse(data: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(data), { status, headers });
}

async function getOrders(db: D1Database, options: { status?: string; limit: number; offset: number }): Promise<OrderSummary[]> {
  let query = `SELECT o.display_id, c.first_name as customer_name, c.username as customer_username, o.status,
    (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) as item_count, o.created_at
FROM orders o JOIN customers c ON o.customer_id = c.id`;
  const bindings: (string | number)[] = [];

  if (options.status) {
    query += ' WHERE o.status = ?';
    bindings.push(options.status);
  }

  query += ' ORDER BY o.created_at DESC LIMIT ? OFFSET ?';
  bindings.push(options.limit, options.offset);

  const result = await db.prepare(query).bind(...bindings).all();
  return result.results as unknown as OrderSummary[];
}

async function getOrdersCount(db: D1Database, options: { status?: string }): Promise<number> {
  let query = 'SELECT COUNT(*) as count FROM orders';
  const bindings: string[] = [];

  if (options.status) {
    query += ' WHERE status = ?';
    bindings.push(options.status);
  }

  const result = await db.prepare(query).bind(...bindings).first<{ count: number }>();
  return result?.count ?? 0;
}

async function getOrderByDisplayId(db: D1Database, displayId: string): Promise<OrderDetail | null> {
  const orderResult = await db.prepare(
    `SELECT o.*, c.first_name as customer_name, c.username as customer_username, c.telegram_id, c.id as cust_id
     FROM orders o JOIN customers c ON o.customer_id = c.id WHERE o.display_id = ?`
  ).bind(displayId).first();

  if (!orderResult) return null;

  const itemsResult = await db.prepare('SELECT link, sort_order FROM order_items WHERE order_id = ? ORDER BY sort_order').bind((orderResult as Record<string, unknown>).id as number).all();

  const transitionsResult = await db.prepare('SELECT from_status, to_status, changed_by, created_at FROM status_transitions WHERE order_id = ? ORDER BY created_at').bind((orderResult as Record<string, unknown>).id as number).all();

  return {
    display_id: displayId,
    customer: {
      id: (orderResult as Record<string, unknown>).cust_id as number,
      name: (orderResult as Record<string, unknown>).customer_name as string,
      username: (orderResult as Record<string, unknown>).customer_username as string | null,
      telegram_id: (orderResult as Record<string, unknown>).telegram_id as number,
    },
    items: itemsResult.results as Array<{ link: string; sort_order: number }>,
    specs: (orderResult as Record<string, unknown>).specs as string | null,
    status: (orderResult as Record<string, unknown>).status as OrderDetail['status'],
    created_at: (orderResult as Record<string, unknown>).created_at as string,
    updated_at: (orderResult as Record<string, unknown>).updated_at as string,
    transitions: transitionsResult.results as OrderDetail['transitions'],
  };
}

interface StatusUpdateResult {
  order: OrderDetail | null;
  telegramId: number | null;
  previousStatus: string | null;
}

async function updateOrderStatus(db: D1Database, displayId: string, status: string): Promise<StatusUpdateResult> {
  // 1. Read previous status + customer telegram_id before the UPDATE (needed for transition row + notification)
  const prev = await db.prepare(
    `SELECT o.id, o.status as previous_status, c.telegram_id
     FROM orders o JOIN customers c ON o.customer_id = c.id
     WHERE o.display_id = ?`,
  ).bind(displayId).first<{ id: number; previous_status: string; telegram_id: number }>();

  if (!prev) return { order: null, telegramId: null, previousStatus: null };

  // 2. Apply the status change
  const now = new Date().toISOString();
  const updateResult = await db.prepare(
    'UPDATE orders SET status = ?, updated_at = ? WHERE display_id = ?',
  ).bind(status, now, displayId).run();

  if (!updateResult.success) return { order: null, telegramId: null, previousStatus: null };

  // 3. Record the transition so the dashboard's Status History stays in sync (FR-010 / SC-005)
  await db.prepare(
    `INSERT INTO status_transitions (order_id, from_status, to_status, changed_by, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(prev.id, prev.previous_status, status, 'manager', now).run();

  // 4. Return the fresh order so the caller can include it in the response
  const order = await getOrderByDisplayId(db, displayId);
  return { order, telegramId: prev.telegram_id, previousStatus: prev.previous_status };
}

const STATUS_ICON: Record<string, string> = {
  confirmed: '📦',
  processing: '🔄',
  shipped: '🚚',
  completed: '✅',
  cancelled: '❌',
};

/**
 * Sends a status-change notification to the customer's Telegram chat.
 * Returns true if the Telegram API acknowledged with `ok: true`, false otherwise.
 * Returns false (not throws) if TELEGRAM_BOT_TOKEN is unset.
 */
async function sendTelegramStatusNotification(
  env: Env,
  telegramId: number,
  displayId: string,
  status: string,
): Promise<boolean> {
  if (!env.TELEGRAM_BOT_TOKEN) {
    console.error('TELEGRAM_BOT_TOKEN secret is not set; cannot send notification');
    return false;
  }
  const icon = STATUS_ICON[status] ?? '';
  const text = `${icon} Order #${displayId} is now: ${status}`;
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: telegramId, text }),
    });
    const data = await r.json() as { ok: boolean };
    return data.ok === true;
  } catch (e) {
    console.error('sendTelegramStatusNotification fetch error:', e);
    return false;
  }
}

async function getCustomerById(db: D1Database, customerId: number): Promise<Record<string, unknown> | null> {
  return db.prepare('SELECT * FROM customers WHERE id = ?').bind(customerId).first();
}

async function getOrdersByCustomer(db: D1Database, customerId: number): Promise<OrderSummary[]> {
  const result = await db.prepare('SELECT display_id, first_name as customer_name, username as customer_username, status, (SELECT COUNT(*) FROM order_items WHERE order_id = orders.id) as item_count, created_at FROM orders WHERE customer_id = ? ORDER BY created_at DESC').bind(customerId).all();
  return result.results as unknown as OrderSummary[];
}

async function getActivityLogs(env: Env, options: { action?: string; actor?: string; from?: string; to?: string; limit: number; offset: number }): Promise<{ logs: unknown[]; total: number }> {
  const { readActivityLogs } = await import('./lib/kv-schema');
  return readActivityLogs(env, options);
}