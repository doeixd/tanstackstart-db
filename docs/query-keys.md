# Query keys

Query keys are how the runtime identifies a query for **caching**,
**deduplication**, and **invalidation**. They are the unit of identity for
every `DbQuerySpec` and the unit the React resource cache uses to decide
whether two specs share a subscription.

This document covers:

- The default key shape and how the runtime composes it.
- The `key` option for explicit control.
- How view bindings, `select(...)`, and chainable methods change the key.
- How the route builder and React hooks use the key for dedup.
- Action-side invalidation through `affects(...)`.

For pagination (which builds a new key per page), see
[`docs/pagination.md`](./pagination.md).

---

## 1. The default key shape

Every `DbQuerySpec` carries a `resourceKey: ReadonlyArray<unknown>`. The
default shape is composed from:

- The query's logical name (e.g. `"post"`, `"comment"`).
- The query arguments (`id`, `authorId`, etc.) as a tuple.
- The view binding (`as(View)`) — adds the view's serialized form to the
  key so two specs that differ only in view get separate subscriptions.
- The chainable methods (`select`, `optional`, `one`, `many`, `defer`,
  `preloadOnly`, `required`, `field`, `infinite`).

The shape is **opaque** to consumers. Use `spec.resourceKey` if you need
to log or assert on the key, but treat it as a stable identifier rather
than a structured record.

---

## 2. Explicit keys

`queryFactory` and `db.q.raw(...)` accept an explicit `key` option:

```ts
import { queryFactory } from "@doeixd/tanstackstart-db";

const postById = queryFactory({
  key: ["post", "byId", "post_1"],
  execute: () => fetchPost("post_1"),
});
```

The `key` is the **prefix** of `resourceKey`. The runtime appends the
view binding and chainable-method markers to the prefix. Two specs with
the same `key` and the same chainable methods share a subscription; two
specs that differ in any segment do not.

Use explicit keys when:

- The default composed key is unstable across renders (e.g. it captures
  a closure-local value that is not in the spec's logical name).
- You need to look up the spec by a stable token from outside the React
  tree (e.g. in a service worker or a debug tool).
- Two generated specs need to share a subscription despite differing in
  some other field.

`db.q.raw({ key, query })` is the escape hatch for low-level TanStack DB
queries that do not have a generated helper.

---

## 3. View bindings

`.as(view)` extends `resourceKey` with the view's serialized form. Two
specs that differ only in their view get separate subscriptions:

```ts
const a = db.q.post.byId("post_1").as(postCard);
const b = db.q.post.byId("post_1").as(fullPost);
// a.resourceKey !== b.resourceKey
```

This is intentional: a view change is a **shape** change, and the
runtime cannot assume the consumer wants the same data under two
shapes. If you genuinely want two views to share the underlying
collection subscription, derive the projection locally instead of
through `.as(...)`.

The serialization uses the view's selection record. A view's
`serializeView(view)` is internal but stable for a given
`(entity, selection)` pair.

---

## 4. `select(selector)` and `cacheKey`

`.select(selector, cacheKey?)` extends `resourceKey` with the
selector's string form. The default `cacheKey` is
`selector.toString()`. The intent is to make the key **stable** for
two selectors that should share a subscription:

```ts
const titles = (sel: (p: Post) => string) => db.q.post.all().select(sel, "titles");

const a = titles((p) => p.title);
const b = titles((p) => p.title.toUpperCase());
// a.resourceKey !== b.resourceKey (the explicit cacheKey is the same,
// but the default selector.toString() differs)
```

A custom `cacheKey` should be passed whenever the selector's identity
is not a good proxy for the selector's behavior — closures over
non-serialized values, dynamically composed selectors, etc.

---

## 5. Chainable method markers

Each chainable method appends a marker to `resourceKey`:

| Method           | Marker                    |
| ---------------- | ------------------------- |
| `.one()`         | `"one"`                   |
| `.optional()`    | `"optional"`              |
| `.many()`        | `"many"`                  |
| `.list()`        | `"list"`                  |
| `.infinite()`    | `"infinite"`              |
| `.as(view)`      | `"as", <serialized view>` |
| `.select(fn, k)` | `"select", <cacheKey>`    |
| `.defer()`       | `"defer"`                 |
| `.preloadOnly()` | `"preloadOnly"`           |
| `.required()`    | `"required"`              |
| `.field(name)`   | `"field", <name>`         |

The exact markers are internal. The point is that two specs that differ
in **any** chainable method get separate keys, and identical chains
share keys.

---

## 6. The React resource cache

The React entrypoint's suspense / live-query hooks share a resource
cache keyed by `(db instance, resourceKey)`. Two components that
mount the same spec share a single subscription; two components that
mount different specs (even by a single chainable method) get separate
subscriptions.

The cache is **per DB instance**. Two `createStartDbFromSchema(schema)`
calls produce two DB instances; their resources do not share. This
matters for tests that build multiple DBs in the same process.

The cache is also **scoped by `initialPageParam`** for infinite queries.
A `useDbLiveInfiniteQuery` with one `initialPageParam` and a different
one (in the same component or across components) get separate
resources, even if the `pageSpec` callback is otherwise identical.

---

## 7. Dedup and refetch

The `useDbLiveQuery(spec)` hook uses `useSyncExternalStore` with a
stable `subscribe` callback, so the subscription is set up **once per
mount**. If the same spec is mounted by another component in the same
render, the second component reuses the first's subscription through
the shared resource cache.

Live subscriptions re-emit when the underlying collection changes.
The runtime does **not** debounce or batch re-emissions; consumers
that want a "latest value" view should compute it from the spec's
state directly.

A manual refetch is `spec.execute()` (one-shot) or
`spec.subscribe(cb)` (live). There is no `refetch()` method on
`DbQuerySpec`; refetch is a side-effect of re-executing the spec, not
a separate API.

---

## 8. Action-side invalidation

Actions can declare the queries they affect through `affects(handler)`:

```ts
const likePost = action<{ id: string }>({
  affects: ({ input, q }) => [q.post.byId(input.id).field("likes")],
  run: ({ input }) => {
    /* ... */
  },
});
```

The `affects` handler returns query specs the action invalidates. The
route builder uses this to mark dependent specs as pending while the
action runs; the action's `invalidate` hook (separate from `affects`)
is the post-success invalidation hook.

`affects` is a **declaration**, not an imperative call. The runtime
reads the result and updates the affected specs' pending state; the
underlying live collections continue to emit on their own schedule.
The pending state is a UI signal, not a cache primitive.

For finer-grained control, the `LiveQueryTracker` registry (exposed
on `ActionTracker.liveQueries`) tracks loading predicates for native
live collections. `pending.query(name)` returns `true` while any
matching predicate is still loading.

---

## 9. Common pitfalls

- **Unstable closures inside `key`.** The `key` option should be a
  stable tuple. A closure that captures a changing variable will
  produce a different key per render and break dedup. Hoist the key
  to module scope or memoize it.
- **Sharing subscriptions across DBs.** Two DB instances have
  separate resource caches. If you have a test that builds a new DB
  per test, the cache is fresh per test.
- **Relying on `resourceKey` for assertions.** The key is an opaque
  identifier. Asserting on its exact shape couples tests to internal
  markers that may change between versions.
- **Forgetting `.as(view)` in a key comparison.** Two specs that
  differ only in view binding get separate keys. The runtime will not
  dedup them; if you want shared subscriptions, the view must be the
  same.
