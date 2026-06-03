# Actions, live queries, pagination, and views

This guide translates common "server mutation + live view" patterns into
`@doeixd/tanstackstart-db`.

The important difference: this package does not ship a server transport, a Vite
plugin that discovers mutations, or a normalized SSE cache. It builds typed
application contracts on top of TanStack DB collections. Your collection adapter
owns the transport: local-only, TanStack Query, `localStorage`, Electric,
PowerSync, or a custom sync engine.

## Actions

Actions live on `db.a`. Every schema entity gets generated CRUD actions:

```ts
db.a.post.create(value);
db.a.post.patch({ id, changes });
db.a.post.update({ id, value });
db.a.post.delete({ id });
```

Custom domain actions are added with `db.extendActions(...)`:

```ts
export const db = baseDb.extendActions(({ action, c, q }) => ({
  post: {
    like: action<{ id: string }, { id: string; likes: number }>({
      affects: ({ input }) => [q.post.byId(input.id).field("likes")],
      run: async ({ input, setTransaction }) => {
        const updated = await postsApi.like(input.id);
        const result = c.post.update(input.id, () => updated);
        setTransaction(result.transaction);
        return result.value;
      },
    }),
  },
}));
```

Calling an action returns a `DbActionSubmission` immediately. The submission is
also awaitable:

```tsx
import { useDbPending } from "@doeixd/tanstackstart-db/react";
import { db } from "../db";

export function LikeButton({ post }: { readonly post: { id: string; likes: number } }) {
  const pending = useDbPending(db);

  return (
    <button disabled={pending.field(post, "likes")} onClick={() => db.a.post.like({ id: post.id })}>
      {post.likes} likes
    </button>
  );
}
```

You can also inspect the submission directly:

```ts
const submission = db.a.post.like({ id: "post_1" });

submission.status; // "pending" | "persisting" | "completed" | "failed"
submission.transaction;

await submission.persisted;
const result = await submission.result;
```

### Route actions

Routes usually expose actions under route-specific names:

```tsx
const postRoute = createDbFileRoute("/posts/$postId")
  .views(({ params, q }) => ({
    post: q.post.byId(params.postId).as(postCard).required(),
  }))
  .actions(({ a, data }) => ({
    likePost: a.post.like.with({ id: data.post.id }),
  }))
  .component(({ post, actions, pending }) => (
    <button disabled={pending.field(post, "likes")} onClick={() => actions.likePost({})}>
      {post.likes} likes
    </button>
  ));
```

The alias `likePost` is route-local. The action still carries its canonical
name, so pending and submissions stay connected to the underlying action.

## Optimistic updates

This package does not pass per-call `optimistic` objects to actions. Optimistic
behavior is part of the action definition, so every caller gets the same
rollback and pending-state semantics.

```ts
const db = baseDb.extendActions(({ action, c, q }) => ({
  post: {
    like: action<{ id: string }, void>({
      affects: ({ input }) => [q.post.byId(input.id).field("likes")],
      optimistic: ({ input, cache }) => {
        cache.post(input.id).increment("likes");
      },
      run: async ({ input, setTransaction }) => {
        const updated = await postsApi.like(input.id);
        const result = c.post.update(input.id, () => updated);
        setTransaction(result.transaction);
      },
    }),
  },
}));
```

If `run` throws, the optimistic overlay is rolled back and the submission fails
with `DbActionError`. If `run` succeeds, native TanStack DB mutations are
accepted and the submission completes.

`affects(...)` is what powers field-level pending checks:

```ts
db.pending.field({ id: "post_1" }, "likes");
db.pending.query("post");
```

Views still mask the fields a component can read, but this package does not
promise Fate-style per-field render invalidation for arbitrary React trees. Live
query reactivity is provided by the underlying TanStack DB collection and the
query spec you subscribe to.

## Inserting new records

Generated CRUD supports inserts:

```ts
const submission = db.a.comment.create({
  id: `optimistic:${Date.now().toString(36)}`,
  postId: post.id,
  content,
});

await submission.persisted;
```

For a domain action that creates a comment, put the temporary row and rollback
policy in the action definition:

```ts
const db = baseDb.extendActions(({ action, c, q }) => ({
  comment: {
    add: action<{ postId: string; content: string }, Comment>({
      affects: ({ input }) => [q.comment.byPost(input.postId), q.post.byId(input.postId)],
      optimistic: ({ input, cache }) => {
        const id = cache.optimisticId("comment");
        cache.comment.insert({
          id,
          postId: input.postId,
          content: input.content,
        });
        cache.post(input.postId).patch({
          commentCount: (count: unknown) => Number(count) + 1,
        });
      },
      run: async ({ input, setTransaction }) => {
        const comment = await commentsApi.add(input);
        const result = c.comment.insert(comment);
        setTransaction(result.transaction);
        return result.value;
      },
    }),
  },
}));
```

There is no built-in `insert: "before" | "after" | "none"` option. List ordering
comes from the query you render. For newest-first feeds, sort by timestamp or
create a query spec that returns the desired order.

## Returning a selected shape

Actions do not accept a per-call `view` option. Prefer returning the domain
result from the action and reading the displayed shape through a view-bound
query:

```ts
const commentCard = db.view("comment", {
  id: true,
  content: true,
  post: db.view("post", {
    id: true,
    commentCount: true,
  }),
});

const submission = db.a.comment.add({ postId: post.id, content });
const comment = await submission.result;
const comments = await db.q.comment.byPost(post.id).as(commentCard).execute();
```

When a mutation changes related state, include every affected query in
`affects(...)` and update the relevant collections in `run(...)`.

## Imperative mutations

There is no separate `actions` vs `mutations` namespace. `DbAction` calls are
imperative by default and can be used inside or outside React:

```ts
await db.a.comment.add({ postId, content });

const submission = db.a.post.delete({ id: postId });
await submission.persisted;
```

In React, route actions and `useDbPending` / `useDbSubmissions` provide the
loading and history surfaces. Outside React, hold the returned submission and
handle status, errors, and retries yourself.

## Server implementation

This package does not define your server mutation protocol. Server writes live
behind your action `run(...)` callback or behind a collection adapter.

A common TanStack Query-backed setup looks like this:

```ts
import { createStartDbFromSchema } from "@doeixd/tanstackstart-db";
import { queryCollection } from "@doeixd/tanstackstart-db/query-collection";
import { QueryClient } from "@tanstack/query-core";
import { schema } from "./schema";

const queryClient = new QueryClient();

const baseDb = createStartDbFromSchema(schema, {
  collections: () => ({
    post: queryCollection("post", {
      queryClient,
      queryKey: ["posts"],
      queryFn: () => postsApi.list(),
    }),
  }),
});

export const db = baseDb.extendActions(({ action, c, q }) => ({
  post: {
    like: action<{ id: string }, Post>({
      affects: ({ input }) => [q.post.byId(input.id).field("likes")],
      run: async ({ input, setTransaction }) => {
        const post = await postsApi.like(input.id);
        const result = c.post.update(input.id, () => post);
        setTransaction(result.transaction);
        return result.value;
      },
    }),
  },
}));
```

If your sync engine already exposes a TanStack DB `Collection`, wrap it with
`syncCollection(...)` or `nativeCollection(...)` and keep your server protocol in
that adapter.

## Error handling

Action failures reject the submission with `DbActionError`. The original error
is available as `error.cause`.

```ts
import { isDbActionError, isDbConflictError, isDbOfflineError } from "@doeixd/tanstackstart-db";

const submission = db.a.post.like({ id: post.id });

await submission.result.catch((error) => {
  if (isDbActionError(error) && isDbConflictError(error.cause)) {
    return refetchAndRetry();
  }
  if (isDbActionError(error) && isDbOfflineError(error.cause)) {
    return queueForLater();
  }
  throw error;
});
```

For call-site UI, use the submission APIs:

```tsx
const submissions = useDbSubmissions(db);
const latest = submissions.latest("post.like");

if (latest?.status === "failed") {
  return <p>Could not like this post.</p>;
}
```

For local button ergonomics, wrap an action with `useDbAction(...)`:

```tsx
import { useDbAction } from "@doeixd/tanstackstart-db/react";

function LikeButton({ post }: { readonly post: { id: string; likes: number } }) {
  const like = useDbAction(db.a.post.like);

  return (
    <button disabled={like.pending} onClick={() => like.run({ id: post.id })}>
      {like.error ? "Retry" : `${post.likes} likes`}
    </button>
  );
}
```

Unexpected errors should still be handled by route or React error boundaries.
This package does not classify HTTP status codes into call-site vs boundary
errors for you; your adapter or action should throw the error type you want
callers to handle.

## Deleting records

Generated delete actions remove rows from the collection:

```ts
const submission = db.a.post.delete({ id: post.id });
await submission.persisted;
```

For route aliases:

```tsx
const route = createDbFileRoute("/posts/$postId")
  .views(({ params, q }) => ({
    post: q.post.byId(params.postId).as(postCard).required(),
  }))
  .actions(({ a, data }) => ({
    deletePost: a.post.delete.with({ id: data.post.id }),
  }));
```

There is no per-call `delete: true` flag. Deletion is represented by the delete
action itself or by a custom action that calls `c.<entity>.delete(id)`.

## Resetting action state

There is no `useActionState` reset token. Submissions are retained in the
tracker so components can inspect recent history:

```ts
db.submissions.latest("post.like");
db.submissions.all("post.like");
db.submissions.forInput("post.like", { id: post.id });
```

If a component wants to dismiss an error message, keep that dismissal in local
component state. The underlying submission history remains available for
debugging and route-level status.

## Live queries

This package does not use `ViewRef`, `useView`, or one built-in SSE stream.
Instead, a view is bound to a query spec with `.as(view)`, and React subscribes
with `useDbLiveQuery(...)` or `useDbLiveSuspenseQuery(...)`.

```tsx
import { useDbLiveQuery } from "@doeixd/tanstackstart-db/react";
import { db } from "../db";
import { postCard } from "../db/views";

export function PostCard({ postId }: { readonly postId: string }) {
  const post = useDbLiveQuery(db.q.post.byId(postId).as(postCard));

  if (!post) return null;

  return (
    <article>
      <h2>{post.title}</h2>
      <p>{post.likes} likes</p>
    </article>
  );
}
```

The live behavior comes from the collection behind `db.collections.post`. A
local TanStack DB collection updates when actions mutate it. Query Collection
updates when its Query-backed data changes. Electric, PowerSync, or another
sync engine can push updates through its own TanStack DB collection.

If you need logging for live subscription errors, use the state hook:

```tsx
const state = useDbLiveQueryState(db.q.post.byId(postId).as(postCard));

if (state.status === "error") {
  captureException(state.error);
}
```

## Live lists and pagination

List queries are ordinary query specs:

```tsx
const posts = useDbLiveQuery(db.q.post.all().as(postCard)) ?? [];
```

For cursor-style pagination, use `createInfiniteQuery(...)`:

```ts
import { createInfiniteQuery } from "@doeixd/tanstackstart-db";

const recentPosts = createInfiniteQuery({
  pageSpec: (cursor: number | null) =>
    db.q.raw({
      key: ["posts", "recent", cursor],
      execute: () => postsApi.recent({ cursor, limit: 20 }),
    }),
  initialPageParam: null,
  getNextPageParam: (lastPage) => lastPage.nextCursor,
});
```

Then subscribe in React:

```tsx
import { useDbLiveInfiniteQuery } from "@doeixd/tanstackstart-db/react";

function RecentPosts() {
  const recent = useDbLiveInfiniteQuery(recentPosts);

  if (recent.status !== "ready") return null;

  return (
    <>
      {recent.pages.flatMap((page) =>
        page.items.map((post) => <PostCard key={post.id} postId={post.id} />),
      )}
      {recent.hasNextPage ? <button onClick={recent.loadMore}>Load more</button> : null}
    </>
  );
}
```

There is no Relay connection object, no built-in visible append/prepend policy,
and no live connection event protocol. If your sync engine needs those
semantics, implement them in the collection/query layer and expose the result as
a `DbQuerySpec` or `DbInfiniteQuerySpec`.

## Views

Views are typed field masks:

```ts
const postCard = db.view("post", {
  id: true,
  title: true,
  likes: true,
});
```

For a more fluent style, start from an entity:

```ts
const postCard = db.entity("post").pick("id", "title", "likes");

const postDetail = db.entity("post").view({
  id: true,
  title: true,
  body: true,
});
```

Bind a view to a query:

```ts
const post = await db.q.post.byId("post_1").as(postCard).required().execute();
```

Use the same view in React:

```tsx
const post = useDbLiveQuery(db.q.post.byId(postId).as(postCard));
```

Views can be composed with fragments:

```ts
import { defineViewFragment } from "@doeixd/tanstackstart-db";

const identity = defineViewFragment({ id: true });
const postTitleFields = defineViewFragment({ ...identity, title: true });
const postLikeFields = defineViewFragment({ ...identity, likes: true });

export const postCard = db.view("post", {
  ...postTitleFields,
  ...postLikeFields,
});
```

Nested relationship views use schema relationships:

```ts
const userCard = db.view("user", {
  id: true,
  name: true,
});

const postWithAuthor = db.view("post", {
  id: true,
  title: true,
  author: userCard,
});
```

The projected type is available with `InferView`:

```ts
import type { InferView } from "@doeixd/tanstackstart-db";

type PostCard = InferView<typeof postCard>;
```

Anything not selected is not part of the projected type and is dropped by
runtime masking.

## Requests and route data

The equivalent of collecting several view requests is a DB route contract:

```tsx
const postPage = createDbFileRoute("/posts/$postId")
  .views(({ params, q }) => ({
    post: q.post.byId(params.postId).as(postWithAuthor).required(),
    comments: q.comment.byPost(params.postId).as(commentCard),
  }))
  .actions(({ a, data }) => ({
    likePost: a.post.like.with({ id: data.post.id }),
  }))
  .component(({ post, comments, actions }) => (
    <PostPage post={post} comments={comments} onLike={() => actions.likePost({})} />
  ));

export const Route = postPage.build();
```

Independent specs inside one `.views(...)` stage are awaited together inside the
single Router loader for that route. If later specs need earlier data, add
another `.views(...)` stage:

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

That staging controls data dependency order; it does not create extra Router
loader requests.
