# Devtools

> **Status: deferred to v0.2.**
>
> The review that motivated this document identified a Devtools story as a
> worthwhile addition. The package's current focus is the runtime contract
> and the React integration; a first-class Devtools surface is intentionally
> out of scope for the pre-stable API.

This document is a **placeholder**. It captures the design intent, the
boundary with the runtime, and the open questions so the v0.2 work has a
starting point. The first usable Devtools surface will be specified in
detail in a follow-up.

---

## 1. Why a separate document

The package exposes a runtime, a React entrypoint, and a route builder.
A Devtools surface is **observability** — a way to inspect live
collections, query subscriptions, action submissions, and pending state
during development. It is intentionally decoupled from the runtime so
that:

- Production builds can drop the Devtools module entirely.
- The runtime's hot paths do not need to pay for telemetry it does not
  emit.
- The Devtools UI can evolve independently of the runtime contract.

The runtime provides **hooks** for the Devtools module to attach. The
Devtools module is an opt-in consumer; it is not bundled into the main
entrypoint.

---

## 2. Surface area (planned)

The intended v0.2 surface is:

- **Live collections** — list of registered collections, their schema,
  their current size, and the count of active subscriptions.
- **Query subscriptions** — list of `resourceKey` values with active
  subscriptions, their `DbQuerySpec` definitions, and the React
  components that mounted them.
- **Action submissions** — recent submissions, their input, status,
  result, and the canonical action name.
- **Pending state** — `pending.any()`, `pending.action(...)`,
  `pending.query(...)`, `pending.field(...)` results, with the
  per-spec loading predicates.
- **Route state** — for each registered route, the resolved data, the
  pending / submissions registries, and the route's hydration status.

The shape is **read-only**. Devtools is an inspection surface, not a
control surface. Mutation goes through the normal action / query APIs.

---

## 3. Integration with the React entrypoint

The most natural integration is a `<DbDevtools />` component that mounts
a small floating panel. The component would:

1. Receive a `db` (or read it from `useDb()`).
2. Subscribe to the action tracker and the live-query tracker.
3. Render the panels described in §2.
4. Poll / subscribe at a low rate to keep the UI responsive without
   spamming the runtime.

The polling rate, panel layout, and keyboard shortcuts are all open
questions for v0.2.

---

## 4. Open questions

- **Server-side rendering.** A Devtools surface is browser-only. The
  server entrypoint should not include it.
- **Time-travel debugging.** Optimistic overlays are kept in the cache
  and the native transaction. Time-travel would replay the cache's
  recorded undo operations; this is technically possible but couples
  the Devtools surface to internal cache state.
- **Persistence debugging.** The Query Collection, `localStorage`, and
  generic sync helpers all have their own dehydrate / hydrate hooks.
  Devtools could show the most-recent snapshot, the last write, and
  the last refetch; this would be a separate panel from the live
  subscription panel.
- **Schema introspection.** Devtools could surface the schema as a
  graph: entities, indexes, relationships. The schema is already
  inspectable through `schema.entities`, but a rendered graph is a
  v0.2 concern.

---

## 5. Status and timeline

The review pass that motivated this document is otherwise complete:

- Infinite query runtime, view/error APIs, and alias-introspection are
  done in v0.1.
- Detailed docs for views, relationships, pagination, authorization,
  optimistic / conflict / offline, action aliases, and query keys are
  done in v0.1.

Devtools is the only review item deferred. It will be specified in
detail in the v0.2 design pass.

If you need Devtools-style observability before v0.2, the runtime
hooks are already in place: `db.pending`, `db.submissions`, the
`ActionTracker.liveQueries` registry, and the `resourceKey` on every
`DbQuerySpec` are all directly inspectable. A small custom panel that
reads these is straightforward to build without a dedicated module.
