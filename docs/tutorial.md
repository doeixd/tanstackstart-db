# Tutorial: refactor a posts route into `tanstackstart-db`

This tutorial starts with a normal TanStack Start-style route: a loader fetches
posts, the component renders them, and a like button calls an API directly. Then
it refactors the same feature into `@doeixd/tanstackstart-db` one step at a
time.

The goal is not to make a tiny feature look clever. The goal is to move the
contracts that usually drift across loaders, components, mutations, and tests
into one schema-backed DB object.

## Starting point

Imagine an app with a small posts API:

```ts
// src/api/posts.ts
export type Post = {
  id: string;
  title: string;
  body: string;
  likes: number;
};

let posts: Post[] = [
  {
    id: "post_1",
    title: "Using TanStack Start",
    body: "A route loader fetches the page data.",
    likes: 3,
  },
  {
    id: "post_2",
    title: "Optimistic UI",
    body: "The component owns the temporary state.",
    likes: 7,
  },
];

export const postsApi = {
  async list() {
    return posts;
  },
  async like(id: string) {
    posts = posts.map((post) => (post.id === id ? { ...post, likes: post.likes + 1 } : post));
    return posts.find((post) => post.id === id);
  },
};
```

A plain route might look like this:

```tsx
// src/routes/posts.tsx
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { postsApi, type Post } from "../api/posts";

export const Route = createFileRoute("/posts")({
  loader: () => postsApi.list(),
  component: PostsRoute,
});

function PostsRoute() {
  const initialPosts = Route.useLoaderData();
  const [posts, setPosts] = useState(initialPosts);
  const [pendingLikes, setPendingLikes] = useState(() => new Set<string>());

  async function likePost(post: Post) {
    setPendingLikes((current) => new Set(current).add(post.id));
    setPosts((current) =>
      current.map((row) => (row.id === post.id ? { ...row, likes: row.likes + 1 } : row)),
    );

    try {
      const updated = await postsApi.like(post.id);
      if (updated) {
        setPosts((current) => current.map((row) => (row.id === updated.id ? updated : row)));
      }
    } finally {
      setPendingLikes((current) => {
        const next = new Set(current);
        next.delete(post.id);
        return next;
      });
    }
  }

  return (
    <main>
      {posts.map((post) => (
        <article key={post.id}>
          <h2>{post.title}</h2>
          <p>{post.body}</p>
          <button disabled={pendingLikes.has(post.id)} onClick={() => likePost(post)}>
            {post.likes} likes
          </button>
        </article>
      ))}
    </main>
  );
}
```

This is fine for one page. The problems show up as the app grows:

- `Post` is a transport type, a loader type, a component type, and a mutation
  type.
- The route owns optimistic state and rollback policy.
- Pending state is local to this component.
- A second page that renders posts has to reinvent the loader, projection, and
  like behavior.
- Tests need to mock both route data and mutation state.

Now refactor it gradually.

## 1. Define the DB schema

Create one schema module that describes the entities your app owns.

```ts
// src/db/schema.ts
import { defineDbSchema, entity, passthrough } from "@doeixd/tanstackstart-db/schema";

export const schema = defineDbSchema({
  entities: {
    post: entity(
      passthrough<{
        id: string;
        title: string;
        body: string;
        likes: number;
      }>(),
      { key: "id" },
    ),
  },
});
```

`passthrough` carries the TypeScript shape without validating at runtime. In a
real app you can swap it for a Standard Schema-compatible validator from Zod,
Valibot, ArkType, or another schema library.

## 2. Create a DB

At first, keep the data local. You now get generated query and action helpers:

```ts
// src/db/index.ts
import { createStartDbFromSchema } from "@doeixd/tanstackstart-db";
import { schema } from "./schema";

export const db = createStartDbFromSchema(schema, {
  collections: ({ queryCollection }) => ({
    post: queryCollection("post", {
      initialValues: [
        {
          id: "post_1",
          title: "Using TanStack Start",
          body: "A route loader fetches the page data.",
          likes: 3,
        },
        {
          id: "post_2",
          title: "Optimistic UI",
          body: "The component owns the temporary state.",
          likes: 7,
        },
      ],
    }),
  }),
});
```

The generated API is already useful:

```ts
await db.q.post.all().execute();
await db.q.post.byId("post_1").execute();
await db.a.post.patch({
  id: "post_1",
  changes: { likes: 4 },
});
```

## 3. Read from DB in the route

Replace the raw API loader with generated query specs. This still uses the
normal Router route shape.

```tsx
// src/routes/posts.tsx
import { createFileRoute } from "@tanstack/react-router";
import { db } from "../db";

export const Route = createFileRoute("/posts")({
  loader: () => db.q.post.all().execute(),
  component: PostsRoute,
});

function PostsRoute() {
  const posts = Route.useLoaderData();

  return (
    <main>
      {posts.map((post) => (
        <article key={post.id}>
          <h2>{post.title}</h2>
          <p>{post.body}</p>
          <button
            onClick={() =>
              db.a.post.patch({
                id: post.id,
                changes: { likes: post.likes + 1 },
              })
            }
          >
            {post.likes} likes
          </button>
        </article>
      ))}
    </main>
  );
}
```

The component is smaller, but it still reads one fixed loader snapshot. The DB
state changes after the action, yet the route data does not automatically
subscribe to it.

## 4. Use live queries in the component

Add `DbProvider` once near the route tree, then subscribe to the query in the
component.

```tsx
// src/routes/__root.tsx
import { Outlet, createRootRoute } from "@tanstack/react-router";
import { DbProvider } from "@doeixd/tanstackstart-db/react";
import { db } from "../db";

export const Route = createRootRoute({
  component: () => (
    <DbProvider db={db}>
      <Outlet />
    </DbProvider>
  ),
});
```

```tsx
// src/routes/posts.tsx
import { createFileRoute } from "@tanstack/react-router";
import { useDbLiveQuery } from "@doeixd/tanstackstart-db/react";
import { db } from "../db";

export const Route = createFileRoute("/posts")({
  loader: () => db.q.post.all().execute(),
  component: PostsRoute,
});

function PostsRoute() {
  const posts = useDbLiveQuery(db.q.post.all()) ?? Route.useLoaderData();

  return (
    <main>
      {posts.map((post) => (
        <article key={post.id}>
          <h2>{post.title}</h2>
          <p>{post.body}</p>
          <button
            disabled={db.pending.field(post, "likes")}
            onClick={() =>
              db.a.post.patch({
                id: post.id,
                changes: { likes: post.likes + 1 },
              })
            }
          >
            {post.likes} likes
          </button>
        </article>
      ))}
    </main>
  );
}
```

Now the route can render server-loaded data immediately, and the component
switches to live DB state once the subscription emits. The like button also uses
shared pending state instead of component-local `useState`.

## 5. Add a view

The route currently exposes the full `post` row to the component. A view turns
the component contract into an explicit field mask.

```ts
// src/db/views.ts
import { db } from "./index";

export const postCard = db.view("post", {
  id: true,
  title: true,
  likes: true,
});
```

Use the view in both the loader and live query:

```tsx
import { createFileRoute } from "@tanstack/react-router";
import { useDbLiveQuery } from "@doeixd/tanstackstart-db/react";
import { db } from "../db";
import { postCard } from "../db/views";

export const Route = createFileRoute("/posts")({
  loader: () => db.q.post.all().as(postCard).execute(),
  component: PostsRoute,
});

function PostsRoute() {
  const posts = useDbLiveQuery(db.q.post.all().as(postCard)) ?? Route.useLoaderData();

  return (
    <main>
      {posts.map((post) => (
        <article key={post.id}>
          <h2>{post.title}</h2>
          <button
            disabled={db.pending.field(post, "likes")}
            onClick={() =>
              db.a.post.patch({
                id: post.id,
                changes: { likes: post.likes + 1 },
              })
            }
          >
            {post.likes} likes
          </button>
        </article>
      ))}
    </main>
  );
}
```

`post.body` is no longer available in this component. That is the point: the
route and component now agree on the exact shape being rendered.

## 6. Split views into component fragments

As the page grows, one view per route can become too coarse. A title component,
a like button, and a compact card each need slightly different fields.

Use `defineViewFragment(...)` for reusable selection fragments, then compose
those fragments into the views each component needs.

```ts
// src/db/views.ts
import { defineViewFragment } from "@doeixd/tanstackstart-db";
import { db } from "./index";

export const postIdentity = defineViewFragment({
  id: true,
});

export const postTitleFields = defineViewFragment({
  ...postIdentity,
  title: true,
});

export const postLikeFields = defineViewFragment({
  ...postIdentity,
  likes: true,
});

export const postTitle = db.view("post", postTitleFields);
export const postLikeButton = db.view("post", postLikeFields);

export const postCard = db.view("post", {
  ...postTitleFields,
  ...postLikeFields,
});
```

The fragments are plain selection objects. They do not fetch anything by
themselves; they let component boundaries share the same field contract.

```tsx
// src/components/post-title.tsx
import { db } from "../db";
import { postTitle } from "../db/views";

export const PostTitle = db.component(postTitle)(({ post }) => <h2>{post.title}</h2>);
```

```tsx
// src/components/post-like-button.tsx
import { db } from "../db";
import { postLikeButton } from "../db/views";

export const PostLikeButton = db
  .component(postLikeButton)
  .actions(({ a }) => ({
    likePost: a.post.patch,
  }))
  .render(({ post, actions, pending }) => (
    <button
      disabled={pending.field(post, "likes")}
      onClick={() =>
        actions.likePost({
          id: post.id,
          changes: { likes: post.likes + 1 },
        })
      }
    >
      {post.likes} likes
    </button>
  ));
```

Now the route can load `postCard`, and child components can receive the same
row while only reading their own fields.

```tsx
import { PostLikeButton } from "../components/post-like-button";
import { PostTitle } from "../components/post-title";
import type { InferView } from "@doeixd/tanstackstart-db";
import { postCard } from "../db/views";

type PostCardProps = {
  readonly post: InferView<typeof postCard>;
};

function PostCard({ post }: PostCardProps) {
  return (
    <article>
      <PostTitle post={post} />
      <PostLikeButton post={post} />
    </article>
  );
}
```

`InferView<typeof postCard>` is the projected row type. Since `postCard`
includes the fields required by `postTitle` and `postLikeButton`, the same row
can be passed down to both components.

If a component needs its own props object, use the same helper:

```ts
import type { InferView } from "@doeixd/tanstackstart-db";
import { postCard } from "../db/views";

type PostCardProps = {
  readonly post: InferView<typeof postCard>;
};
```

## 7. Collect route fragments into one request

View fragments compose component field selection. Route fragments compose page
data requirements.

Suppose the posts page needs the list of posts plus a small stats panel. In a
plain app, it is easy to accidentally split this into multiple loaders or move
one fetch down into a component. The DB route builder lets you collect those
pieces and still build one Router loader.

```tsx
// src/routes/posts.tsx
import { composeDbRouteFragments, createDbFileRouteFactory } from "@doeixd/tanstackstart-db/react";
import { db } from "../db";
import { postCard } from "../db/views";

const createDbFileRoute = createDbFileRouteFactory({
  db,
  defaults: { hydrate: "route" },
});

const postsListFragment = createDbFileRoute.fragment(({ q }) => ({
  posts: q.post.all().as(postCard),
}));

const postStatsFragment = createDbFileRoute.fragment(({ q }) => ({
  postsForStats: q.post
    .all()
    .as(postCard)
    .select(
      (posts) => ({
        totalPosts: posts.length,
        totalLikes: posts.reduce((sum, post) => sum + post.likes, 0),
      }),
      "post-stats",
    ),
}));

const postsPageData = composeDbRouteFragments(postsListFragment, postStatsFragment);

const postsRoute = createDbFileRoute("/posts")
  .views(postsPageData)
  .actions(({ a }) => ({
    likePost: a.post.patch,
  }))
  .component(({ posts, postsForStats, actions, pending }) => (
    <main>
      <aside>
        {postsForStats.totalPosts} posts, {postsForStats.totalLikes} likes
      </aside>

      {posts.map((post) => (
        <article key={post.id}>
          <h2>{post.title}</h2>
          <button
            disabled={pending.field(post, "likes")}
            onClick={() =>
              actions.likePost({
                id: post.id,
                changes: { likes: post.likes + 1 },
              })
            }
          >
            {post.likes} likes
          </button>
        </article>
      ))}
    </main>
  ));

export const Route = postsRoute.build();
```

`postsListFragment` and `postStatsFragment` are independent, so the generated
loader can execute their specs together. The browser still navigates through
one `/posts` route loader request; the route just has a richer internal data
contract.

Fragments can also depend on earlier fragment data. In that case, call
`.views(...)` more than once. Each call appends a stage; specs inside one stage
run together, then the next stage receives the data that already resolved.

```tsx
const selectedPostFragment = createDbFileRoute.fragment(({ params, q }) => ({
  selectedPost: q.post.byId(params.postId).as(postCard).required(),
}));

const relatedPostsStage = createDbFileRoute.fragment(({ data, q }) => ({
  relatedPosts: q.post
    .all()
    .as(postCard)
    .select(
      (posts) => posts.filter((post) => post.id !== data.selectedPost.id).slice(0, 3),
      "related-posts",
    ),
}));

export const Route = createDbFileRoute("/posts/$postId")
  .views(selectedPostFragment)
  .views(relatedPostsStage)
  .build();
```

That still produces one Router loader for `/posts/$postId`. Stages are about
data dependency order, not about creating extra route loader requests.

## 8. Move the route contract into the DB route builder

The route still has three separate concepts in the component: data, actions,
and pending state. `createDbFileRouteFactory` collects them into one route
contract.

```tsx
// src/routes/posts.tsx
import { createDbFileRouteFactory } from "@doeixd/tanstackstart-db/react";
import { db } from "../db";
import { postCard } from "../db/views";

const createDbFileRoute = createDbFileRouteFactory({
  db,
  defaults: { hydrate: "route" },
});

const postsRoute = createDbFileRoute("/posts")
  .views(({ q }) => ({
    posts: q.post.all().as(postCard),
  }))
  .actions(({ a }) => ({
    likePost: a.post.patch,
  }))
  .component(({ posts, actions, pending }) => (
    <main>
      {posts.map((post) => (
        <article key={post.id}>
          <h2>{post.title}</h2>
          <button
            disabled={pending.field(post, "likes")}
            onClick={() =>
              actions.likePost({
                id: post.id,
                changes: { likes: post.likes + 1 },
              })
            }
          >
            {post.likes} likes
          </button>
        </article>
      ))}
    </main>
  ));

export const Route = postsRoute.build();
```

At this point the page contract is visible from top to bottom:

- `views(...)` says what data the page gets.
- `actions(...)` says what mutations the page exposes.
- `component(...)` receives typed data, route-scoped actions, pending state,
  submission history, and status.
- `hydrate: "route"` includes a confirmed DB snapshot in the loader payload.

## 9. Replace generic patch with a domain action

`post.patch` is useful, but `likePost` is a domain action. Define it once with
its optimistic behavior and affected field.

```ts
// src/db/index.ts
import { createStartDbFromSchema } from "@doeixd/tanstackstart-db";
import { queryCollection } from "@doeixd/tanstackstart-db/query-collection";
import { QueryClient } from "@tanstack/query-core";
import { postsApi } from "../api/posts";
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
    like: action<{ id: string }, void>({
      affects: ({ input }) => [q.post.byId(input.id).field("likes")],
      optimistic: ({ input, cache }) => {
        cache.post(input.id).increment("likes");
      },
      run: async ({ input, setTransaction }) => {
        const updated = await postsApi.like(input.id);
        if (!updated) throw new Error(`Post "${input.id}" was not found.`);
        const result = c.post.update(input.id, () => updated);
        setTransaction(result.transaction);
      },
    }),
  },
}));
```

Then expose the domain action from the route:

```tsx
const postsRoute = createDbFileRoute("/posts")
  .views(({ q }) => ({
    posts: q.post.all().as(postCard),
  }))
  .actions(({ a }) => ({
    likePost: a.post.like,
  }))
  .component(({ posts, actions, pending }) => (
    <main>
      {posts.map((post) => (
        <article key={post.id}>
          <h2>{post.title}</h2>
          <button
            disabled={pending.field(post, "likes")}
            onClick={() => actions.likePost({ id: post.id })}
          >
            {post.likes} likes
          </button>
        </article>
      ))}
    </main>
  ));
```

The component no longer knows that liking a post is implemented as a patch, an
API call, an optimistic update, or a field-level pending marker. It only knows
there is a `likePost` route action.

## 10. Test the same contract

Use the testing entrypoint to create an in-memory DB and seed rows without a
backend.

```ts
import { expect, test } from "vitest";
import { createMemoryStartDb, seedCollections } from "@doeixd/tanstackstart-db/testing";
import { schema } from "../src/db/schema";

test("likes a post", async () => {
  const db = createMemoryStartDb(schema);
  seedCollections(db, {
    post: [{ id: "post_1", title: "Hello", body: "Body", likes: 0 }],
  });

  await db.a.post.patch({
    id: "post_1",
    changes: { likes: 1 },
  });

  await expect(db.q.post.byId("post_1").execute()).resolves.toMatchObject({
    likes: 1,
  });
});
```

Route contracts can be tested with `renderDbRoute(...)` when you want to drive
the loader shape without mounting a full Router.

## What changed

The final route is not just shorter. More importantly, the important behavior
lives in reusable contracts:

- Schema owns the entity shape and key.
- Generated queries own query names and result types.
- View fragments let component contracts share field selections without
  duplicating them.
- Views own what a component is allowed to render.
- Actions own optimistic writes, persistence, pending markers, rollback, and
  submission history.
- Route fragments collect page data into one loader contract, with staged
  execution only when later specs depend on earlier results.
- Routes own page data, action aliases, hydration, and status.
- Tests can exercise the same schema-backed DB without duplicating route state.

Use the deeper guides when you need the next layer:

- [`views.md`](./views.md) for field masks and nested relationship views.
- [`relationships.md`](./relationships.md) for `one` / `many` relationships.
- [`query-keys.md`](./query-keys.md) for cache keys and action invalidation.
- [`action-aliases.md`](./action-aliases.md) for bound route actions.
- [`optimistic-conflict-offline.md`](./optimistic-conflict-offline.md) for
  rollback, conflicts, and offline behavior.
