export interface Customer {
  id: number;
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  created_at: string;
}

export interface Order {
  id: number;
  display_id: string;
  customer_id: number;
  status: OrderStatus;
  specs: string | null;
  is_duplicate: number;
  created_at: string;
  updated_at: string;
}

export interface OrderItem {
  id: number;
  order_id: number;
  link: string;
  sort_order: number;
}

export interface StatusTransition {
  id: number;
  order_id: number;
  from_status: string | null;
  to_status: string;
  changed_by: 'manager' | 'system';
  created_at: string;
}

export type OrderStatus =
  | 'new'
  | 'confirmed'
  | 'processing'
  | 'shipped'
  | 'completed'
  | 'cancelled';

export const VALID_STATUSES: OrderStatus[] = [
  'new', 'confirmed', 'processing', 'shipped', 'completed', 'cancelled',
];

// Per specs/001-telegram-order-bot/data-model.md §"Status Lifecycle":
// Forward transitions are allowed, including skipping intermediate states. Any
// non-terminal status can also transition to `cancelled`. `completed` and
// `cancelled` are terminal.
export const STATUS_LIFECYCLE: Record<OrderStatus, OrderStatus[]> = {
  new: ['confirmed', 'processing', 'shipped', 'completed', 'cancelled'],
  confirmed: ['processing', 'shipped', 'completed', 'cancelled'],
  processing: ['shipped', 'completed', 'cancelled'],
  shipped: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

export interface Env {
  DB: D1Database;
  MANAGER_CHAT_ID: string;
  BOT_TOKEN: string;
}