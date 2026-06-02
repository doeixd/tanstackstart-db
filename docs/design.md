# Design

The package is intentionally a thin **contract layer** on top of
[TanStack DB](https://tanstack.com/db). This document explains the
positioning, the relationship to TanStack DB, and the design choices
that drive the API.

## What this package is

**Application-level contracts on top of TanStack DB.** Define entities
once, get typed query helpers, optimistic CRUD actions, view masking,
route loader contracts, action aliases, hydration snapshots, and React
component builders — all wired to the same TanStack DB engine.

The package is the bridge between "TanStack DB's primitives" and "the
contracts a TanStack Start app needs to be readable". It does not
re-implement the data engine.

## What this package is not

- **Not a second normalized cache.** TanStack DB is the source of
  truth. This package reads from it; it does not maintain a parallel
  state.
- **Not a different transport.** The same sync adapters, the same
  network calls, the same persistence model. The package only adds the
  app-level vocabulary.
- **Not a Fate clone.** Fate is a fuller framework with its own
  component model, its own data engine, and its own transport. This
  package borrows the _ergonomics_ (view masking, action aliases,
  route contracts) without re-implementing the engine.
- **Not a replacement for the underlying primitives.** Every
  abstraction has an escape hatch back to the raw TanStack DB API.

## Relationship to TanStack DB

The package should be invisible to anyone who already knows TanStack
DB. The mental model is:

```
┌─────────────────────────────────────┐
│ App contracts (this package)        │
│ ─ schema → query/action generation  │
│ ─ view masking                      │
│ ─ route loader contracts            │
│ ─ action aliases                    │
│ ─ hydration snapshots               │
└──────────────┬──────────────────────┘
               │ uses
               ▼
┌─────────────────────────────────────┐
│ TanStack DB                         │
│ ─ live queries (differential)       │
│ ─ collections + sync adapters       │
│ ─ optimistic mutations              │
│ ─ schema validation                 │
└──────────────┬──────────────────────┘
               │ uses
               ▼
┌─────────────────────────────────────┐
│ Sync engines (Electric, PowerSync,  │
│ Query, localStorage, custom)        │
└─────────────────────────────────────┘
```

The "App contracts" layer is the only thing this package adds. It
adds zero behaviour to the layers below it; it just gives them a more
ergonomic shape.

## Escape hatches

Every abstraction has a way back to the engine. None of these are
considered "advanced" — they're first-class parts of the API:

- **`db.q.raw({ ... })`** — build a `DbQuerySpec` from a hand-written
  native TanStack DB query-builder closure. Use this for queries that
  don't map to a single entity (cross-entity joins, aggregations,
  custom projections).
- **`db.collections`** — the typed adapter map. Read or write rows
  directly. The generated CRUD actions are convenience wrappers
  around this; the collections are the underlying engine.
- **`useDb()`** / **`route.useDb()`** — return the `StartDb` so React
  components can reach `q`, `a`, `pending`, `submissions`, `collections`.
- **`useCollections()`** / **`route.useCollections()`** — return the
  typed collections map for direct access.
- **`nativeCollection(key, engine)`** — wrap a pre-existing TanStack
  DB `Collection` (Electric, PowerSync, Query, custom sync engines).
  This is the documented way to integrate external engines.

If a feature isn't covered by the package, fall back to the engine
directly. The package is layered on top, not in place of.

## Why "actions own their behavior" is the default

The action definition (`ActionDefinition`) owns the entire mutation
lifecycle: input validation, optimistic overlay, authorization gate,
persistence call, post-success invalidation, success / error /
settled hooks, rollback behavior. The route only chooses _which_
actions to expose, optionally aliasing them or binding values already
known from route data.

This separation has three benefits:

1. **Routes stay declarative.** A route's `.actions(...)` callback is
   a mapping from alias to action. It does not re-implement
   optimistic / rollback / authorization logic.
2. **Custom actions and generated CRUD share the same surface.**
   `db.a.post.patch` (generated) and `db.a.workflow.approve` (custom)
   both flow through `createAction(...)` and the same `pending` /
   `submissions` API. Routes don't have to special-case "is this
   built-in or custom".
3. **The action is the testable unit.** Routes glue the action to a
   page; the action itself can be unit-tested without rendering a
   route. This is why `mockDbAction` in the testing entrypoint
   returns a real `DbAction` rather than a stub.

## Why auto-affects is the default for generated CRUD

Generated CRUD knows the entity's shape and the input's shape. The
affected queries are derivable:

- `create(value)` — any list query (`q.<entity>.all()`) now contains
  the new row.
- `patch({ id, changes })` — for each field in `changes`, the
  byId(id).field(name) spec is affected. This is what makes
  `pending.field(entity, "title")` work for free.
- `update({ id, value })` — the byId(id) spec is affected. Field
  granularity is not derivable from a whole-row replacement.
- `delete({ id })` — the byId(id) spec is affected.

This is the smallest set of affects that drives the canonical
`pending.query` and `pending.field` lookups. Custom actions can
override with `.extend({ affects: ... })` when they need to mark
related collections or cross-entity queries.

## Why views are readonly, deeply, by construction

A view selection is a literal type. The TypeScript compiler rejects
access to fields that are not in the selection. The result is wrapped
in `Readonly<...>` so direct mutation is also rejected at the type
level. `freezeView` does the same at runtime (deep-freeze).

This is the contract:

- **Unselected fields are unavailable.** `post.body` is a type error
  if `body` is not in the view.
- **Nested relationships are masked recursively.** A view inside a
  view is also readonly and masked.
- **The runtime enforces what the type system promises.** `freezeView`
  prevents prototype pollution and direct mutation.

The cost is small (one `Object.freeze` per view result) and the
benefit is large: views become load-bearing for refactor safety
(renaming a field is a type error in every view that doesn't include
it).

## Why routes own their hydration, not the framework

The package does not invent a server-side rendering protocol. It
returns a `{ data, snapshot }` payload from the route's loader and
hands it to `@tanstack/react-router`'s existing loader contract. The
client-side `hydrateDbRoutePayload(db, payload)` is a thin wrapper
around `hydrateDb(db, snapshot)`.

This means:

- No new SSR protocol to learn.
- The same Router loader semantics that ship with TanStack Start work
  as-is.
- The "deferred" and "preloadOnly" query options are pure additions
  on top of the Router loader; no protocol changes needed.

The "root" and "manual" hydration strategies exist for apps that want
to capture the snapshot once at the root or drive hydration from a
custom point (e.g. after authentication). The route builder honors
`hydrate: "route" | "root" | "manual"` and returns the appropriate
loader shape.

## Status

The package is **pre-stable**. The API may change. The Devtools
surface is deferred to v0.2. All other design decisions in this
document are reflected in the current code.
