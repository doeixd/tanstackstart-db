# Pagination

Pagination in `@doeixd/tanstackstart-db` is **cursor-based** and
**framework-neutral**. The runtime is `createInfiniteQuery(...)` plus
`useDbLiveInfiniteQuery(spec)` / `useDbLiveInfiniteSuspenseQuery(spec)` for
React. Routes warm the first page during SSR; subsequent pages resolve in
the browser.

This document covers:

- The `InfiniteOptions<Page, Param>` block and the `DbInfiniteQuerySpec` it
  produces.
- Cursor semantics: `initialPageParam`, `getNextPageParam`, and the `null` /
  `undefined` terminator.
- `loadMore()`, `subscribe(...)`, `firstPage()`, and `dispose()`.
- The React hooks: `useDbLiveInfiniteQuery` and
  `useDbLiveInfiniteSuspenseQuery`.
- Route integration: how the route builder detects infinite specs, attaches
  them to deferred route data, and warms the first page for SSR.

For related query-key and cache-invalidation patterns, see
[`docs/query-keys.md`](./query-keys.md).

---

## 1. Defining an infinite query

```ts
import { createInfiniteQuery, isDbInfiniteQuerySpec } from "@doeixd/tanstackstart-db";

const recentPosts = createInfiniteQuery({
  pageSpec: (cursor: number | null) =>
    db.q.post
      .all()
      .as(postCard)
      .page(cursor ?? 0, 20),
  initialPageParam: 0,
  getNextPageParam: (lastPage) => (lastPage.length < 20 ? null : lastPage[lastPage.length - 1].id),
});
```

The three required pieces are:

- **`pageSpec(param)`** — returns a `DbQuerySpec<Page>` for the given cursor.
  The runtime invokes this once for the first page and again for every page
  returned by `getNextPageParam`. The page type is inferred from the spec's
  return value; the cursor type is inferred from `initialPageParam` and
  `getNextPageParam`.
- **`initialPageParam`** — the cursor used to build the first page. This is
  the same value the runtime forwards to `pageSpec` when no pages have
  loaded yet.
- **`getNextPageParam(lastPage, allPages)`** — extracts the next cursor from
  the last loaded page. Return `null` or `undefined` to signal "no more
  pages". The runtime treats both as the terminator (see §3).

`isDbInfiniteQuerySpec(value)` is the runtime type-guard for
`DbInfiniteQuerySpec` values.

---

## 2. The state machine

A `DbInfiniteQuerySpec` carries a single `current` value of type
`DbInfiniteState<Page, Param>`:

```ts
type DbInfiniteState<Page, Param> =
  | { status: "loading" }
  | {
      status: "ready";
      pages: ReadonlyArray<Page>;
      pageParams: ReadonlyArray<Param>;
      hasNextPage: boolean;
      isLoadingNext: boolean;
      error?: unknown;
    }
  | { status: "error"; error: unknown };
```

`status` starts as `"loading"`, transitions to `"ready"` after the first page
resolves, and flips to `"error"` if the first page's underlying spec throws.
`hasNextPage` is computed from `getNextPageParam`'s return: `false` when the
last call returned `null` or `undefined`. `isLoadingNext` is `true` only
between calling `loadMore()` and the next page resolving.

Subsequent pages re-emit the same `"ready"` state with a longer `pages`
array and a longer `pageParams` array. `error` on a `"ready"` state reflects
the most recent `loadMore()` failure, not the first page.

---

## 3. The `null` / `undefined` terminator

`getNextPageParam` may return `Param`, `null`, or `undefined`. The runtime
treats **both** `null` and `undefined` as "end of pagination" — a
deliberate choice so a server that returns `null` for "no more rows" does
not have to be reshaped client-side. The check is `== null`, which covers
both.

This means returning `null` from `getNextPageParam` immediately flips
`hasNextPage` to `false` and short-circuits any subsequent `loadMore()` call
to a no-op. The same applies to `undefined`; pick whichever your code reads
more naturally.

---

## 4. The instance API

`createInfiniteQuery(...)` returns a `DbInfiniteQuerySpec<Page, Param>`:

- **`loadMore(): Promise<void>`** — load the next page if `hasNextPage` is
  `true` and no `loadMore()` is in flight. No-op otherwise. Rejects if the
  spec has been disposed or the first page has not yet resolved.
- **`subscribe(onChange, onError?): () => void`** — receive every state
  transition. Returns a teardown function. Errors are reported through the
  `error` field of `"ready"` states or the `"error"` state itself; the
  optional `onError` is invoked for `"error"` transitions in addition.
- **`firstPage(): Promise<Page>`** — resolve the first page only, without
  taking over the spec's internal state. Used by route loaders that need a
  single SSR-resolved value; the spec is unaffected after `firstPage()`
  resolves.
- **`dispose(): void`** — release retained subscriptions. Subsequent
  `loadMore()` calls fail. Safe to call multiple times.
- **`current`** — getter for the latest state. Useful for tests and one-off
  reads.

The `options` field is exposed for inspection but is not meant to be
mutated.

---

## 5. React hooks

### `useDbLiveInfiniteQuery(spec)`

Returns the live state of the spec plus a stable `loadMore` callback. The
hook subscribes to `spec.subscribe(...)` and re-emits on every state change.
The subscription is shared across components that pass the same spec
instance.

```tsx
import { useDbLiveInfiniteQuery } from "@doeixd/tanstackstart-db/react";

function RecentPosts() {
  const { status, pages, hasNextPage, isLoadingNext, loadMore, error } =
    useDbLiveInfiniteQuery(recentPosts);

  if (status === "loading") return <p>Loading…</p>;
  if (status === "error") return <p>Error: {String(error)}</p>;

  return (
    <>
      {pages.map((page, i) => (
        <PostList key={i} posts={page} />
      ))}
      {hasNextPage && (
        <button onClick={() => loadMore()} disabled={isLoadingNext}>
          {isLoadingNext ? "Loading…" : "Load more"}
        </button>
      )}
    </>
  );
}
```

### `useDbLiveInfiniteSuspenseQuery(spec)`

Same shape as `useDbLiveInfiniteQuery`, but the hook suspends until the
first page resolves. The shared suspense resource is keyed by the spec's
identity (and `initialPageParam`, so changing the initial cursor creates a
new resource), preloads before commit, and tears down with the component.

```tsx
import { useDbLiveInfiniteSuspenseQuery } from "@doeixd/tanstackstart-db/react";

function RecentPosts() {
  const { pages, hasNextPage, loadMore, isLoadingNext } =
    useDbLiveInfiniteSuspenseQuery(recentPosts);

  return (
    <Suspense fallback={<p>Loading…</p>}>
      {/* pages[0] is always present in the resolved state */}
    </Suspense>
  );
}
```

Both hooks are stable across re-renders: the `loadMore` callback is wrapped
in a `useCallback` that forwards to the spec's method, so the closure
identity does not change between renders.

---

## 6. Route integration

`loadRouteData()` in the React entrypoint detects infinite specs with
`isDbInfiniteQuerySpec`. It treats them as **deferred** — the spec itself is
attached to `data[name]` as a non-blocking handle, and `firstPage()` is
called inside the loader to warm the first page for SSR.

```ts
const Route = createDbFileRoute("/posts/recent")
  .views(({ q }) => ({
    recentPosts: createInfiniteQuery({
      pageSpec: (cursor) =>
        q.post
          .all()
          .as(postCard)
          .page(cursor ?? 0, 20),
      initialPageParam: 0,
      getNextPageParam: (lastPage) =>
        lastPage.length < 20 ? null : lastPage[lastPage.length - 1].id,
    }),
  }))
  .build();
```

In the route component, `useData().recentPosts` is the **spec itself** (not
a value). The component then calls
`useDbLiveInfiniteSuspenseQuery(useData().recentPosts)` to read pages. The
SSR pass attaches a frozen snapshot of the first page so the server-rendered
HTML reflects the first batch; subsequent pages are loaded by the client.

The "treat as deferred" decision matters because `q.post.all().defer()`
returns a promise that resolves once, whereas an infinite spec is a
**retained subscription**. Marking it `defer()` would discard the live
feed; treating it as an infinite spec attaches the spec so the React hook
can subscribe to the live state without re-creating the underlying native
live collection.

---

## 7. SSR warming with `firstPage()`

The route loader's "warm first page" call is `firstPage()`, not `loadMore()`.
`firstPage()` returns a promise that resolves to the first page's data and
**does not** mutate the spec's internal state — the spec remains
uninitialized, and a subsequent `useDbLiveInfiniteQuery(spec)` call in the
component starts a fresh first-page subscription.

This is deliberate: the SSR pass and the client hydration pass should
**not** race to drive the spec. `firstPage()` is the read-only side door.

If you need to render more than the first page on the server, call
`loadMore()` instead and await the result, but be aware that the spec's
state has now advanced — the client's `useDbLiveInfiniteQuery(spec)` will
see the same state, not start fresh.

---

## 8. Disposal and unmount

Compiled route components release retained infinite-query subscriptions on
unmount. The route builder exposes a `.dispose()` method for loader-only
consumers (server-side renders, tests) that need to release subscriptions
explicitly. Calling `.dispose()` twice is safe.

Once disposed, `loadMore()` rejects with `"Infinite query was disposed."`,
`subscribe(...)` returns a no-op teardown, and `firstPage()` rejects. The
spec is unusable after disposal.

---

## 9. Common pitfalls

- **Returning `undefined` when you meant `null`.** Both terminate
  pagination. The runtime does not distinguish. The type of
  `getNextPageParam` is `Param | null | undefined`; pick the value that
  reads more naturally for your server.
- **Creating a new spec per render.** `createInfiniteQuery` registers a
  per-page subscription immediately. Creating a new spec on every render
  leaks subscriptions. Either hoist the spec to module scope or memoize it
  with `useMemo` / `useRef`.
- **Calling `loadMore()` during render.** `loadMore()` is async; calling
  it from a render function is a side effect and can cause duplicate
  loads. Use the `loadMore` returned by `useDbLiveInfiniteQuery` from an
  event handler.
- **Attaching the spec to a route view and using it as a value.** The
  route attaches the **spec itself** to `data[name]`. Reading
  `data.recentPages[0]` on the server is correct (it is the SSR-warmed
  first page); reading `data.recentPages` on the client without a hook
  is a no-op because the spec's state is empty until the hook subscribes.
