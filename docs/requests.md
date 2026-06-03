# Requests

This package does not have a `useRequest(...)` hook. The equivalent concepts
are:

- `db.q.*` query specs for reads.
- `.as(view)` for selecting a component or route shape.
- `useDbLiveQuery(...)` / `useDbLiveSuspenseQuery(...)` for component reads.
- `createDbFileRouteFactory(...)` for collecting route data into one Router
  loader.
- `dehydrateDb(...)` / `hydrateDb(...)` for SSR snapshots.

The data engine is TanStack DB. This package does not add a second normalized
cache or a request transport; collections and adapters own data fetching,
freshness, and sync behavior.

## Query bundles

Use `db.request(...)` when you want a reusable group of named query specs
without creating a new request/cache API.

```ts
const postPage = db.request(({ q }) => ({
  post: q.post.byId("post_1").as(postCard).required(),
  comments: q.comment.byPost("post_1").as(commentCard),
}));
```

The returned bundle can execute outside React:

```ts
const data = await postPage.execute();
// data.post
// data.comments

await postPage.preload();
postPage.keys();
```

It is also callable, so route builders can consume it directly:

```tsx
export const Route = createDbFileRoute("/posts/$postId").views(postPage).build();
```

Bundles can be staged when later specs need earlier results:

```ts
const postPage = db
  .request(({ params, q }) => ({
    post: q.post.require(params.postId).as(postCard),
  }))
  .extend(({ data, q }) => ({
    comments: q.comment.byPost(data.post.id).as(commentCard),
  }));

const data = await postPage.execute({ params: { postId: "post_1" } });
```

The route shortcut builds a DB file-route builder and attaches the bundle as
views:

```tsx
export const Route = postPage.route("/posts/$postId").build();
```

This is deliberately small. A query bundle is just a named set of
`DbQuerySpec`s with convenience methods. It does not retain data, batch network
requests, garbage collect records, or introduce a normalized cache. Those jobs
belong to TanStack DB collections and their adapters.

## Requesting lists

For a component-level list, subscribe to a list query:

```tsx
import { useDbLiveQuery } from "@doeixd/tanstackstart-db/react";
import { db } from "../db";
import { PostCard } from "./post-card";
import { postCard } from "../db/views";

export function PostsList() {
  const posts = useDbLiveQuery(db.q.post.all().as(postCard)) ?? [];

  return posts.map((post) => <PostCard key={post.id} post={post} />);
}
```

For a route-level list, put the data contract in the route loader:

```tsx
import { createDbFileRouteFactory } from "@doeixd/tanstackstart-db/react";
import { db } from "../db";
import { PostCard } from "../components/post-card";
import { postCard } from "../db/views";

const createDbFileRoute = createDbFileRouteFactory({
  db,
  defaults: { hydrate: "route" },
});

export const Route = createDbFileRoute("/posts")
  .views(({ q }) => ({
    posts: q.post.all().as(postCard),
  }))
  .component(({ posts }) => posts.map((post) => <PostCard key={post.id} post={post} />))
  .build();
```

`useDbLiveSuspenseQuery(...)` can be used when you want component reads to
suspend until the first value is ready:

```tsx
import { Suspense } from "react";
import { useDbLiveSuspenseQuery } from "@doeixd/tanstackstart-db/react";

function PostsList() {
  const posts = useDbLiveSuspenseQuery(db.q.post.all().as(postCard));
  return posts.map((post) => <PostCard key={post.id} post={post} />);
}

export function PostsBoundary() {
  return (
    <ErrorBoundary fallback={<p>Could not load posts.</p>}>
      <Suspense fallback={<div>Loading...</div>}>
        <PostsList />
      </Suspense>
    </ErrorBoundary>
  );
}
```

Route loaders and Suspense query hooks throw errors to the nearest route or
React boundary. Non-Suspense `useDbLiveQuery(...)` returns `undefined` until the
first value is available; use `useDbLiveQueryState(...)` when you need explicit
`loading` / `ready` / `error` state.

## One route loader, many query specs

Independent specs inside one `.views(...)` or `.queries(...)` stage are awaited
together with `Promise.all` inside one Router loader:

```tsx
export const Route = createDbFileRoute("/dashboard")
  .views(({ q }) => ({
    posts: q.post.all().as(postCard),
    comments: q.comment.all().as(commentCard),
    viewer: q.user.byId("viewer").as(userCard).required(),
  }))
  .build();
```

That means a navigation runs one Router loader for `/dashboard`. It does not
guarantee one backend HTTP request. Backend request batching belongs to the
configured collection adapter. For example, TanStack Query can dedupe and cache
collection fetches; a custom sync adapter may stream updates over a persistent
connection.

When one request depends on earlier data, add another stage:

```tsx
export const Route = createDbFileRoute("/posts/$postId")
  .views(({ params, q }) => ({
    post: q.post.byId(params.postId).as(postCard).required(),
  }))
  .views(({ data, q }) => ({
    comments: q.comment.byPost(data.post.id).as(commentCard),
  }))
  .build();
```

Stages are about dependency order; they do not create extra Router loader
requests.

## Requesting objects by ID

Use generated `byId(...)` helpers:

```ts
const post = await db.q.post.byId("12").as(postCard).required().execute();
```

The generated aliases read a little closer to application code:

```ts
await db.q.post.get("12").execute(); // alias for byId
await db.q.post.require("12").execute(); // byId(...).required()
await db.q.post.list().execute(); // alias for all()
```

In a route:

```tsx
export const Route = createDbFileRoute("/posts/$postId")
  .views(({ params, q }) => ({
    post: q.post.byId(params.postId).as(postCard).required(),
  }))
  .build();
```

To load several IDs, either compose several specs under stable names:

```tsx
export const Route = createDbFileRoute("/compare")
  .views(({ q }) => ({
    leftPost: q.post.byId("6").as(postCard).required(),
    rightPost: q.post.byId("7").as(postCard).required(),
  }))
  .build();
```

or create a custom list-shaped spec:

```ts
const postsByIds = (ids: ReadonlyArray<string>) =>
  db.q.raw({
    key: ["post", "byIds", ids],
    execute: async () => {
      const posts = await Promise.all(ids.map((id) => db.q.post.byId(id).execute()));
      return posts.filter((post) => post !== undefined);
    },
  });
```

## Other request types

For app-specific roots such as `viewer`, `settings`, or `notifications`, use
`q.raw(...)`:

```ts
const viewer = db.q.raw({
  key: ["viewer"],
  execute: () => userApi.viewer(),
});

const data = await viewer.execute();
```

You can combine raw specs with generated entity specs in routes:

```tsx
export const Route = createDbFileRoute("/account")
  .queries(({ q }) => ({
    viewer: q.raw({
      key: ["viewer"],
      execute: () => userApi.viewer(),
    }),
  }))
  .build();
```

Use `.queries(...)` for arbitrary query results and `.views(...)` for
view-bound entity results. If your route factory sets `requireViews: true`,
non-view specs must go through `.queries(...)`.

## Request arguments and cache keys

Every `DbQuerySpec` has a stable key:

```ts
db.q.post.byId("post_1").key();
// ["post", "byId", "post_1"]
```

Generated helpers include the entity, helper name, and arguments in the key.
For custom specs, put all meaningful arguments in `key`:

```ts
const postsByCategory = (categoryId: string, sort: "new" | "top") =>
  db.q.raw({
    key: ["posts", "category", categoryId, sort],
    execute: () => postsApi.list({ categoryId, sort }),
  });
```

Views and selectors are part of the React resource cache key:

```ts
const titles = db.q.post
  .all()
  .as(postCard)
  .select((posts) => posts.map((post) => post.title), "post-titles");
```

Pass an explicit selector key when the selector closes over values not already
represented in the query key.

For pagination, put filters in the infinite query key or in each page spec key,
and keep cursor values in the page specs:

```ts
const postsPage = (categoryId: string, cursor: string | null) =>
  db.q.raw({
    key: ["posts", "category", categoryId, "page", cursor],
    execute: () => postsApi.page({ categoryId, cursor }),
  });
```

## Request modes

There is no package-level `cache-first`, `stale-while-revalidate`, or
`network-only` option. Choose behavior through the query spec and the collection
adapter:

- `spec.live()` subscribes to live collection changes. This is the default.
- `spec.static()` resolves once and does not keep a live subscription.
- TanStack Query-backed collections use TanStack Query's own stale time,
  refetching, retries, and cache policies.
- Custom adapters can expose their own preload, status, and sync behavior.

Examples:

```ts
const livePost = db.q.post.byId("post_1").as(postCard).live();
const staticPost = db.q.post.byId("post_1").as(postCard).static();
```

Use `useDbStatus()` or route status APIs to surface adapter status:

```tsx
const status = useDbStatus();

if (status.isRefetching) {
  return <p>Refreshing...</p>;
}
```

## Cache lifetime

This package does not maintain a Fate-style normalized cache with retainers,
release buffers, or garbage collection.

State lives in collections:

- `TanStackCollection` stores local rows in a TanStack DB collection.
- Query Collection stores confirmed rows from TanStack Query.
- `localStorageCollection` persists through browser storage.
- `syncCollection` and `nativeCollection` wrap an external TanStack DB engine.
- `MemoryCollection` stores rows in a plain `Map` for tests.

React live-query resources are retained while components subscribe and cleaned
up when subscriptions dispose. The underlying collection decides whether rows
remain in memory, refetch, persist, or sync.

If you need to clear state in tests, create a fresh DB:

```ts
import { createMemoryStartDb } from "@doeixd/tanstackstart-db/testing";

const db = createMemoryStartDb(schema);
```

If you need durable browser state, use `localStorageCollection(...)`. If you
need server cache freshness, configure the Query Client or sync engine that
backs your collection.

For the common TanStack Query-backed shape, the optional Query Collection
entrypoint includes `queryCollectionFromApi(...)`:

```ts
import { queryCollectionFromApi } from "@doeixd/tanstackstart-db/query-collection";

const db = createStartDbFromSchema(schema, {
  collections: () => ({
    post: queryCollectionFromApi("post", {
      queryClient,
      queryKey: ["posts"],
      list: () => postsApi.list(),
      create: (posts) => postsApi.create(posts),
      update: (updates) => postsApi.update(updates),
      delete: (ids) => postsApi.delete(ids),
    }),
  }),
});
```

## SSR and hydration

Use `dehydrateDb(...)` and `hydrateDb(...)` directly, or let the route builder
include a snapshot with `defaults: { hydrate: "route" }`.

Manual server-side flow:

```ts
import { dehydrateDb, preloadDb } from "@doeixd/tanstackstart-db";

await preloadDb([db.q.post.byId("12").as(postCard).required()]);

return {
  snapshot: dehydrateDb(db),
};
```

Browser flow:

```ts
import { hydrateDb } from "@doeixd/tanstackstart-db";

hydrateDb(db, loaderData.snapshot);
```

Route-builder flow:

```tsx
const createDbFileRoute = createDbFileRouteFactory({
  db,
  defaults: { hydrate: "route" },
});

export const Route = createDbFileRoute("/posts/$postId")
  .views(({ params, q }) => ({
    post: q.post.byId(params.postId).as(postCard).required(),
  }))
  .build();
```

The route loader resolves the declared specs and includes a confirmed-state DB
snapshot in the payload. The client hydrates that snapshot before route data is
read.

By default, dehydration captures confirmed collection state only:

```ts
dehydrateDb(db);
```

There is a debug mode for inspecting in-flight optimistic overlays:

```ts
dehydrateDb(db, { snapshot: "include-pending-for-debug" });
```

Do not ship debug snapshots as authoritative SSR or storage state. Pending
optimistic writes may still fail and roll back.

Hydration semantics are intentionally simple:

- Unknown collections in the snapshot are skipped.
- Each collection decides how to apply rows through its `hydrate(...)` hook.
- There is no hydration scope field.
- There are no built-in encoded-size limits.
- There is no merge-mode option. Adapters either upsert or apply their own
  policy.
- Active subscriptions, route resources, pending submissions, timers, and
  optimistic mutation state are not restored from snapshots.

Create request-scoped DB instances on the server when data is user-specific.
Do not reuse one user's dehydrated snapshot for another user.
