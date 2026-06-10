import type { Env, OrderStatus } from './types';
import { OrderQueries } from './db/queries';
import { extractLinks, extractSpecs, formatOrderSummary } from './handlers/helpers';

async function tg(method: string, token: string, body: Record<string, unknown>): Promise<boolean> {
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json() as { ok: boolean };
    return data.ok;
  } catch { return false; }
}

async function send(token: string, chatId: number, text: string) {
  return tg('sendMessage', token, { chat_id: chatId, text, parse_mode: 'HTML' });
}

const VALID_STATUSES = ['new', 'confirmed', 'processing', 'shipped', 'completed', 'cancelled'];
// Per specs/001-telegram-order-bot/data-model.md §"Status Lifecycle":
// "Transitions forward through the pipeline; skipping intermediate states is allowed."
// `completed` and `cancelled` are terminal — no outgoing transitions.
const ALLOWED_NEXT: Record<string, string[]> = {
  new: ['confirmed', 'processing', 'shipped', 'completed', 'cancelled'],
  confirmed: ['processing', 'shipped', 'completed', 'cancelled'],
  processing: ['shipped', 'completed', 'cancelled'],
  shipped: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};
const STATUS_ICON: Record<string, string> = {
  confirmed: '\uD83D\uDCE6', processing: '\uD83D\uDD04',
  shipped: '\uD83D\uDE9A', completed: '\u2705', cancelled: '\u274C',
};
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const MANAGER_ID = parseInt(env.MANAGER_CHAT_ID) || 0;
    try {
      const url = new URL(request.url);
      if (url.pathname !== '/webhook') {
        return new Response('Telegram Order Bot', { status: 200 });
      }

      const raw = await request.text();
      const update = JSON.parse(raw);
      const msg = update.message;
      if (!msg?.text) return new Response('OK', { status: 200 });

      const chatId = msg.chat.id as number;
      const fromId = msg.from.id as number;
      const text = msg.text as string;
      const q = new OrderQueries(env.DB);
      const token = env.BOT_TOKEN;

      // ── Manager commands ──
      if (chatId === MANAGER_ID) {
        const parts = text.split(/\s+/);
        const cmd = parts[0];
        const args = parts.slice(1);
        if (!cmd) return new Response('OK', { status: 200 });
        const cmdName = cmd.toLowerCase();

        // /ping
        if (cmdName === '/ping') {
          await send(token, chatId, `pong chat=${chatId} manager=${MANAGER_ID}`);
          return new Response('OK', { status: 200 });
        }

        // /list [status]
        if (cmdName === '/list') {
          const statusFilter = args[0] || undefined;
          const orders = statusFilter
            ? await q.getOrders(statusFilter as OrderStatus)
            : await q.getOrders();
          if (orders.length === 0) {
            await send(token, chatId, 'No orders found.');
            return new Response('OK', { status: 200 });
          }
          const lines: string[] = [];
          for (const o of orders) {
            const items = await q.getOrderItems(o.id);
            lines.push(` #${o.display_id} ${o.status} — ${items.length} item(s)`);
          }
          await send(token, chatId, `Orders:\n${lines.join('\n')}`);
          await send(token, chatId, 'Use /customer &lt;order-id&gt; to view details.');
          return new Response('OK', { status: 200 });
        }

        // /customer <display_id>
        if (cmdName === '/customer') {
          const displayId = args[0];
          if (!displayId) {
            await send(token, chatId, 'Usage: /customer &lt;order-id&gt;');
            return new Response('OK', { status: 200 });
          }
          const order = await q.getOrderByDisplayId(displayId);
          if (!order) {
            await send(token, chatId, `Order #${displayId} not found.`);
            return new Response('OK', { status: 200 });
          }
          const customer = await q.getCustomerById(order.customer_id);
          const items = await q.getOrderItems(order.id);
          const uname = customer?.username ? `@${customer.username}` : customer?.first_name ?? 'Unknown';
          const itemLinks = items.map(i => i.link).join('\n');
          await send(token, chatId,
            `Order #${displayId} by ${uname}:\nItems:\n${itemLinks}\nSpecs: ${order.specs ?? '(none)'}\nStatus: ${order.status}`,
          );
          return new Response('OK', { status: 200 });
        }

        // /update <display_id> <new_status>
        if (cmdName === '/update') {
          const [displayId, newStatus] = args;
          if (!displayId || !newStatus) {
            await send(token, chatId, 'Usage: /update &lt;order-id&gt; &lt;new-status&gt;');
            return new Response('OK', { status: 200 });
          }
          if (!VALID_STATUSES.includes(newStatus)) {
            await send(token, chatId, `Invalid status. Valid: ${VALID_STATUSES.join(', ')}`);
            return new Response('OK', { status: 200 });
          }
          const order = await q.getOrderByDisplayId(displayId);
          if (!order) {
            await send(token, chatId, `Order #${displayId} not found.`);
            return new Response('OK', { status: 200 });
          }
          const allowed = ALLOWED_NEXT[order.status];
          if (!allowed?.includes(newStatus)) {
            await send(token, chatId, `Cannot change from "${order.status}" to "${newStatus}". Allowed: ${allowed?.join(', ') ?? 'none'}`);
            return new Response('OK', { status: 200 });
          }
          const updated = await q.updateOrderStatus(order.id, newStatus as OrderStatus, 'manager');
          await send(token, chatId, `Order #${displayId} updated to ${updated!.status}. Customer notified.`);

          const customer = await q.getCustomerById(order.customer_id);
          if (customer) {
            const icon = STATUS_ICON[newStatus] ?? '';
            const reason = newStatus === 'cancelled' ? ' Reason: cancelled by manager.' : '';
            await send(token, customer.telegram_id, `${icon} Order #${displayId} is now: ${newStatus}${reason}`);
          }
          return new Response('OK', { status: 200 });
        }
      }

      // ── Customer commands and order creation ──

      // /status
      if (text.startsWith('/status')) {
        const customer = await q.getCustomerByTelegramId(fromId);
        if (!customer) {
          await send(token, chatId, 'No orders found. Send me a product link to create an order.');
          return new Response('OK', { status: 200 });
        }
        const orders = await q.getOrdersByCustomer(customer.id);
        if (orders.length === 0) {
          await send(token, chatId, 'No orders found. Send me a product link to create an order.');
        } else {
          await send(token, chatId, `Your orders:\n${orders.map(o => ` #${o.display_id} — ${o.status}`).join('\n')}`);
        }
        return new Response('OK', { status: 200 });
      }

      // Order creation (message with links)
      const links = extractLinks(text);
      if (links.length > 0) {
        const specs = extractSpecs(text, links);
        const customer = await q.findOrCreateCustomer(fromId, msg.from.username ?? null, msg.from.first_name ?? null);
        const isDuplicate = await q.checkDuplicate(customer.id, links);
        const order = await q.createOrder(customer.id, specs, links, isDuplicate);
        await send(token, chatId, formatOrderSummary(order, links, specs));

        if (chatId !== MANAGER_ID) {
          const prefix = isDuplicate ? '\u{26A0}\uFE0F ' : '\uD83C\uDD95 ';
          const uname = msg.from.username ? `@${msg.from.username}` : msg.from.first_name ?? 'Unknown';
          const linkList = links.map((l, i) => `${i + 1}. ${l}`).join('\n');
          await send(token, MANAGER_ID,
            `${prefix}New Order #${order.display_id}\nFrom: ${uname}\nItems:\n${linkList}\nSpecs: ${specs ?? '(none)'}\nTime: ${order.created_at}\n\nManage: /customer ${order.display_id}`,
          );
        }
        return new Response('OK', { status: 200 });
      }

      // Catch-all
      if (chatId !== MANAGER_ID) {
        await send(token, chatId, 'Send me a product link to create an order. Use /status to check your orders.');
      }

      return new Response('OK', { status: 200 });
    } catch (e) {
      return new Response(`Error: ${e instanceof Error ? e.message : 'unknown'}`, { status: 200 });
    }
  },
};