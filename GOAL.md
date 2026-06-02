# `tanstackstart-db`

## Package structure

```txt
tanstackstart-db
  core schema/view/action/query helpers

tanstackstart-db/react
  createDbFileRouteFactory
  route hooks
  component helpers

tanstackstart-db/server
  preload/dehydrate/hydrate helpers
  server function helpers

tanstackstart-db/testing
  memory db
  fixtures
  render helpers
```

---

# 1. Schema-first API

This should be the highest-DX path.

```ts
// src/db/schema.ts
import { defineDbSchema, entity } from "tanstackstart-db/schema";
import { z } from "zod";

const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  avatarUrl: z.string().nullable(),
});

const postSchema = z.object({
  id: z.string(),
  authorId: z.string(),
  title: z.string(),
  body: z.string(),
  excerpt: z.string(),
  likes: z.number().default(0),
  viewerHasLiked: z.boolean().default(false),
  commentCount: z.number().default(0),
  relatedTo: z.array(z.string()).default([]),
  createdAt: z.string(),
});

const commentSchema = z.object({
  id: z.string(),
  postId: z.string(),
  authorId: z.string(),
  body: z.string(),
  pending: z.boolean().default(false),
  createdAt: z.string(),
});

export const appSchema = defineDbSchema({
  entities: {
    user: entity(userSchema, {
      key: "id",
    }),

    post: entity(postSchema, {
      key: "id",
      indexes: ["authorId", "createdAt"],

      relationships: ({ one, many }) => ({
        author: one("user", {
          local: "authorId",
          foreign: "id",
        }),

        comments: many("comment", {
          local: "id",
          foreign: "postId",
        }),
      }),
    }),

    comment: entity(commentSchema, {
      key: "id",
      indexes: ["postId", "authorId", "createdAt"],

      relationships: ({ one }) => ({
        post: one("post", {
          local: "postId",
          foreign: "id",
        }),

        author: one("user", {
          local: "authorId",
          foreign: "id",
        }),
      }),
    }),
  },
});
```

This should support any Standard Schema-compatible library, not only Zod. Standard Schema is a shared interface for TypeScript validation libraries, and TanStack DB already documents schema validation, transforms, defaults, and the distinction between input and output types. ([GitHub][3])

## Generated type helpers

```ts
type User = EntityOutput<typeof appSchema.entities.user>;
type NewUser = EntityInput<typeof appSchema.entities.user>;

type Post = EntityOutput<typeof appSchema.entities.post>;
type NewPost = EntityInput<typeof appSchema.entities.post>;

type Comment = EntityOutput<typeof appSchema.entities.comment>;
type NewComment = EntityInput<typeof appSchema.entities.comment>;
```

Important distinction:

```txt
EntityInput  = what callers may insert/update
EntityOutput = what collections/query results contain after validation/defaults/transforms
```

TanStack DB mutation docs note that when a schema is configured, mutation handlers receive transformed output data rather than raw input data. ([TanStack][4])

---

# 2. Create the DB from schema

```ts
// src/db/index.ts
import { createStartDbFromSchema } from "tanstackstart-db";
import { appSchema } from "./schema";
import { api } from "~/api";
import { queryClient } from "~/query-client";

export const db = createStartDbFromSchema(appSchema, {
  collections: ({ queryCollection }) => ({
    user: queryCollection("user", {
      queryKey: ["users"],
      queryFn: api.users.list,
      queryClient,

      onInsert: async ({ transaction }) =>
        api.users.create(transaction.mutations.map((mutation) => mutation.modified)),

      onUpdate: async ({ transaction }) =>
        api.users.update(
          transaction.mutations.map((mutation) => ({
            id: mutation.key,
            changes: mutation.changes,
          })),
        ),

      onDelete: async ({ transaction }) =>
        api.users.delete(transaction.mutations.map((mutation) => mutation.key)),
    }),

    post: queryCollection("post", {
      queryKey: ["posts"],
      queryFn: api.posts.list,
      queryClient,
      onInsert: async ({ transaction }) =>
        api.posts.create(transaction.mutations.map((mutation) => mutation.modified)),
      onUpdate: async ({ transaction }) =>
        api.posts.update(
          transaction.mutations.map((mutation) => ({
            id: mutation.key,
            changes: mutation.changes,
          })),
        ),
      onDelete: async ({ transaction }) =>
        api.posts.delete(transaction.mutations.map((mutation) => mutation.key)),
    }),

    comment: queryCollection("comment", {
      queryKey: ["comments"],
      queryFn: api.comments.list,
      queryClient,
      onInsert: async ({ transaction }) =>
        api.comments.create(transaction.mutations.map((mutation) => mutation.modified)),
      onUpdate: async ({ transaction }) =>
        api.comments.update(
          transaction.mutations.map((mutation) => ({
            id: mutation.key,
            changes: mutation.changes,
          })),
        ),
      onDelete: async ({ transaction }) =>
        api.comments.delete(transaction.mutations.map((mutation) => mutation.key)),
    }),
  }),
});
```

`queryCollection(...)` is ergonomic sugar over `createCollection(queryCollectionOptions(...))`.
It should pass each entity schema through to the underlying TanStack DB collection.

This generates:

```ts
db.collections.user;
db.collections.post;
db.collections.comment;

db.q.user.byId(id);
db.q.post.byId(id);
db.q.post.all();
db.q.post.byAuthor(authorId);
db.q.post.related(postId);
db.q.comment.byPost(postId);

db.a.user.create;
db.a.user.patch;
db.a.user.update;
db.a.user.delete;

db.a.post.create;
db.a.post.patch;
db.a.post.update;
db.a.post.delete;
```

Generated CRUD actions should wrap normal TanStack DB collection mutations, not invent a second mutation system. TanStack DB’s mutation model already handles optimistic local writes, persistence, and rollback/error states. ([TanStack][4])

Generated action calls should expose the underlying transaction and a convenient
persisted promise:

```ts
const submission = db.a.post.patch({
  id: postId,
  changes: { title: "Updated" },
});

submission.transaction;
await submission.persisted;
```

---

# 3. Manual DB API

Schema-first should be best, but manual mode must exist.

```ts
export const db = createStartDb({
  collections: {
    post: postCollection,
    comment: commentCollection,
    user: userCollection,
  },

  relationships: ({ one, many }) => ({
    post: {
      author: one("user", {
        local: "authorId",
        foreign: "id",
      }),
    },

    comment: {
      author: one("user", {
        local: "authorId",
        foreign: "id",
      }),
    },
  }),

  queries: ({ c, query }) => ({
    post: {
      byId: (id: string) =>
        query.one({
          key: ["post", id],
          query: (q) => q.from({ post: c.post }).where(({ post }) => eq(post.id, id)),
        }),
    },
  }),

  actions: ({ c, action }) => ({
    post: {
      like: action({
        input: (input: { postId: string }) => input,

        run: async ({ input }) => {
          c.post.update(input.postId, (post) => {
            post.likes++;
            post.viewerHasLiked = true;
          });
        },
      }),
    },
  }),
});
```

Manual mode matters for complex sync engines, custom collection types, local-only state, live query collections, and nonstandard persistence.

---

# 4. Views and masking

This is the most important Fate-inspired piece.

```ts
// src/db/views.ts
export const UserAvatarView = db.view("user", {
  id: true,
  name: true,
  avatarUrl: true,
});

export const PostCardView = db.view("post", {
  id: true,
  title: true,
  excerpt: true,
  likes: true,
  author: UserAvatarView,
});

export const PostPageView = db.view("post", {
  id: true,
  title: true,
  body: true,
  likes: true,
  viewerHasLiked: true,
  commentCount: true,
  createdAt: true,
  author: UserAvatarView,
});

export const CommentView = db.view("comment", {
  id: true,
  postId: true,
  body: true,
  pending: true,
  createdAt: true,
  author: UserAvatarView,
});
```

`db.view()` should:

```txt
validate selected fields
validate relationship names
infer masked result type
compile to TanStack DB select projections
return readonly component data
```

Example:

```ts
type PostCard = InferView<typeof PostCardView>;

post.title; // ok
post.likes; // ok
post.body; // type error
```

## View fragments

```ts
export const TimestampFields = db.viewFragment({
  createdAt: true,
  updatedAt: true,
});

export const PostAdminView = db.view("post", {
  id: true,
  title: true,
  body: true,
  ...TimestampFields,
});
```

## View helpers

```ts
maskView(PostCardView, post);
pickView(PostCardView, post);
withView(PostCardView);
satisfiesView(PostCardView, post);
```

Use cases:

```tsx
<PostCard post={pickView(PostCardView, post)} />
```

or:

```tsx
{
  posts.map(withView(PostCardView)).map((post) => <PostCard post={post} />);
}
```

---

# 5. Query API

The route/user-facing query API should feel generated and composable.

```ts
q.post.byId(id);
q.post.all();
q.post.byAuthor(authorId);
q.post.related(postId);
q.comment.byPost(postId);
```

Every query spec should support:

```ts
.as(View)
.select(selector)
.one()
.optional()
.many()
.list()
.infinite(options)
.live()
.static()
.defer()
.preloadOnly()
.required()
.field(name)
.key()
```

Example:

```ts
q.post.byId(params.postId).as(PostPageView).live().required();
```

List:

```ts
q.comment.byPost(params.postId).as(CommentView).list();
```

Deferred list:

```ts
q.post.related(params.postId).as(PostCardView).list().defer();
```

Projection without a named view:

```ts
q.post.byId(id).select((post) => ({
  id: post.id,
  title: post.title,
}));
```

Raw query escape hatch:

```ts
q.raw({
  key: ['custom'],
  query: (qb) =>
    qb
      .from({ post: db.collections.post })
      .where(...)
      .select(...),
})
```

---

# 6. Route factory

```ts
// src/db/route.ts
import { createDbFileRouteFactory } from "tanstackstart-db/react";
import { db } from "./index";

export const createDbFileRoute = createDbFileRouteFactory({
  db,

  getClient: ({ context }) => context.db ?? db,

  defaults: {
    ssr: true,
    live: true,
    suspense: true,
    hydrate: "route",
    componentProps: "flat",
    readonlyData: true,
    requireViews: false,
    actionPending: "field-aware",
  },
});
```

## Route API

```ts
createDbFileRoute(path)
  .validateSearch(...)
  .beforeLoad(...)
  .loaderDeps(...)
  .queries(...)
  .views(...)
  .actions(...)
  .options(...)
  .pendingComponent(...)
  .errorComponent(...)
  .notFoundComponent(...)
  .component(...)
```

Use `.queries()` for raw query results:

```tsx
export const Route = createDbFileRoute("/posts/$postId")
  .queries(({ params, q }) => ({
    post: q.post.byId(params.postId),
  }))
  .component(({ post }) => <PostPage post={post} />);
```

Use `.views()` for masked contracts:

```tsx
export const Route = createDbFileRoute("/posts/$postId")
  .views(({ params, q }) => ({
    post: q.post.byId(params.postId).as(PostPageView),
    comments: q.comment.byPost(params.postId).as(CommentView).list(),
  }))
  .component(({ post, comments }) => <PostPage post={post} comments={comments} />);
```

## Best route example

```tsx
export const Route = createDbFileRoute("/posts/$postId")
  .views(({ params, q }) => ({
    post: q.post.byId(params.postId).as(PostPageView),

    comments: q.comment.byPost(params.postId).as(CommentView).list(),

    related: q.post.related(params.postId).as(PostCardView).list().defer(),
  }))
  .actions(({ a }) => ({
    likePost: a.post.like,
    addComment: a.comment.add,
  }))
  .pendingComponent(() => <PostPageSkeleton />)
  .component(({ post, comments, related, actions, pending, status }) => (
    <PostPage
      post={post}
      comments={comments}
      related={related}
      refreshing={status.isRefetching}
      liking={pending.field(post, "likes")}
      sendingComment={pending.action("addComment")}
      onLike={() => actions.likePost({ postId: post.id })}
      onComment={(body) =>
        actions.addComment({
          postId: post.id,
          body,
        })
      }
    />
  ));
```

---

# 7. Route hooks

Every route should expose typed hooks:

```ts
Route.useData();
Route.useActions();
Route.usePending();
Route.useStatus();
Route.useSubmissions();
Route.useDb();
Route.useCollections();
Route.useQuery("post");
```

Example:

```tsx
function LikeButton() {
  const { post } = Route.useData();
  const { likePost } = Route.useActions();
  const pending = Route.usePending();

  return (
    <button disabled={pending.field(post, "likes")} onClick={() => likePost({ postId: post.id })}>
      {pending.field(post, "likes") ? "Liking…" : `Like · ${post.likes}`}
    </button>
  );
}
```

---

# 8. Route fragments

Reusable route data:

```ts
export const postPageFragment = createDbRouteFragment(({ params, q }) => ({
  post: q.post.byId(params.postId).as(PostPageView),

  comments: q.comment.byPost(params.postId).as(CommentView).list(),
}));
```

Use it:

```tsx
export const Route = createDbFileRoute("/posts/$postId")
  .views(postPageFragment)
  .component(({ post, comments }) => <PostPage post={post} comments={comments} />);
```

Compose:

```ts
export const editPostFragment = composeDbRouteFragments(postPageFragment, ({ data, q }) => ({
  permissions: q.postPermissions.forPost(data.post.id).as(PostPermissionsView),
}));
```

---

# 9. Component-level contracts

This should be optional but first-class.

## `db.component(View)`

```tsx
export const PostCard = db.component(PostCardView)(({ post }) => (
  <article>
    <h2>{post.title}</h2>
    <p>{post.likes} likes</p>
    <UserAvatar user={post.author} />
  </article>
));
```

`post` is exactly `InferView<typeof PostCardView>`.

## Component with actions

```tsx
export const LikeButton = db
  .component(PostLikeView)
  .actions(({ a }) => ({
    likePost: a.post.like,
  }))
  .render(({ post, actions, pending }) => (
    <button
      disabled={pending.field(post, "likes")}
      onClick={() => actions.likePost({ postId: post.id })}
    >
      {post.viewerHasLiked ? "Liked" : "Like"} · {post.likes}
    </button>
  ));
```

## Component with local query

For components that own their own data:

```tsx
export const UserAvatar = db
  .component()
  .views(({ props, q }) => ({
    user: q.user.byId(props.userId).as(UserAvatarView),
  }))
  .render(({ user }) => <img src={user.avatarUrl ?? fallbackAvatar} alt={user.name} />);
```

---

# 10. Actions

Actions should compose over TanStack DB mutations/transactions.

## Generated CRUD actions

```ts
a.post.create(input);
a.post.update({ id, value });
a.post.patch({ id, changes });
a.post.delete({ id });
```

## Custom actions

```ts
export const db = createStartDbFromSchema(appSchema, {
  // ...
}).extendActions(({ a, action }) => ({
  post: {
    like: action({
      input: (input: { postId: string }) => input,

      affects: ({ input, q }) => [
        q.post.byId(input.postId).field("likes"),
        q.post.byId(input.postId).field("viewerHasLiked"),
      ],

      optimistic: ({ input, cache }) => {
        cache.post(input.postId).patch({
          likes: (n) => n + 1,
          viewerHasLiked: true,
        });
      },

      run: async ({ input }) => {
        await a.post.patch({
          id: input.postId,
          changes: {
            likes: increment(1),
            viewerHasLiked: true,
          },
        });
      },
    }),
  },

  comment: {
    add: action({
      input: (input: { postId: string; body: string }) => input,

      returns: CommentView,

      affects: ({ input, q }) => [
        q.comment.byPost(input.postId),
        q.post.byId(input.postId).field("commentCount"),
      ],

      optimistic: ({ input, cache }) => {
        cache.comment.insert({
          id: cache.optimisticId("comment"),
          postId: input.postId,
          body: input.body,
          pending: true,
          createdAt: cache.now(),
        });

        cache.post(input.postId).patch({
          commentCount: (n) => n + 1,
        });
      },

      run: async ({ input }) => {
        return a.comment.create({
          postId: input.postId,
          body: input.body,
        });
      },
    }),
  },
}));
```

Action definitions own behavior that is true wherever the action is used:

```txt
input validation
run/persistence behavior
optimistic patch
affected queries/fields
returned view shape
invalidations
authorization
server function mapping
error handling
```

The route normally only exposes actions and optionally aliases them:

```ts
.actions(({ a }) => ({
  likePost: a.post.like,
  addComment: a.comment.add,
}))

.actions(({ a }) => ({
  publish: a.post.publish,
  remove: a.post.delete,
}))
```

An action such as `a.post.like` should already know its input, optimistic mutations, pending fields, affected views/lists, return shape, and rollback behavior.

## Action chain API

Every action should support:

```ts
.input(schemaOrValidator)
.affects(factory)
.optimistic(handler)
.returns(View)
.invalidate(factory)
.form(mapper)
.server(serverFn)
.transaction(handler)
.authorize(handler)
.onSuccess(handler)
.onError(handler)
.onSettled(handler)
```

These methods configure reusable action definitions. Route-level overrides should exist for rare UI-specific behavior, but should not be the normal path.

## Route-bound actions

Routes may partially supply action input from route data:

```ts
.actions(({ a, data }) => ({
  likePost: a.post.like.with({
    postId: data.post.id,
  }),

  addComment: a.comment.add.with({
    postId: data.post.id,
  }),
}))
```

Then components can call:

```ts
actions.likePost();
actions.addComment({ body });
```

## Local action overrides

Route-level optimism is an extension point for UI-specific behavior. For example, a post page may insert a visible optimistic comment row while a notification popover does not need one:

```ts
.actions(({ a, data, q }) => ({
  addComment: a.comment.add
    .with({ postId: data.post.id })
    .extend({
      optimisticLocal: ({ input, cache }) => {
        cache.comment.insertIntoList(
          q.comment.byPost(data.post.id),
          {
            id: cache.optimisticId('comment'),
            body: input.body,
            pending: true,
          },
        );
      },
    }),
}))
```

The package should support three levels:

```ts
// 1. Normal: action already knows everything
.actions(({ a }) => ({
  likePost: a.post.like,
}))

// 2. Route-bound: action input is partially supplied from route data
.actions(({ a, data }) => ({
  addComment: a.comment.add.with({ postId: data.post.id }),
}))

// 3. Local override: rare UI-specific optimistic/invalidation behavior
.actions(({ a }) => ({
  addComment: a.comment.add.extend({
    optimisticLocal: ...
  }),
}))
```

## Action pending

```ts
pending.any();
pending.action("addComment");
pending.action("likePost", { postId });
pending.field(post, "likes");
pending.query("comments");
```

## Submissions

```ts
submissions.latest("addComment");
submissions.all("addComment");
submissions.forInput("likePost", { postId });
```

---

# 11. Optimistic cache API

Use a high-level cache wrapper over TanStack DB collection mutations.

```ts
cache.post(id).patch({
  likes: (n) => n + 1,
  viewerHasLiked: true,
});

cache.comment.insert({
  id: cache.optimisticId('comment'),
  postId,
  body,
  pending: true,
  createdAt: cache.now(),
});

cache.comment(id).delete();

cache.transaction((tx) => {
  tx.post(postId).patch({ commentCount: (n) => n + 1 });
  tx.comment.insert(...);
});
```

This wrapper should still delegate to TanStack DB collection operations or transactions.

---

# 12. Status API

Route components should receive:

```ts
status.isLoading;
status.isHydrating;
status.isRefetching;
status.isStale;
status.error;
status.deferred.related.isLoading;
status.deferred.related.error;
```

Example:

```tsx
.component(({ post, related, status }) => (
  <PostPage
    post={post}
    related={related}
    refreshing={status.isRefetching}
    relatedLoading={status.deferred.related.isLoading}
  />
))
```

TanStack Router supports deferred data for cases where slower data should load in the background while critical data renders first. ([TanStack][5])

---

# 13. SSR, preload, hydrate

## Factory defaults

```ts
createDbFileRouteFactory({
  db,

  defaults: {
    ssr: true,
    hydrate: "route",
    live: true,
    suspense: true,
  },
});
```

## Server helpers

```ts
preloadDbRoute({
  db,
  queries: ({ q }) => ({
    post: q.post.byId(postId).as(PostPageView),
  }),
});

const snapshot = await dehydrateDb(db, {
  adapters: ["queryCollection"],
});

await hydrateDb(db, snapshot);
```

Hydration is adapter-specific. These helpers should delegate to registered
collection adapters rather than serialize arbitrary collection internals.
Pending optimistic transactions must not be serialized as confirmed state.

## Route behavior

```txt
server:
  build query/view specs
  preload critical specs
  serialize DB snapshot
  stream/defer noncritical specs where possible

client:
  hydrate DB snapshot
  attach live queries
  subscribe deferred specs
  release route retainers on unmount
```

## Hydration strategies

```ts
hydrate: "route"; // hydrate per route
hydrate: "root"; // one app-level DB snapshot
hydrate: "manual"; // user controls hydration
```

---

# 14. Testing API

```ts
import {
  createMemoryStartDb,
  renderDbRoute,
  renderDbComponent,
  fixture,
  listFixture,
  mockDbAction,
} from "tanstackstart-db/testing";
```

## View fixtures

```ts
const post = fixture(PostPageView, {
  id: "post_1",
  title: "Hello",
  body: "World",
  likes: 1,
});
```

## Route test

```tsx
it("renders post page", async () => {
  const screen = await renderDbRoute(Route, {
    params: { postId: "post_1" },

    data: {
      post: fixture(PostPageView),
      comments: listFixture(CommentView, 3),
      related: listFixture(PostCardView, 2),
    },
  });

  expect(screen.getByRole("heading")).toBeInTheDocument();
});
```

---

# 15. Full export surface

## `tanstackstart-db`

```ts
export {
  createStartDb,
  createStartDbFromSchema,
  defineView,
  defineViewFragment,
  defineProjection,
  maskView,
  pickView,
  withView,
  satisfiesView,
  preloadDb,
  dehydrateDb,
  hydrateDb,
  isDbRouteError,
  isDbNotFound,
  isDbAuthError,
  isDbPreloadError,
  isDbHydrationError,
  isDbActionError,
};

export type {
  StartDb,
  DbCollections,
  DbQueries,
  DbActions,
  DbView,
  DbViewFragment,
  InferView,
  InferViewEntity,
  InferViewInput,
  DbList,
  DbInfiniteList,
  InferDbQueryResult,
  InferDbActionInput,
  InferDbActionResult,
};
```

## `tanstackstart-db/schema`

```ts
export { defineDbSchema, entity, field, ref, one, many, index, unique };

export type {
  EntityInput,
  EntityOutput,
  EntityKey,
  EntityName,
  InferEntity,
  InferEntityInput,
  InferEntityOutput,
  DbSchema,
};
```

## `tanstackstart-db/react`

```ts
export {
  createDbFileRouteFactory,
  createDbRouteFragment,
  composeDbRouteFragments,
  createDbComponent,
  createDbActionGroup,
  useDb,
  useDbCollections,
  useDbAction,
  useDbPending,
  useDbStatus,
  useDbSubmissions,
};

export type {
  InferDbRouteData,
  InferDbRouteActions,
  InferDbRouteComponentProps,
  DbRouteDefaults,
  DbRoutePlugin,
};
```

## `tanstackstart-db/server`

```ts
export {
  preloadDbRoute,
  dehydrateDbRoute,
  hydrateDbRoute,
  createDbServerFn,
  createDbServerHandler,
};
```

## `tanstackstart-db/testing`

```ts
export {
  createMemoryStartDb,
  seedCollections,
  renderDbRoute,
  renderDbComponent,
  fixture,
  listFixture,
  mockDbAction,
};
```

---

# 16. The final “best DX” example

```tsx
export const Route = createDbFileRoute("/posts/$postId")
  .views(({ params, q }) => ({
    post: q.post.byId(params.postId).as(PostPageView),

    comments: q.comment.byPost(params.postId).as(CommentView).list(),

    related: q.post.related(params.postId).as(PostCardView).list().defer(),
  }))
  .actions(({ a, data }) => ({
    likePost: a.post.like.with({
      postId: data.post.id,
    }),

    addComment: a.comment.add.with({
      postId: data.post.id,
    }),
  }))
  .pendingComponent(() => <PostPageSkeleton />)
  .component(({ post, comments, related, actions, pending, status }) => (
    <PostPage
      post={post}
      comments={comments}
      related={related}
      refreshing={status.isRefetching}
      liking={pending.action("likePost")}
      sendingComment={pending.action("addComment")}
      onLike={() => actions.likePost()}
      onComment={(body) => actions.addComment({ body })}
    />
  ));
```

That is the ideal shape.

```txt
Schema defines structure.
Collections define sync/persistence.
Views define component/page contracts.
Queries define reusable data access.
Actions define mutations and optimistic behavior.
Routes expose, alias, and optionally bind actions into typed UI contracts.
TanStack DB remains the only data engine.
```

The main principles:

**Add contracts and ergonomics, not another runtime.**

**Routes should not usually contain `.affects(...)` or `.optimistic(...)`. Actions are rich objects defined once and reused everywhere.**

---

# 17. Implementation-grounded architecture decisions

The API above is the desired DX. The implementation must preserve the actual
TanStack DB, TanStack Router, and TanStack Start runtime contracts below.

## Package integration layers

Use the official packages at their actual ownership boundaries:

```txt
@tanstack/db
  createCollection
  createLiveQueryCollection
  queryOnce
  createTransaction
  createOptimisticAction
  query builder expressions

@tanstack/react-db
  useLiveQuery
  useLiveSuspenseQuery
  useLiveInfiniteQuery

@tanstack/query-db-collection
  queryCollectionOptions
  TanStack Query-backed REST/API synchronization

@tanstack/query-core
  QueryClient used by queryCollectionOptions

@tanstack/react-router
  createFileRoute
  route loaders, pending/error boundaries, deferred promises

@tanstack/react-start
  createServerFn
  server middleware, request context, serialization boundary
```

The package should use peer dependencies and optional adapters where possible.
The framework-neutral core must not require React, Router, Start, or Query
Collection unless the matching entrypoint is imported.

## Collection creation must wrap official collection options

`queryCollection(...)` is package sugar. Its implementation should create a
normal TanStack DB collection with `queryCollectionOptions(...)`:

```ts
import { createCollection } from "@tanstack/db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";

const postCollection = createCollection(
  queryCollectionOptions({
    id: "post",
    queryKey: ["posts"],
    queryFn: api.posts.list,
    queryClient,
    getKey: (post) => post.id,
    schema: postSchema,

    onInsert: async ({ transaction }) => {
      await api.posts.create(transaction.mutations.map((mutation) => mutation.modified));
    },

    onUpdate: async ({ transaction }) => {
      await api.posts.update(
        transaction.mutations.map((mutation) => ({
          id: mutation.key,
          changes: mutation.changes,
        })),
      );
    },

    onDelete: async ({ transaction }) => {
      await api.posts.delete(transaction.mutations.map((mutation) => mutation.key));
    },
  }),
);
```

Any convenience `mutations: { insert, update, delete }` overload must compile to
these official `onInsert`, `onUpdate`, and `onDelete` transaction handlers.

Schema-first creation should pass the entity's Standard Schema into the
underlying collection. TanStack DB should remain responsible for validation,
defaults, transforms, optimistic state, persistence state, and rollback.

Support other official collection configurations without forcing them through
Query Collection:

```txt
localOnlyCollectionOptions
localStorageCollectionOptions
Electric collection options
PowerSync collection options
custom sync collections
pre-created Collection instances
```

## Actions compile to TanStack DB transactions

Do not implement a parallel rollback engine.

Generated CRUD actions should call normal collection mutations:

```ts
const tx = db.collections.post.update(postId, (draft) => {
  draft.likes++;
  draft.viewerHasLiked = true;
});

await tx.isPersisted.promise;
```

Custom optimistic actions should compile to `createOptimisticAction(...)` or
`createTransaction(...)`:

```ts
import { createOptimisticAction } from "@tanstack/db";

const likePost = createOptimisticAction<{ postId: string }>({
  onMutate: ({ postId }) => {
    db.collections.post.update(postId, (draft) => {
      draft.likes++;
      draft.viewerHasLiked = true;
    });
  },

  mutationFn: async ({ postId }) => {
    await api.posts.like(postId);
    await db.collections.post.utils.refetch();
  },
});
```

Important TanStack DB constraints:

```txt
onMutate must be synchronous
collection operations inside transaction.mutate(...) must be synchronous
async persistence belongs in mutationFn
the optimistic layer is discarded when mutationFn resolves
mutationFn must wait until server writes have synced back
rollback and conflicting-transaction rollback are TanStack DB responsibilities
```

The high-level action API may expose a promise-returning convenience call, but
the underlying transaction must remain observable:

```ts
const submission = actions.likePost();

submission.transaction;
await submission.persisted;
```

Define the final action result contract explicitly:

```txt
transaction   underlying TanStack DB Transaction
persisted     transaction.isPersisted.promise
result        optional server-function result tracked by the wrapper
status        pending | persisting | completed | failed
```

## Query specs compile to the TanStack DB query builder

Generated query helpers should compile to query builder functions:

```ts
q.post.byId(id)
// compiles to:
(q) =>
  q
    .from({ post: db.collections.post })
    .where(({ post }) => eq(post.id, id))
    .findOne()

q.comment.byPost(postId)
// compiles to:
(q) =>
  q
    .from({ comment: db.collections.comment })
    .where(({ comment }) => eq(comment.postId, postId))
    .select(({ comment }) => comment)
```

Execute those specs with official primitives:

```txt
queryOnce(query)                 imperative/server one-shot execution
createLiveQueryCollection(query) retained live collection execution
useLiveQuery(query)              React live subscription
useLiveSuspenseQuery(query)      React suspense subscription
```

For `syncMode: "on-demand"` collections, preload the live query collection for
the specific query. Calling `.preload()` on the base collection is a no-op.

`field(name)` is metadata for pending/invalidation tracking. It must not compile
to a top-level scalar query because TanStack DB live queries and `queryOnce()`
do not support top-level scalar `select()` results.

## Route integration wraps Router rather than replacing it

`createDbFileRoute(...)` should compile to the real Router shape:

```tsx
export const Route = createFileRoute("/posts/$postId")({
  loader: async ({ params, context }) => {
    // preload critical query specs
  },
  pendingComponent: PostPageSkeleton,
  errorComponent: PostPageError,
  component: PostPageRoute,
});
```

The fluent API is acceptable as a compile-time builder, but the final result
must remain a normal file route so Router code generation, route context,
preloading, pending handling, and error boundaries continue to work.

For external data libraries, deferred route data should use unresolved loader
promises and retained cache/live-query handles. `.defer()` is package sugar for
that behavior, not a TanStack DB primitive.

## React integration wraps official hooks

Route and component hooks should retain and dispose official live queries:

```ts
useLiveQuery(queryFn, deps);
useLiveSuspenseQuery(queryFn, deps);
useLiveInfiniteQuery(config);
```

Status values should be derived from the official hook/collection status where
possible:

```txt
isLoading
isReady
isError
status
collection
```

Package-specific values such as `isHydrating`, `isRefetching`, and deferred
child status need documented derivation rules per adapter.

## Server functions wrap TanStack Start server functions

`createDbServerFn(...)` should compose `createServerFn(...)`, not create an
independent RPC mechanism:

```ts
import { createServerFn } from "@tanstack/react-start";

export const likePost = createServerFn({ method: "POST" })
  .inputValidator(LikePostInput)
  .handler(async ({ data }) => {
    await api.posts.like(data.postId);
  });
```

Server function inputs and outputs must remain serializable. Authorization must
be enforced in server middleware or the server-function handler; route guards
alone do not protect the RPC endpoint.

## Hydration is adapter-specific

Do not assume that serializing every collection's internal state is a universal
hydration strategy.

The package should define hydration adapters:

```txt
Query Collection:
  dehydrate/hydrate TanStack Query state and reattach live queries

local-only collections:
  opt-in serialization of confirmed state only

sync engines such as Electric or PowerSync:
  reconnect/re-subscribe using adapter-specific semantics

custom collections:
  explicit adapter hooks or manual hydration
```

Never serialize pending optimistic transactions as confirmed server state.

## Pending and submissions derive from transactions

`pending` and `submissions` should observe TanStack DB transactions and action
metadata:

```txt
pending.action(alias, input?)
  action submissions whose transactions are pending or persisting

pending.field(entity, field)
  pending submissions whose affects metadata includes that entity field

pending.query(name)
  retained query refresh/loadSubset state for that query

submissions.latest(alias)
submissions.all(alias)
submissions.forInput(alias, input)
  wrapper records containing the underlying transaction and server result
```

The route alias matters. If `a.post.like` is exposed as `likePost`, pending and
submission lookups should use `"likePost"` inside that route.

## Revised implementation order

```txt
1. Official collection adapters and schema pass-through
2. Query specs compiling to TanStack DB query builder functions
3. Action wrappers compiling to TanStack DB transactions
4. Transaction-derived pending/submission state
5. React live-query hook wrappers
6. Router createFileRoute compiler and loader preloading
7. Start createServerFn wrappers and middleware integration
8. Adapter-specific SSR hydration
9. Deferred data and infinite-query integration
10. Testing helpers around the real adapters
```

[6]: https://tanstack.com/db/latest/docs/collections/query-collection "Query Collection | TanStack DB Docs"
[7]: https://tanstack.com/db/latest/docs/reference/functions/createOptimisticAction "createOptimisticAction | TanStack DB Docs"
[8]: https://tanstack.com/db/latest/docs/reference/functions/createLiveQueryCollection "createLiveQueryCollection | TanStack DB Docs"
[9]: https://tanstack.com/db/latest/docs/framework/react/reference/functions/useLiveQuery "useLiveQuery | TanStack DB React Docs"
[10]: https://tanstack.com/router/latest/docs/api/router/createFileRouteFunction "createFileRoute function | TanStack Router Docs"
[11]: https://tanstack.com/start/latest/docs/framework/react/guide/server-functions "Server Functions | TanStack Start React Docs"
[1]: https://tanstack.com/db/latest?utm_source=chatgpt.com "TanStack DB"
[2]: https://tanstack.com/router/latest/docs/guide/external-data-loading?utm_source=chatgpt.com "External Data Loading | TanStack Router Docs"
[3]: https://github.com/standard-schema/standard-schema?utm_source=chatgpt.com "standard-schema/standard-schema: A standard interface ..."
[4]: https://tanstack.com/db/latest/docs/guides/mutations?utm_source=chatgpt.com "Mutations | TanStack DB Docs"
[5]: https://tanstack.com/router/v1/docs/guide/deferred-data-loading?utm_source=chatgpt.com "Deferred Data Loading | TanStack Router Docs"
