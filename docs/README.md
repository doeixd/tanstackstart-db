# `@doeixd/tanstackstart-db` docs

Detailed guides for the runtime, the React entrypoint, and the route
builder. The `README.md` at the repo root is a high-level overview; the
files in this folder are the deep-dives.

## Topics

| Document                                                             | What it covers                                                                                                |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [`tutorial.md`](./tutorial.md)                                       | A progressive refactor from a normal posts route with a like button into schema-backed DB routes and actions. |
| [`design.md`](./design.md)                                           | Positioning, "not Fate", relationship to TanStack DB, escape hatches, the rationale for the API choices.      |
| [`views.md`](./views.md)                                             | Defining views, field selection, nested relationship projections, deep-freeze, view-aware query specs.        |
| [`requests.md`](./requests.md)                                       | Query specs, route data contracts, request keys, cache modes, collection lifetime, SSR, and hydration.        |
| [`relationships.md`](./relationships.md)                             | `api.one` / `api.many` declarations, generated helpers, foldable joins, post-execute materialization.         |
| [`pagination.md`](./pagination.md)                                   | `createInfiniteQuery`, the `null` / `undefined` terminator, the React hooks, route integration, SSR warming.  |
| [`authorization.md`](./authorization.md)                             | The `authorize` hook, `DbAuthError`, shared gates, ordering relative to optimistic / run.                     |
| [`optimistic-conflict-offline.md`](./optimistic-conflict-offline.md) | Optimistic overlays, rollback, `DbConflictError`, `DbOfflineError`, recovery patterns.                        |
| [`action-aliases.md`](./action-aliases.md)                           | `.with(...)`, `.extend(...)`, route-level aliasing, `actionName` preservation, generated CRUD auto-affects.   |
| [`query-keys.md`](./query-keys.md)                                   | The default key shape, explicit keys, view bindings, React resource cache dedup, action-side invalidation.    |
| [`actions-live-views.md`](./actions-live-views.md)                   | Project-native equivalents for actions, optimistic writes, live queries, pagination, and view composition.    |
| [`devtools.md`](./devtools.md)                                       | Deferred to v0.2. Placeholder with the design intent and the open questions.                                  |

## Reading order

If you are new to the package, the suggested reading order is:

1. `design.md` — the positioning and the rationale for the API.
2. `tutorial.md` — the practical adoption path from a normal route.
3. `views.md` — the view contract is the first thing most users touch.
4. `requests.md` — how reads, route data, and hydration work.
5. `relationships.md` — the schema declaration that views depend on.
6. `query-keys.md` — how the runtime identifies a query.
7. `pagination.md` — only if you need infinite queries.
8. `action-aliases.md` — the action chain and route-level aliasing.
9. `authorization.md` — the per-action gate.
10. `optimistic-conflict-offline.md` — the failure modes and recovery.
11. `actions-live-views.md` — a cross-topic map of common app patterns.

The Devtools document is a placeholder; the rest of the package is the
v0.1 surface.

## Status

- The package is **pre-stable**. The API may change between versions.
- The Devtools surface is the only review item deferred to v0.2.
- All other review items from the same pass are covered by the docs
  above.
