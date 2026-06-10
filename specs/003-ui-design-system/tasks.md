---

description: "Task list for shadcn-ui Design System feature implementation"

---

# Tasks: shadcn-ui Design System

**Input**: Design documents from `/specs/003-ui-design-system/`
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/components.md, quickstart.md

**Tests**: No test tasks — spec does not explicitly request tests.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- Frontend (dashboard/): React + shadcn/ui components at `dashboard/components/ui/`
- Backend (workers/): Unchanged by this feature
- Bundler: Vite for Workers Assets compatibility
- shadcn/ui components installed via `npx shadcn@latest add [component]`

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Initialize React development environment and shadcn/ui component library

- [X] T001 [P] Install React and React DOM in dashboard/ (`npm install react react-dom`)
- [X] T002 [P] Install React types in dashboard/ (`npm install -D @types/react @types/react-dom`)
- [X] T003 [P] Initialize Vite bundler in dashboard/ (`npm create vite@latest . -- --template react-ts`); preserve existing index.html, styles.css, app.js, api.js, favicon.svg
- [X] T004 [P] Initialize shadcn/ui in dashboard/ (`npx shadcn@latest init`); creates `components.json` and `dashboard/components/ui/` directory
- [X] T005 [P] Configure Tailwind CSS with dark mode (`darkMode: 'class'` in `tailwind.config.ts`)
- [X] T006 [P] Add all required shadcn/ui components (`npx shadcn@latest add button table dialog input select badge card label avatar`)

---

## Phase 2: Foundational (React Infrastructure)

**Purpose**: Set up React entry point and shadcn/ui theme CSS — CRITICAL for all user stories

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [X] T007 Create React entry point `dashboard/src/main.tsx` that mounts the DashboardApp component
- [X] T008 Create shadcn/ui theme CSS variables in `dashboard/src/app.css` (background, foreground, primary, secondary, muted, accent, border, input, ring, radius per data-model.md)
- [X] T009 Verify React app builds and serves via Vite (`npm run dev` in dashboard/)

**Checkpoint**: React + shadcn/ui environment is ready for component implementation

---

## Phase 3: User Story 1 - Migrate Dashboard to shadcn/ui (Priority: P1) 🎯 MVP

**Goal**: Dashboard displays all orders with shadcn/ui components — table, dialog, form controls, badges

**Independent Test**: Open dashboard URL, verify all UI elements render using shadcn/ui components; click row to open order detail modal; use filters and pagination

- [X] T010 [P] [US1] Create DashboardApp React component in `dashboard/src/App.tsx` (replace app.js logic with React state + event handlers)
- [X] T011 [P] [US1] Create LoginScreen component in `dashboard/src/components/LoginScreen.tsx` (Input + Label + Button)
- [X] T012 [P] [US1] Create OrdersTable component in `dashboard/src/components/OrdersTable.tsx` (Table, TableHeader, TableBody, TableRow, TableHead, TableCell, Button for pagination)
- [X] T013 [US1] Create OrderDetailDialog component in `dashboard/src/components/OrderDetailDialog.tsx` (Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, Card, Badge, Avatar, Button)
- [X] T014 [US1] Create FilterControls component in `dashboard/src/components/FilterControls.tsx` (Input for search, Select for status filter, Button for clear)
- [X] T015 [US1] Implement sorting logic in OrdersTable (click column header → sort by column; toggle asc/desc)
- [X] T016 [US1] Implement customer search with debounce 300ms in FilterControls
- [X] T017 [US1] Implement pagination in DashboardApp (Previous/Next buttons using Button variant="outline" size="sm")
- [X] T018 [US1] Implement dark mode toggle in DashboardApp (add/remove "dark" class on document.documentElement)
- [X] T019 [US1] Apply Badge variants per status (new=default, confirmed=secondary, processing/shipped=outline, completed=secondary with green tint, cancelled=destructive)
- [X] T020 [US1] Verify login flow works (password → X-Session-Token → dashboard loads)
- [X] T021 [US1] Verify all acceptance criteria from spec.md US1 (table, sorting, filters, modal)

**Checkpoint**: At this point, dashboard renders with shadcn/ui components and is functionally equivalent to the vanilla HTML version

---

## Phase 4: User Story 2 - Migrate Telegram Worker Web Pages (Priority: P2)

**Goal**: Any web pages served by telegram-notify worker use shadcn/ui components

**Independent Test**: Access telegram-notify worker's web pages and verify shadcn/ui styling is applied

- [X] T022 [P] [US2] Inspect `workers/telegram-notify/` directory and source files for any HTML render methods (Response with HTML, HtmlTemplate, etc.); document findings in `specs/003-ui-design-system/contracts/telegram-pages.md`
- [X] T023 [P] [US2] Migrate status pages to shadcn/ui Card and Badge components (or document if no web pages exist)
- [X] T024 [US2] Apply consistent dark mode support across telegram-notify web pages

---

## Phase 5: User Story 3 - Establish shadcn/ui as Project Standard (Priority: P3)

**Goal**: All future web interface work uses shadcn/ui exclusively

**Independent Test**: Code review of new web interfaces finds no vanilla HTML/CSS UI elements

- [X] T025 [P] [US3] Add shadcn/ui to AGENTS.md as mandatory for web interfaces
- [X] T026 [P] [US3] Document required shadcn/ui components list (button, table, dialog, input, select, badge, card, label, avatar) in a `CONTRIBUTING.md` or `docs/ui-standards.md`
- [X] T027 [US3] Verify existing workers/dashboard-api/ has no web UI code that needs migration

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Accessibility, mobile responsiveness, and final verification

- [X] T028 [P] Verify keyboard navigation works on all interactive elements (Tab, Enter, Space, Escape for dialog)
- [X] T029 [P] Verify focus management in Dialog (focus trap, close on Escape)
- [X] T030 Add mobile responsive styles for orders table (horizontal scroll on small screens)
- [X] T031 Add screen reader announcements for dynamic content (dialog open/close, filter results count)
- [X] T032 Verify all shadcn/ui components pass accessibility audit (aria- attributes present)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories (Phase 3-5)**: All depend on Foundational phase completion
- **Polish (Phase 6)**: Depends on user story completion

### User Story Dependencies

- **US1 (P1)**: Can start after Foundational - No dependencies on other stories
- **US2 (P2)**: Can start after Foundational - Independent of US1 once foundational is done
- **US3 (P3)**: Can start after Foundational - Independent of US1/US2

### Within Each User Story

- UI components within a story marked [P] can run in parallel
- React entry point (T007) must complete before React component tasks (T010-T014)
- shadcn/ui init (T004) must complete before component implementation

### Parallel Opportunities

- T001, T002, T003, T004, T005, T006 can all run in parallel (Phase 1 setup)
- T010, T011, T012, T013, T014 can run in parallel (different React component files)
- T022, T023, T024 can run in parallel (different pages for US2)
- T025, T026 can run in parallel (documentation tasks for US3)
- T028, T029, T030, T031, T032 can run in parallel (polish tasks)

---

## Parallel Example: User Story 1

```bash
# Launch all React components for User Story 1 in parallel:
Task: "Create DashboardApp React component in dashboard/src/App.tsx"
Task: "Create LoginScreen component in dashboard/src/components/LoginScreen.tsx"
Task: "Create OrdersTable component in dashboard/src/components/OrdersTable.tsx"
Task: "Create OrderDetailDialog component in dashboard/src/components/OrderDetailDialog.tsx"
Task: "Create FilterControls component in dashboard/src/components/FilterControls.tsx"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (React + shadcn/ui init)
2. Complete Phase 2: Foundational (React entry point + theme CSS) — CRITICAL blocks all stories
3. Complete Phase 3: User Story 1
4. **STOP and VALIDATE**: Open dashboard URL, verify table renders with shadcn/ui, modal opens on row click, filters work
5. Deploy/demo if ready

### Incremental Delivery

1. Complete Setup + Foundational → Foundation ready
2. Add User Story 1 → Test independently → Deploy (MVP: dashboard with shadcn/ui)
3. Add User Story 2 → Test independently → Deploy (telegram-notify pages)
4. Add User Story 3 → Test independently → Deploy (standard established)
5. Polish → Deploy

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- shadcn/ui components are installed into `dashboard/components/ui/` via CLI
- Do NOT modify shadcn/ui source files in `components/ui/` — extend via className or CSS variables only