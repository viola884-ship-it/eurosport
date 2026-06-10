# Spec vs Codebase Audit — `dev/eurosport`

**Date**: 2026-06-10
**Scope**: `~/dev/eurosport`
**Specs audited**:
- `specs/001-telegram-order-bot/` (status: implemented)
- `specs/002-orders-dashboard/` (status: implemented)
- `specs/003-ui-design-system/` (status: draft)

**Verification commands run**:
- `npx vitest run` → **45/45 passing** (17 helpers + 14 queries + 14 dashboard-api)
- `npx tsc --noEmit` (root, `workers/dashboard-api/`, `dashboard/`) → **clean**

---

## TL;DR

| Spec | Status | Tests | TypeCheck |
|------|--------|-------|-----------|
| 001 — Telegram Bot | ✅ Mostly compliant | ✅ 31 pass | ✅ clean |
| 002 — Orders Dashboard | ⚠️ Partially compliant (dead broken code + missing Telegram notification) | ✅ 14 pass | ✅ clean |
| 003 — UI Design System | ✅ Compliant (migrated) | n/a | ✅ clean |

**The biggest issues are NOT failures — they are inconsistencies and dead code**:

1. **Duplicate bot implementations** (grammY vs raw fetch). The grammY one is dead code that contradicts the plan.
2. **dashboard-api `lib/db.ts` and `handlers/*.ts` files reference a schema that does not exist** (`order_status_transitions`, `customers.name`). The deployed `index.ts` inlines the correct queries, so the broken files are dead code. But they will explode the moment someone wires them up.
3. **PATCH /orders/:id/status does not record a status transition** and `notification_sent` is hardcoded `false`. SC-005 and FR-008 silently violated.
4. **All 003 tasks still show `[ ]` in `tasks.md`** even though the migration is complete in code.

---

## 1. Spec 001 — Telegram Order Bot

**Files audited**: `src/{index.ts, types.ts, db/schema.sql, db/queries.ts, handlers/{helpers,manager,customer}.ts}`, `tests/db/queries.test.ts`, `tests/handlers/helpers.test.ts`, `wrangler.toml`.

### ✅ Compliant

- **Data model**: `src/db/schema.sql` exactly matches `data-model.md` (4 tables, 5 indexes, correct columns, FKs, CHECK constraints).
- **All 12 FRs implemented** in the deployed entry `src/index.ts`.
- **All 4 user stories complete** (place order, manager reviews, manager updates lifecycle, customer status query).
- **All 5 bot API contracts met** in the deployed `src/index.ts`:
  - Customer order placement → confirmation with items + specs
  - Manager `/ping`, `/list`, `/customer`, `/update`
  - Customer `/status` (lists own orders)
  - Manager notification with prefix 🆕 / ⚠️
  - Customer notification on status change with status icon
- **Duplicate detection**: 5-minute window, same customer + same links in same order = flagged.
- **Status lifecycle**: enforced, valid transitions checked before update.
- **Deployed entry** uses raw `fetch('https://api.telegram.org/...')` — matches `plan.md` §"All Telegram integration uses the raw REST API via `fetch()` — no bot framework dependency."
- **No secrets in repo**: `MANAGER_CHAT_ID` is a non-secret env var in `wrangler.toml`; `BOT_TOKEN` is sourced from `env.BOT_TOKEN` (secret).
- **31 unit tests pass** (17 helper + 14 query).

### ⚠️ Issues

#### 1.1 — Two conflicting bot implementations
**Severity: Medium** (dead code = confusion + future breakage)

| File | Framework | Deployed? | Matches plan? |
|------|-----------|-----------|---------------|
| `src/index.ts` | raw `fetch` | ✅ (via `wrangler.toml` `main`) | ✅ (plan says no bot framework) |
| `src/handlers/customer.ts` | grammY | ❌ | ❌ |
| `src/handlers/manager.ts` | grammY | ❌ | ❌ |

- `package.json` ships `grammy: ^1.34.0` (per research.md, which contradicts plan.md).
- `src/types.ts` even imports `Context` from `grammy` for a `BotContext` type that nothing else uses.
- These files are NOT wired into `wrangler.toml` (only `src/index.ts` is `main`).
- **Recommendation**: delete `src/handlers/{customer,manager}.ts`, drop grammY from `package.json`/`package-lock.json`, remove `BotContext` from `src/types.ts`. Keep them only if there's a near-term plan to migrate from raw fetch to grammY.

#### 1.2 — `/list` output format deviates from contract
**Severity: Low**

- `contracts/bot-api.md` says manager `/list` should output: `#003 processing — 1 item(s)`
- `src/index.ts:77` actually outputs: ` #${o.display_id} ${o.status}` (no em-dash, no item count).
- The grammY version (`src/handlers/manager.ts:100`) does include ` — ${items.length} item(s)`, so the contract format exists in the dead code, not the deployed code.
- **Recommendation**: change `src/index.ts:77` to ` #${o.display_id} ${o.status} — ${items.length} item(s)` and look up items inside the loop, or add a JOIN to keep it a single query.

#### 1.3 — Strict status transition enforcement
**Severity: Low** (data-model says skipping intermediate states is allowed; code disallows it)

- `data-model.md` §"Status Lifecycle": *"Transitions forward through the pipeline; skipping intermediate states is allowed."*
- `src/index.ts:22-29` and `src/handlers/manager.ts:45-52` both enforce a strict graph: `new → confirmed → processing → shipped → completed`. Manager cannot go `new → shipped` in one step.
- **Recommendation**: either loosen `ALLOWED_NEXT` to permit any forward transition + `cancelled`, or amend `data-model.md` to reflect the strict graph.

#### 1.4 — Cancellation reason hardcoded
**Severity: Low** (contract example shows custom reason)

- `contracts/bot-api.md` says cancellation notification may include a reason: `❌ Order #005 has been cancelled. Reason: out of stock`.
- `src/index.ts:133` hardcodes: `Reason: cancelled by manager.` (no way to pass a real reason from `/update 005 cancelled <reason>`).
- Same issue in `src/handlers/manager.ts:73`.

#### 1.5 — No 4000-char truncation
**Severity: Low** (edge case from spec)

- Edge case in `spec.md`: *"Bot processes the first 4000 characters of the message; longer input is truncated."*
- Neither implementation truncates. Telegram's hard limit is 4096 chars, but the spec is explicit about 4000.

#### 1.6 — `tsconfig.json` strictness not verified
The plan says "Create tsconfig.json with strict TypeScript config". `tsc --noEmit` passes, so functionally fine, but the actual file wasn't opened in this audit.

---

## 2. Spec 002 — Orders Dashboard

**Files audited**: `workers/dashboard-api/{index.ts, types.ts, wrangler.toml}`, `workers/dashboard-api/middleware/{auth,logging,rate-limit}.ts`, `workers/dashboard-api/lib/{db,kv-schema}.ts`, `workers/dashboard-api/handlers/{base,orders-list,order-detail,order-status,order-message,customer-detail,activity-logs,handlers.test}.ts`, `dashboard/src/{App.tsx, main.tsx, index.css}`, `dashboard/src/components/{LoginScreen,FilterControls,OrdersTable,OrderDetailDialog}.tsx`, `dashboard/src/components/ui/*`, `dashboard/{index.html, components.json, vite.config.ts, tailwind.config.js}`, `dashboard/api.js`, `dashboard/app.js`, `dashboard/styles.css`.

### ✅ Compliant

- **All 6 REST endpoints** from `contracts/api.md` are reachable from `workers/dashboard-api/index.ts`:
  - `GET /orders` (status filter, pagination)
  - `GET /orders/:display_id`
  - `PATCH /orders/:display_id/status`
  - `POST /orders/:display_id/message`
  - `GET /activity-logs`
  - `GET /customers` (see issue 2.3)
- **Auth** matches `plan.md` and `spec.md` FR-009: password login → `X-Session-Token` header (response & request) + HttpOnly `dashboard_session` cookie fallback with `SameSite=Lax`. 30-minute timeout enforced on both paths.
- **Login lockout** (5 attempts / 15 min) implemented per `middleware/auth.ts` and used in `index.ts:41-57`.
- **Rate limiting middleware** at 100 req/min/IP, returns `429` and `X-RateLimit-*` headers.
- **KV activity logging** with key pattern `log:{timestamp}:{id}`, correct schema from `data-model.md`, all 6 actions supported (`view_order`, `update_status`, `send_message`, `api_call`, `login`, `logout`).
- **Dashboard frontend** covers all FRs from `spec.md`:
  - FR-001 ✅ — served via Workers Assets binding at `/dashboard/`.
  - FR-002 ✅ — table with Order ID, Customer, Status, Created At, Items columns.
  - FR-003 ✅ — click column header sorts (asc/desc toggle).
  - FR-004 ✅ — Select dropdown with all 6 statuses.
  - FR-005 ⚠️ — debounce 300ms is in `App.tsx:8`/`:179` but the minimum-2-characters rule is NOT enforced; search is also wired as a debounced call to `loadOrdersInternal`, but the spec says **client-side filtering of loaded orders** (no API call), and the code actually does call the API on each debounced keystroke. See issue 2.5.
  - FR-006/FR-007 ✅ — Dialog opens on row click; shows customer, items, specs, current status, status history with relative timestamps.
  - FR-008 ✅ — relative time + `title=` tooltip with absolute timestamp.
  - FR-009 ✅ — auth required.
- **T036 (login lockout) + T035 (14 handler tests)** both present and pass.

### ⚠️ Critical issues

#### 2.1 — `PATCH /orders/:id/status` does NOT record a status transition
**Severity: High** — silently violates FR-010, SC-005

- `workers/dashboard-api/index.ts:314-317`:
  ```ts
  async function updateOrderStatus(db, displayId, status) {
    const result = await db.prepare(
      'UPDATE orders SET status = ?, updated_at = ? WHERE display_id = ?'
    ).bind(status, new Date().toISOString(), displayId).run();
    return result.success;
  }
  ```
  The PATCH handler (`index.ts:197`) calls this and returns — **no insert into `status_transitions`**.
- The bot's equivalent (`src/db/queries.ts:99-110`) DOES record a transition via `recordTransition()`.
- Net effect: any status change made through the dashboard is invisible to the order history shown in `OrderDetailDialog`. **Status History will be stale or empty for orders touched only via the dashboard.**
- `handlers/order-status.ts:43-55` shows the correct pattern (uses `order_status_transitions` — wrong table name, see 2.2 — but the intent is right). Even that one isn't wired into the deployed `index.ts`.
- **Recommendation**: in `index.ts:314-317`, after the UPDATE, insert a row into `status_transitions` with `from_status` = previous value, `to_status` = new value, `changed_by` = `'manager'`, mirroring the bot's `OrderQueries.updateOrderStatus`.

#### 2.2 — `notification_sent` is hardcoded `false`
**Severity: High** — silently violates FR-008 and SC-002

- `index.ts:202`: `return jsonResponse({ success: true, notification_sent: false }, 200, headers);`
- `handlers/order-status.ts:34`: same.
- The PATCH handler does not invoke `sendMessage` on the Telegram API at all. So the customer's chat is never notified when the dashboard flips a status — the bot-side `/update` path is the only thing that notifies today.
- `handlers/order-message.ts:41-58` has the right pattern (uses `env.TELEGRAM_BOT_TOKEN`), but it is **dead code** (not wired from `index.ts`).
- **Recommendation**: in `index.ts:202`, after updating + recording transition, look up the customer's `telegram_id` (via the join that's already in `getOrderByDisplayId`) and POST to `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage` with the status icon + display_id. Set `notification_sent: true` on success, `false` on failure. Also requires adding `TELEGRAM_BOT_TOKEN` to the dashboard-api's `wrangler.toml` secrets.

#### 2.3 — `GET /customers` shape contradicts `contracts/api.md`
**Severity: Medium** — `data-model.md` and `contracts/api.md` both define `GET /customers/:id`, but the deployed route accepts `?id=…` instead.

- `index.ts:123-127`:
  ```ts
  if (path === '/customers' && request.method === 'GET') {
    const customerId = url.searchParams.get('id');
    if (!customerId) return jsonResponse({ error: 'Customer ID required' }, 400, HEADERS);
    return handleCustomerDetail(request, parseInt(customerId, 10), env, HEADERS);
  }
  ```
- `handlers/customer-detail.ts` is the broken refactor that would have used the right path (`/customers/:id`); it just isn't referenced from `index.ts`.
- The React frontend (`App.tsx`) never calls this endpoint, so the bug is dormant. But a future client reading the spec will look for `/customers/:id` and 404.
- **Recommendation**: change the matcher in `index.ts` to `/^\/customers\/[^/]+$/` and read the id from the path segment.

#### 2.4 — Dead / broken code in `lib/db.ts` and `handlers/*.ts`
**Severity: Medium** — landmine for the next person who tries to "tidy up"

Files in `workers/dashboard-api/lib/` and `workers/dashboard-api/handlers/` that **do not match the real schema**:

| Wrong reference | Should be | Per actual schema |
|-----------------|-----------|-------------------|
| `FROM order_status_transitions` (lib/db.ts:62, 108; order-detail.ts:39; order-status.ts:45) | `FROM status_transitions` | `src/db/schema.sql:32` |
| `c.name as customer_name` (lib/db.ts:19, 43; order-detail.ts:24) | `c.first_name as customer_name` | `src/db/schema.sql:5` |
| `o.item_count` (lib/db.ts:21, 32, 132; order-detail.ts — implied) | derived via `(SELECT COUNT(*) FROM order_items WHERE order_id = o.id) as item_count` | (no such column in `orders` table) |

These files are not invoked from `index.ts` (which inlines its own correct queries), so the Worker runs fine. But `handlers/*.ts` are referenced from `handlers/handlers.test.ts` (14 passing tests) — those tests pass only because the mock DB ignores table/column names. Wiring the handlers up would crash on first request.

- **Recommendation**: either delete the unused `lib/db.ts` and the per-handler files (`base.ts`, `orders-list.ts`, `order-detail.ts`, `order-status.ts`, `order-message.ts`, `customer-detail.ts`, `activity-logs.ts`) and the corresponding test file, OR refactor `index.ts` to import them after fixing the schema references. Doing both halves the LOC and keeps the test suite honest.

#### 2.5 — Customer search is API-side, not client-side, and has no 2-char minimum
**Severity: Low** — contradicts FR-005

- `App.tsx:175-184` debounces the search input by 300ms then calls `loadOrdersInternal()`, which calls `api.getOrders({ status, limit, offset })` — `search` is never sent as a query param. The filter is then applied **in-memory on the loaded page only** (`App.tsx:220-225`), not across the full result set.
- Net behavior: typing "jo" on page 1 of 5 pages will only ever match "jo" within the 50 orders on the current page. Spec FR-005 says "search is client-side filtering of loaded orders (not a server API call)" — which the code does, but also says "results update as user types (debounced 300ms)", which the code does too. The "minimum 2 characters" gate is missing (`App.tsx:24-28` accepts any length).
- **Recommendation**: either (a) add `if (search.length < 2) return;` early in `handleSearchChange` to gate the search, or (b) load all orders up front and filter client-side (trades memory for fidelity to spec).

#### 2.6 — `validateCredentials` silently falls back to `'changeme'`
**Severity: High if deployed without `DASHBOARD_PASSWORD` set, else Low** — but it's a tripwire.

- `middleware/auth.ts:170-171`:
  ```ts
  const storedPassword = env.DASHBOARD_PASSWORD || 'changeme';
  return password === storedPassword;
  ```
- This is the same default the project memory flagged for fork audit. If the secret is missing in Cloudflare, the dashboard accepts password `changeme` for any caller that knows to try it. Same warning the user already saw during fork setup.
- **Recommendation**: throw at request time if `DASHBOARD_PASSWORD` is unset (e.g., `if (!env.DASHBOARD_PASSWORD) return false; throw new Error('DASHBOARD_PASSWORD env var not set')` in the route handler). Better: `validateCredentials` returns `false` AND logs an error.

#### 2.7 — Rate limit store is in-memory (resets on cold start)
**Severity: Low** — not effective across Worker instances

- `middleware/rate-limit.ts:11`: `const rateLimitStore = new Map<string, RateLimitEntry>();`
- Cloudflare Workers can run across many isolates; an in-memory Map only limits within one. Lockout uses KV (which is shared) and works correctly.
- **Recommendation**: if real rate limiting matters, move it to KV or use Cloudflare's rate limiting rules.

#### 2.8 — `TELEGRAM_BOT_TOKEN` is referenced in `order-message.ts` but not declared in `Env`
**Severity: Low** — works at runtime if the secret exists in env, but the type system doesn't know about it.

- `types.ts` declares `DB`, `ACTIVITY_LOGS`, `ASSETS` only.
- `order-message.ts:42` reads `env.TELEGRAM_BOT_TOKEN` — TypeScript allowed it (any-type laundering via the `as Env` casts) but it's a hidden runtime dep.

### ℹ️ Lower-stakes

#### 2.9 — Plan says dashboard-api is at `/dashboard/`, but contract says `/dashboard-api`
- `wrangler.toml` mounts assets at root → URL is `https://eurosport-orders.workers.dev/dashboard/`.
- API routes are at `/dashboard-api/...`.
- `contracts/api.md` §"Dashboard UI" says it could be at root or at `/dashboard/`; the implementation chose `/dashboard/`. The frontend correctly hardcodes `/dashboard-api/...` for the API base.

#### 2.10 — `kv-schema.ts` has a comment that suggests copy-paste
- `lib/kv-schema.ts:3`: `* Copied to workers/dashboard-api/lib/kv-schema.ts for build resolution` — looks like the lib was duplicated from `kv/` at the repo root (there's a `kv/` directory at the top level). Not a bug, but the duplication is fragile.

---

## 3. Spec 003 — UI Design System

**Files audited**: `dashboard/components.json`, `dashboard/src/index.css`, `dashboard/src/components/ui/{avatar,badge,button,card,dialog,input,label,select,skeleton,table}.tsx`, `dashboard/src/components/{LoginScreen,FilterControls,OrdersTable,OrderDetailDialog}.tsx`, `dashboard/vite.config.ts`, `dashboard/tailwind.config.js`, `dashboard/package.json`, `dashboard/dist/`, `dashboard/@/components/ui/*` (alias mirror), `docs/ui-standards.md`.

### ✅ Compliant

- **FR-001**: All UI elements in the active React app are shadcn primitives.
- **FR-002**: Components installed via `npx shadcn@latest add ...` — `components.json` is the canonical shadcn config, `dashboard/src/components/ui/*` are the unmodified shadcn sources.
- **FR-003**: All 9 required components present (Button, Table, Dialog, Input, Select, Badge, Card, Label, Avatar) plus Skeleton. Verified used in App.tsx, OrdersTable.tsx, OrderDetailDialog.tsx, FilterControls.tsx, LoginScreen.tsx.
- **FR-004**: `darkMode: 'class'` in `tailwind.config.js`; CSS variables defined for `:root` and `.dark` in `src/index.css`; toggle in `App.tsx:111-114` adds/removes `dark` on `document.documentElement`.
- **FR-005**: shadcn primitives ship with Radix UI ARIA + keyboard handling.
- **FR-006**: No edits inside `components/ui/`; customisation via `className` and CSS variables in `src/index.css`.
- **Status badge variants** in `OrdersTable.tsx:47-63` match `tasks.md` T019: `new=default, confirmed=secondary, processing/shipped=outline, completed=secondary, cancelled=destructive`.
- **`docs/ui-standards.md`** already documents the standard (per US3/T025/T026).
- **Built `dist/`** is current (built 2026-06-09).

### ⚠️ Issues

#### 3.1 — All 003 tasks in `tasks.md` are still `[ ]`
**Severity: Cosmetic**

- `specs/003-ui-design-system/tasks.md` shows T001–T032 as `[ ]` unchecked, but every task has been done in code. The plan-mode checkbox tracker is out of sync with reality.
- **Recommendation**: sweep through and mark them `[X]`, or delete the obsolete tasks file (spec status was "Draft" — could be promoted to "Implemented" too).

#### 3.2 — Dead vanilla code in `dashboard/` is still in the repo
**Severity: Cosmetic**

- `dashboard/app.js` (395 lines), `dashboard/api.js` (76 lines), `dashboard/styles.css` — the old vanilla implementation that was replaced by the React build. The shadcn migration tasks (T003) said to "preserve existing index.html, styles.css, app.js, api.js, favicon.svg" so this was a deliberate step, but they're now stale.
- `dashboard/@/components/ui/*` (10 files) — a copy/mirror of `src/components/ui/*`. The `vite.config.ts` alias `@` → `src` makes these redundant.
- **Recommendation**: delete the dead vanilla files and the `@/` mirror in a follow-up commit; keep them only if you want the rollback path.

#### 3.3 — `lucide-react: ^1.16.0` is suspiciously old
**Severity: Low**

- `dashboard/package.json` pins `lucide-react` to `^1.16.0`; the current major is `^0.400` and `^1.16.0` doesn't exist on npm. This may be a typo for `0.469.0` or similar. If `npm install` is being run cleanly, the lockfile is the source of truth; if not, the install will fail.
- **Recommendation**: check `package-lock.json` and update the version to a real `lucide-react` release.

---

## 4. Cross-cutting observations

### 4.1 — `.gitignore` includes `wrangler.toml` (good)
The user's fork-audit memory said to replace hardcoded credentials. `wrangler.toml` is git-ignored (the example file `wrangler.example.toml` is committed as the template). Local `wrangler.toml` carries the D1 ID + KV ID + non-secret `MANAGER_CHAT_ID`. ✅

### 4.2 — `MANAGER_CHAT_ID` is in `wrangler.toml` for both workers
- `wrangler.toml` (root, for `telegram-order-bot`): `MANAGER_CHAT_ID = "-5268718508"`
- `workers/dashboard-api/wrangler.toml`: same
- This is the same group chat the manager-notify should go to, and the same number the memory note flagged ("Manager chat: -5268718508 … Known bug: manager notifications silent — bot likely not in group"). Same operational caveat still applies.

### 4.3 — `AGENTS.md` is accurate for the live code
- `Active Technologies: TypeScript (existing Cloudflare Workers project) + shadcn/ui, Tailwind CSS, Radix UI primitives (002-orders-dashboard)` — accurate.
- The note that the dashboard uses shadcn/ui is correct.

### 4.4 — Beads workflow honoured
- `bd` is installed, `.beads/` present, AGENTS.md references `bd prime`. The user's standard "update beads and commit" workflow is intact.

---

## 5. Recommended next actions (prioritized)

| # | Action | Severity | Effort |
|---|--------|----------|--------|
| 1 | Fix `PATCH /orders/:id/status` in `workers/dashboard-api/index.ts` to insert into `status_transitions` (per data-model + FR-010) | High | 5 min |
| 2 | Make `PATCH /orders/:id/status` actually call Telegram `sendMessage`; set `notification_sent` truthfully (per FR-008) | High | 15 min |
| 3 | Delete or refactor the dead `workers/dashboard-api/{lib,handlers}/*.ts` files referencing `order_status_transitions` / `customers.name` | Medium | 30 min |
| 4 | Delete `src/handlers/{customer,manager}.ts`, drop grammY, remove `BotContext` from `src/types.ts` | Medium | 10 min |
| 5 | Make `validateCredentials` reject (not fall back to `'changeme'`) when `DASHBOARD_PASSWORD` is unset | High if exposed, else Low | 2 min |
| 6 | Adjust `/list` output in `src/index.ts:77` to match `contracts/bot-api.md` (` — ${items.length} item(s)`) | Low | 2 min |
| 7 | Tighten status transition rules (or amend `data-model.md`) — pick one | Low | 5 min |
| 8 | Add `GET /customers/:id` path-parameter routing; drop the `?id=` query-param form | Low | 5 min |
| 9 | Either enforce 2-char search minimum in `App.tsx` or document that the spec is interpreted loosely | Low | 2 min |
| 10 | Mark 003 tasks done in `tasks.md`, promote spec status to Implemented | Cosmetic | 5 min |
| 11 | Delete the dead vanilla `dashboard/{app,api}.js`, `styles.css`, and `dashboard/@/` mirror | Cosmetic | 5 min |
| 12 | Investigate `lucide-react@^1.16.0` version | Low | 5 min |

Total time to land all the non-cosmetic fixes: ~1 hour.
