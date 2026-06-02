import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import type { DbAction } from "./action.ts";
import { MemoryCollection } from "./collection.ts";
import { createStartDbFromSchema, queryCollection, type StartDb } from "./db.ts";
import type { DbSchema } from "./schema.ts";
import { createDbActionSubmission } from "./transaction.ts";
import type { DbView, InferView } from "./view.ts";

/**
 * Create a {@link StartDb} whose entities are all backed by
 * {@link MemoryCollection} adapters. Useful for tests that want to drive
 * the in-memory executor and undo paths without going through TanStack DB.
 *
 * @typeParam Schema - the schema to instantiate. Inferred from the argument.
 *
 * @example
 * ```ts
 * const db = createMemoryStartDb(schema);
 * await db.a.post.create({ id: "post_1", title: "Hello", likes: 0, secret: "x" });
 * expect(db.q.post.byId("post_1").queryBuilder).toBeUndefined(); // in-memory fallback
 * ```
 */
export function createMemoryStartDb<Schema extends DbSchema>(schema: Schema): StartDb<Schema> {
  return createStartDbFromSchema(schema, {
    collections: () =>
      Object.fromEntries(
        Object.entries(schema.entities).map(([name, definition]) => [
          name,
          queryCollection(name, {
            collection: new MemoryCollection(definition.key),
          }),
        ]),
      ) as never,
  });
}

/**
 * Bulk-insert fixture values into the named collections. Each entry's
 * shape is untyped by design — pass `Partial<EntityOutput<...>>` or the
 * full row. Skips collections that do not exist on the DB.
 *
 * @typeParam Schema - the DB's schema, inferred from `db`.
 * @typeParam Actions - the DB's action map, inferred from `db`.
 *
 * @example
 * ```ts
 * seedCollections(db, {
 *   user: [{ id: "u1", name: "Alice", email: "a@x" }],
 *   post: [{ id: "p1", authorId: "u1", title: "Hello", likes: 0 }],
 * });
 * ```
 */
export function seedCollections<Schema extends DbSchema, Actions extends Record<string, unknown>>(
  db: StartDb<Schema, Actions>,
  values: Readonly<Record<string, ReadonlyArray<Record<string, unknown>>>>,
): void {
  const collections = db.collections as unknown as Record<
    string,
    { insert: (value: Record<string, unknown>) => unknown }
  >;
  for (const [name, entities] of Object.entries(values)) {
    const collection = collections[name];
    if (!collection) continue;
    for (const entity of entities) {
      collection.insert(entity);
    }
  }
}

/**
 * Build a single fixture row shaped to match a view. Useful in tests where
 * the assertion cares about the projected shape and the underlying row's
 * extra fields would just be noise.
 *
 * @typeParam View - the view the fixture is shaped against; the return
 *   type is `InferView<View>`.
 *
 * @example
 * ```ts
 * const card = db.view("user", { id: true, name: true });
 * const row = fixture(card, { id: "u1", name: "Alice" });
 * ```
 */
export function fixture<View extends DbView>(
  _view: View,
  value: Partial<InferView<View>> = {},
): InferView<View> {
  return value as InferView<View>;
}

/**
 * Build a list of `count` fixture rows, invoking `create(index)` to seed
 * each one. Default `create` produces empty `Partial<InferView<View>>`s.
 *
 * @typeParam View - the view the fixtures are shaped against.
 *
 * @example
 * ```ts
 * const cards = listFixture(userCard, 3, (i) => ({ id: `u${i}`, name: `User ${i}` }));
 * ```
 */
export function listFixture<View extends DbView>(
  view: View,
  count: number,
  create: (index: number) => Partial<InferView<View>> = () => ({}),
): ReadonlyArray<InferView<View>> {
  return Array.from({ length: count }, (_, index) => fixture(view, create(index)));
}

/**
 * Wrap a plain async handler as a {@link DbAction}. Use this to mock a
 * single action in unit tests without going through `createAction(...)` and
 * the surrounding tracker machinery. The returned function produces a
 * real {@link DbActionSubmission} on each call, so `isDbActionSubmission`
 * will return `true` and `await action(input)` will resolve with the
 * handler's return value.
 *
 * @typeParam Input - the handler input type. Inferred from `handler`.
 * @typeParam Result - the handler result type. Inferred from `handler`.
 *
 * @example
 * ```ts
 * const likePost = mockDbAction(async ({ postId }: { postId: string }) => {
 *   return { postId, likes: 1 };
 * });
 * const submission = likePost({ postId: "p1" });
 * expect(isDbActionSubmission(submission)).toBe(true);
 * expect(await submission).toEqual({ postId: "p1", likes: 1 });
 * ```
 */
export function mockDbAction<Input, Result>(
  handler: (input: Input) => Result | Promise<Result>,
): DbAction<Input, Result> {
  const action = ((input: Input) =>
    createDbActionSubmission({
      input,
      run: () => handler(input),
    })) as unknown as DbAction<Input, Result>;
  return action;
}

/**
 * Drive a route builder's `.load(...)` for tests. Returns the loader data
 * and snapshot so tests can assert on either.
 *
 * The `route` argument is the value returned by `createDbFileRouteFactory`
 * (or any compatible builder exposing `.load({ params, context })` and
 * `.hydrate(payload, context)`). The `options` shape is a subset of what
 * the official Router loader receives.
 *
 * @typeParam Data - the loader's data shape, inferred from the route.
 *
 * @example
 * ```ts
 * const route = createDbFileRouteFactory(db)
 *   .queries((q) => ({ post: q.post.byId("p1") }))
 *   .build("/posts/$postId");
 *
 * const { data, snapshot } = await renderDbRoute(route, {
 *   params: { postId: "p1" },
 * });
 * expect(data.post).toMatchObject({ id: "p1" });
 * ```
 */
export async function renderDbRoute<Route extends { load: (options: never) => Promise<unknown> }>(
  route: Route,
  options: { readonly params?: Record<string, string>; readonly context?: unknown } = {},
): Promise<{
  readonly route: Route;
  readonly data: Awaited<ReturnType<Route["load"]>>;
}> {
  const data = (await route.load(options as never)) as Awaited<ReturnType<Route["load"]>>;
  return { route, data };
}

/**
 * Render a component factory to its HTML string. The factory is called
 * with the provided `props`. Returns the rendered markup and the props
 * for further assertion.
 *
 * @typeParam Props - the component's props type. Inferred from `component`.
 *
 * @example
 * ```ts
 * const PostTitle = createDbComponent(db)
 *   .props<{ postId: string }>()
 *   .views(({ props, q }) => ({ post: q.post.byId(props.postId) }))
 *   .render(({ post }) => createElement("h2", null, post.title));
 *
 * const { html } = await renderDbComponent(PostTitle, { postId: "p1" });
 * expect(html).toContain("Hello");
 * ```
 */
export async function renderDbComponent<Props extends Record<string, unknown>>(
  component: (props: Props) => ReactNode,
  props: Props,
): Promise<{ readonly html: string; readonly props: Props }> {
  return {
    html: renderToString(createElement(component, props)),
    props,
  };
}

/**
 * Poll a predicate until it returns truthy or the timeout elapses. Uses
 * `setTimeout` between checks; the default interval is 5 ms and the
 * default timeout is 1000 ms.
 *
 * @example
 * ```ts
 * await waitFor(() => observed.length > 0);
 * expect(observed.at(-1)).toMatchObject({ id: "p1" });
 * ```
 */
export async function waitFor(
  predicate: () => unknown,
  options: { readonly intervalMs?: number; readonly timeoutMs?: number } = {},
): Promise<void> {
  const intervalMs = options.intervalMs ?? 5;
  const timeoutMs = options.timeoutMs ?? 1000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms.`);
}

/**
 * Flush `ticks` microtask queues. Useful for settling TanStack DB's
 * `preload()` and other microtask-driven initialization in tests.
 *
 * @example
 * ```ts
 * const submission = db.a.post.create({ id: "p1", title: "Hello", likes: 0, secret: "x" });
 * await flushMicrotasks();
 * expect(submission.status).toBe("persisting");
 * ```
 */
export async function flushMicrotasks(ticks = 1): Promise<void> {
  for (let index = 0; index < ticks; index += 1) {
    await Promise.resolve();
  }
}
