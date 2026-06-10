/**
 * KV Activity Log Helper Functions
 * Writes structured entries to the ACTIVITY_LOGS KV namespace and reads them
 * back for the dashboard. Key shape: `log:<iso-timestamp>:<uuid>`.
 */

import type { ActivityLogEntry } from '../types';

export type { ActivityLogEntry } from '../types';

const LOG_KEY_PREFIX = 'log:';

export async function writeActivityLog(
  env: { ACTIVITY_LOGS: KVNamespace },
  entry: ActivityLogEntry
): Promise<void> {
  const key = `${LOG_KEY_PREFIX}${entry.timestamp}:${entry.id}`;
  await env.ACTIVITY_LOGS.put(key, JSON.stringify(entry));
}

export async function readActivityLogs(
  env: { ACTIVITY_LOGS: KVNamespace },
  options: {
    action?: string;
    actor?: string;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  } = {}
): Promise<{ logs: ActivityLogEntry[]; total: number }> {
  const { action, actor, from, to, limit = 50, offset = 0 } = options;

  // CF KV's `list()` only returns keys, not values — so we fetch each value via `get()`.
  // We cap the key list at 1000 to bound the N+1 read pattern; activity logs older than
  // that won't appear (acceptable since the dashboard paginates anyway).
  const listResult = await env.ACTIVITY_LOGS.list({ prefix: LOG_KEY_PREFIX, limit: 1000 });

  const logs: ActivityLogEntry[] = [];
  for (const key of listResult.keys) {
    const raw = await env.ACTIVITY_LOGS.get(key.name);
    if (!raw) continue;
    try {
      logs.push(JSON.parse(raw) as ActivityLogEntry);
    } catch {
      // skip corrupt entries
    }
  }

  let filtered = logs;
  if (action) filtered = filtered.filter((log) => log.action === action);
  if (actor) filtered = filtered.filter((log) => log.actor === actor);
  if (from) filtered = filtered.filter((log) => log.timestamp >= from);
  if (to) filtered = filtered.filter((log) => log.timestamp <= to);

  filtered.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  return {
    logs: filtered.slice(offset, offset + limit),
    total: filtered.length,
  };
}

export function generateLogId(): string {
  return crypto.randomUUID();
}

export function createLogEntry(
  actor: ActivityLogEntry['actor'],
  action: ActivityLogEntry['action'],
  targetType: ActivityLogEntry['target_type'],
  targetId: string,
  details: Record<string, unknown> = {},
  ipAddress?: string
): ActivityLogEntry {
  return {
    id: generateLogId(),
    timestamp: new Date().toISOString(),
    actor,
    action,
    target_type: targetType,
    target_id: targetId,
    details,
    ip_address: ipAddress,
  };
}