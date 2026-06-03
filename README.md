# tanstackstart-db

Schema-first application data helpers for [TanStack DB](https://tanstack.com/db).

`@doeixd/tanstackstart-db` turns a small entity schema into a typed application
data layer: collections, query helpers, optimistic CRUD actions, reusable views,
live React hooks, route loaders, hydration snapshots, and testing utilities.
It keeps TanStack DB as the data engine and adds the application-level contracts
needed to use that engine consistently across a TanStack Start app.

> **Status**: Pre-release (0.x). The API may change between minor versions.
> See [GOAL.md](./GOAL.md) for design direction and
> [docs/](./docs/README.md) for deep-dive topics.

## Why use it?

TanStack DB provides reactive client-side collections, live queries, and
optimistic mutations. Building an application still requires decisions about
schema ownership, query naming, view projection, action conventions, SSR
hydration, route loading, and testing.

This package makes those decisions once:

- **Define entities once.** Standard Schema-compatible validators drive runtime
  validation and TypeScript inference.
- **Get a useful API immediately.** Every entity receives typed `q.*` query
  helpers and `a.*` CRUD actions.
- **Keep optimistic writes observable.** Actions return awaitable submissions
  with transaction, persistence, result, and status state.
- **Shape data at component boundaries.** Reusable views select fields and
  materialize declared relationships.
- **Use the right collection engine per entity.** Start local, connect TanStack
  Query, persist to `localStorage`, or wrap an existing sync engine such as
  Electric or PowerSync.
- **Carry the same model through React and routes.** Live-query hooks, Suspense
  resources, Router loader builders, confirmed-state hydration, and testing
  helpers all use the same schema-backed DB.
- **Describe a page in one place.** DB file routes collect page views, reusable
  fragments, action aliases, pending state, boundaries, and hydration into one
  typed TanStack Router contract.

## Positioning

This package is **TanStack DB with application-level contracts** — not a
replacement for TanStack DB and not a Fate-clone. The relationship is:

- **Use raw TanStack DB** when you want the un-augmented engine: live
  queries, differential dataflow, sync adapters, optimistic mutations,
  schema validation. Nothing in this package hides those primitives.
- **Use this package** when you want app-level contracts on top of the
  same engine: typed schema → query/action generation, view masking,
  route loaders, action aliases, hydration snapshots, React component
  builders.

The two are the same data engine. This package layers **contracts**
(schema-to-CRUD generation, view masking, action aliases, route loader
contracts) on top of TanStack DB. It does not introduce a second
normalized cache, transport, or query planner.

Every abstraction has an escape hatch back to the engine:

- `db.q.raw({ ... })` builds a `DbQuerySpec` from a hand-written
  native TanStack DB query-builder closure.
- `db.collections` and `useCollections()` return the typed adapter
  map; you can read or write rows directly.
- `useDb()` returns the `StartDb` so React components can reach the
  generated queries and actions.
- `nativeCollection(key, engine)` wraps a pre-existing TanStack DB
  `Collection` (Electric, PowerSync, Query, custom sync engines).
- `route.useDb()` and `route.useCollections()` expose the route's
  bound DB to the component for direct access.

## Three levels

The package is structured so you can adopt it one slice at a time. Most
apps will land in Level 2; the deeper patterns are there when you
reach for them.

### Level 1: schema to CRUD

Define entities, get a DB, read and write immediately. No views, no
routes, no React. Useful for scripts, server-side rendering helpers,
or the first hour of an app.

```ts
import { defineDbSchema, entity, passthrough } from "@doeixd/tanstackstart-db/schema";
import { createStartDbFromSchema } from "@doeixd/tanstackstart-db";

const schema = defineDbSchema({
  entities: {
    post: entity(passthrough<{ id: string; title: string; likes: number }>(), { key: "id" }),
  },
});

const db = createStartDbFromSchema(schema);

await db.a.post.create({ id: "post_1", title: "Hello", likes: 0 });
const post = await db.q.post.byId("post_1").execute();
await db.a.post.patch({ id: "post_1", changes: { likes: 1 } });
```

### Level 2: views, components, and routes

Add view masking, typed component builders, and Router route
contracts. This is the level most apps spend their time in.

```ts
const postCard = db.view("post", { id: true, title: true, likes: true });

const PostCard = db.component(postCard)(({ post }) => (
  <article>
    <h2>{post.title}</h2>
    <p>{post.likes} likes</p>
  </article>
));

export const Route = createDbFileRoute("/posts/$postId")
  .views(({ params, q }) => ({
    post: q.post.byId(params.postId).as(postCard).required(),
  }))
  .actions(({ a, data }) => ({
    like: a.post.patch.with({ id: data.post.id }),
  }))
  .build();
```

### Level 3: custom actions, relationships, adapters, devtools

Add custom action definitions, schema relationships with native
joins, collection adapters for sync engines, and a devtools surface
(planned for v0.2). This is where `extendActions`, `api.one` /
`api.many`, `localStorageCollection`, `syncCollection`, and the
`createOptimisticAction` integration live.

```ts
const appDb = db.extendActions(({ action, c }) => ({
  post: {
    like: action<{ id: string }, void>({
      optimistic: ({ input, cache }) => {
        cache.post(input.id).patch({ likes: (n: unknown) => Number(n) + 1 });
      },
      run: ({ input, setTransaction }) => {
        const result = c.post.update(input.id, (post) => ({
          ...post,
          likes: post.likes + 1,
        }));
        setTransaction(result.transaction);
      },
    }),
  },
}));
```

## At a glance

| Concern     | What the package provides                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Schema      | Standard Schema entities, indexes, and `one` / `many` relationships                                                                  |
| Queries     | Generated `byId`, `all`, indexed, and relationship helpers; native TanStack DB execution; live subscriptions; raw query escape hatch |
| Views       | Typed field masks and nested relationship projections, compiled into native selects and joins where possible                         |
| Actions     | Generated optimistic CRUD, reusable custom actions, pending state, submission history, and rollback behavior                         |
| Collections | Local TanStack DB collections, Query Collection, `localStorage`, and generic sync-engine adapters                                    |
| React       | Provider-backed hooks, live queries, Suspense queries, DB-bound component helpers, and status hooks                                  |
| Routes      | Fluent TanStack Router file-route builders with deferred queries, preload-only queries, route hydration, and cleanup                 |
| Testing     | Memory-backed DBs, collection seeding, fixtures, action mocks, render helpers, and async utilities                                   |

## Quick start

Install the package and TanStack DB:

```bash
pnpm add @doeixd/tanstackstart-db @tanstack/db
```

Define the entities your application works with. Any Standard Schema-compatible
library can be used in place of `passthrough`.

```ts
import { defineDbSchema, entity, passthrough } from "@doeixd/tanstackstart-db/schema";

export const schema = defineDbSchema({
  entities: {
    user: entity(passthrough<{ id: string; name: string }>(), {
      key: "id",
    }),
    post: entity(passthrough<{ id: string; authorId: string; title: string; likes: number }>(), {
      key: "id",
      indexes: ["authorId"],
      relationships: (api) => ({
        author: api.one("user", { local: "authorId", foreign: "id" }),
      }),
    }),
  },
});
```

Create the DB. With no collection configuration, entities use local TanStack DB
collections and already support generated actions and queries.

```ts
import { createStartDbFromSchema } from "@doeixd/tanstackstart-db";
import { schema } from "./schema";

export const db = createStartDbFromSchema(schema);

await db.a.user.create({ id: "user_1", name: "Ada" });
await db.a.post.create({
  id: "post_1",
  authorId: "user_1",
  title: "Hello",
  likes: 0,
});

const post = await db.q.post.byId("post_1").execute();
const byAuthor = await db.q.post.byAuthor("user_1").execute();
```

Schema indexes generate concise helpers such as `authorId -> byAuthor(...)`.
Relationships generate named query helpers and can also be selected in views.

## Views

Views describe the shape a component or route needs without leaking the full
entity. Nested views are checked against declared relationships.

```ts
const userCard = db.view("user", { id: true, name: true });
const postCard = db.view("post", {
  id: true,
  title: true,
  likes: true,
  author: userCard,
});

const post = await db.q.post.byId("post_1").as(postCard).execute();
// { id, title, likes, author: { id, name } }
```

Simple projections are compiled into native TanStack DB `select` operations.
Eligible `one` relationships are folded into native joins. Other nested
relationships are materialized from their related collections after execution
and remain reactive for live queries. See
[`docs/views.md`](./docs/views.md) for the full view contract and
[`docs/relationships.md`](./docs/relationships.md) for the schema declarations
that views depend on.

## Actions and optimistic state

Generated actions expose `create`, `patch`, `update`, and `delete` for each
entity. An action call immediately returns a `DbActionSubmission`: a thenable
object that can be awaited like a promise while also exposing mutation state.

```ts
const submission = db.a.post.patch({
  id: "post_1",
  changes: { likes: 1 },
});

submission.status; // "pending" | "persisting" | "completed" | "failed"
submission.transaction; // native TanStack DB transaction when available

await submission.persisted;
const updated = await submission;
```

Use the DB tracker to drive granular UI feedback:

```ts
db.pending.any();
db.pending.action("post.patch", { id: "post_1", changes: { likes: 1 } });
db.pending.field({ id: "post_1" }, "likes");
db.pending.query("post");
db.submissions.latest("post.patch");
```

Application-specific actions can extend the generated namespace. The action
pipeline supports optimistic work, authorization, affected-query metadata,
invalidation, success/error hooks, and rollback behavior. See
[`docs/action-aliases.md`](./docs/action-aliases.md) for `.with(...)`,
`.extend(...)`, and route-level aliasing;
[`docs/authorization.md`](./docs/authorization.md) for the `authorize` gate
and `DbAuthError`; and
[`docs/optimistic-conflict-offline.md`](./docs/optimistic-conflict-offline.md)
for the optimistic / conflict / offline failure modes and recovery.

```ts
const appDb = db.extendActions(({ action, c, q }) => ({
  post: {
    like: action<{ id: string }, void>({
      affects: ({ input }) => [q.post.byId(input.id).field("likes")],
      run: ({ input, setTransaction }) => {
        const result = c.post.update(input.id, (post) => ({
          ...post,
          likes: post.likes + 1,
        }));
        setTransaction(result.transaction);
      },
    }),
  },
}));

await appDb.a.post.like({ id: "post_1" });
```

## Collection adapters

Each entity can choose its own TanStack DB collection engine. The schema key and
validator are forwarded to adapters so generated actions and direct native
mutations share the same rules.

### TanStack Query

Use the optional Query Collection entrypoint for server-backed entities:

```ts
import { QueryClient } from "@tanstack/query-core";
import { queryCollection } from "@doeixd/tanstackstart-db/query-collection";

const queryClient = new QueryClient();

const db = createStartDbFromSchema(schema, {
  collections: () => ({
    post: queryCollection("post", {
      queryClient,
      queryKey: ["posts"],
      queryFn: () => api.posts.list(),
      mutations: {
        insert: (rows) => api.posts.create(rows),
        update: (updates) => api.posts.update(updates),
        delete: (ids) => api.posts.delete(ids),
      },
    }),
  }),
});
```

### Local storage

Use `localStorageCollection` for browser-persisted entities. Its storage API is
configurable, which also makes it straightforward to test.

```ts
import { localStorageCollection } from "@doeixd/tanstackstart-db/local-storage-collection";

const db = createStartDbFromSchema(schema, {
  collections: () => ({
    post: localStorageCollection("post", {
      storageKey: "app.posts",
    }),
  }),
});
```

### Existing sync engines

Use `syncCollection` to wrap an existing TanStack DB `Collection`, including
collections created for Electric, PowerSync, or a custom synchronization layer.

```ts
import { syncCollection } from "@doeixd/tanstackstart-db/sync-collection";

const db = createStartDbFromSchema(schema, {
  collections: () => ({
    post: syncCollection("post", {
      engine: electricEngine,
      key: "id",
    }),
  }),
});
```

For lower-level integration, `nativeCollection(key, engine, options?)` wraps any
pre-created official TanStack DB collection directly.

## Hydration

Snapshots contain confirmed collection state. Pending optimistic overlays are
excluded by default so SSR payloads and client rehydration do not accidentally
promote unconfirmed writes.

```ts
import { dehydrateDb, hydrateDb } from "@doeixd/tanstackstart-db";

const snapshot = dehydrateDb(db);
hydrateDb(db, snapshot);
```

### Snapshot strategies

`dehydrateDb` accepts a `snapshot` option to control what state is captured:

- `"confirmed-only"` (default) — only rows that have been persisted to the
  collection's confirmed store. Pending optimistic overlays are excluded.
- `"include-pending-for-debug"` — keep in-flight optimistic overlays in
  the snapshot. Useful when debugging optimistic-rollback regressions, but
  never ship this to production SSR or storage because the overlay may
  never persist.

```ts
// Default — exclude pending overlays
const snapshot = dehydrateDb(db);

// Debug — preserve in-flight optimistic state
const debugSnapshot = dehydrateDb(db, { snapshot: "include-pending-for-debug" });
```

The route builder forwards `defaults.snapshot` to the loader, so a route
declared with `defaults: { hydrate: "route", snapshot: "include-pending-for-debug" }`
will include pending overlays in the SSR payload.

### Hydration strategies

`DbRouteDefaults.hydrate` chooses how the route's SSR loader exposes the
DB snapshot to the client:

- `"route"` (default) — the loader returns `{ data, snapshot }` and the
  client hydrates the DB on mount. The simplest choice when the root
  layout is purely structural.
- `"root"` — the loader returns the raw data only. A parent layout is
  expected to capture the snapshot and hydrate the DB once, so every
  child route sees the hydrated state without re-sending the snapshot.
- `"manual"` — the loader returns the raw data only. The application is
  responsible for calling `hydrateDb(db, snapshot)` at the appropriate
  point (custom route guard, post-auth, `localStorage` reload, etc.).

External native adapters are excluded from snapshots by default unless they
provide adapter-specific `dehydrate` and `hydrate` behavior. The built-in Query
Collection, `localStorage`, and generic sync helpers provide suitable defaults.

## React

`@doeixd/tanstackstart-db/react` provides context-backed live-query hooks,
Suspense resources, status helpers, and component builders.

```tsx
import { DbProvider, useDbLiveQuery } from "@doeixd/tanstackstart-db/react";

function App() {
  return (
    <DbProvider db={db}>
      <PostTitle postId="post_1" />
    </DbProvider>
  );
}

function PostTitle({ postId }: { postId: string }) {
  const post = useDbLiveQuery(db.q.post.byId(postId));
  return <h2>{post?.title}</h2>;
}
```

For Suspense-driven rendering, use `useDbLiveSuspenseQuery(spec)`. Identical
query keys share a retained subscription within the same DB scope and continue
to emit as the underlying data changes.

### View-bound components

For components that receive a view-projected row, `db.component(View)` is
the flagship builder. The render callback receives the projected row plus
(optional) `actions`, `pending`, `status`, and `submissions`:

```tsx
const PostCard = db.component(postCard)(({ post }) => (
  <article>
    <h2>{post.title}</h2>
    <p>{post.likes} likes</p>
  </article>
));

const LikeButton = db
  .component(postCard)
  .actions(({ a }) => ({ like: a.post.patch.with({ id: postCard.id }) }))
  .render(({ post, actions, pending }) => (
    <button
      disabled={pending.field(post, "likes")}
      onClick={() => actions.like({ changes: { likes: post.likes + 1 } })}
    >
      {post.likes}
    </button>
  ));
```

The action-aware form threads `actions`, `pending`, `status`, and
`submissions` through automatically; the component just renders. The DB
is read from the nearest `DbProvider` at render time, so the same
component can run against any DB.

### Component-owned queries

For components that own their query definitions (i.e. don't receive a
view-projected row), use `createDbComponent(db).props<Props>().views(...).render(...)`:

```tsx
import { createDbComponent } from "@doeixd/tanstackstart-db/react";

const PostTitle = createDbComponent(db)
  .props<{ postId: string }>()
  .views(({ props, q }) => ({
    post: q.post.byId(props.postId).required(),
  }))
  .render(({ post }) => <h2>{post.title}</h2>);
```

## Pagination

`@doeixd/tanstackstart-db/pagination` provides cursor-based pagination built on
top of TanStack DB collections. Define a paginated collection once, then use
`useListView` to load pages incrementally with automatic cursor tracking and
reactive re-renders.

```tsx
import { createCollection } from "@tanstack/db";
import { paginatedCollectionOptions, useListView } from "@doeixd/tanstackstart-db/pagination";

const CommentView = db.view("comment", { id: true, body: true, createdAt: true });

const comments = createCollection(
  paginatedCollectionOptions({
    id: "post-comments",
    getKey: (c) => c.id,
    pageSize: 10,
    cursor: "id",
    direction: "both",
    fetchPage: async ({ after, before, limit }) => {
      const params = new URLSearchParams();
      if (after !== undefined) params.set("after", String(after));
      if (before !== undefined) params.set("before", String(before));
      params.set("limit", String(limit));
      const response = await fetch(`/api/comments?${params}`);
      return response.json();
    },
  }),
);

function PostComments() {
  const [items, loadNext, loadPrevious, state] = useListView({
    collection: comments,
    view: CommentView,
  });

  return (
    <div>
      {loadPrevious && (
        <button onClick={loadPrevious} disabled={state.isLoadingPrevious}>
          Load older
        </button>
      )}
      {items.map((comment) => (
        <CommentCard key={comment.id} comment={comment} />
      ))}
      {loadNext && (
        <button onClick={loadNext} disabled={state.isLoadingNext}>
          Load newer
        </button>
      )}
    </div>
  );
}
```

The `useListView` hook returns a tuple of `[items, loadNext, loadPrevious, state]`:

- `items` - all currently loaded items projected through the view, reactively updated
- `loadNext` - function to load the next page, or `undefined` if no more pages or a load is in flight
- `loadPrevious` - function to load the previous page (only present for `direction: "backward"` or `"both"`), or `undefined` if at the start or a load is in flight
- `state` - pagination state including `hasNextPage`, `hasPreviousPage`, `isLoadingNext`, `isLoadingPrevious`, `error`, `totalCount`, `loadedCount`

Items are deduplicated by `getKey`, so calling `loadNextPage` twice with the
same cursor is safe. Use `useRefetchPaginated(collection)` to get a stable
refetch callback for refresh buttons (clears all loaded data and re-fetches
the first page).

The collection exposes all pagination primitives via `collection.utils`:

- `loadNextPage()` - fetch the next page
- `loadPreviousPage()` - fetch the previous page (undefined for forward-only)
- `refetchFirstPage()` - clear all data and re-fetch the first page
- `subscribe(callback)` - subscribe to pagination state changes
- `getState()` - get the current pagination state snapshot
- `getCollection()` - get the underlying collection instance

## DB file routes

The main application-level value of the React entrypoint is its DB file-route
builder. A DB file route is a typed page contract compiled to an official
TanStack Router `createFileRoute(path)(options)` route.

Instead of scattering page reads and mutation wiring across loader functions,
components, and hooks, the route declares:

- the data and views the page needs;
- reusable fragments shared with other routes;
- actions the page exposes, including route-bound inputs;
- pending, submission, refetch, and hydration state;
- Router search validation, loader dependencies, and boundaries.

```ts
import { createDbFileRouteFactory } from "@doeixd/tanstackstart-db/react";

const createDbFileRoute = createDbFileRouteFactory({
  db,
  defaults: { hydrate: "route" },
});

export const Route = createDbFileRoute("/posts/$postId")
  .views(({ params, q }) => ({
    post: q.post.byId(params.postId).as(postCard).required(),
    recentPosts: q.post.all().defer(),
  }))
  .actions(({ a, data }) => ({
    renamePost: a.post.patch.with({ id: data.post.id }),
  }))
  .build();
```

Use `.queries(...)` for raw entity results and `.views(...)` when the route is
exposing masked page contracts. Both methods accept the same typed query specs.

### One route loader request

All route specs run inside the one Router loader produced by `.build()`.
Independent specs in each fragment stage are awaited together with
`Promise.all`; dependent stages run in order; deferred specs are returned as
promises; preload-only specs warm collections without becoming component data.
When `hydrate: "route"` is enabled, the same loader response also includes a
confirmed-state snapshot for client hydration.

This means one navigation invokes one route loader request. It does **not**
promise that arbitrary adapter code makes only one backend HTTP call: that is
owned by the configured TanStack DB collection engine. For example, a Query
Collection can fetch a collection once and let several route specs query the
result locally.

### Route fragments

Fragments turn repeated page data into reusable contracts. Use the DB-bound
`createDbFileRoute.fragment(...)` helper so the callback receives the same typed
`q` API as the routes that consume it:

```ts
const postPageFragment = createDbFileRoute.fragment(({ params, q }) => ({
  post: q.post.byId(params.postId).as(postCard).required(),
  recentPosts: q.post.all().as(postCard).defer(),
}));

export const Route = createDbFileRoute("/posts/$postId").views(postPageFragment).build();
```

Repeated `.queries(...)` and `.views(...)` calls append stages rather than
replacing earlier declarations. A later stage can use the data resolved by an
earlier fragment:

```ts
export const Route = createDbFileRoute("/posts/$postId")
  .views(postPageFragment)
  .views(({ data, q }) => ({
    comments: q.comment.byPost(data.post.id).as(commentCard),
  }))
  .build();
```

Use `composeDbRouteFragments(...)` when the composed contract should be reused
by several routes:

```ts
import { composeDbRouteFragments } from "@doeixd/tanstackstart-db/react";

const postWithComments = composeDbRouteFragments(postPageFragment, ({ data, q }) => ({
  comments: q.comment.byPost(data.post.id).as(commentCard),
}));

export const Route = createDbFileRoute("/posts/$postId").views(postWithComments).build();
```

Fragment stages still run inside the same Router loader request. Staging exists
so later query specs can be built from earlier results without creating a
second route loader or moving data dependencies into components.

For standalone modules that are not attached to a DB-bound factory, the React
entrypoint also exports `createDbRouteFragment(...)`.

### Route actions

Actions define mutation behavior once at the DB layer: input validation,
optimistic changes, persistence, affected fields and queries, invalidation,
authorization, and lifecycle hooks. Routes normally expose those actions,
optionally rename them, and bind values already known from route data.

```ts
const postRoute = createDbFileRoute("/posts/$postId")
  .views(postPageFragment)
  .actions(({ a, data }) => ({
    renamePost: a.post.patch.with({ id: data.post.id }),
    deletePost: a.post.delete.with({ id: data.post.id }),
  }))
  .component(({ post, actions, pending, submissions }) => (
    <PostPage
      post={post}
      renaming={pending.action("renamePost")}
      lastRename={submissions.latest("renamePost")}
      onRename={(title) => actions.renamePost({ changes: { title } })}
      onDelete={() => actions.deletePost({})}
    />
  ));

export const Route = postRoute.build();
```

The route alias remains connected to the underlying action submission. That
means `pending.action("renamePost")` and `submissions.latest("renamePost")`
work even though the canonical action is `post.patch`, and the component only
supplies the input that was not already bound from route data.

### Route hooks and loading modes

Before `.build()`, the builder is also a testable route contract:

```ts
await postRoute.load({ params: { postId: "post_1" } });
postRoute.useData();
postRoute.useActions();
postRoute.usePending();
postRoute.useSubmissions();
postRoute.useStatus();
postRoute.useQuery("post");
```

Query specs can opt into `.required()`, `.defer()`, and `.preloadOnly()`.
Factory defaults support `hydrate: "route"`, `requireViews`, `live: false`,
and Router `ssr` forwarding. See
[`docs/pagination.md`](./docs/pagination.md) for the infinite-query runtime,
`useDbLiveInfiniteQuery` / `useDbLiveInfiniteSuspenseQuery`, and the
route-builder's first-page SSR warming; and
[`docs/query-keys.md`](./docs/query-keys.md) for how query keys compose, how
the React resource cache deduplicates, and how `affects(...)` declares
invalidation.

Deferred native route queries retain a live subscription after their first
value resolves. Compiled route components release those subscriptions on
unmount. Loader-only consumers should call `builder.dispose()` when retained
route data is no longer needed.

## Server helpers

`@doeixd/tanstackstart-db/server` exports `preloadDbRoute`,
`dehydrateDbRoute`, and `hydrateDbRoute` for SSR data transfer. It also provides
thin `createDbServerFn` and `createDbServerHandler` wrappers for environments
that already have a DB in scope. Production TanStack Start routes can keep using
the framework's own server-function integration.

## Type inference

Runtime schema, view, and query values also carry their projected TypeScript
types:

```ts
import type { InferDbQueryResult, InferView } from "@doeixd/tanstackstart-db";
import type { InferEntity } from "@doeixd/tanstackstart-db/schema";

type Post = InferEntity<typeof schema.entities.post>;
type PostCard = InferView<typeof postCard>;
type PostResult = InferDbQueryResult<ReturnType<typeof db.q.post.byId>>;
```

## Testing

`@doeixd/tanstackstart-db/testing` provides focused helpers for tests that
should exercise the application model without requiring a browser sync engine.

```ts
import { createMemoryStartDb, fixture, seedCollections } from "@doeixd/tanstackstart-db/testing";

const db = createMemoryStartDb(schema);
seedCollections(db, {
  user: [{ id: "user_1", name: "Ada" }],
});

const userCard = db.view("user", { id: true, name: true });
const user = fixture(userCard, { id: "user_1", name: "Ada" });
```

The testing entrypoint also exports `listFixture`, `mockDbAction`,
`renderDbComponent`, `renderDbRoute`, `waitFor`, and `flushMicrotasks`.

DB route builders can be exercised without mounting a Router:

```ts
const { data } = await renderDbRoute(postRoute, {
  params: { postId: "post_1" },
});

expect(data.post.title).toBe("Hello");
```

## Public entrypoints

```txt
@doeixd/tanstackstart-db
@doeixd/tanstackstart-db/schema
@doeixd/tanstackstart-db/react
@doeixd/tanstackstart-db/server
@doeixd/tanstackstart-db/testing
@doeixd/tanstackstart-db/query-collection
@doeixd/tanstackstart-db/local-storage-collection
@doeixd/tanstackstart-db/sync-collection
```

Peer dependency requirements by entrypoint:

- `@tanstack/query-core` and `@tanstack/query-db-collection` for
  `query-collection`
- `react` and `@tanstack/react-router` for the root package and `react`
- `react-dom` for `testing`

## Development

This repository uses [Vite+](https://viteplus.dev/guide/):

```bash
vp install
vp check
vp test
vp run build
```
