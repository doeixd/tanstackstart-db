import { expect, test } from "vite-plus/test";
import { act, createElement, Suspense, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createCollection, eq, localOnlyCollectionOptions } from "@tanstack/db";
import { QueryClient } from "@tanstack/query-core";
import {
  MemoryCollection,
  createActionTracker,
  createInfiniteQuery,
  createStartDbFromSchema,
  DbConflictError,
  DbOfflineError,
  dehydrateDb,
  freezeView,
  hydrateDb,
  isDbActionSubmission,
  isDbConflictError,
  isDbHydrationError,
  isDbInfiniteQuerySpec,
  isDbNotFound,
  isDbOfflineError,
  isDbPreloadError,
  nativeCollection,
  pickView,
  preloadDb,
  queryFactory,
} from "../src/index.ts";
import {
  DbProvider,
  type DbDeferredValue,
  composeDbRouteFragments,
  createDbComponent,
  createDbFileRouteFactory,
  createDbRouteFragment,
  useDb,
  useDbCollections,
  useDbLiveInfiniteQuery,
  useDbLiveInfiniteSuspenseQuery,
  useDbLiveQuery,
  useDbLiveQueryState,
  useDbLiveSuspenseQuery,
  useDbPending,
  useDbStatus,
  useDbSubmissions,
} from "../src/react.ts";
import { defineDbSchema, entity, many, passthrough } from "../src/schema.ts";
import { queryCollection as queryDbCollection } from "../src/query-collection.ts";
import { syncCollection } from "../src/sync-collection.ts";
import {
  createMemoryStartDb,
  fixture,
  flushMicrotasks,
  listFixture,
  mockDbAction,
  renderDbComponent,
  seedCollections,
  waitFor,
} from "../src/testing.ts";

/// <reference lib="dom" />

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const passthroughSchema = <Value>() => ({
  "~standard": {
    version: 1 as const,
    vendor: "test",
    validate: (value: unknown) => ({ value: value as Value }),
    types: undefined as unknown as { input: Value; output: Value },
  },
});

const appSchema = defineDbSchema({
  entities: {
    post: entity(
      passthroughSchema<{
        id: string;
        title: string;
        likes: number;
        secret: string;
      }>(),
      { key: "id", indexes: ["title"] },
    ),
  },
});

test("creates schema-generated CRUD actions and queries", async () => {
  const db = createStartDbFromSchema(appSchema);

  await db.a.post.create({ id: "post_1", title: "Hello", likes: 0, secret: "x" });
  expect(await db.q.post.byId("post_1").execute()).toMatchObject({ title: "Hello" });

  await db.a.post.patch({ id: "post_1", changes: { likes: 1 } });
  expect((await db.q.post.byId("post_1").execute())?.likes).toBe(1);
});

test("returns observable action submissions with native CRUD transactions", async () => {
  const db = createStartDbFromSchema(appSchema);
  const submission = db.a.post.create({ id: "post_1", title: "Hello", likes: 0, secret: "x" });

  expect(isDbActionSubmission(submission)).toBe(true);
  expect(submission.status).toBe("pending");
  expect(db.submissions.latest("post.create")).toBe(submission);

  await submission.persisted;

  expect(submission.transaction).toBeDefined();
  expect(submission.transaction?.state).toBe("completed");
  expect(submission.status).toBe("completed");
  expect(await submission).toMatchObject({ id: "post_1", title: "Hello" });
});

test("masks entities with views", () => {
  const db = createStartDbFromSchema(appSchema);
  const postCard = db.view("post", { id: true, title: true });

  expect(pickView(postCard, { id: "post_1", title: "Hello", likes: 0, secret: "x" })).toEqual({
    id: "post_1",
    title: "Hello",
  });
});

test("rolls optimistic writes back when custom action fails", async () => {
  const base = createStartDbFromSchema(appSchema);
  await base.a.post.create({ id: "post_1", title: "Hello", likes: 0, secret: "x" });
  const db = base.extendActions(({ action }) => ({
    post: {
      like: action<{ postId: string }, void>({
        optimistic: ({ input, cache }) => {
          cache.post(input.postId).patch({
            likes: (likes: unknown) => Number(likes) + 1,
          });
        },
        run: () => {
          throw new Error("nope");
        },
      }),
    },
  }));

  await expect(db.a.post.like({ postId: "post_1" })).rejects.toThrow("Action failed");
  expect((await db.q.post.byId("post_1").execute())?.likes).toBe(0);
});

test("exposes native transactions for reusable custom optimistic actions", async () => {
  const base = createStartDbFromSchema(appSchema);
  await base.a.post.create({ id: "post_1", title: "Hello", likes: 0, secret: "x" });
  let finish = () => {};
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const db = base.extendActions(({ action }) => ({
    post: {
      like: action<{ postId: string }, void>({
        optimistic: ({ input, cache }) => {
          cache.post(input.postId).patch({
            likes: (likes: unknown) => Number(likes) + 1,
          });
        },
        run: () => waiting,
      }),
    },
  }));

  const submission = db.a.post.like({ postId: "post_1" });
  await Promise.resolve();
  await Promise.resolve();

  expect(submission.transaction).toBeDefined();
  expect(submission.transaction?.state).toBe("persisting");
  expect((await db.q.post.byId("post_1").execute())?.likes).toBe(1);

  finish();
  await submission.persisted;

  expect(submission.transaction?.state).toBe("completed");
  expect((await db.q.post.byId("post_1").execute())?.likes).toBe(1);
});

test("hydrates snapshots", async () => {
  const source = createStartDbFromSchema(appSchema);
  await source.a.post.create({ id: "post_1", title: "Hello", likes: 0, secret: "x" });
  const target = createStartDbFromSchema(appSchema);

  hydrateDb(target, dehydrateDb(source));

  expect(await target.q.post.byId("post_1").execute()).toMatchObject({ id: "post_1" });
});

test("dehydrates confirmed state without pending optimistic overlays", async () => {
  const base = createStartDbFromSchema(appSchema);
  await base.a.post.create({ id: "post_1", title: "Hello", likes: 0, secret: "x" });
  let finish = () => {};
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const db = base.extendActions(({ action }) => ({
    post: {
      like: action<{ postId: string }, void>({
        optimistic: ({ input, cache }) => {
          cache.post(input.postId).patch({
            likes: (likes: unknown) => Number(likes) + 1,
          });
        },
        run: () => waiting,
      }),
    },
  }));

  const submission = db.a.post.like({ postId: "post_1" });
  await Promise.resolve();
  await Promise.resolve();

  expect((await db.q.post.byId("post_1").execute())?.likes).toBe(1);
  expect(dehydrateDb(db).collections.post?.[0]?.likes).toBe(0);

  finish();
  await submission.persisted;
  expect(dehydrateDb(db).collections.post?.[0]?.likes).toBe(1);
});

test("dehydrateDb snapshot: 'include-pending-for-debug' preserves in-flight optimistic overlays", async () => {
  const base = createStartDbFromSchema(appSchema);
  await base.a.post.create({ id: "post_1", title: "Hello", likes: 0, secret: "x" });
  let finish = () => {};
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const db = base.extendActions(({ action }) => ({
    post: {
      like: action<{ postId: string }, void>({
        optimistic: ({ input, cache }) => {
          cache.post(input.postId).patch({
            likes: (likes: unknown) => Number(likes) + 1,
          });
        },
        run: () => waiting,
      }),
    },
  }));

  const submission = db.a.post.like({ postId: "post_1" });
  await Promise.resolve();
  await Promise.resolve();

  // While the action is parked, the optimistic overlay is visible to
  // the live query but the default (confirmed-only) snapshot still
  // excludes it.
  expect((await db.q.post.byId("post_1").execute())?.likes).toBe(1);
  expect(dehydrateDb(db).collections.post?.[0]?.likes).toBe(0);

  // `include-pending-for-debug` keeps the in-flight overlay in the
  // snapshot so SSR or localStorage debugging can see what the user
  // sees before the action commits.
  expect(
    dehydrateDb(db, { snapshot: "include-pending-for-debug" }).collections.post?.[0]?.likes,
  ).toBe(1);

  // Release the action; both modes now agree.
  finish();
  await submission.persisted;
  expect(dehydrateDb(db).collections.post?.[0]?.likes).toBe(1);
  expect(
    dehydrateDb(db, { snapshot: "include-pending-for-debug" }).collections.post?.[0]?.likes,
  ).toBe(1);
});

test("route builder forwards snapshot: 'include-pending-for-debug' into the SSR payload", async () => {
  const base = createStartDbFromSchema(appSchema);
  await base.a.post.create({ id: "post_1", title: "Hello", likes: 0, secret: "x" });
  let finish = () => {};
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const db = base.extendActions(({ action }) => ({
    post: {
      like: action<{ postId: string }, void>({
        optimistic: ({ input, cache }) => {
          cache.post(input.postId).patch({
            likes: (likes: unknown) => Number(likes) + 1,
          });
        },
        run: () => waiting,
      }),
    },
  }));

  const createDbFileRoute = createDbFileRouteFactory({
    db,
    defaults: { hydrate: "route", snapshot: "include-pending-for-debug" },
  });
  const route = createDbFileRoute("/posts/$postId")
    .queries(({ params, q }) => ({
      post: q.post.byId(params.postId),
    }))
    .build();

  const submission = db.a.post.like({ postId: "post_1" });
  await Promise.resolve();
  await Promise.resolve();

  // Drive the route loader directly to capture the SSR payload.
  // Since the loader is async, we wrap in a small async helper.
  const loadPromise = (async () => {
    const result = await (
      route as unknown as { options: { loader: (opts: unknown) => Promise<unknown> } }
    ).options.loader({ params: { postId: "post_1" }, context: undefined });
    return result as {
      data: { post: unknown };
      snapshot: { collections: { post?: Array<{ likes: number }> } };
    };
  })();
  const payload = await loadPromise;
  expect(payload.data.post).toMatchObject({ id: "post_1" });
  expect(payload.snapshot.collections.post?.[0]?.likes).toBe(1);

  finish();
  await submission.persisted;
});

test("validates and persists generated CRUD actions", async () => {
  const inserted: Array<Record<string, unknown>> = [];
  const db = createStartDbFromSchema(appSchema, {
    collections: ({ queryCollection }) => ({
      post: queryCollection("post", {
        mutations: {
          insert: (value) => inserted.push(value),
        },
      }),
    }),
  });

  await db.a.post.create({ id: "post_1", title: "Hello", likes: 0, secret: "x" });

  expect(inserted).toEqual([{ id: "post_1", title: "Hello", likes: 0, secret: "x" }]);
});

test("rejects invalid schema input", async () => {
  const schema = defineDbSchema({
    entities: {
      post: entity(
        {
          "~standard": {
            version: 1 as const,
            vendor: "test",
            validate: () => ({ issues: [{ message: "invalid post" }] }),
            types: undefined as unknown as {
              input: { id: string };
              output: { id: string };
            },
          },
        },
        { key: "id" },
      ),
    },
  });
  const db = createStartDbFromSchema(schema);

  await expect(db.a.post.create({ id: "post_1" })).rejects.toThrow("Action failed");
  expect(db.collections.post.values()).toEqual([]);
});

test("passes entity schemas through to generated TanStack collections", async () => {
  const schema = defineDbSchema({
    entities: {
      post: entity(
        {
          "~standard": {
            version: 1 as const,
            vendor: "test",
            validate: (value: unknown) => {
              const post = value as { id: string; title: string; likes?: number };
              return { value: { ...post, likes: post.likes ?? 0 } };
            },
            types: undefined as unknown as {
              input: { id: string; title: string; likes?: number };
              output: { id: string; title: string; likes: number };
            },
          },
        },
        { key: "id" },
      ),
    },
  });
  const db = createStartDbFromSchema(schema);

  const transaction = db.collections.post.engine!.insert({ id: "post_1", title: "Hello" } as never);
  await transaction.isPersisted.promise;

  expect(db.collections.post.get("post_1")).toEqual({ id: "post_1", title: "Hello", likes: 0 });
});

test("evaluates reusable action metadata", async () => {
  const base = createStartDbFromSchema(appSchema);
  const events: string[] = [];
  const db = base.extendActions(({ action }) => ({
    post: {
      inspect: action<{ postId: string }, void>({
        affects: ({ input }) => [`post:${input.postId}`],
        invalidate: ({ input }) => events.push(`invalidate:${input.postId}`),
        run: ({ input }) => {
          events.push(`run:${input.postId}`);
        },
      }),
    },
  }));

  await db.a.post.inspect({ postId: "post_1" });

  expect(events).toEqual(["run:post_1", "invalidate:post_1"]);
  expect(db.submissions.latest("post.inspect")?.affected).toEqual(["post:post_1"]);
  expect(db.a.post.create).toBeTypeOf("function");
});

test("generates concise index and relationship query helpers", async () => {
  const schema = defineDbSchema({
    entities: {
      post: entity(passthroughSchema<{ id: string; authorId: string; title: string }>(), {
        key: "id",
        indexes: ["authorId"],
        relationships: () => ({
          comments: many("comment", { local: "id", foreign: "postId" }),
        }),
      }),
      comment: entity(passthroughSchema<{ id: string; postId: string; body: string }>(), {
        key: "id",
        indexes: ["postId"],
      }),
    },
  });
  const db = createStartDbFromSchema(schema);
  await db.a.post.create({ id: "post_1", authorId: "user_1", title: "Hello" });
  await db.a.comment.create({ id: "comment_1", postId: "post_1", body: "First" });

  expect(await db.q.comment.byPost("post_1").execute()).toHaveLength(1);
  expect(await db.q.post.comments("post_1").execute()).toHaveLength(1);
});

test("uses the declared entity key for generated native lookups and relationships", async () => {
  const schema = defineDbSchema({
    entities: {
      team: entity(
        passthroughSchema<{
          slug: string;
          name: string;
        }>(),
        { key: "slug" },
      ),
      member: entity(
        passthroughSchema<{
          slug: string;
          teamSlug: string;
          name: string;
        }>(),
        {
          key: "slug",
          relationships: (api) => ({
            team: api.one("team", { local: "teamSlug", foreign: "slug" }),
          }),
        },
      ),
    },
  });
  const db = createStartDbFromSchema(schema);
  await db.a.team.create({ slug: "core", name: "Core" });
  await db.a.member.create({ slug: "ada", teamSlug: "core", name: "Ada" });

  expect(await db.q.member.byId("ada").execute()).toMatchObject({ name: "Ada" });
  expect(await db.q.member.team("ada").execute()).toMatchObject({ name: "Core" });
});

test("uses distinct native join aliases for multiple relationships to the same entity", async () => {
  const schema = defineDbSchema({
    entities: {
      user: entity(passthroughSchema<{ id: string; name: string }>(), { key: "id" }),
      post: entity(
        passthroughSchema<{ id: string; authorId: string; editorId: string; title: string }>(),
        {
          key: "id",
          relationships: (api) => ({
            author: api.one("user", { local: "authorId", foreign: "id" }),
            editor: api.one("user", { local: "editorId", foreign: "id" }),
          }),
        },
      ),
    },
  });
  const db = createStartDbFromSchema(schema);
  await db.a.user.create({ id: "user_1", name: "Author" });
  await db.a.user.create({ id: "user_2", name: "Editor" });
  await db.a.post.create({
    id: "post_1",
    authorId: "user_1",
    editorId: "user_2",
    title: "Hello",
  });
  const userCard = db.view("user", { name: true });
  const postCard = db.view("post", { title: true, author: userCard, editor: userCard });

  expect(await db.q.post.byId("post_1").as(postCard).execute()).toEqual({
    title: "Hello",
    author: { name: "Author" },
    editor: { name: "Editor" },
  });
});

test("tracks pending fields from affected query specs", async () => {
  const base = createStartDbFromSchema(appSchema);
  await base.a.post.create({ id: "post_1", title: "Hello", likes: 0, secret: "x" });
  let finish = () => {};
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const db = base.extendActions(({ action }) => ({
    post: {
      like: action<{ postId: string }, void>({
        affects: ({ input }) => [base.q.post.byId(input.postId).field("likes")],
        run: () => waiting,
      }),
    },
  }));

  const result = db.a.post.like({ postId: "post_1" });
  await Promise.resolve();

  expect(db.pending.field({ id: "post_1" }, "likes")).toBe(true);
  expect(db.pending.field({ id: "post_1" }, "title")).toBe(false);

  finish();
  await result;
  expect(db.pending.field({ id: "post_1" }, "likes")).toBe(false);
});

test("accepts external collection adapters", async () => {
  const posts = new MemoryCollection<Record<string, unknown>>("id");
  const db = createStartDbFromSchema(appSchema, {
    collections: ({ queryCollection }) => ({
      post: queryCollection("post", { collection: posts }),
    }),
  });

  await db.a.post.create({ id: "post_1", title: "Hello", likes: 0, secret: "x" });

  expect(posts.get("post_1")).toMatchObject({ title: "Hello" });
});

test("creates official Query Collection adapters through the optional entrypoint", async () => {
  const posts = [{ id: "post_1", title: "Remote", likes: 0, secret: "x" }];
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let insertCalls = 0;
  const db = createStartDbFromSchema(appSchema, {
    collections: () => ({
      post: queryDbCollection("post", {
        queryClient,
        queryKey: ["posts"],
        queryFn: async () => posts,
        mutations: {
          insert: async (values) => {
            insertCalls += 1;
            posts.push(...values);
          },
        },
      }),
    }),
  });

  await db.collections.post.engine?.preload();
  expect(await db.q.post.byId("post_1").execute()).toMatchObject({ title: "Remote" });

  const submission = db.a.post.create({ id: "post_2", title: "Local", likes: 0, secret: "y" });
  await submission.persisted;

  expect(insertCalls).toBe(1);
  expect(await db.q.post.byId("post_2").execute()).toMatchObject({ title: "Local" });
});

test("dehydrates and hydrates official Query Collection adapters", async () => {
  type Post = { id: string; title: string; likes: number; secret: string };
  const createDb = (posts: ReadonlyArray<Post>) =>
    createStartDbFromSchema(appSchema, {
      collections: () => ({
        post: queryDbCollection("post", {
          queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
          queryKey: ["posts"],
          queryFn: async () => [...posts],
        }),
      }),
    });
  const source = createDb([{ id: "post_1", title: "Remote", likes: 0, secret: "x" }]);
  await source.collections.post.engine?.preload();
  const target = createDb([]);
  await target.collections.post.engine?.preload();

  hydrateDb(target, dehydrateDb(source));

  expect(await target.q.post.byId("post_1").execute()).toMatchObject({ title: "Remote" });
});

test("derives route refetch and stale status from official Query Collection adapters", async () => {
  const posts = [{ id: "post_1", title: "Remote", likes: 0, secret: "x" }];
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let calls = 0;
  let finishRefetch = () => {};
  const db = createStartDbFromSchema(appSchema, {
    collections: () => ({
      post: queryDbCollection("post", {
        queryClient,
        queryKey: ["posts"],
        queryFn: async () => {
          calls += 1;
          if (calls === 1) return posts;
          return new Promise<typeof posts>((resolve) => {
            finishRefetch = () => resolve(posts);
          });
        },
        staleTime: Number.POSITIVE_INFINITY,
      }),
    }),
  });
  const route = createDbFileRouteFactory({ db })("/posts");
  await db.collections.post.engine?.preload();

  expect(route.useStatus().isLoading).toBe(false);
  expect(route.useStatus().isStale).toBe(false);

  queryClient
    .getQueryCache()
    .find({ queryKey: ["posts"] })
    ?.invalidate();
  expect(route.useStatus().isStale).toBe(true);

  const refetch = db.collections.post.engine?.utils.refetch?.();
  await Promise.resolve();
  expect(route.useStatus().isRefetching).toBe(true);

  finishRefetch();
  await refetch;
  expect(route.useStatus().isRefetching).toBe(false);
});

test("creates engine-free memory DBs for testing fallbacks", async () => {
  const db = createMemoryStartDb(appSchema);
  await db.a.post.create({ id: "post_1", title: "Hello", likes: 0, secret: "x" });

  expect(db.collections.post.engine).toBeUndefined();
  expect(db.q.post.byId("post_1").queryBuilder).toBeUndefined();
  expect(await db.q.post.byId("post_1").execute()).toMatchObject({ title: "Hello" });
});

test("wraps pre-created native TanStack collections without forcing local-only creation", async () => {
  const engine = createCollection(
    localOnlyCollectionOptions<{ id: string; title: string; likes: number; secret: string }>({
      getKey: (post) => post.id,
    }),
  );
  const db = createStartDbFromSchema(appSchema, {
    collections: ({ queryCollection }) => ({
      post: queryCollection("post", { collection: nativeCollection("id", engine) }),
    }),
  });

  const submission = db.a.post.create({ id: "post_1", title: "Hello", likes: 0, secret: "x" });
  await submission.persisted;

  expect(submission.transaction).toBeDefined();
  expect(await db.q.post.byId("post_1").execute()).toMatchObject({ title: "Hello" });
  expect(dehydrateDb(db).collections).toEqual({});
});

test("supports explicit hydration hooks for external native collection adapters", async () => {
  const createAdapter = () => {
    const engine = createCollection(
      localOnlyCollectionOptions<{ id: string; title: string; likes: number; secret: string }>({
        getKey: (post) => post.id,
      }),
    );
    return nativeCollection("id", engine, {
      dehydrate: (collection) => [...collection._state.syncedData.values()],
      hydrate: (collection, values) => {
        for (const value of values) collection.insert(value);
      },
    });
  };
  const source = createStartDbFromSchema(appSchema, {
    collections: ({ queryCollection }) => ({
      post: queryCollection("post", { collection: createAdapter() }),
    }),
  });
  await source.a.post.create({ id: "post_1", title: "Hello", likes: 0, secret: "x" });
  const target = createStartDbFromSchema(appSchema, {
    collections: ({ queryCollection }) => ({
      post: queryCollection("post", { collection: createAdapter() }),
    }),
  });

  hydrateDb(target, dehydrateDb(source));

  expect(await target.q.post.byId("post_1").execute()).toMatchObject({ title: "Hello" });
});

test("compiles q.* specs to native TanStack DB query-builder functions", async () => {
  const db = createStartDbFromSchema(appSchema);
  await db.a.post.create({ id: "post_1", title: "Hello", likes: 1, secret: "x" });
  await db.a.post.create({ id: "post_2", title: "World", likes: 2, secret: "y" });

  const byId = db.q.post.byId("post_1");
  const all = db.q.post.all();
  const byTitle = db.q.post.byTitle("Hello");

  expect(typeof byId.queryBuilder).toBe("function");
  expect(typeof all.queryBuilder).toBe("function");
  expect(typeof byTitle.queryBuilder).toBe("function");

  expect(await byId.execute()).toMatchObject({ id: "post_1", title: "Hello" });
  expect(await all.execute()).toHaveLength(2);
  expect(await byTitle.execute()).toHaveLength(1);
});

test("executes and subscribes to native q.raw query builders", async () => {
  const db = createStartDbFromSchema(appSchema);
  await db.a.post.create({ id: "post_1", title: "Hello", likes: 1, secret: "x" });
  const spec = db.q.raw<{ id: string; title: string } | undefined>({
    key: ["raw", "post", "post_1"],
    query: (q) =>
      q
        .from({ post: db.collections.post.engine! })
        .where(({ post }) => eq(post.id, "post_1"))
        .select(({ post }) => ({ id: post.id, title: post.title }))
        .findOne(),
  });

  expect(await spec.execute()).toEqual({ id: "post_1", title: "Hello" });

  const observed: Array<unknown> = [];
  const unsubscribe = spec.subscribe((value) => {
    observed.push(value);
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  await db.a.post.patch({ id: "post_1", changes: { title: "Updated" } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(observed.at(-1)).toEqual({ id: "post_1", title: "Updated" });

  unsubscribe();
});

test("executes native byId through the @tanstack/db queryOnce pipeline", async () => {
  const db = createStartDbFromSchema(appSchema);
  await db.a.post.create({ id: "post_1", title: "Hello", likes: 1, secret: "x" });

  const spec = db.q.post.byId("post_1");
  const result = await spec.execute();

  expect(result).toMatchObject({ id: "post_1", title: "Hello", likes: 1 });
  expect((result as Record<string, unknown>).secret).toBe("x");
});

test("returns undefined from a missing native byId", async () => {
  const db = createStartDbFromSchema(appSchema);
  const result = await db.q.post.byId("missing").execute();
  expect(result).toBeUndefined();
});

test("throws DbNotFoundError for missing required query results", async () => {
  const db = createStartDbFromSchema(appSchema);

  await expect(db.q.post.byId("missing").required().execute()).rejects.toSatisfy(isDbNotFound);
});

test("compiles relationship queries to native join queries", async () => {
  const schema = defineDbSchema({
    entities: {
      user: entity(passthroughSchema<{ id: string; name: string }>(), {
        key: "id",
      }),
      post: entity(passthroughSchema<{ id: string; authorId: string; title: string }>(), {
        key: "id",
        indexes: ["authorId"],
        relationships: (api) => ({
          author: api.one("user", { local: "authorId", foreign: "id" }),
          comments: api.many("comment", { local: "id", foreign: "postId" }),
        }),
      }),
      comment: entity(passthroughSchema<{ id: string; postId: string; body: string }>(), {
        key: "id",
        indexes: ["postId"],
      }),
    },
  });
  const db = createStartDbFromSchema(schema);
  await db.a.user.create({ id: "user_1", name: "Alice" });
  await db.a.post.create({ id: "post_1", authorId: "user_1", title: "Hello" });
  await db.a.comment.create({ id: "comment_1", postId: "post_1", body: "First" });
  await db.a.comment.create({ id: "comment_2", postId: "post_1", body: "Second" });

  expect(typeof db.q.post.author("post_1").queryBuilder).toBe("function");
  expect(typeof db.q.post.comments("post_1").queryBuilder).toBe("function");

  const author = await db.q.post.author("post_1").execute();
  expect(author).toMatchObject({ id: "user_1", name: "Alice" });

  const comments = await db.q.post.comments("post_1").execute();
  expect(comments).toHaveLength(2);
  expect(comments).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "comment_1", body: "First" }),
      expect.objectContaining({ id: "comment_2", body: "Second" }),
    ]),
  );
});

test("masks native query results with a view at execute time", async () => {
  const db = createStartDbFromSchema(appSchema);
  await db.a.post.create({ id: "post_1", title: "Hello", likes: 1, secret: "x" });
  const postCard = db.view("post", { id: true, title: true });

  const masked = await db.q.post.byId("post_1").as(postCard).execute();
  expect(masked).toEqual({ id: "post_1", title: "Hello" });
});

test("compiles a simple view into a native TanStack DB select projection", async () => {
  const db = createStartDbFromSchema(appSchema);
  await db.a.post.create({ id: "post_1", title: "Hello", likes: 1, secret: "x" });
  await db.a.post.create({ id: "post_2", title: "World", likes: 2, secret: "y" });
  const postCard = db.view("post", { id: true, title: true });

  const one = await db.q.post.byId("post_1").as(postCard).execute();
  expect(one).toEqual({ id: "post_1", title: "Hello" });

  const many = await db.q.post.all().as(postCard).execute();
  expect(many).toEqual([
    { id: "post_1", title: "Hello" },
    { id: "post_2", title: "World" },
  ]);

  const indexed = await db.q.post.byTitle("Hello").as(postCard).execute();
  expect(indexed).toEqual([{ id: "post_1", title: "Hello" }]);
});

test("compiles a view into a native select for relationship queries", async () => {
  const schema = defineDbSchema({
    entities: {
      user: entity(passthroughSchema<{ id: string; name: string; email: string }>(), {
        key: "id",
      }),
      post: entity(passthroughSchema<{ id: string; authorId: string; title: string }>(), {
        key: "id",
        indexes: ["authorId"],
        relationships: (api) => ({
          author: api.one("user", { local: "authorId", foreign: "id" }),
        }),
      }),
    },
  });
  const db = createStartDbFromSchema(schema);
  await db.a.user.create({ id: "user_1", name: "Alice", email: "alice@example.com" });
  await db.a.post.create({ id: "post_1", authorId: "user_1", title: "Hello" });
  const userCard = db.view("user", { id: true, name: true });

  const author = await db.q.post.author("post_1").as(userCard).execute();
  expect(author).toEqual({ id: "user_1", name: "Alice" });
});

test("materializes nested one and many relationship views", async () => {
  const schema = defineDbSchema({
    entities: {
      user: entity(passthroughSchema<{ id: string; name: string; email: string }>(), {
        key: "id",
      }),
      post: entity(passthroughSchema<{ id: string; authorId: string; title: string }>(), {
        key: "id",
        relationships: (api) => ({
          author: api.one("user", { local: "authorId", foreign: "id" }),
          comments: api.many("comment", { local: "id", foreign: "postId" }),
        }),
      }),
      comment: entity(passthroughSchema<{ id: string; postId: string; body: string }>(), {
        key: "id",
      }),
    },
  });
  const db = createStartDbFromSchema(schema);
  await db.a.user.create({ id: "user_1", name: "Alice", email: "alice@example.com" });
  await db.a.post.create({ id: "post_1", authorId: "user_1", title: "Hello" });
  await db.a.comment.create({ id: "comment_1", postId: "post_1", body: "First" });
  await db.a.comment.create({ id: "comment_2", postId: "post_1", body: "Second" });

  const userCard = db.view("user", { id: true, name: true });
  const commentCard = db.view("comment", { id: true, body: true });
  const postPage = db.view("post", {
    id: true,
    title: true,
    author: userCard,
    comments: commentCard,
  });

  expect(await db.q.post.byId("post_1").as(postPage).execute()).toEqual({
    id: "post_1",
    title: "Hello",
    author: { id: "user_1", name: "Alice" },
    comments: [
      { id: "comment_1", body: "First" },
      { id: "comment_2", body: "Second" },
    ],
  });
});

test("rejects nested views for unknown or mismatched relationships", () => {
  const schema = defineDbSchema({
    entities: {
      user: entity(passthroughSchema<{ id: string; name: string }>(), { key: "id" }),
      post: entity(passthroughSchema<{ id: string; authorId: string }>(), {
        key: "id",
        relationships: (api) => ({
          author: api.one("user", { local: "authorId", foreign: "id" }),
        }),
      }),
    },
  });
  const db = createStartDbFromSchema(schema);
  const userCard = db.view("user", { id: true });
  const postCard = db.view("post", { id: true });

  expect(() => db.view("post", { missing: userCard } as never)).toThrow(
    'View relationship "missing" is not defined.',
  );
  expect(() => db.view("post", { author: postCard } as never)).toThrow(
    'View relationship "author" targets "user", not "post".',
  );
});

test("subscribes to live query results from a native live collection", async () => {
  const db = createStartDbFromSchema(appSchema);
  await db.a.post.create({ id: "post_1", title: "Hello", likes: 0, secret: "x" });

  const observed: Array<unknown> = [];
  const unsubscribe = db.q.post.byId("post_1").subscribe((value) => {
    observed.push(value);
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(observed.length).toBeGreaterThanOrEqual(1);
  expect(observed.at(-1)).toMatchObject({ id: "post_1", title: "Hello" });

  await db.a.post.patch({ id: "post_1", changes: { title: "Updated" } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const lastWithUpdate = observed.at(-1);
  expect(lastWithUpdate).toMatchObject({ id: "post_1", title: "Updated" });

  unsubscribe();
});

test("re-emits nested live views when a related collection changes", async () => {
  const schema = defineDbSchema({
    entities: {
      user: entity(passthroughSchema<{ id: string; name: string }>(), { key: "id" }),
      post: entity(passthroughSchema<{ id: string; authorId: string; title: string }>(), {
        key: "id",
        relationships: (api) => ({
          author: api.one("user", { local: "authorId", foreign: "id" }),
        }),
      }),
    },
  });
  const db = createStartDbFromSchema(schema);
  await db.a.user.create({ id: "user_1", name: "Alice" });
  await db.a.post.create({ id: "post_1", authorId: "user_1", title: "Hello" });
  const userCard = db.view("user", { id: true, name: true });
  const postCard = db.view("post", { id: true, author: userCard });
  const observed: Array<unknown> = [];
  const unsubscribe = db.q.post
    .byId("post_1")
    .as(postCard)
    .subscribe((value) => {
      observed.push(value);
    });

  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(observed.at(-1)).toEqual({ id: "post_1", author: { id: "user_1", name: "Alice" } });

  await db.a.user.patch({ id: "user_1", changes: { name: "Alicia" } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(observed.at(-1)).toEqual({ id: "post_1", author: { id: "user_1", name: "Alicia" } });

  unsubscribe();
});

test("folds nested one relationship views into native joins while resolving many views post-execute", async () => {
  const schema = defineDbSchema({
    entities: {
      user: entity(passthroughSchema<{ id: string; name: string; email: string }>(), {
        key: "id",
      }),
      post: entity(passthroughSchema<{ id: string; authorId: string; title: string }>(), {
        key: "id",
        relationships: (api) => ({
          author: api.one("user", { local: "authorId", foreign: "id" }),
          comments: api.many("comment", { local: "id", foreign: "postId" }),
        }),
      }),
      comment: entity(passthroughSchema<{ id: string; postId: string; body: string }>(), {
        key: "id",
      }),
    },
  });
  const db = createStartDbFromSchema(schema);
  await db.a.user.create({ id: "user_1", name: "Alice", email: "alice@example.com" });
  await db.a.post.create({ id: "post_1", authorId: "user_1", title: "Hello" });
  await db.a.comment.create({ id: "comment_1", postId: "post_1", body: "First" });
  await db.a.comment.create({ id: "comment_2", postId: "post_1", body: "Second" });

  const userCard = db.view("user", { id: true, name: true });
  const commentCard = db.view("comment", { id: true, body: true });
  const postPage = db.view("post", {
    id: true,
    title: true,
    author: userCard,
    comments: commentCard,
  });
  const postIndex = db.view("post", { id: true, title: true, author: userCard });

  expect(await db.q.post.byId("post_1").as(postPage).execute()).toEqual({
    id: "post_1",
    title: "Hello",
    author: { id: "user_1", name: "Alice" },
    comments: [
      { id: "comment_1", body: "First" },
      { id: "comment_2", body: "Second" },
    ],
  });

  const all = await db.q.post.all().as(postIndex).execute();
  expect(all).toEqual([{ id: "post_1", title: "Hello", author: { id: "user_1", name: "Alice" } }]);

  const observed: Array<unknown> = [];
  const unsubscribe = db.q.post
    .byId("post_1")
    .as(postPage)
    .subscribe((value) => {
      observed.push(value);
    });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(observed.at(-1)).toEqual({
    id: "post_1",
    title: "Hello",
    author: { id: "user_1", name: "Alice" },
    comments: [
      { id: "comment_1", body: "First" },
      { id: "comment_2", body: "Second" },
    ],
  });

  await db.a.user.patch({ id: "user_1", changes: { name: "Alicia" } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(observed.at(-1)).toEqual({
    id: "post_1",
    title: "Hello",
    author: { id: "user_1", name: "Alicia" },
    comments: [
      { id: "comment_1", body: "First" },
      { id: "comment_2", body: "Second" },
    ],
  });

  await db.a.comment.create({ id: "comment_3", postId: "post_1", body: "Third" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(observed.at(-1)).toEqual({
    id: "post_1",
    title: "Hello",
    author: { id: "user_1", name: "Alicia" },
    comments: [
      { id: "comment_1", body: "First" },
      { id: "comment_2", body: "Second" },
      { id: "comment_3", body: "Third" },
    ],
  });

  unsubscribe();
});

test("falls back to post-execute materialization for one relationships whose related collection has no engine", async () => {
  const schema = defineDbSchema({
    entities: {
      user: entity(passthroughSchema<{ id: string; name: string }>(), { key: "id" }),
      post: entity(passthroughSchema<{ id: string; authorId: string; title: string }>(), {
        key: "id",
        relationships: (api) => ({
          author: api.one("user", { local: "authorId", foreign: "id" }),
        }),
      }),
    },
  });
  const userCollection = new MemoryCollection<{ id: string; name: string }>("id");
  userCollection.insert({ id: "user_1", name: "Alice" });
  const db = createStartDbFromSchema(schema, {
    collections: () => ({
      user: { options: { collection: userCollection } },
    }),
  });
  await db.a.post.create({ id: "post_1", authorId: "user_1", title: "Hello" });
  const userCard = db.view("user", { id: true, name: true });
  const postCard = db.view("post", { id: true, title: true, author: userCard });

  expect(await db.q.post.byId("post_1").as(postCard).execute()).toEqual({
    id: "post_1",
    title: "Hello",
    author: { id: "user_1", name: "Alice" },
  });
});

test("tracks pending query refresh state for live query subscriptions", async () => {
  const schema = defineDbSchema({
    entities: {
      post: entity(
        passthroughSchema<{ id: string; title: string; likes: number; secret: string }>(),
        {
          key: "id",
        },
      ),
    },
  });
  const db = createStartDbFromSchema(schema);
  await db.a.post.create({ id: "post_1", title: "Hello", likes: 0, secret: "x" });

  let pendingInsideCallback: boolean | undefined;
  const unsubscribe = db.q.post.byId("post_1").subscribe(() => {
    pendingInsideCallback = db.pending.query("post");
  });
  expect(db.pending.query("post")).toBe(true);

  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(pendingInsideCallback).toBe(false);
  expect(db.pending.query("post")).toBe(false);

  unsubscribe();
  expect(db.pending.query("post")).toBe(false);
});

test("exposes a passthrough Standard Schema helper for unvalidated entities", async () => {
  const schema = defineDbSchema({
    entities: {
      post: entity(passthrough<{ id: string; title: string; likes: number; secret: string }>(), {
        key: "id",
      }),
    },
  });
  const db = createStartDbFromSchema(schema);
  const submission = db.a.post.create({
    id: "post_1",
    title: "Hello",
    likes: 0,
    secret: "x",
  });
  expect(isDbActionSubmission(submission)).toBe(true);
  const value = await submission;
  expect(value).toMatchObject({ id: "post_1", title: "Hello" });
  expect(await db.q.post.byId("post_1").execute()).toMatchObject({ title: "Hello" });
});

test("tracks pending query state across multiple subscriptions to the same spec", async () => {
  const schema = defineDbSchema({
    entities: {
      post: entity(
        passthroughSchema<{ id: string; title: string; likes: number; secret: string }>(),
        { key: "id" },
      ),
    },
  });
  const db = createStartDbFromSchema(schema);
  await db.a.post.create({ id: "post_1", title: "Hello", likes: 0, secret: "x" });

  const unsubscribers: Array<() => void> = [];
  unsubscribers.push(db.q.post.byId("post_1").subscribe(() => {}));
  expect(db.pending.query("post")).toBe(true);

  unsubscribers.push(db.q.post.byId("post_1").subscribe(() => {}));
  expect(db.pending.query("post")).toBe(true);

  unsubscribers[0]!();
  unsubscribers[1]!();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(db.pending.query("post")).toBe(false);
});

test("does not emit query values after the subscription is unsubscribed", async () => {
  const schema = defineDbSchema({
    entities: {
      post: entity(
        passthroughSchema<{ id: string; title: string; likes: number; secret: string }>(),
        { key: "id" },
      ),
    },
  });
  const db = createStartDbFromSchema(schema);
  await db.a.post.create({ id: "post_1", title: "Hello", likes: 0, secret: "x" });

  const observed: Array<unknown> = [];
  const unsubscribe = db.q.post.byId("post_1").subscribe((value) => {
    observed.push(value);
  });
  unsubscribe();

  await db.a.post.patch({ id: "post_1", changes: { title: "Updated" } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(observed).toEqual([]);
});

test("materializes a one relationship with a non-object joined value by falling back to the related collection", async () => {
  const schema = defineDbSchema({
    entities: {
      user: entity(passthroughSchema<{ id: string; name: string }>(), { key: "id" }),
      post: entity(passthroughSchema<{ id: string; authorId: string; title: string }>(), {
        key: "id",
        relationships: (api) => ({
          author: api.one("user", { local: "authorId", foreign: "id" }),
        }),
      }),
    },
  });
  const db = createStartDbFromSchema(schema);
  await db.a.user.create({ id: "user_1", name: "Alice" });
  await db.a.post.create({ id: "post_1", authorId: "user_1", title: "Hello" });
  const userCard = db.view("user", { id: true, name: true });
  const postCard = db.view("post", { id: true, title: true, author: userCard });

  expect(await db.q.post.byId("post_1").as(postCard).execute()).toEqual({
    id: "post_1",
    title: "Hello",
    author: { id: "user_1", name: "Alice" },
  });
});

test("LiveQueryTracker aggregates loading state across multiple predicates per key", () => {
  const tracker = createActionTracker();
  let loading1 = true;
  let loading2 = true;
  const unregister1 = tracker.liveQueries.register(["post", "byId", "post_1"], () => loading1);
  const unregister2 = tracker.liveQueries.register(["post", "byId", "post_1"], () => loading2);
  expect(tracker.liveQueries.size()).toBe(2);
  expect(tracker.liveQueries.isLoading("post")).toBe(true);

  loading1 = false;
  expect(tracker.liveQueries.isLoading("post")).toBe(true);

  unregister1();
  expect(tracker.liveQueries.size()).toBe(1);
  expect(tracker.liveQueries.isLoading("post")).toBe(true);

  loading2 = false;
  unregister2();
  expect(tracker.liveQueries.size()).toBe(0);
  expect(tracker.liveQueries.isLoading("post")).toBe(false);
});

interface Rendered {
  readonly root: Root;
  readonly container: HTMLDivElement;
  readonly unmount: () => void;
}

function render(element: ReactNode): Rendered {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return {
    root,
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
    },
  };
}

test("useDbLiveQueryState emits a ready state with the current value", async () => {
  const db = createStartDbFromSchema(appSchema);
  await db.a.post.create({ id: "post_1", title: "Hello", likes: 0, secret: "x" });

  let latest: unknown = null;
  const rendered = render(
    createElement(function ReadHook() {
      latest = useDbLiveQueryState(db.q.post.byId("post_1"));
      return null;
    }),
  );

  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const latestReady = latest as { status: "ready"; value: { id: string; title: string } };
  expect(latestReady.status).toBe("ready");
  expect(latestReady.value).toMatchObject({ id: "post_1", title: "Hello" });

  await act(async () => {
    await db.a.post.patch({ id: "post_1", changes: { title: "Updated" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const latestUpdated = latest as { status: "ready"; value: { title: string } };
  expect(latestUpdated.status).toBe("ready");
  expect(latestUpdated.value.title).toBe("Updated");

  rendered.unmount();
});

test("useDbLiveQuery returns the current value (or undefined while loading)", async () => {
  const db = createStartDbFromSchema(appSchema);
  await db.a.post.create({ id: "post_1", title: "Hello", likes: 0, secret: "x" });

  let observed: { id: string; title: string } | undefined;
  const rendered = render(
    createElement(function ReadHook() {
      observed = useDbLiveQuery(db.q.post.byId("post_1")) as { id: string; title: string };
      return null;
    }),
  );

  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  expect(observed).toMatchObject({ id: "post_1", title: "Hello" });

  rendered.unmount();
});

test("useDbLiveQuery resubscribes when its query key changes", async () => {
  const db = createStartDbFromSchema(appSchema);
  await db.a.post.create({ id: "post_1", title: "First", likes: 0, secret: "x" });
  await db.a.post.create({ id: "post_2", title: "Second", likes: 0, secret: "y" });
  let observed: { id: string; title: string } | undefined;
  const ReadHook = ({ postId }: { postId: string }) => {
    observed = useDbLiveQuery(db.q.post.byId(postId));
    return null;
  };
  const rendered = render(createElement(ReadHook, { postId: "post_1" }));

  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(observed).toMatchObject({ id: "post_1", title: "First" });

  act(() => {
    rendered.root.render(createElement(ReadHook, { postId: "post_2" }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(observed).toMatchObject({ id: "post_2", title: "Second" });

  rendered.unmount();
});

test("useDbLiveQueryState supports server rendering", async () => {
  const db = createStartDbFromSchema(appSchema);

  await expect(
    renderDbComponent(() => {
      useDbLiveQueryState(db.q.post.byId("post_1"));
      return createElement("div");
    }, {}),
  ).resolves.toMatchObject({ html: "<div></div>" });
});

test("resolves DB hooks through DbProvider context", () => {
  const db = createStartDbFromSchema(appSchema);
  const status = {
    isLoading: false,
    isHydrating: false,
    isRefetching: true,
    isStale: true,
    deferred: {},
  };
  let resolved: unknown;
  const rendered = render(
    createElement(
      DbProvider,
      { db, status },
      createElement(function ReadContext() {
        resolved = {
          db: useDb(),
          collections: useDbCollections(),
          pending: useDbPending(),
          status: useDbStatus(),
          submissions: useDbSubmissions(),
        };
        return null;
      }),
    ),
  );

  expect(resolved).toEqual({
    db,
    collections: db.collections,
    pending: db.pending,
    status,
    submissions: db.submissions,
  });
  rendered.unmount();
});

test("DbProvider preserves an outer status when no override is passed", () => {
  const db = createStartDbFromSchema(appSchema);
  const status = {
    isLoading: false,
    isHydrating: false,
    isRefetching: true,
    isStale: true,
    deferred: {},
  };
  let resolved: unknown;
  const rendered = render(
    createElement(
      DbProvider,
      { db, status },
      createElement(
        DbProvider,
        { db },
        createElement(function ReadStatus() {
          resolved = useDbStatus();
          return null;
        }),
      ),
    ),
  );

  expect(resolved).toBe(status);
  rendered.unmount();
});

test("creates typed static and action-aware DB view components", () => {
  const db = createStartDbFromSchema(appSchema);
  const postCard = db.view("post", { id: true, title: true });
  const post = { id: "post_1", title: "Hello" };
  const StaticPost = createDbComponent(postCard)(({ post }) =>
    createElement("span", null, post.title),
  );
  const renderedStatic = render(createElement(StaticPost, { post }));

  expect(renderedStatic.container.textContent).toBe("Hello");
  renderedStatic.unmount();

  let observed: unknown;
  const ActionPost = createDbComponent(postCard)
    .actions(({ a }) => ({ createPost: a.post.create }))
    .render((props) => {
      observed = props;
      return null;
    });
  const status = {
    isLoading: false,
    isHydrating: false,
    isRefetching: true,
    isStale: true,
    deferred: {},
  };
  const renderedAction = render(
    createElement(DbProvider, { db, status }, createElement(ActionPost, { post })),
  );

  expect(observed).toMatchObject({
    post,
    actions: { createPost: db.a.post.create },
    pending: db.pending,
    status,
    submissions: db.submissions,
  });
  renderedAction.unmount();
});

test("creates component-owned local views with retained live updates", async () => {
  const db = createStartDbFromSchema(appSchema);
  await db.a.post.create({ id: "post_1", title: "Hello", likes: 0, secret: "x" });
  const LocalPost = createDbComponent(db)
    .props<{ postId: string }>()
    .views(({ props, q }) => ({
      post: q.post.byId(props.postId).required(),
    }))
    .render(({ post }) => createElement("span", null, post.title));
  const rendered = render(
    createElement(
      DbProvider,
      { db },
      createElement(
        Suspense,
        { fallback: createElement("span", null, "Loading") },
        createElement(LocalPost, { postId: "post_1" }),
      ),
    ),
  );

  expect(rendered.container.textContent).toBe("Loading");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(rendered.container.textContent).toBe("Hello");

  await act(async () => {
    await db.a.post.patch({ id: "post_1", changes: { title: "Updated" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(rendered.container.textContent).toBe("Updated");
  rendered.unmount();
});

test("loads fluent DB route queries and compiles an official Router file route", async () => {
  const db = createStartDbFromSchema(appSchema);
  await db.a.post.create({ id: "post_1", title: "Hello", likes: 0, secret: "x" });
  const createDbFileRoute = createDbFileRouteFactory({ db });
  const validateSearch = (search: unknown) => search;
  const beforeLoad = () => ({});
  const loaderDeps = () => ({});
  const builder = createDbFileRoute("/posts/$postId")
    .validateSearch(validateSearch)
    .beforeLoad(beforeLoad)
    .loaderDeps(loaderDeps)
    .views(({ params, q }) => ({
      post: q.post.byId(params.postId!).required(),
    }));

  expect(await builder.load({ params: { postId: "post_1" } })).toEqual({
    post: expect.objectContaining({ id: "post_1", title: "Hello" }),
  });

  const route = builder.build() as {
    readonly options: {
      readonly loader: (options: {
        readonly params: Record<string, string>;
        readonly context: unknown;
      }) => Promise<unknown>;
      readonly validateSearch: unknown;
      readonly beforeLoad: unknown;
      readonly loaderDeps: unknown;
    };
  };
  expect(route.options.loader).toBeTypeOf("function");
  expect(route.options.validateSearch).toBe(validateSearch);
  expect(route.options.beforeLoad).toBe(beforeLoad);
  expect(route.options.loaderDeps).toBe(loaderDeps);
  expect(await route.options.loader({ params: { postId: "post_1" }, context: {} })).toEqual({
    post: expect.objectContaining({ id: "post_1", title: "Hello" }),
  });
});

test("runs composed route fragments as stages inside one file-route loader request", async () => {
  const db = createStartDbFromSchema(appSchema);
  await db.a.post.create({ id: "post_1", title: "Hello", likes: 0, secret: "x" });
  let clientCalls = 0;
  const createDbFileRoute = createDbFileRouteFactory({
    db,
    getClient: () => {
      clientCalls += 1;
      return db;
    },
  });
  const postFragment = createDbFileRoute.fragment(({ params, q }) => ({
    post: q.post.byId(params.postId!).required(),
  }));
  const route = createDbFileRoute("/posts/$postId").views(
    composeDbRouteFragments(postFragment, ({ data, q }) => ({
      samePost: q.post.byId(data.post.id).required(),
    })),
  );
  const built = route.build() as {
    readonly options: {
      readonly loader: (options: {
        readonly params: Record<string, string>;
        readonly context: unknown;
      }) => Promise<Record<string, unknown>>;
    };
  };

  expect(await built.options.loader({ params: { postId: "post_1" }, context: {} })).toEqual({
    post: expect.objectContaining({ id: "post_1", title: "Hello" }),
    samePost: expect.objectContaining({ id: "post_1", title: "Hello" }),
  });
  expect(clientCalls).toBe(1);
});

test("lets multiple route specs read through one Query Collection fetch", async () => {
  const posts = [
    { id: "post_1", title: "Hello", likes: 0, secret: "x" },
    { id: "post_2", title: "Second", likes: 0, secret: "y" },
  ];
  let fetches = 0;
  const db = createStartDbFromSchema(appSchema, {
    collections: () => ({
      post: queryDbCollection("post", {
        queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }),
        queryKey: ["route-posts"],
        queryFn: async () => {
          fetches += 1;
          return posts;
        },
      }),
    }),
  });
  const route = createDbFileRouteFactory({ db })("/posts/$postId").queries(({ params, q }) => ({
    post: q.post.byId(params.postId!).required(),
    posts: q.post.all(),
    matchingTitle: q.post.byTitle("Hello"),
  }));

  expect(await route.load({ params: { postId: "post_1" } })).toMatchObject({
    post: { id: "post_1" },
    posts: [{ id: "post_1" }, { id: "post_2" }],
    matchingTitle: [{ id: "post_1" }],
  });
  expect(fetches).toBe(1);
});

test("appends repeated route fragments and binds route actions from loaded fragment data", async () => {
  const base = createStartDbFromSchema(appSchema);
  await base.a.post.create({ id: "post_1", title: "Hello", likes: 0, secret: "x" });
  let finish = () => {};
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const db = base.extendActions(({ action }) => ({
    post: {
      publish: action<{ postId: string; title: string }, void>({
        run: () => waiting,
      }),
    },
  }));
  const createDbFileRoute = createDbFileRouteFactory({ db });
  const postFragment = createDbFileRoute.fragment(({ params, q }) => ({
    post: q.post.byId(params.postId!).required(),
  }));
  const route = createDbFileRoute("/posts/$postId")
    .views(postFragment)
    .views(({ data, q }) => ({
      postAgain: q.post.byId(data.post.id).required(),
    }))
    .actions(({ a, data }) => ({
      publishPost: a.post.publish.with({ postId: data.post.id }),
    }));

  expect(await route.load({ params: { postId: "post_1" } })).toMatchObject({
    post: { id: "post_1", title: "Hello" },
    postAgain: { id: "post_1", title: "Hello" },
  });
  const submission = route.useActions().publishPost({ title: "Published" });
  await Promise.resolve();

  expect(route.usePending().action("publishPost")).toBe(true);
  expect(route.useSubmissions().latest("publishPost")).toBe(submission);

  finish();
  await submission;
  expect(route.usePending().action("publishPost")).toBe(false);
});

test("resolves route-bound actions against the per-request DB client", async () => {
  const defaultDb = createStartDbFromSchema(appSchema);
  const requestDb = createStartDbFromSchema(appSchema);
  await defaultDb.a.post.create({ id: "post_1", title: "Default", likes: 0, secret: "x" });
  await requestDb.a.post.create({ id: "post_1", title: "Request", likes: 0, secret: "y" });
  const route = createDbFileRouteFactory({
    db: defaultDb,
    getClient: () => requestDb,
  })("/posts/$postId")
    .views(({ params, q }) => ({
      post: q.post.byId(params.postId!).required(),
    }))
    .actions(({ a, data }) => ({
      renamePost: a.post.patch.with({ id: data.post.id }),
    }));

  expect(await route.load({ params: { postId: "post_1" }, context: {} })).toMatchObject({
    post: { title: "Request" },
  });
  await route.useActions().renamePost({ changes: { title: "Updated request" } });

  expect(await requestDb.q.post.byId("post_1").execute()).toMatchObject({
    title: "Updated request",
  });
  expect(await defaultDb.q.post.byId("post_1").execute()).toMatchObject({ title: "Default" });
});

test("createDbRouteFragment keeps explicitly typed standalone fragments reusable", async () => {
  const db = createStartDbFromSchema(appSchema);
  await db.a.post.create({ id: "post_1", title: "Hello", likes: 0, secret: "x" });
  const fragment = createDbRouteFragment<
    typeof db,
    Record<string, never>,
    { readonly posts: ReturnType<typeof db.q.post.all> }
  >(({ q }) => ({
    posts: q.post.all(),
  }));
  const route = createDbFileRouteFactory({ db })("/posts").views(fragment);

  expect(await route.load({})).toMatchObject({
    posts: [{ id: "post_1", title: "Hello" }],
  });
});

test("returns deferred promises and confirmed snapshots from route hydration loaders", async () => {
  const db = createStartDbFromSchema(appSchema);
  await db.a.post.create({ id: "post_1", title: "Hello", likes: 0, secret: "x" });
  let finish = () => {};
  const waiting = new Promise<string>((resolve) => {
    finish = () => resolve("related");
  });
  let preloaded = false;
  const createDbFileRoute = createDbFileRouteFactory({
    db,
    defaults: { hydrate: "route" },
  });
  const builder = createDbFileRoute("/posts/$postId").views(({ params, q }) => ({
    post: q.post.byId(params.postId!).required(),
    related: q.raw({ key: ["related"], execute: () => waiting }).defer(),
    preload: q
      .raw({
        key: ["preload"],
        execute: () => {
          preloaded = true;
        },
      })
      .preloadOnly(),
  }));
  const route = builder.build() as {
    readonly options: {
      readonly loader: (options: {
        readonly params: Record<string, string>;
        readonly context: unknown;
      }) => Promise<{
        readonly data: Record<string, unknown>;
        readonly snapshot: {
          readonly collections: Record<string, ReadonlyArray<Record<string, unknown>>>;
        };
      }>;
    };
  };

  const loaded = await route.options.loader({ params: { postId: "post_1" }, context: {} });

  expect(preloaded).toBe(true);
  expect(loaded.data.post).toMatchObject({ id: "post_1", title: "Hello" });
  expect(loaded.data.related).toBeInstanceOf(Promise);
  expect(loaded.data).not.toHaveProperty("preload");
  expect(loaded.snapshot.collections.post).toHaveLength(1);
  expect(builder.useStatus().deferred.related?.isLoading).toBe(true);

  finish();
  await expect(loaded.data.related).resolves.toBe("related");
  expect(builder.useStatus().deferred.related?.isLoading).toBe(false);
});

test("retains native deferred live queries until the route builder is disposed", async () => {
  const db = createStartDbFromSchema(appSchema);
  await db.a.post.create({ id: "post_1", title: "First", likes: 0, secret: "x" });
  const builder = createDbFileRouteFactory({ db })("/posts").queries(({ q }) => ({
    posts: q.post.all().defer(),
  }));

  const loaded = (await builder.load({})) as unknown as {
    readonly posts: DbDeferredValue<ReadonlyArray<{ id: string; title: string }>>;
  };
  await expect(loaded.posts).resolves.toHaveLength(1);
  expect(loaded.posts.current).toEqual([expect.objectContaining({ id: "post_1", title: "First" })]);

  await db.a.post.create({ id: "post_2", title: "Second", likes: 0, secret: "y" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(loaded.posts.current).toHaveLength(2);

  builder.dispose();
  await db.a.post.create({ id: "post_3", title: "Third", likes: 0, secret: "z" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(loaded.posts.current).toHaveLength(2);
});

test("tracks critical route loading and hydrates route payload snapshots on the client", async () => {
  const source = createStartDbFromSchema(appSchema);
  await source.a.post.create({ id: "post_1", title: "Hello", likes: 0, secret: "x" });
  let finish = () => {};
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const sourceRoute = createDbFileRouteFactory({
    db: source,
    defaults: { hydrate: "route" },
  })("/posts").queries(({ q }) => ({
    preload: q.raw({ key: ["wait"], execute: () => waiting }).preloadOnly(),
    posts: q.post.all(),
  }));
  const loading = sourceRoute.load({});

  expect(sourceRoute.useStatus().isLoading).toBe(true);
  finish();
  await loading;
  expect(sourceRoute.useStatus().isLoading).toBe(false);

  const built = sourceRoute.build() as {
    readonly options: {
      readonly loader: (options: {
        readonly params: Record<string, string>;
        readonly context: unknown;
      }) => Promise<{
        readonly data: Record<string, unknown>;
        readonly snapshot: {
          readonly collections: Record<string, ReadonlyArray<Record<string, unknown>>>;
        };
      }>;
    };
  };
  const payload = await built.options.loader({ params: {}, context: {} });
  const target = createStartDbFromSchema(appSchema);
  const targetRoute = createDbFileRouteFactory({ db: target })("/posts");

  expect(target.collections.post.values()).toEqual([]);
  expect(targetRoute.hydrate(payload)).toEqual(payload.data);
  expect(targetRoute.useStatus().isHydrating).toBe(false);
  expect(await target.q.post.byId("post_1").execute()).toMatchObject({ title: "Hello" });
});

test("route defaults enforce views, disable retained live defers, and forward SSR configuration", async () => {
  const db = createStartDbFromSchema(appSchema);
  await db.a.post.create({ id: "post_1", title: "Hello", likes: 0, secret: "x" });
  const postCard = db.view("post", { id: true, title: true });
  const missingView = createDbFileRouteFactory({
    db,
    defaults: { requireViews: true },
  })("/posts").queries(({ q }) => ({
    posts: q.post.all(),
  }));
  await expect(missingView.load({})).rejects.toThrow('Route query "posts" requires a view');

  const route = createDbFileRouteFactory({
    db,
    defaults: { live: false, requireViews: true, ssr: false },
  })("/posts").queries(({ q }) => ({
    posts: q.post.all().as(postCard).defer(),
  }));
  const data = await route.load({});
  expect(data.posts).toBeInstanceOf(Promise);
  expect(route.useStatus().deferred.posts?.isLoading).toBe(true);
  await expect(data.posts).resolves.toEqual([{ id: "post_1", title: "Hello" }]);
  expect(route.useStatus().deferred.posts?.isLoading).toBe(false);
  expect(
    (
      route.build() as {
        readonly options: { readonly ssr?: boolean };
      }
    ).options.ssr,
  ).toBe(false);
});

test("resolves route action aliases for pending state and submissions", async () => {
  const base = createStartDbFromSchema(appSchema);
  let finish = () => {};
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const db = base.extendActions(({ action }) => ({
    post: {
      like: action<{ postId: string }, void>({
        run: () => waiting,
      }),
    },
  }));
  const route = createDbFileRouteFactory({ db })("/posts/$postId").actions(({ a }) => ({
    likePost: a.post.like,
  }));

  const submission = db.a.post.like({ postId: "post_1" });
  await Promise.resolve();

  expect(route.usePending().action("likePost")).toBe(true);
  expect(route.useSubmissions().latest("likePost")).toBe(submission);

  finish();
  await submission.persisted;
  expect(route.usePending().action("likePost")).toBe(false);
});

test("useDbLiveSuspenseQuery wakes a Suspense boundary and returns live values", async () => {
  const db = createStartDbFromSchema(appSchema);
  await db.a.post.create({ id: "post_1", title: "Hello", likes: 0, secret: "x" });

  const rendered = render(
    createElement(
      Suspense,
      { fallback: createElement("span", null, "Loading") },
      createElement(function ReadHook() {
        const post = useDbLiveSuspenseQuery(db.q.post.byId("post_1"));
        return createElement("span", null, post?.title);
      }),
    ),
  );

  expect(rendered.container.textContent).toBe("Loading");

  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(rendered.container.textContent).toBe("Hello");

  await act(async () => {
    await db.a.post.patch({ id: "post_1", changes: { title: "Updated" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(rendered.container.textContent).toBe("Updated");

  rendered.unmount();
});

test("useDbLiveSuspenseQuery isolates different views of the same query", async () => {
  const db = createStartDbFromSchema(appSchema);
  await db.a.post.create({ id: "post_1", title: "Hello", likes: 0, secret: "hidden" });
  const titleView = db.view("post", { title: true });
  const secretView = db.view("post", { secret: true });

  const rendered = render(
    createElement(
      Suspense,
      { fallback: createElement("span", null, "Loading") },
      createElement(function ReadViews() {
        const title = useDbLiveSuspenseQuery(db.q.post.byId("post_1").as(titleView));
        const secret = useDbLiveSuspenseQuery(db.q.post.byId("post_1").as(secretView));
        return createElement("span", null, `${title?.title}:${secret?.secret}`);
      }),
    ),
  );

  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(rendered.container.textContent).toBe("Hello:hidden");

  rendered.unmount();
});

test("useDbLiveSuspenseQuery isolates identical keys from different DB instances", async () => {
  const firstDb = createStartDbFromSchema(appSchema);
  const secondDb = createStartDbFromSchema(appSchema);
  await firstDb.a.post.create({ id: "post_1", title: "First", likes: 0, secret: "x" });
  await secondDb.a.post.create({ id: "post_1", title: "Second", likes: 0, secret: "y" });

  const rendered = render(
    createElement(
      Suspense,
      { fallback: createElement("span", null, "Loading") },
      createElement(function ReadHooks() {
        const first = useDbLiveSuspenseQuery(firstDb.q.post.byId("post_1"));
        const second = useDbLiveSuspenseQuery(secondDb.q.post.byId("post_1"));
        return createElement("span", null, `${first?.title}:${second?.title}`);
      }),
    ),
  );

  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(rendered.container.textContent).toBe("First:Second");

  rendered.unmount();
});

test("applies select() once on native and in-memory execute paths", async () => {
  const nativeDb = createStartDbFromSchema(appSchema);
  await nativeDb.a.post.create({ id: "post_1", title: "Hello", likes: 1, secret: "x" });

  const nativeSpec = nativeDb.q.post
    .byId("post_1")
    .select((post) => ({ ...post!, titleLength: post!.title.length }));
  expect(await nativeSpec.execute()).toEqual({
    id: "post_1",
    title: "Hello",
    likes: 1,
    secret: "x",
    titleLength: 5,
  });

  const memoryDb = createMemoryStartDb(appSchema);
  await memoryDb.a.post.create({ id: "post_1", title: "Hello", likes: 1, secret: "x" });
  const memorySpec = memoryDb.q.post
    .byId("post_1")
    .select((post) => ({ ...post!, titleLength: post!.title.length }));
  expect(await memorySpec.execute()).toEqual({
    id: "post_1",
    title: "Hello",
    likes: 1,
    secret: "x",
    titleLength: 5,
  });
});

test("chains select() after as(view) and re-emits when related collection changes", async () => {
  const db = createStartDbFromSchema(appSchema);
  await db.a.post.create({ id: "post_1", title: "Hello", likes: 1, secret: "x" });
  const postCard = db.view("post", { id: true, title: true });

  const observed: Array<unknown> = [];
  const unsubscribe = db.q.post
    .byId("post_1")
    .as(postCard)
    .select((post) => ({ slug: post.title.toLowerCase() }))
    .subscribe((value) => {
      observed.push(value);
    });

  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(observed.at(-1)).toEqual({ slug: "hello" });

  await db.a.post.patch({ id: "post_1", changes: { title: "Updated" } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(observed.at(-1)).toEqual({ slug: "updated" });

  unsubscribe();
});

test("chains as(view) before select() and re-emits when a related collection changes", async () => {
  const schema = defineDbSchema({
    entities: {
      user: entity(passthroughSchema<{ id: string; name: string }>(), { key: "id" }),
      post: entity(
        passthroughSchema<{
          id: string;
          authorId: string;
          title: string;
          likes: number;
          secret: string;
        }>(),
        {
          key: "id",
          indexes: ["authorId"],
          relationships: (api) => ({
            author: api.one("user", { local: "authorId", foreign: "id" }),
          }),
        },
      ),
    },
  });
  const db = createStartDbFromSchema(schema);
  await db.a.user.create({ id: "user_1", name: "Alice" });
  await db.a.post.create({
    id: "post_1",
    authorId: "user_1",
    title: "Hello",
    likes: 0,
    secret: "x",
  });
  const authorCard = db.view("user", { id: true, name: true });
  const postCard = db.view("post", { id: true, title: true, author: authorCard });

  const observed: Array<unknown> = [];
  const unsubscribe = db.q.post
    .byId("post_1")
    .as(postCard)
    .select((post) => ({ id: post!.id, authorName: post!.author?.name ?? "" }))
    .subscribe((value) => {
      observed.push(value);
    });

  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(observed.at(-1)).toEqual({ id: "post_1", authorName: "Alice" });

  await db.a.user.patch({ id: "user_1", changes: { name: "Alicia" } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(observed.at(-1)).toEqual({ id: "post_1", authorName: "Alicia" });

  unsubscribe();
});

function createMemoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
    clear: () => {
      data.clear();
    },
    keys: () => [...data.keys()],
  };
}

function createNoOpStorageEventApi() {
  const listeners = new Set<(event: StorageEvent) => void>();
  return {
    addEventListener: (_type: "storage", listener: (event: StorageEvent) => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: "storage", listener: (event: StorageEvent) => void) => {
      listeners.delete(listener);
    },
  };
}

test("localStorageCollection persists generated CRUD through the storage API", async () => {
  const storage = createMemoryStorage();
  const inserted: Array<Record<string, unknown>> = [];
  const updated: Array<{ id: string; changes: Record<string, unknown> }> = [];
  const deleted: Array<string> = [];

  const db = createStartDbFromSchema(appSchema, {
    collections: ({ localStorageCollection: ls }) => ({
      post: ls("post", {
        storageKey: "test.posts",
        storage,
        storageEventApi: createNoOpStorageEventApi(),
        mutations: {
          insert: (values) => {
            for (const value of values) inserted.push(value);
          },
          update: (values) => {
            for (const value of values) updated.push(value as never);
          },
          delete: (ids) => {
            for (const id of ids) deleted.push(String(id));
          },
        },
      }),
    }),
  });

  await db.a.post.create({ id: "post_1", title: "Hello", likes: 0, secret: "x" });
  expect(inserted).toEqual([{ id: "post_1", title: "Hello", likes: 0, secret: "x" }]);
  expect(await db.q.post.byId("post_1").execute()).toMatchObject({ title: "Hello" });

  const stored = JSON.parse(storage.getItem("test.posts") ?? "{}") as Record<
    string,
    { data: Record<string, unknown> }
  >;
  expect(stored["s:post_1"]?.data).toMatchObject({ id: "post_1", title: "Hello" });

  await db.a.post.patch({ id: "post_1", changes: { title: "Updated" } });
  expect(updated).toEqual([{ id: "post_1", changes: { title: "Updated" } }]);
  expect((await db.q.post.byId("post_1").execute())?.title).toBe("Updated");

  await db.a.post.delete({ id: "post_1" });
  expect(deleted).toEqual(["post_1"]);
  expect(await db.q.post.byId("post_1").execute()).toBeUndefined();
});

test("localStorageCollection dehydrate returns the confirmed engine state", async () => {
  const storage = createMemoryStorage();
  const db = createStartDbFromSchema(appSchema, {
    collections: ({ localStorageCollection: ls }) => ({
      post: ls("post", {
        storageKey: "test.posts.dehydrate",
        storage,
        storageEventApi: createNoOpStorageEventApi(),
      }),
    }),
  });

  await db.a.post.create({ id: "post_1", title: "Hello", likes: 0, secret: "x" });
  expect(dehydrateDb(db)).toMatchObject({
    collections: { post: [{ id: "post_1", title: "Hello" }] },
  });
});

test("syncCollection wraps an external engine and supports custom dehydrate/hydrate", async () => {
  const engine = createCollection(
    localOnlyCollectionOptions<{ id: string; title: string; likes: number; secret: string }>({
      getKey: (post) => post.id,
    }),
  ) as unknown as Parameters<typeof syncCollection>[1]["engine"];
  const customDehydrateCalls: Array<unknown> = [];
  const customHydrateCalls: Array<unknown> = [];

  const db = createStartDbFromSchema(appSchema, {
    collections: ({ syncCollection: sc }) => ({
      post: sc("post", {
        engine,
        key: "id",
        dehydrate: (target) => {
          customDehydrateCalls.push(target);
          return [
            ...(target as unknown as { values: () => Iterable<Record<string, unknown>> }).values(),
          ] as ReadonlyArray<Record<string, unknown>>;
        },
        hydrate: (target, values) => {
          customHydrateCalls.push({ target, values });
          for (const value of values) {
            (target as unknown as { insert: (value: unknown) => void }).insert(value);
          }
        },
      }),
    }),
  });

  await db.a.post.create({ id: "post_1", title: "Hello", likes: 0, secret: "x" });
  expect(await db.q.post.byId("post_1").execute()).toMatchObject({ title: "Hello" });
  expect(customDehydrateCalls).toHaveLength(0);

  const snapshot = dehydrateDb(db);
  expect(customDehydrateCalls).toHaveLength(1);
  expect(snapshot).toMatchObject({
    collections: { post: [{ id: "post_1", title: "Hello" }] },
  });

  const other = createStartDbFromSchema(appSchema, {
    collections: ({ syncCollection: sc }) => ({
      post: sc("post", {
        engine: createCollection(
          localOnlyCollectionOptions({ getKey: (post: { id: string }) => post.id }),
        ) as unknown as Parameters<typeof syncCollection>[1]["engine"],
        hydrate: (target, values) => {
          customHydrateCalls.push({ target, values });
          for (const value of values) {
            (target as unknown as { insert: (value: unknown) => void }).insert(value);
          }
        },
      }),
    }),
  });
  hydrateDb(other, snapshot);
  expect(customHydrateCalls).toHaveLength(1);
  expect(await other.q.post.byId("post_1").execute()).toMatchObject({ title: "Hello" });
});

test("syncCollection inherits non-id schema keys and refreshes existing rows during hydration", async () => {
  const schema = defineDbSchema({
    entities: {
      widget: entity(passthroughSchema<{ slug: string; title: string }>(), { key: "slug" }),
    },
  });
  const createDb = () => {
    const engine = createCollection(
      localOnlyCollectionOptions<{ slug: string; title: string }>({
        getKey: (widget) => widget.slug,
      }),
    ) as unknown as Parameters<typeof syncCollection<{ slug: string; title: string }>>[1]["engine"];
    return createStartDbFromSchema(schema, {
      collections: ({ syncCollection: sc }) => ({
        widget: sc("widget", { engine }),
      }),
    });
  };
  const source = createDb();
  const target = createDb();
  await source.a.widget.create({ slug: "main", title: "New" });
  await target.a.widget.create({ slug: "main", title: "Old" });

  hydrateDb(target, dehydrateDb(source));

  expect(await target.q.widget.byId("main").execute()).toEqual({ slug: "main", title: "New" });
});

test("localStorageCollection dehydrates through the browser storage default", async () => {
  localStorage.clear();
  const db = createStartDbFromSchema(appSchema, {
    collections: ({ localStorageCollection: ls }) => ({
      post: ls("post", {
        storageKey: "browser.posts",
        storageEventApi: createNoOpStorageEventApi(),
      }),
    }),
  });
  await db.a.post.create({ id: "post_1", title: "Hello", likes: 0, secret: "x" });

  expect(dehydrateDb(db)).toMatchObject({
    collections: { post: [{ id: "post_1", title: "Hello" }] },
  });
  localStorage.clear();
});

test("createMemoryStartDb seeds the in-memory executor and supports query/execute", async () => {
  const db = createMemoryStartDb(appSchema);
  await db.a.post.create({ id: "post_1", title: "Hello", likes: 0, secret: "x" });
  const post = await db.q.post.byId("post_1").execute();
  expect(post).toMatchObject({ id: "post_1", title: "Hello" });
  const all = await db.q.post.all().execute();
  expect(all).toHaveLength(1);
});

test("seedCollections bulk-inserts rows into the named collections", () => {
  const db = createMemoryStartDb(appSchema);
  seedCollections(db, {
    post: [
      { id: "post_1", title: "Hello", likes: 0, secret: "x" },
      { id: "post_2", title: "World", likes: 0, secret: "y" },
    ],
  });
  expect(db.collections.post.values()).toHaveLength(2);
  expect(db.collections.post.get("post_2")).toMatchObject({ title: "World" });
});

test("fixture and listFixture shape their return type to the view's projection", () => {
  const db = createStartDbFromSchema(appSchema);
  const postCard = db.view("post", { id: true, title: true });
  const single = fixture(postCard, { id: "p1", title: "Hello" });
  expect(single).toEqual({ id: "p1", title: "Hello" });
  const list = listFixture(postCard, 2, (i) => ({ id: `p${i}`, title: `Post ${i}` }));
  expect(list).toEqual([
    { id: "p0", title: "Post 0" },
    { id: "p1", title: "Post 1" },
  ]);
});

test("mockDbAction returns a thenable submission that resolves with the handler's return value", async () => {
  const likePost = mockDbAction<{ postId: string }, { postId: string; likes: number }>(
    async ({ postId }) => ({ postId, likes: 1 }),
  );
  const submission = likePost({ postId: "p1" });
  expect(isDbActionSubmission(submission)).toBe(true);
  const result = await submission;
  expect(result).toEqual({ postId: "p1", likes: 1 });
});

test("renderDbComponent renders a component factory to its HTML string", async () => {
  const Greeting = (props: { name: string }) => createElement("h1", null, `Hello, ${props.name}!`);
  const { html, props } = await renderDbComponent(Greeting, { name: "world" });
  expect(html).toBe("<h1>Hello, world!</h1>");
  expect(props).toEqual({ name: "world" });
});

test("waitFor resolves once a predicate is true and times out otherwise", async () => {
  let count = 0;
  const id = setInterval(() => {
    count += 1;
  }, 5);
  try {
    await waitFor(() => count >= 3, { intervalMs: 5, timeoutMs: 500 });
    expect(count).toBeGreaterThanOrEqual(3);
  } finally {
    clearInterval(id);
  }
  await expect(waitFor(() => false, { intervalMs: 5, timeoutMs: 20 })).rejects.toThrowError(
    /timed out/,
  );
});

test("flushMicrotasks advances the microtask queue the requested number of times", async () => {
  let observed = 0;
  void Promise.resolve().then(() => {
    observed += 1;
  });
  void Promise.resolve().then(() => {
    observed += 1;
  });
  expect(observed).toBe(0);
  await flushMicrotasks(1);
  expect(observed).toBe(2);
});

test("type-level: InferEntity, InferView, and InferDbQueryResult narrow correctly", async () => {
  const db = createStartDbFromSchema(appSchema);
  await db.a.post.create({ id: "post_1", title: "Hello", likes: 0, secret: "x" });
  const postCard = db.view("post", { id: true, title: true });
  const result = await db.q.post.byId("post_1").as(postCard).execute();
  if (!result) throw new Error("expected post");
  const id: string = result.id;
  const title: string = result.title;
  expect(typeof id).toBe("string");
  expect(typeof title).toBe("string");
});

test("type-level: generated helpers preserve schema input, index, relationship, and view types", async () => {
  const schema = defineDbSchema({
    entities: {
      post: entity(
        {
          "~standard": {
            version: 1 as const,
            vendor: "test",
            validate: (value: unknown) => {
              const post = value as { id: string; authorId: string; likes?: number };
              return { value: { ...post, likes: post.likes ?? 0 } };
            },
            types: undefined as unknown as {
              input: { id: string; authorId: string; likes?: number };
              output: { id: string; authorId: string; likes: number };
            },
          },
        },
        {
          key: "id",
          indexes: ["authorId"],
          relationships: (api) => ({
            comments: api.many("comment", { local: "id", foreign: "postId" }),
          }),
        },
      ),
      comment: entity(passthroughSchema<{ id: string; postId: string; body: string }>(), {
        key: "id",
      }),
    },
  });
  const db = createStartDbFromSchema(schema);
  await db.a.post.create({ id: "post_1", authorId: "user_1" });
  const indexed: ReadonlyArray<{ id: string; authorId: string; likes: number }> = await db.q.post
    .byAuthor("user_1")
    .execute();
  const related: ReadonlyArray<{ id: string; postId: string; body: string }> = await db.q.post
    .comments("post_1")
    .execute();
  const commentCard = db.view("comment", { body: true });
  db.view("post", { comments: commentCard });

  const typeCheckOnly = () => {
    // @ts-expect-error authorId index values are strings
    db.q.post.byAuthor(123);
    const postCard = db.view("post", { id: true });
    // @ts-expect-error comments targets comment views
    db.view("post", { comments: postCard });
    // @ts-expect-error entity keys must exist on schema output
    entity(passthroughSchema<{ id: string }>(), { key: "missing" });
    // @ts-expect-error indexes must exist on schema output
    entity(passthroughSchema<{ id: string }>(), { key: "id", indexes: ["missing"] });
    entity(passthroughSchema<{ id: string }>(), {
      key: "id",
      relationships: (api) => ({
        // @ts-expect-error local relationship fields must exist on schema output
        comments: api.many("comment", { local: "missing", foreign: "postId" }),
      }),
    });
  };
  void typeCheckOnly;

  expect(indexed).toHaveLength(1);
  expect(related).toEqual([]);
});

test("rejects schema relationships that target unknown entities", () => {
  expect(() =>
    defineDbSchema({
      entities: {
        post: entity(passthroughSchema<{ id: string }>(), {
          key: "id",
          relationships: (api) => ({
            comments: api.many("missing", { local: "id", foreign: "postId" }),
          }),
        }),
      },
    }),
  ).toThrow('relationship "comments" targets unknown entity "missing"');
});

test("full native updates remove fields omitted from the replacement value", async () => {
  const schema = defineDbSchema({
    entities: {
      post: entity(passthroughSchema<{ id: string; title: string; note?: string }>(), {
        key: "id",
      }),
    },
  });
  const db = createStartDbFromSchema(schema);
  await db.a.post.create({ id: "post_1", title: "First", note: "remove me" });

  await db.a.post.update({ id: "post_1", value: { id: "post_1", title: "Second" } });

  expect(await db.q.post.byId("post_1").execute()).toEqual({ id: "post_1", title: "Second" });
});

test("generated updates reject attempts to change an entity key", async () => {
  const db = createStartDbFromSchema(appSchema);
  await db.a.post.create({ id: "post_1", title: "First", likes: 0, secret: "x" });

  await expect(
    db.a.post.update({
      id: "post_1",
      value: { id: "post_2", title: "Second", likes: 0, secret: "x" },
    }),
  ).rejects.toMatchObject({
    cause: expect.objectContaining({ message: expect.stringContaining("Collection key") }),
  });
  expect(await db.q.post.byId("post_1").execute()).toMatchObject({ title: "First" });
  expect(await db.q.post.byId("post_2").execute()).toBeUndefined();
});

test("local hydration is idempotent and refreshes existing rows", async () => {
  const source = createStartDbFromSchema(appSchema);
  const target = createStartDbFromSchema(appSchema);
  await source.a.post.create({ id: "post_1", title: "First", likes: 0, secret: "x" });
  const snapshot = dehydrateDb(source);

  hydrateDb(target, snapshot);
  hydrateDb(target, snapshot);
  expect(await target.q.post.byId("post_1").execute()).toMatchObject({ title: "First" });
});

test("wraps adapter hydration and batch preload failures with public error types", async () => {
  const engine = createCollection(
    localOnlyCollectionOptions<{ id: string; title: string; likes: number; secret: string }>({
      getKey: (post) => post.id,
    }),
  );
  const db = createStartDbFromSchema(appSchema, {
    collections: ({ queryCollection }) => ({
      post: queryCollection("post", {
        collection: nativeCollection("id", engine, {
          hydrate: () => {
            throw new Error("hydrate failed");
          },
        }),
      }),
    }),
  });

  expect(() => hydrateDb(db, { collections: { post: [] } })).toThrowError(
    expect.objectContaining({
      name: "DbHydrationError",
      cause: expect.objectContaining({ message: "hydrate failed" }),
    }),
  );
  try {
    hydrateDb(db, { collections: { post: [] } });
  } catch (error) {
    expect(isDbHydrationError(error)).toBe(true);
  }

  await expect(
    preloadDb([
      {
        execute: async () => {
          throw new Error("preload failed");
        },
      },
    ]),
  ).rejects.toMatchObject({
    name: "DbPreloadError",
    cause: expect.objectContaining({ message: "preload failed" }),
  });
  try {
    await preloadDb([{ execute: async () => Promise.reject(new Error("preload failed")) }]);
  } catch (error) {
    expect(isDbPreloadError(error)).toBe(true);
  }
});

test("preserves primitive custom-action inputs and matches falsy pending inputs exactly", async () => {
  const base = createStartDbFromSchema(appSchema);
  let finish = () => {};
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let received: boolean | undefined;
  const db = base.extendActions(({ action }) => ({
    flag: {
      inspect: action<boolean, void>({
        run: async ({ input }) => {
          received = input;
          await waiting;
        },
      }),
    },
  }));

  const submission = db.a.flag.inspect(false);
  await Promise.resolve();

  expect(received).toBe(false);
  expect(db.pending.action("flag.inspect", false)).toBe(true);
  expect(db.pending.action("flag.inspect", true)).toBe(false);

  finish();
  await submission;
});

test("static subscriptions emit once and infinite queries expose their initial page", async () => {
  const db = createStartDbFromSchema(appSchema);
  await db.a.post.create({ id: "post_1", title: "First", likes: 0, secret: "x" });
  const values: unknown[] = [];
  const unsubscribe = db.q.post
    .all()
    .static()
    .subscribe((value) => values.push(value));

  await waitFor(() => values.length === 1);
  await db.a.post.create({ id: "post_2", title: "Second", likes: 0, secret: "y" });
  await flushMicrotasks(2);

  expect(values).toHaveLength(1);
  unsubscribe();

  const infinite = queryFactory.many({
    key: ["posts"],
    execute: () => ["first", "second"],
  });
  expect(await infinite.infinite({ pageSize: 20 }).execute()).toEqual({
    pages: [["first", "second"]],
  });
});

test("createInfiniteQuery exposes the first page as a live subscription", async () => {
  const db = createStartDbFromSchema(appSchema);
  await db.a.post.create({ id: "post_1", title: "First", likes: 0, secret: "x" });
  await db.a.post.create({ id: "post_2", title: "Second", likes: 0, secret: "y" });

  const spec = createInfiniteQuery<readonly string[], string | undefined>({
    pageSpec: (cursor) =>
      queryFactory.many({
        key: ["post", "infinite", cursor ?? "start"],
        execute: () =>
          db.q.post
            .all()
            .execute()
            .then((rows) => (rows ?? []).map((r) => r.id)),
      }),
    initialPageParam: undefined,
    getNextPageParam: (lastPage) =>
      lastPage.length === 0 ? undefined : lastPage[lastPage.length - 1],
  });

  expect(isDbInfiniteQuerySpec(spec)).toBe(true);

  const states: Array<{
    status: string;
    pages: ReadonlyArray<readonly string[]>;
    hasNextPage: boolean;
  }> = [];
  const unsubscribe = spec.subscribe((state) => {
    if (state.status === "ready") {
      states.push({ status: state.status, pages: state.pages, hasNextPage: state.hasNextPage });
    }
  });

  await waitFor(() => states.length >= 1);
  expect(states[0]).toEqual({
    status: "ready",
    pages: [["post_1", "post_2"]],
    hasNextPage: true,
  });

  unsubscribe();
  spec.dispose();
});

test("createInfiniteQuery treats getNextPageParam returning null on the first page as end of pagination", async () => {
  const db = createStartDbFromSchema(appSchema);
  await db.a.post.create({ id: "post_1", title: "First", likes: 0, secret: "x" });

  const spec = createInfiniteQuery<readonly string[], number | null>({
    pageSpec: (cursor) =>
      queryFactory.many({
        key: ["post", "null-end", cursor ?? "start"],
        execute: () =>
          db.q.post
            .all()
            .execute()
            .then((rows) => (rows ?? []).map((r) => r.id)),
      }),
    initialPageParam: 0,
    getNextPageParam: () => null,
  });

  await new Promise<void>((resolve) => {
    const unsubscribe = spec.subscribe((state) => {
      if (state.status === "ready" && state.pages.length >= 1) {
        unsubscribe();
        resolve();
      }
    });
  });

  expect(spec.current).toMatchObject({
    status: "ready",
    hasNextPage: false,
    pages: [["post_1"]],
  });

  spec.dispose();
});

test("createInfiniteQuery loadMore appends pages until getNextPageParam returns undefined", async () => {
  const db = createStartDbFromSchema(appSchema);
  for (let i = 0; i < 6; i += 1) {
    await db.a.post.create({ id: `post_${i}`, title: `T${i}`, likes: i, secret: "x" });
  }

  const PAGE_SIZE = 2;
  const allIds = (): Promise<string[]> =>
    db.q.post
      .all()
      .execute()
      .then((rows) => (rows ?? []).map((r) => r.id));

  const spec = createInfiniteQuery<readonly string[], number | null>({
    pageSpec: (cursor) =>
      queryFactory.many({
        key: ["post", "paged", cursor ?? -1],
        execute: async () => {
          if (cursor === null) return [] as string[];
          const ids = await allIds();
          return ids.slice(cursor, cursor + PAGE_SIZE);
        },
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      if (lastPage.length < PAGE_SIZE) return null;
      const loadedSoFar = allPages.reduce((sum, page) => sum + page.length, 0);
      return loadedSoFar;
    },
  });

  // Drain the first emission
  await new Promise<void>((resolve) => {
    const unsubscribe = spec.subscribe((state) => {
      if (state.status === "ready" && state.pages.length >= 1) {
        unsubscribe();
        resolve();
      }
    });
  });

  await spec.loadMore();
  expect(spec.current).toMatchObject({
    status: "ready",
    hasNextPage: true,
    pages: [
      ["post_0", "post_1"],
      ["post_2", "post_3"],
    ],
  });

  await spec.loadMore();
  expect(spec.current).toMatchObject({
    status: "ready",
    hasNextPage: true,
    pages: [
      ["post_0", "post_1"],
      ["post_2", "post_3"],
      ["post_4", "post_5"],
    ],
  });

  // Final loadMore: page returns [], getNextPageParam returns null, hasNextPage flips to false
  await spec.loadMore();
  expect(spec.current).toMatchObject({
    status: "ready",
    hasNextPage: false,
    pages: [["post_0", "post_1"], ["post_2", "post_3"], ["post_4", "post_5"], []],
  });

  // No more pages — loadMore is a no-op
  if (spec.current.status === "ready") {
    const before = spec.current.pages.length;
    await spec.loadMore();
    expect(spec.current).toMatchObject({
      status: "ready",
      hasNextPage: false,
      pages: [["post_0", "post_1"], ["post_2", "post_3"], ["post_4", "post_5"], []],
    });
    if (spec.current.status === "ready") {
      expect(spec.current.pages.length).toBe(before);
    }
  }

  spec.dispose();
});

test("useDbLiveInfiniteQuery returns pages and loadMore from a mounted React tree", async () => {
  const db = createStartDbFromSchema(appSchema);
  await db.a.post.create({ id: "post_1", title: "First", likes: 0, secret: "x" });
  await db.a.post.create({ id: "post_2", title: "Second", likes: 0, secret: "y" });

  const spec = createInfiniteQuery<readonly string[], string | undefined>({
    pageSpec: (cursor) =>
      queryFactory.many({
        key: ["post", "react-infinite", cursor ?? "start"],
        execute: () =>
          db.q.post
            .all()
            .execute()
            .then((rows) => (rows ?? []).map((r) => r.id)),
      }),
    initialPageParam: undefined,
    getNextPageParam: () => undefined,
  });

  const container = document.createElement("div");
  const root = createRoot(container);
  let captured: {
    status: string;
    pages: ReadonlyArray<readonly string[]>;
    hasNextPage: boolean;
  } | null = null;
  function Page() {
    const inf = useDbLiveInfiniteQuery(spec);
    captured = { status: inf.status, pages: inf.pages, hasNextPage: inf.hasNextPage };
    return null;
  }

  await act(async () => {
    root.render(createElement(DbProvider, { db }, createElement(Page)));
  });

  await waitFor(() => captured?.status === "ready");
  expect(captured).toEqual({
    status: "ready",
    pages: [["post_1", "post_2"]],
    hasNextPage: false,
  });

  await act(async () => {
    root.unmount();
  });
  spec.dispose();
});

test("useDbLiveInfiniteSuspenseQuery suspends until the first page resolves", async () => {
  const db = createStartDbFromSchema(appSchema);
  await db.a.post.create({ id: "post_1", title: "First", likes: 0, secret: "x" });

  const spec = createInfiniteQuery<readonly string[], string | undefined>({
    pageSpec: (cursor) =>
      queryFactory.many({
        key: ["post", "react-suspense", cursor ?? "start"],
        execute: () =>
          db.q.post
            .all()
            .execute()
            .then((rows) => (rows ?? []).map((r) => r.id)),
      }),
    initialPageParam: undefined,
    getNextPageParam: () => undefined,
  });

  const container = document.createElement("div");
  const root = createRoot(container);
  let captured: { status: string; pages: ReadonlyArray<readonly string[]> } | null = null;
  function Page() {
    const inf = useDbLiveInfiniteSuspenseQuery(spec);
    captured = { status: inf.status, pages: inf.pages };
    return null;
  }

  await act(async () => {
    root.render(
      createElement(
        DbProvider,
        { db },
        createElement(Suspense, { fallback: null }, createElement(Page)),
      ),
    );
  });

  await waitFor(() => captured?.status === "ready");
  expect(captured).toEqual({ status: "ready", pages: [["post_1"]] });

  await act(async () => {
    root.unmount();
  });
  spec.dispose();
});

test("route builder attaches a DbInfiniteQuerySpec to data and warms the first page during SSR", async () => {
  const db = createStartDbFromSchema(appSchema);
  await db.a.post.create({ id: "post_1", title: "Hello", likes: 0, secret: "x" });

  const createDbFileRoute = createDbFileRouteFactory({ db });
  const spec = createInfiniteQuery<readonly string[], string | undefined>({
    pageSpec: (cursor) =>
      queryFactory.many({
        key: ["post", "route-infinite", cursor ?? "start"],
        execute: () =>
          db.q.post
            .all()
            .execute()
            .then((rows) => (rows ?? []).map((r) => r.id)),
      }),
    initialPageParam: undefined,
    getNextPageParam: () => undefined,
  });

  const builder = createDbFileRoute("/infinite").views(({ q }) => ({
    posts: spec as unknown as ReturnType<typeof q.post.all>,
  }));

  const data = await builder.load({ params: {} });
  expect(isDbInfiniteQuerySpec(data.posts)).toBe(true);
  await waitFor(() => spec.current.status === "ready");
  expect(spec.current).toMatchObject({ status: "ready", pages: [["post_1"]] });
  builder.dispose();
});

test("freezeView deeply freezes a projected value", () => {
  const userCard = freezeView.bind(null);
  const schema = defineDbSchema({
    entities: {
      user: entity(passthroughSchema<{ id: string; name: string; nested: { tag: string } }>(), {
        key: "id",
      }),
    },
  });
  const db = createStartDbFromSchema(schema);
  const card = db.view("user", { id: true, name: true });
  const user = { id: "u1", name: "Alice", email: "x", nested: { tag: "t" } };
  const frozen = freezeView(card, user);
  expect(Object.isFrozen(frozen)).toBe(true);
  expect(() => {
    (frozen as { name: string }).name = "Bob";
  }).toThrow();
  void userCard;
});

test("DbConflictError and DbOfflineError are exported with stable type guards", () => {
  const conflict = new Error("server revision");
  const offline = new Error("network down");
  expect(isDbConflictError(conflict)).toBe(false);
  expect(isDbOfflineError(offline)).toBe(false);
  expect(isDbConflictError(new DbConflictError("server revision"))).toBe(true);
  expect(isDbOfflineError(new DbOfflineError("network down"))).toBe(true);
  expect(new DbConflictError("x").name).toBe("DbConflictError");
  expect(new DbOfflineError("x").name).toBe("DbOfflineError");
});

test("DbAction.actionName is preserved through with, extend, and route-level aliases", async () => {
  const db = createStartDbFromSchema(appSchema);
  await db.a.post.create({ id: "post_1", title: "Hello", likes: 0, secret: "x" });

  // Bound action keeps canonical name.
  const likePost = db.a.post.patch.with({ id: "post_1" });
  expect(likePost.actionName).toBe("post.patch");

  // `extend` keeps canonical name. The `run` callback can return `void`,
  // a value, or a Promise of either.
  const extended = likePost.extend({
    run: (({ input }: { input: unknown }) => {
      void input;
      return undefined;
    }) as never,
  });
  expect(extended.actionName).toBe("post.patch");

  // Re-binding is type-system-rejected here: after `.with({ id })`, `id`
  // is removed from the required input, so a second `.with({ id })` is
  // a compile error. The contract is that `actionName` is set on the
  // action chain itself, not on the bound input, so re-binding does not
  // rename the action.
  expect(likePost.actionName).toBe("post.patch");

  // Route-level alias resolves to the canonical name through the
  // route's action factory: the bound action returned to the component
  // keeps the canonical `actionName` even when the route exposes it
  // under a different alias key.
  const createDbFileRoute = createDbFileRouteFactory({ db });
  const builder = createDbFileRoute("/posts/$postId")
    .views(({ q, params }) => ({
      post: q.post.byId(params.postId),
    }))
    .actions(({ a, data }) => ({
      rename: a.post.patch.with({ id: (data as { post: { id: string } }).post.id }),
    }));

  await builder.load({ params: { postId: "post_1" } });
  const actions = (
    builder as unknown as {
      useActions: () => Record<string, { actionName?: string }>;
    }
  ).useActions();
  expect(actions.rename.actionName).toBe("post.patch");

  builder.dispose();
});

test("route builder wires a level-1 bare custom action via a.post.like", async () => {
  const base = createStartDbFromSchema(appSchema);
  await base.a.post.create({ id: "post_1", title: "Hello", likes: 0, secret: "x" });
  const db = base.extendActions(({ action, c }) => ({
    post: {
      like: action<{ postId: string }, void>({
        run: (context) => {
          const result = c.post.update(context.input.postId, (current) => ({
            ...current,
            likes: current.likes + 1,
          }));
          context.setTransaction(result.transaction);
        },
      }),
    },
  }));

  const createDbFileRoute = createDbFileRouteFactory({ db });
  const route = createDbFileRoute("/posts/$postId")
    .views(({ params, q }) => ({
      post: q.post.byId(params.postId).required(),
    }))
    .actions(({ a }) => ({
      // Level 1: bare — the caller supplies the entire input.
      likePost: a.post.like,
    }));

  const { likePost } = route.useActions();
  expect(likePost.actionName).toBe("post.like");

  const submission = likePost({ postId: "post_1" });
  await submission;

  expect((await db.q.post.byId("post_1").execute())?.likes).toBe(1);
  expect(db.submissions.latest("post.like")).toBe(submission);

  route.dispose();
});

test("route builder wires a level-2 route-bound action via .with({ postId: data.post.id })", async () => {
  const pageSchema = defineDbSchema({
    entities: {
      user: entity(passthroughSchema<{ id: string; name: string }>(), { key: "id" }),
      post: entity(
        passthroughSchema<{
          id: string;
          authorId: string;
          title: string;
          likes: number;
          category: string;
        }>(),
        {
          key: "id",
          indexes: ["authorId", "category"],
          relationships: (api) => ({
            author: api.one("user", { local: "authorId", foreign: "id" }),
            related: api.many("post", { local: "category", foreign: "category" }),
          }),
        },
      ),
      comment: entity(passthroughSchema<{ id: string; postId: string; body: string }>(), {
        key: "id",
        indexes: ["postId"],
      }),
    },
  });

  const base = createStartDbFromSchema(pageSchema);
  await base.a.post.create({
    id: "post_1",
    authorId: "user_1",
    title: "Hello",
    likes: 0,
    category: "news",
  });
  const db = base.extendActions(({ action, c }) => ({
    comment: {
      add: action<{ postId: string; body: string }, void>({
        run: (context) => {
          const result = c.comment.insert({
            id: `comment_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            postId: context.input.postId,
            body: context.input.body,
          });
          context.setTransaction(result.transaction);
        },
      }),
    },
  }));

  const createDbFileRoute = createDbFileRouteFactory({ db });
  const route = createDbFileRoute("/posts/$postId")
    .views(({ params, q }) => ({
      post: q.post.byId(params.postId).required(),
    }))
    .actions(({ a, data }) => ({
      // Level 2: bound — `postId` is supplied from earlier fragment data.
      addComment: a.comment.add.with({ postId: data.post.id }),
    }));

  await route.load({ params: { postId: "post_1" } });
  const { addComment } = route.useActions();
  expect(addComment.actionName).toBe("comment.add");

  // The bound key is removed from the required input — caller only supplies `body`.
  const submission = addComment({ body: "First!" });
  await submission;

  const stored = await db.q.comment.byPost("post_1").execute();
  expect(stored).toHaveLength(1);
  expect(stored[0]?.body).toBe("First!");
  expect(stored[0]?.postId).toBe("post_1");
  expect(db.submissions.latest("comment.add")).toBe(submission);

  route.dispose();
});

test("route builder wires a level-3 local override via .extend({ optimisticLocal })", async () => {
  const pageSchema = defineDbSchema({
    entities: {
      post: entity(passthroughSchema<{ id: string; title: string }>(), { key: "id" }),
      comment: entity(passthroughSchema<{ id: string; postId: string; body: string }>(), {
        key: "id",
        indexes: ["postId"],
      }),
    },
  });

  const base = createStartDbFromSchema(pageSchema);
  await base.a.post.create({ id: "post_1", title: "Hello" });
  let finish = () => {};
  const waiting = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const db = base.extendActions(({ action, c }) => ({
    comment: {
      add: action<{ postId: string; body: string }, void>({
        run: (context) => {
          const result = c.comment.insert({
            id: `comment_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            postId: context.input.postId,
            body: context.input.body,
          });
          context.setTransaction(result.transaction);
          return waiting;
        },
      }),
    },
  }));

  const createDbFileRoute = createDbFileRouteFactory({ db });
  const route = createDbFileRoute("/posts/$postId")
    .views(({ params, q }) => ({
      post: q.post.byId(params.postId).required(),
    }))
    .actions(({ a }) => ({
      // Level 3: local override — `run` is preserved; the optimisticLocal
      // overlay fires before `run` resolves so the UI sees the new comment
      // immediately. Use `cache.<entity>.insert(value)` to mirror the row
      // into the optimistic cache (which forwards the write to the
      // collection synchronously).
      addComment: a.comment.add.extend({
        optimisticLocal: ({ input, cache }) => {
          cache.comment.insert({
            id: `optimistic_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            postId: input.postId,
            body: `[optimistic] ${input.body}`,
          });
        },
      }),
    }));

  const { addComment } = route.useActions();
  expect(addComment.actionName).toBe("comment.add");

  // Optimistic insert lands in the collection BEFORE `run` resolves —
  // `run` is parked on a `waiting` promise to make the race observable.
  const submission = addComment({ postId: "post_1", body: "Race me" });
  await Promise.resolve();
  await Promise.resolve();
  const visibleDuringRun = await db.q.comment.byPost("post_1").execute();
  expect(visibleDuringRun.map((c) => c.body)).toContain("[optimistic] Race me");

  finish();
  await submission;

  // After completion, both the optimistic and the canonical row are
  // present — the optimistic cache does not clean up its own writes.
  const after = await db.q.comment.byPost("post_1").execute();
  expect(after.map((c) => c.body).sort()).toEqual(["Race me", "[optimistic] Race me"]);

  route.dispose();
});

test("end-to-end route example wires views, route-bound actions, deferred queries, and status", async () => {
  const pageSchema = defineDbSchema({
    entities: {
      user: entity(passthroughSchema<{ id: string; name: string }>(), { key: "id" }),
      post: entity(
        passthroughSchema<{
          id: string;
          authorId: string;
          title: string;
          likes: number;
          category: string;
        }>(),
        {
          key: "id",
          indexes: ["authorId", "category"],
          relationships: (api) => ({
            author: api.one("user", { local: "authorId", foreign: "id" }),
            related: api.many("post", { local: "category", foreign: "category" }),
          }),
        },
      ),
      comment: entity(passthroughSchema<{ id: string; postId: string; body: string }>(), {
        key: "id",
        indexes: ["postId"],
      }),
    },
  });

  const base = createStartDbFromSchema(pageSchema);
  await base.a.user.create({ id: "user_1", name: "Ada" });
  await base.a.post.create({
    id: "post_1",
    authorId: "user_1",
    title: "Hello",
    likes: 0,
    category: "news",
  });
  await base.a.post.create({
    id: "post_2",
    authorId: "user_1",
    title: "Sibling",
    likes: 0,
    category: "news",
  });
  await base.a.post.create({
    id: "post_3",
    authorId: "user_1",
    title: "Other",
    likes: 0,
    category: "music",
  });
  await base.a.comment.create({ id: "comment_existing", postId: "post_1", body: "Hi" });

  const db = base.extendActions(({ action, c }) => ({
    post: {
      like: action<{ postId: string }, void>({
        run: (context) => {
          const result = c.post.update(context.input.postId, (current) => ({
            ...current,
            likes: current.likes + 1,
          }));
          context.setTransaction(result.transaction);
        },
      }),
    },
    comment: {
      add: action<{ postId: string; body: string }, void>({
        run: (context) => {
          const result = c.comment.insert({
            id: `comment_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            postId: context.input.postId,
            body: context.input.body,
          });
          context.setTransaction(result.transaction);
        },
      }),
    },
  }));

  const PostPageView = db.view("post", { id: true, title: true, likes: true });
  const CommentView = db.view("comment", { id: true, postId: true, body: true });
  const PostCardView = db.view("post", { id: true, title: true });

  const createDbFileRoute = createDbFileRouteFactory({ db });
  const route = createDbFileRoute("/posts/$postId")
    .views(({ params, q }) => ({
      post: q.post.byId(params.postId).as(PostPageView).required(),
      comments: q.comment.byPost(params.postId).as(CommentView).list(),
      related: q.post.related(params.postId).as(PostCardView).list().defer(),
    }))
    .actions(({ a, data }) => ({
      likePost: a.post.like,
      addComment: a.comment.add.with({ postId: data.post.id }),
    }));

  const data = await route.load({ params: { postId: "post_1" } });

  // Synchronous views resolve inside the loader.
  expect(data.post).toMatchObject({ id: "post_1", title: "Hello", likes: 0 });
  expect(data.comments).toHaveLength(1);
  expect(data.comments[0]).toMatchObject({ id: "comment_existing", body: "Hi" });

  // `related` is a DbDeferredValue — await it through a cast.
  const relatedRows = (await (data.related as unknown as Promise<
    ReadonlyArray<{ id: string; title: string }>
  >)) as ReadonlyArray<{ id: string; title: string }>;
  const relatedIds = relatedRows.map((r) => r.id).sort();
  expect(relatedIds).toContain("post_1");
  expect(relatedIds).toContain("post_2");
  expect(relatedIds).not.toContain("post_3");

  // Status surfaces the deferred loading state and the canonical isRefetching flag.
  const status = route.useStatus();
  expect(typeof status.isRefetching).toBe("boolean");
  expect(status.deferred.related?.isLoading).toBe(false);

  // Action factory returns the route-bound actions with the right `actionName`s.
  const actions = route.useActions();
  expect(actions.likePost.actionName).toBe("post.like");
  expect(actions.addComment.actionName).toBe("comment.add");

  // Drive both actions through the route-bound `actions` map.
  await actions.likePost({ postId: "post_1" });
  expect((await db.q.post.byId("post_1").execute())?.likes).toBe(1);

  await actions.addComment({ body: "Reply" });
  const after = await db.q.comment.byPost("post_1").execute();
  expect(after).toHaveLength(2);
  expect(after.map((c) => c.body).sort()).toEqual(["Hi", "Reply"]);

  route.dispose();
});

test("generated CRUD actions populate submission.affected with auto-derived specs", async () => {
  const db = createStartDbFromSchema(appSchema);

  type AffectedSpec = {
    key(): ReadonlyArray<unknown>;
    readonly metadata: { readonly field?: string };
  };
  const readAffected = (submission: unknown): ReadonlyArray<AffectedSpec> =>
    (submission as { affected?: unknown }).affected as ReadonlyArray<AffectedSpec>;

  // create: affects the entity's all() list spec.
  const createSub = db.a.post.create({
    id: "post_1",
    title: "Hello",
    likes: 0,
    secret: "x",
  });
  const createAffected = readAffected(createSub);
  expect(createAffected).toHaveLength(1);
  expect(createAffected[0]!.key()).toEqual(["post", "all"]);
  expect(createAffected[0]!.metadata.field).toBeUndefined();
  await createSub;

  // patch with two fields: affects byId(id).field(name) for each field
  // in `changes`, so pending.field can resolve per-field pending state.
  const patchSub = db.a.post.patch({
    id: "post_1",
    changes: { title: "New", likes: 5 },
  });
  const patchAffected = readAffected(patchSub);
  expect(patchAffected).toHaveLength(2);
  const fields = patchAffected
    .map((a) => a.metadata.field)
    .sort((left, right) => String(left).localeCompare(String(right)));
  expect(fields).toEqual(["likes", "title"]);
  for (const spec of patchAffected) {
    expect(spec.key()[0]).toBe("post");
    expect(spec.key()[1]).toBe("byId");
    expect(spec.key()).toContain("post_1");
  }
  await patchSub;

  // patch with empty `changes` produces no affected specs.
  const emptyPatchSub = db.a.post.patch({ id: "post_1", changes: {} });
  expect(readAffected(emptyPatchSub)).toHaveLength(0);
  await emptyPatchSub;

  // update: affects byId(id) only — `update` replaces the whole row, so
  // there are no per-field specs to mark.
  const updateSub = db.a.post.update({
    id: "post_1",
    value: { id: "post_1", title: "Full", likes: 10, secret: "y" },
  });
  const updateAffected = readAffected(updateSub);
  expect(updateAffected).toHaveLength(1);
  expect(updateAffected[0]!.key()).toEqual(["post", "byId", "post_1"]);
  expect(updateAffected[0]!.metadata.field).toBeUndefined();
  await updateSub;

  // delete: affects byId(id) only.
  const deleteSub = db.a.post.delete({ id: "post_1" });
  const deleteAffected = readAffected(deleteSub);
  expect(deleteAffected).toHaveLength(1);
  expect(deleteAffected[0]!.key()).toEqual(["post", "byId", "post_1"]);
  expect(deleteAffected[0]!.metadata.field).toBeUndefined();
  await deleteSub;
});

test("generated CRUD auto-affects drive pending.field and pending.query in real time", async () => {
  // Park the persistence callback so the action stays in flight while
  // we observe the pending state. The submission's affected specs are
  // what db.pending reads from, so proving they line up also proves
  // pending.field resolves correctly.
  let release: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const db = createStartDbFromSchema(appSchema, {
    collections: ({ queryCollection }) => ({
      post: queryCollection("post", {
        initialValues: [{ id: "post_1", title: "Original", likes: 0, secret: "x" }],
        mutations: {
          update: () => waiting,
        },
      }),
    }),
  });

  const submission = db.a.post.patch({
    id: "post_1",
    changes: { title: "New title" },
  });

  // Yield once so the action's `run` callback reaches `await mutations.update()`.
  await Promise.resolve();
  await Promise.resolve();

  // While parked:
  // - pending.field({ id }, "title") is true (the auto-affects produced
  //   a byId(id).field("title") spec).
  // - pending.field({ id }, "likes") is false (no spec for "likes" was
  //   produced because the patch did not include it).
  // - pending.query("post") is true (any byId spec's key starts with
  //   the entity name).
  expect(db.pending.field({ id: "post_1" }, "title")).toBe(true);
  expect(db.pending.field({ id: "post_1" }, "likes")).toBe(false);
  expect(db.pending.query("post")).toBe(true);

  // Release the action and confirm pending clears.
  release!();
  await submission;

  expect(db.pending.field({ id: "post_1" }, "title")).toBe(false);
  expect(db.pending.query("post")).toBe(false);
});

test("db.component(View) is the flagship component API and mirrors createDbComponent(View)", () => {
  const db = createStartDbFromSchema(appSchema);
  const postCard = db.view("post", { id: true, title: true });
  const post = { id: "post_1", title: "Hello" };

  // Simple form: db.component(View)(render) returns a component.
  const PostCard = db.component(postCard)(({ post: row }) =>
    createElement("span", null, row.title),
  );
  const renderedStatic = render(createElement(PostCard, { post }));
  expect(renderedStatic.container.textContent).toBe("Hello");
  renderedStatic.unmount();

  // Action-aware form: db.component(View).actions(...).render(...) returns
  // a component that receives actions, pending, status, submissions.
  let observed: unknown;
  const ActionPost = db
    .component(postCard)
    .actions(({ a }) => ({ createPost: a.post.create }))
    .render((props) => {
      observed = props;
      return null;
    });
  const status = {
    isLoading: false,
    isHydrating: false,
    isRefetching: true,
    isStale: true,
    deferred: {},
  };
  const renderedAction = render(
    createElement(DbProvider, { db, status }, createElement(ActionPost, { post })),
  );

  expect(observed).toMatchObject({
    post,
    actions: { createPost: db.a.post.create },
    pending: db.pending,
    status,
    submissions: db.submissions,
  });
  renderedAction.unmount();
});

test("stripVirtualProps drops __proto__/constructor/prototype keys from inserts", () => {
  const db = createStartDbFromSchema(appSchema);
  const collection = db.collections.post as unknown as {
    insert: (value: Record<string, unknown>) => unknown;
    values: () => ReadonlyArray<Record<string, unknown>>;
  };
  const polluted = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(polluted, "id", { value: "post_1", enumerable: true });
  Object.defineProperty(polluted, "title", { value: "Hello", enumerable: true });
  Object.defineProperty(polluted, "likes", { value: 0, enumerable: true });
  Object.defineProperty(polluted, "secret", { value: "x", enumerable: true });
  Object.defineProperty(polluted, "__proto__", {
    value: { polluted: "yes" },
    enumerable: true,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(polluted, "constructor", {
    value: { polluted: "yes" },
    enumerable: true,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(polluted, "prototype", {
    value: { polluted: "yes" },
    enumerable: true,
    configurable: true,
    writable: true,
  });
  collection.insert(polluted);
  const values = collection.values();
  expect(values).toHaveLength(1);
  expect(values[0]).not.toHaveProperty("__proto__");
  expect(values[0]).not.toHaveProperty("constructor");
  expect(values[0]).not.toHaveProperty("prototype");
  expect(values[0]).toEqual({ id: "post_1", title: "Hello", likes: 0, secret: "x" });
  expect(({} as { polluted?: string }).polluted).toBeUndefined();
});

test("replaceDraft drops __proto__/constructor/prototype keys from update payloads", async () => {
  const db = createStartDbFromSchema(appSchema);
  await db.a.post.create({ id: "post_1", title: "Hello", likes: 0, secret: "x" });
  const polluted = { id: "post_1", title: "Polluted" } as Record<string, unknown>;
  Object.defineProperty(polluted, "__proto__", {
    value: { polluted: "yes" },
    enumerable: true,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(polluted, "constructor", {
    value: { polluted: "yes" },
    enumerable: true,
    configurable: true,
    writable: true,
  });
  const collection = db.collections.post as unknown as {
    update: (
      id: string,
      updater: (value: Record<string, unknown>) => Record<string, unknown>,
    ) => unknown;
  };
  collection.update("post_1", () => polluted);
  const updated = await db.q.post.byId("post_1").execute();
  expect(updated).toMatchObject({ id: "post_1", title: "Polluted" });
  expect(Object.prototype.hasOwnProperty.call(updated, "__proto__")).toBe(false);
  expect(Object.prototype.hasOwnProperty.call(updated, "constructor")).toBe(false);
  expect(({} as { polluted?: string }).polluted).toBeUndefined();
});

test("syncCollection defaultHydrate tolerates concurrent duplicate-key inserts", async () => {
  const schema = defineDbSchema({
    entities: {
      widget: entity(passthroughSchema<{ slug: string; title: string }>(), { key: "slug" }),
    },
  });
  const engine = createCollection(
    localOnlyCollectionOptions<{ slug: string; title: string }>({
      getKey: (widget) => widget.slug,
    }),
  ) as unknown as Parameters<typeof syncCollection>[1]["engine"];
  (engine as unknown as { insert: (value: unknown) => unknown }).insert({
    slug: "main",
    title: "Other",
  });
  const db = createStartDbFromSchema(schema, {
    collections: ({ syncCollection: sc }) => ({
      widget: sc("widget", { engine }),
    }),
  });
  hydrateDb(db, { collections: { widget: [{ slug: "main", title: "New" }] } });
  const widget = await db.q.widget.byId("main").execute();
  expect(widget).toEqual({ slug: "main", title: "New" });
});

test("syncCollection defaultHydrate rethrows non-duplicate-key errors", async () => {
  const schema = defineDbSchema({
    entities: {
      widget: entity(passthroughSchema<{ slug: string; title: string }>(), { key: "slug" }),
    },
  });
  let insertCalls = 0;
  const engine = {
    get: () => undefined,
    insert: () => {
      insertCalls += 1;
      throw new Error("engine rejected: schema mismatch");
    },
    update: () => {
      throw new Error("should not be reached");
    },
  } as unknown as Parameters<typeof syncCollection>[1]["engine"];
  const db = createStartDbFromSchema(schema, {
    collections: ({ syncCollection: sc }) => ({
      widget: sc("widget", { engine }),
    }),
  });
  expect(() =>
    hydrateDb(db, { collections: { widget: [{ slug: "main", title: "New" }] } }),
  ).toThrowError("Failed to hydrate collection");
  expect(insertCalls).toBe(1);
});

test("pickView fast path returns only the selected keys for simple views", () => {
  const db = createStartDbFromSchema(appSchema);
  const postCard = db.view("post", { id: true, title: true });
  const result = pickView(postCard, {
    id: "post_1",
    title: "Hello",
    likes: 5,
    secret: "hidden",
  });
  expect(result).toEqual({ id: "post_1", title: "Hello" });
  expect(result).not.toHaveProperty("likes");
  expect(result).not.toHaveProperty("secret");
});

test("pickView recurses through nested views with null and undefined values", () => {
  const schema = defineDbSchema({
    entities: {
      post: entity(passthroughSchema<{ id: string; title: string; authorId: string | null }>(), {
        key: "id",
        relationships: (api) => ({
          author: api.one("user", { local: "authorId", foreign: "id" }),
        }),
      }),
      user: entity(passthroughSchema<{ id: string; name: string }>(), { key: "id" }),
    },
  });
  const db = createStartDbFromSchema(schema);
  const userCard = db.view("user", { id: true, name: true });
  const postCard = db.view("post", {
    id: true,
    title: true,
    author: userCard,
  });
  const withAuthor = pickView(postCard, {
    id: "p1",
    title: "Hello",
    authorId: "u1",
  });
  expect(withAuthor).toEqual({
    id: "p1",
    title: "Hello",
    author: undefined,
  });
  const withoutAuthor = pickView(postCard, {
    id: "p2",
    title: "World",
    authorId: null,
  });
  expect(withoutAuthor).toEqual({
    id: "p2",
    title: "World",
    author: undefined,
  });
});

test("materializeView resolves a 'one' relationship using the first matching related row", async () => {
  const schema = defineDbSchema({
    entities: {
      post: entity(passthroughSchema<{ id: string; title: string; authorId: string }>(), {
        key: "id",
        relationships: (api) => ({
          author: api.one("user", { local: "authorId", foreign: "id" }),
        }),
      }),
      user: entity(passthroughSchema<{ id: string; name: string }>(), { key: "id" }),
    },
  });
  const db = createStartDbFromSchema(schema, {
    collections: () => ({}),
  });
  await db.a.user.create({ id: "u1", name: "Alice" });
  await db.a.user.create({ id: "u2", name: "Bob" });
  await db.a.post.create({ id: "p1", title: "Hello", authorId: "u1" });
  const userCard = db.view("user", { id: true, name: true });
  const postCard = db.view("post", {
    id: true,
    title: true,
    author: userCard,
  });
  const spec = db.q.post.byId("p1").as(postCard);
  const result = await spec.execute();
  expect(result).toEqual({ id: "p1", title: "Hello", author: { id: "u1", name: "Alice" } });
});

test("inMemory relationship query returns a single row for 'one' cardinality", async () => {
  const schema = defineDbSchema({
    entities: {
      post: entity(passthroughSchema<{ id: string; title: string; authorId: string }>(), {
        key: "id",
        relationships: (api) => ({
          author: api.one("user", { local: "authorId", foreign: "id" }),
        }),
      }),
      user: entity(passthroughSchema<{ id: string; name: string }>(), { key: "id" }),
    },
  });
  const db = createStartDbFromSchema(schema);
  await db.a.user.create({ id: "u1", name: "Alice" });
  await db.a.post.create({ id: "p1", title: "Hello", authorId: "u1" });
  const author = await db.q.post.author("p1").execute();
  expect(author).toEqual({ id: "u1", name: "Alice" });
  const missing = await db.q.post.author("does-not-exist").execute();
  expect(missing).toBeUndefined();
});

test("route action aliases resolve nested namespaces to the canonical name", async () => {
  const db = createStartDbFromSchema(appSchema);
  await db.a.post.create({ id: "post_1", title: "Hello", likes: 0, secret: "x" });
  const route = createDbFileRouteFactory({ db })("/posts")
    .views(({ q }) => ({ post: q.post.byId("post_1").required() }))
    .actions(({ a }) => ({
      post: { like: a.post.patch.with({ id: "post_1" }) },
    }));

  await route.load({});
  const { post } = route.useActions();
  const sub = post.like({ changes: { likes: 1 } });
  await flushMicrotasks(2);
  expect(route.usePending().action("post.like")).toBe(true);
  expect(route.usePending().action("like")).toBe(true);
  expect(route.useSubmissions().latest("post.like")).toBe(sub);
  expect(route.useSubmissions().latest("like")).toBe(sub);
  await sub;
  expect(route.usePending().action("post.like")).toBe(false);
  expect(route.usePending().action("like")).toBe(false);
});

test("useDbLiveQuery re-subscribes when the spec identity changes", async () => {
  const db = createStartDbFromSchema(appSchema);
  await db.a.post.create({ id: "post_1", title: "First", likes: 0, secret: "x" });
  await db.a.post.create({ id: "post_2", title: "Second", likes: 0, secret: "y" });

  let observed: { id: string; title: string } | undefined;
  function Reader({ postId }: { postId: string }) {
    const post = useDbLiveQuery(
      db.q.post.byId(postId).as(db.view("post", { id: true, title: true })),
    );
    if (post) observed = post;
    return null;
  }

  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(DbProvider, { db }, createElement(Reader, { postId: "post_1" })));
  });
  expect(observed).toEqual({ id: "post_1", title: "First" });

  await act(async () => {
    root.render(createElement(DbProvider, { db }, createElement(Reader, { postId: "post_2" })));
  });
  expect(observed).toEqual({ id: "post_2", title: "Second" });

  root.unmount();
});

test("useDbLiveInfiniteQuery deduplicates concurrent loadMore calls", async () => {
  const db = createStartDbFromSchema(appSchema);
  for (let i = 0; i < 4; i += 1) {
    await db.a.post.create({
      id: `post_${i}`,
      title: `Post ${i}`,
      likes: i,
      secret: "x",
    });
  }

  const spec = createInfiniteQuery<readonly string[], number | null>({
    pageSpec: (cursor) =>
      queryFactory.many({
        key: ["post", "dedupe", cursor ?? -1],
        execute: async () => {
          if (cursor === null) return [] as string[];
          const ids = await db.q.post
            .all()
            .execute()
            .then((rows) => (rows ?? []).map((r) => r.id));
          return ids.slice(cursor, cursor + 1);
        },
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      if (lastPage.length === 0) return null;
      return allPages.reduce((sum, page) => sum + page.length, 0);
    },
  });

  const unsubscribe = spec.subscribe(() => {});
  await waitFor(() => spec.current.status === "ready");
  const first = spec.loadMore();
  const second = spec.loadMore();
  await Promise.all([first, second]);
  expect(spec.current).toMatchObject({
    status: "ready",
    pages: [["post_0"], ["post_1"]],
  });
  expect(spec.current).toMatchObject({ status: "ready", isLoadingNext: false });

  unsubscribe();
  spec.dispose();
});

test("pickView handles rows with a __proto__ own property without polluting Object.prototype", () => {
  const db = createStartDbFromSchema(appSchema);
  const postCard = db.view("post", { id: true, title: true });
  const source = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(source, "id", { value: "p1", enumerable: true });
  Object.defineProperty(source, "title", { value: "Hello", enumerable: true });
  Object.defineProperty(source, "__proto__", {
    value: { polluted: true },
    enumerable: true,
    configurable: true,
    writable: true,
  });
  const result = pickView(postCard, source as never);
  expect(result).toEqual({ id: "p1", title: "Hello" });
  expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
});
