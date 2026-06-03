import {
  createAction,
  createActionTracker,
  type ActionDefinition,
  type ActionTracker,
  type DbAction,
  type Submission,
} from "./action.ts";
import { localStorageCollection as defineLocalStorageCollection } from "./local-storage-collection.ts";
import { syncCollection as defineSyncCollection } from "./sync-collection.ts";
import {
  createDbComponent,
  createDbFileRouteFactory,
  type DbComponentBuilder,
  type DbRouteDefaults,
} from "./react.ts";
import {
  TanStackCollection,
  type DbCollection,
  type DbCollections,
  type DbMutationResult,
  type EntityId,
} from "./collection.ts";
import {
  DbQuerySpec,
  compileQueryFn,
  queryFactory,
  type DbQueryOptions,
  type QueryFactory,
  type QueryBuild,
} from "./query.ts";
import type {
  DbSchema,
  EntityDefinition,
  EntityInput,
  EntityName,
  EntityOutput,
  StandardSchemaResult,
  StandardSchemaV1,
} from "./schema.ts";
import {
  compileViewSelect,
  defineView,
  defineViewFragment,
  hasNestedViews,
  type DbView,
  type SelectionResult,
  type ViewSelection,
} from "./view.ts";
import type { Collection } from "@tanstack/db";
import { eq } from "@tanstack/db";

type EntityRecord<Entity extends EntityDefinition> =
  EntityOutput<Entity> extends Record<string, unknown>
    ? EntityOutput<Entity>
    : Record<string, unknown>;

/**
 * The full set of options an entity's collection adapter can be built
 * with. Either pass a fully built `DbCollection` via `collection`, a
 * factory via `createCollection`, or a plain `initialValues` array. The
 * `mutations` field forwards `insert`/`update`/`delete` payloads to the
 * generated CRUD actions; the per-entity sugar
 * ({@link queryCollection}, {@link localStorageCollection},
 * {@link syncCollection}) wraps these into a one-liner.
 *
 * @typeParam Value - the entity row shape.
 */
export interface QueryCollectionOptions<Value extends Record<string, unknown>> {
  readonly collection?: DbCollection<Value> | DbCollection<Record<string, unknown>>;
  readonly createCollection?: (options: {
    readonly key: string;
    readonly schema: StandardSchemaV1<unknown, Value>;
  }) => DbCollection<Value> | DbCollection<Record<string, unknown>>;
  readonly initialValues?: ReadonlyArray<Value>;
  readonly queryKey?: ReadonlyArray<unknown>;
  readonly queryFn?: () => ReadonlyArray<Value> | Promise<ReadonlyArray<Value>>;
  readonly mutations?: {
    readonly insert?: (value: Value) => unknown;
    readonly update?: (value: Value) => unknown;
    readonly delete?: (id: EntityId) => unknown;
  };
}

/**
 * The definition object produced by {@link queryCollection},
 * {@link localStorageCollection}, and {@link syncCollection}. Carries
 * the {@link QueryCollectionOptions} so {@link createStartDbFromSchema}
 * can wire the collection, validate inputs, and forward mutations to
 * the generated CRUD actions.
 *
 * @typeParam Value - the entity row shape.
 */
export interface QueryCollectionDefinition<Value extends Record<string, unknown>> {
  readonly options: QueryCollectionOptions<Value>;
}

/**
 * The four generated CRUD actions for an entity. Each is a
 * {@link DbAction} that validates the input against the entity's
 * `StandardSchema`, calls the configured `mutations.insert/update/delete`
 * if any, and finally applies the change to the underlying collection
 * (recording the transaction on the resulting {@link DbActionSubmission}).
 *
 * - `create(value)` — insert a new row.
 * - `patch({ id, changes })` — read-modify-write a row by id.
 * - `update({ id, value })` — replace a row by id with the full new
 *   value.
 * - `delete({ id })` — remove a row by id; returns the prior value
 *   or `undefined` if the row was missing.
 *
 * @typeParam Value - the entity row shape.
 */
export interface GeneratedEntityActions<
  Input extends Record<string, unknown> = Record<string, unknown>,
  Output extends Record<string, unknown> = Input,
> {
  readonly create: DbAction<Input, Output>;
  readonly patch: DbAction<{ readonly id: EntityId; readonly changes: Partial<Input> }, Output>;
  readonly update: DbAction<{ readonly id: EntityId; readonly value: Input }, Output>;
  readonly delete: DbAction<{ readonly id: EntityId }, Output | undefined>;
}

/** Internal: strip the trailing `Id` from an index name so
 * `byAuthorId` becomes `byAuthor`. */
type StripId<Name extends string> = Name extends `${infer Prefix}Id` ? Prefix : Name;

/** Internal: per-index query helpers. `byAuthor(authorId)` returns a
 * list of rows where the `authorId` column matches the argument. */
type IndexedQueryHelpers<Entity extends EntityDefinition> = {
  [IndexName in Entity["indexes"][number] as `by${Capitalize<StripId<IndexName>>}`]: (
    value: IndexName extends keyof EntityOutput<Entity> ? EntityOutput<Entity>[IndexName] : unknown,
  ) => DbQuerySpec<ReadonlyArray<EntityOutput<Entity>>>;
};

/** Internal: per-relationship query helpers. `posts(authorId)` returns
 * the related rows (one or many, depending on the relationship's
 * `kind`). */
type RelationshipQueryResult<
  Schema extends DbSchema,
  Relationship extends { readonly entity: string; readonly kind: string },
> =
  Relationship["entity"] extends EntityName<Schema>
    ? Relationship["kind"] extends "many"
      ? ReadonlyArray<EntityOutput<Schema["entities"][Relationship["entity"]]>>
      : EntityOutput<Schema["entities"][Relationship["entity"]]> | undefined
    : unknown;

type RelationshipQueryHelpers<Schema extends DbSchema, Entity extends EntityDefinition> = {
  [Name in keyof Entity["relationships"]]: (
    id: EntityId,
  ) => DbQuerySpec<RelationshipQueryResult<Schema, Entity["relationships"][Name]>>;
};

/**
 * The generated query helpers for a single entity.
 *
 * - `byId(id)` — single-row lookup, `cardinality: "optional"`.
 * - `all()` — full collection, `cardinality: "many"`.
 * - `by<Index>(value)` — one helper per `indexes` entry, returning the
 *   list of matching rows.
 * - `<relationship>(id)` — one helper per `relationships` entry,
 *   returning the related row(s).
 *
 * Each helper is itself a {@link DbQuerySpec} and supports the
 * `.as`, `.select`, `.one`, `.optional`, `.many`, `.infinite`,
 * `.live`, `.static`, `.defer`, `.preloadOnly`, `.required`, and
 * `.field` chainables.
 *
 * @typeParam Entity - the entity definition, inferred from the schema.
 */
export type GeneratedEntityQueries<
  Entity extends EntityDefinition,
  Schema extends DbSchema = DbSchema,
> = {
  byId(id: EntityId): DbQuerySpec<EntityOutput<Entity> | undefined>;
  get(id: EntityId): DbQuerySpec<EntityOutput<Entity> | undefined>;
  require(id: EntityId): DbQuerySpec<NonNullable<EntityOutput<Entity>>>;
  all(): DbQuerySpec<ReadonlyArray<EntityOutput<Entity>>>;
  list(): DbQuerySpec<ReadonlyArray<EntityOutput<Entity>>>;
} & IndexedQueryHelpers<Entity> &
  RelationshipQueryHelpers<Schema, Entity>;

type EntityInputRecord<Entity extends EntityDefinition> =
  EntityInput<Entity> extends Record<string, unknown>
    ? EntityInput<Entity>
    : Record<string, unknown>;

/** Internal: map every entity in `Schema` to its
 * {@link GeneratedEntityActions}. */
type GeneratedActions<Schema extends DbSchema> = {
  readonly [Name in EntityName<Schema>]: GeneratedEntityActions<
    EntityInputRecord<Schema["entities"][Name]>,
    EntityRecord<Schema["entities"][Name]>
  >;
};

/** Internal: map every entity in `Schema` to its
 * {@link GeneratedEntityQueries}, plus a `raw` query factory. */
type GeneratedQueries<Schema extends DbSchema> = {
  readonly [Name in EntityName<Schema>]: GeneratedEntityQueries<Schema["entities"][Name], Schema>;
} & {
  raw: QueryFactory["raw"];
};

type QuerySpecMap = Record<string, DbQuerySpec>;

type QueryBundleData<Queries extends QuerySpecMap> = {
  readonly [Name in keyof Queries]: Awaited<ReturnType<Queries[Name]["execute"]>>;
};

const queryBundleStagesKey = "__tanstackstartDbQueryBundleStages";

export type DbQueryBundleContext<
  Q = unknown,
  Data extends Record<string, unknown> = Record<string, never>,
> = {
  readonly q: Q;
  readonly data: Data;
  readonly params: Record<string, string>;
  readonly context?: unknown;
};

export type DbQueryBundleStage = (context: DbQueryBundleContext) => QuerySpecMap;

/**
 * A reusable bundle of named query specs. Bundles are callable so they can be
 * passed directly to route `.queries(...)` / `.views(...)`, and they also expose
 * `.execute()` / `.preload()` for scripts, tests, and non-route code.
 *
 * A bundle does not introduce a new cache layer. It is just a stable named set
 * of {@link DbQuerySpec}s.
 */
export interface DbQueryBundle<Queries extends QuerySpecMap = QuerySpecMap, Q = unknown> {
  (context?: Partial<DbQueryBundleContext>): Queries;
  readonly [queryBundleStagesKey]?: ReadonlyArray<DbQueryBundleStage>;
  readonly queries: Queries;
  keys(options?: { readonly params?: Record<string, string>; readonly context?: unknown }): {
    readonly [Name in keyof Queries]: ReturnType<Queries[Name]["key"]>;
  };
  execute(options?: {
    readonly params?: Record<string, string>;
    readonly context?: unknown;
  }): Promise<QueryBundleData<Queries>>;
  preload(options?: {
    readonly params?: Record<string, string>;
    readonly context?: unknown;
  }): Promise<void>;
  extend<NextQueries extends QuerySpecMap>(
    factory: (context: DbQueryBundleContext<Q, QueryBundleData<Queries>>) => NextQueries,
  ): DbQueryBundle<Queries & NextQueries, Q>;
  route(
    path: string,
    options?: DbRouteDefaults,
  ): ReturnType<ReturnType<typeof createDbFileRouteFactory>>;
}

/** Internal: map every entity in `Schema` to its {@link DbCollection}. */
type SchemaCollections<Schema extends DbSchema> = {
  readonly [Name in EntityName<Schema>]: DbCollection<EntityRecord<Schema["entities"][Name]>>;
};

/** Internal: map every entity in `Schema` to its
 * {@link QueryCollectionDefinition}. The untyped `Record<string, unknown>`
 * branch exists so callers can pass a more permissive definition
 * (e.g. an Electric collection that doesn't yet narrow to the entity
 * shape). */
type SchemaCollectionDefinitions<Schema extends DbSchema> = {
  readonly [Name in EntityName<Schema>]:
    | QueryCollectionDefinition<EntityRecord<Schema["entities"][Name]>>
    | QueryCollectionDefinition<Record<string, unknown>>;
};

/**
 * Reactive surface for tracking in-flight actions and queries. The
 * `useDbPending` / `useDbSubmissions` React hooks read from the same
 * tracker.
 *
 * - `any()` — `true` if any action submission is currently pending.
 * - `action(name, input?)` — `true` if a submission for the given
 *   action is pending; `input` narrows the match to a specific
 *   payload (compared via `JSON.stringify`).
 * - `field(entity, field)` — `true` if any affected query is tagged
 *   with the given `field` (`.field("x")` on the spec). If `entity`
 *   is `{ id }`, only the queries whose `key()` includes that id are
 *   considered.
 * - `query(name)` — `true` if a query whose `key()` includes `name`
 *   is currently loading (initial live preload, or touched by a
 *   pending action).
 */
export interface PendingApi {
  any(): boolean;
  action(name: string, input?: unknown): boolean;
  field(entity: unknown, field: string): boolean;
  query(_name: string): boolean;
}

/**
 * Submission browser. Every successful or failed action call records a
 * {@link Submission} on the tracker, scoped by action name.
 *
 * - `latest(name)` — the most recent submission, if any.
 * - `all(name)` — every submission recorded for the action.
 * - `forInput(name, input)` — every submission whose `input` matches
 *   the given payload (compared via `JSON.stringify`).
 */
export interface SubmissionsApi {
  latest(name: string): Submission | undefined;
  all(name: string): ReadonlyArray<Submission>;
  forInput(name: string, input: unknown): ReadonlyArray<Submission>;
}

/**
 * The DB object returned by {@link createStartDb} and
 * {@link createStartDbFromSchema}. Carries the schema, the typed
 * collections, the generated `q.<entity>.*` query helpers, the
 * generated `a.<entity>.create/patch/update/delete` actions, and the
 * {@link PendingApi} / {@link SubmissionsApi} surfaces.
 *
 * - `view(entityName, selection)` — build a {@link DbView} from a
 *   {@link ViewSelection}.
 * - `viewFragment` — re-export of {@link defineViewFragment} for
 *   inline use.
 * - `extendActions(factory)` — return a new DB with extra action
 *   namespaces merged into `a`. Useful for adding application-level
 *   actions on top of the generated CRUD.
 *
 * @typeParam Schema - the DB's schema, inferred from `createStartDb`.
 * @typeParam Actions - the DB's action map; defaults to the generated
 *   CRUD for every entity in `Schema`.
 */
export interface StartDb<
  Schema extends DbSchema = DbSchema,
  Actions extends Record<string, unknown> = GeneratedActions<Schema>,
> {
  readonly schema: Schema;
  readonly collections: SchemaCollections<Schema>;
  readonly q: GeneratedQueries<Schema>;
  readonly a: Actions;
  readonly pending: PendingApi;
  readonly submissions: SubmissionsApi;
  /**
   * Build a {@link DbView} by selecting fields and relationships from
   * `entityName`. The selection is type-checked against the entity's
   * declared `relationships` so unknown names are rejected.
   *
   * @example
   * ```ts
   * const userCard = db.view("user", {
   *   id: true,
   *   name: true,
   *   posts: { id: true, title: true },
   * });
   * ```
   */
  view<
    Name extends EntityName<Schema>,
    const Selection extends ViewSelection<
      EntityRecord<Schema["entities"][Name]>,
      Schema["entities"][Name]["relationships"]
    >,
  >(
    entityName: Name,
    selection: Selection,
  ): DbView<
    EntityRecord<Schema["entities"][Name]>,
    SelectionResult<
      EntityRecord<Schema["entities"][Name]>,
      Selection,
      Schema["entities"][Name]["relationships"]
    >,
    Name
  >;
  viewFragment: typeof defineViewFragment;
  entity<Name extends EntityName<Schema>>(
    entityName: Name,
  ): {
    view<
      const Selection extends ViewSelection<
        EntityRecord<Schema["entities"][Name]>,
        Schema["entities"][Name]["relationships"]
      >,
    >(
      selection: Selection,
    ): DbView<
      EntityRecord<Schema["entities"][Name]>,
      SelectionResult<
        EntityRecord<Schema["entities"][Name]>,
        Selection,
        Schema["entities"][Name]["relationships"]
      >,
      Name
    >;
    pick<const Fields extends ReadonlyArray<keyof EntityRecord<Schema["entities"][Name]> & string>>(
      ...fields: Fields
    ): DbView<
      EntityRecord<Schema["entities"][Name]>,
      Pick<EntityRecord<Schema["entities"][Name]>, Fields[number]>,
      Name
    >;
  };
  /**
   * Build a render-bound component for a {@link DbView}. Mirrors the
   * {@link createDbComponent} view-bound overload but reads the DB
   * from the call site rather than as an argument, so the render
   * callback only needs to receive the projected row.
   *
   * @example
   * ```ts
   * const PostCard = db.component(PostCardView)(({ post }) => (
   *   <article>
   *     <h2>{post.title}</h2>
   *     <p>{post.likes} likes</p>
   *   </article>
   * ));
   * ```
   */
  component<View extends DbView>(view: View): DbComponentBuilder<View>;
  /**
   * Build a reusable bundle of named query specs. The returned bundle can be
   * executed directly or passed to a route builder:
   *
   * @example
   * ```ts
   * const postPage = db.request(({ q }) => ({
   *   post: q.post.byId("post_1").required(),
   *   comments: q.comment.byPost("post_1"),
   * }));
   *
   * const data = await postPage.execute();
   * createDbFileRoute("/posts/$postId").views(postPage);
   * ```
   */
  request<Queries extends QuerySpecMap>(
    factory: (context: DbQueryBundleContext<GeneratedQueries<Schema>>) => Queries,
  ): DbQueryBundle<Queries, GeneratedQueries<Schema>>;
  action<Input, Result>(
    name: string,
    definition: ActionDefinition<Input, Result>,
  ): DbAction<Input, Result>;
  /**
   * Build a new {@link StartDb} with extra action namespaces merged
   * into `a`. The factory receives the current `a`, an `action(definition)`
   * helper to build new actions, the typed collections `c`, and the
   * generated queries `q`. Return an object whose keys are nested
   * namespaces (e.g. `{ workflow: { approve, reject } }`); the result
   * is deep-merged into the existing `a` tree.
   *
   * @example
   * ```ts
   * const db2 = db.extendActions(({ action, c, q }) => ({
   *   workflow: {
   *     approve: action({
   *       run: async ({ input }) => {
   *         await c.post.update(input.id, (p) => ({ ...p, approved: true }));
   *         return q.post.byId(input.id);
   *       },
   *     }),
   *   },
   * }));
   * db2.a.workflow.approve({ id: "p1" });
   * ```
   */
  extendActions<Extended extends Record<string, unknown>>(
    factory: (context: {
      readonly a: Actions;
      readonly action: <Input, Result>(
        definition: ActionDefinition<Input, Result>,
      ) => DbAction<Input, Result>;
      readonly c: SchemaCollections<Schema>;
      readonly q: GeneratedQueries<Schema>;
    }) => Extended,
  ): StartDb<Schema, Actions & Extended>;
}

function inputMatches(left: unknown, right: unknown): boolean {
  if (right === undefined) return true;
  return JSON.stringify(left) === JSON.stringify(right);
}

function createPendingApi(tracker: ActionTracker): PendingApi {
  const affectedQueries = () =>
    [...tracker.pending].flatMap((submission) =>
      Array.isArray(submission.affected) ? submission.affected : [],
    );
  return {
    any: () => tracker.pending.size > 0,
    action: (name, input) =>
      [...tracker.pending].some(
        (submission) =>
          tracker.submissions.get(name)?.includes(submission) &&
          inputMatches(submission.input, input),
      ),
    field: (entity, field) =>
      affectedQueries().some((affected) => {
        if (!(affected instanceof DbQuerySpec) || affected.metadata.field !== field) {
          return false;
        }
        if (typeof entity !== "object" || entity === null || !("id" in entity)) {
          return true;
        }
        return affected.key().includes(entity.id);
      }),
    query: (name) =>
      affectedQueries().some(
        (affected) => affected instanceof DbQuerySpec && affected.key().includes(name),
      ) || tracker.liveQueries.isLoading(name),
  };
}

function createSubmissionsApi(tracker: ActionTracker): SubmissionsApi {
  return {
    latest: (name) => tracker.submissions.get(name)?.at(-1),
    all: (name) => tracker.submissions.get(name) ?? [],
    forInput: (name, input) =>
      (tracker.submissions.get(name) ?? []).filter((submission) =>
        inputMatches(submission.input, input),
      ),
  };
}

function createQueryBundle<Queries extends QuerySpecMap, Q>(
  q: Q,
  stages: ReadonlyArray<DbQueryBundleStage>,
  routeFactory: ReturnType<typeof createDbFileRouteFactory>,
): DbQueryBundle<Queries, Q> {
  const buildContext = (
    options: Partial<DbQueryBundleContext> = {},
    data: Record<string, unknown> = {},
  ): DbQueryBundleContext => ({
    q,
    data: data as never,
    params: options.params ?? {},
    context: options.context,
  });
  const build = (options: Partial<DbQueryBundleContext> = {}): Queries => {
    if (stages.length > 1) {
      throw new Error(
        "Staged query bundles cannot be inspected synchronously. Use execute(), preload(), or pass the bundle to a route builder.",
      );
    }
    const data: Record<string, unknown> = {};
    for (const stage of stages) {
      const queries = stage(buildContext(options, data));
      Object.assign(data, queries);
    }
    return data as unknown as Queries;
  };
  const executeStages = async (
    options: { readonly params?: Record<string, string>; readonly context?: unknown } = {},
  ): Promise<QueryBundleData<Queries>> => {
    const data: Record<string, unknown> = {};
    for (const stage of stages) {
      const queries = stage(buildContext(options, data));
      const entries = await Promise.all(
        Object.entries(queries).map(async ([name, query]) => [name, await query.execute()]),
      );
      Object.assign(data, Object.fromEntries(entries));
    }
    return data as QueryBundleData<Queries>;
  };
  const bundle = ((context?: Partial<DbQueryBundleContext>) => {
    if (context && "q" in context) {
      return stages.at(-1)?.(context as DbQueryBundleContext) ?? {};
    }
    return build(context);
  }) as DbQueryBundle<Queries, Q>;
  Object.defineProperties(bundle, {
    [queryBundleStagesKey]: { value: stages },
    queries: { get: () => build(), enumerable: true },
    keys: {
      value: (
        options: { readonly params?: Record<string, string>; readonly context?: unknown } = {},
      ) => {
        const queries = build(options);
        return Object.fromEntries(
          Object.entries(queries).map(([name, query]) => [name, query.key()]),
        ) as {
          readonly [Name in keyof Queries]: ReturnType<Queries[Name]["key"]>;
        };
      },
    },
    execute: {
      value: executeStages,
    },
    preload: {
      value: async (
        options: { readonly params?: Record<string, string>; readonly context?: unknown } = {},
      ) => {
        await executeStages(options);
      },
    },
    extend: {
      value: <NextQueries extends QuerySpecMap>(
        factory: (context: DbQueryBundleContext<Q, QueryBundleData<Queries>>) => NextQueries,
      ) =>
        createQueryBundle<Queries & NextQueries, Q>(
          q,
          [...stages, factory as unknown as DbQueryBundleStage],
          routeFactory,
        ),
    },
    route: {
      value: (path: string, options?: DbRouteDefaults) => {
        const route = routeFactory(path).views(bundle);
        return options ? route.options(options) : route;
      },
    },
  });
  return bundle;
}

function mergeActionNamespaces(
  base: Record<string, unknown>,
  extension: Record<string, unknown>,
  path: ReadonlyArray<string> = [],
): Record<string, unknown> {
  const merged = { ...base };
  for (const [name, value] of Object.entries(extension)) {
    const nextPath = [...path, name];
    if (typeof value === "function" && "__setActionName" in value) {
      (value as DbAction<unknown, unknown>).__setActionName(nextPath.join("."));
      merged[name] = value;
    } else if (typeof value === "object" && value !== null) {
      merged[name] = mergeActionNamespaces(
        (merged[name] as Record<string, unknown> | undefined) ?? {},
        value as Record<string, unknown>,
        nextPath,
      );
    } else {
      merged[name] = value;
    }
  }
  return merged;
}

interface ViewSelectWithJoins {
  readonly joins: ReadonlyArray<{
    readonly source: Record<string, Collection<Record<string, unknown>, EntityId>>;
    readonly on: (refs: Record<string, unknown>) => unknown;
    readonly type: "left";
  }>;
  readonly select: (refs: Record<string, unknown>) => Record<string, unknown>;
}

function buildViewSelectWithJoins<Schema extends DbSchema>(
  schema: Schema,
  collections: SchemaCollections<Schema>,
  view: DbView,
  sourceAlias: string,
): ViewSelectWithJoins | undefined {
  const definition = schema.entities[view.entity];
  const joins: Array<{
    readonly source: Record<string, Collection<Record<string, unknown>, EntityId>>;
    readonly on: (refs: Record<string, unknown>) => unknown;
    readonly type: "left";
  }> = [];
  const foldableAliases = new Map<string, string>();
  for (const [name, nested] of Object.entries(view.selection)) {
    if (nested === true) continue;
    const relationship = definition?.relationships[name];
    if (!relationship || relationship.kind !== "one") continue;
    const relatedCollection = collections[relationship.entity];
    const relatedEngine = relatedCollection?.engine;
    if (!relatedEngine) continue;
    const relatedAlias = `${sourceAlias}__${name}`;
    const relatedCast = relatedEngine as unknown as Collection<Record<string, unknown>, EntityId>;
    joins.push({
      source: { [relatedAlias]: relatedCast },
      on: (refs: Record<string, unknown>) =>
        eq(
          (refs[relatedAlias] as Record<string, unknown>)[relationship.foreign],
          (refs[sourceAlias] as Record<string, unknown>)[relationship.local],
        ),
      type: "left",
    });
    foldableAliases.set(name, relatedAlias);
  }
  if (joins.length === 0) return undefined;
  const select = (refs: Record<string, unknown>) => {
    const result: Record<string, unknown> = {};
    for (const [name, nested] of Object.entries(view.selection)) {
      if (nested === true) {
        const row = refs[sourceAlias] as Record<string, unknown> | undefined;
        result[name] = row ? row[name] : undefined;
        continue;
      }
      const relatedAlias = foldableAliases.get(name);
      if (relatedAlias) {
        const related = refs[relatedAlias];
        result[name] = related == null ? undefined : related;
        continue;
      }
      void nested;
      result[name] = undefined;
    }
    return result;
  };
  return { joins, select };
}

function buildGeneratedQueries<Schema extends DbSchema>(
  schema: Schema,
  collections: SchemaCollections<Schema>,
  tracker: ActionTracker,
): GeneratedQueries<Schema> {
  const q: Record<string, unknown> = {
    raw: <Result>(options: DbQueryOptions<Result>) => queryFactory.raw<Result>(options),
  };

  for (const [entityName, definition] of Object.entries(schema.entities)) {
    const collection = collections[entityName as EntityName<Schema>];
    const nativeEngine = collection.engine;
    const useNative = nativeEngine !== undefined;
    const alias = entityName;
    const sourceCollection = nativeEngine as unknown as
      | Collection<Record<string, unknown>, EntityId>
      | undefined;

    const buildViewSelect = (view: DbView): unknown => compileViewSelect(view, alias) as never;
    const buildJoinView = (view: DbView): ViewSelectWithJoins | undefined =>
      buildViewSelectWithJoins(schema, collections, view, alias);
    const resolveView = (view: DbView, value: unknown): unknown =>
      materializeView(schema, collections, view, value);
    const subscribeView = (view: DbView, onChange: () => void): (() => void) =>
      subscribeViewRelationships(schema, collections, view, onChange);

    const applyViewChain = (chain: unknown, view: DbView | undefined): unknown => {
      if (!view) return chain;
      const joinInfo = buildJoinView(view);
      let next: unknown = chain;
      if (joinInfo) {
        for (const join of joinInfo.joins) {
          next = (
            next as {
              join: (
                source: Record<string, Collection<Record<string, unknown>, EntityId>>,
                on: (refs: Record<string, unknown>) => unknown,
                type: "left",
              ) => typeof next;
            }
          ).join(join.source, join.on, join.type);
        }
        return (
          next as {
            select: (cb: (refs: Record<string, unknown>) => unknown) => unknown;
          }
        ).select(joinInfo.select);
      }
      if (!hasNestedViews(view)) {
        return (
          next as {
            select: (cb: (refs: Record<string, unknown>) => unknown) => unknown;
          }
        ).select(buildViewSelect(view) as (refs: Record<string, unknown>) => unknown);
      }
      return next;
    };

    const byId = (id: EntityId) => {
      if (useNative && sourceCollection) {
        const viewBuild: QueryBuild = (view) => {
          return compileQueryFn(sourceCollection, (q) => {
            const base = q
              .from({ [alias]: sourceCollection })
              .where(({ [alias]: row }: Record<string, unknown>) =>
                eq((row as Record<string, unknown>)[definition.key], id),
              );
            return (
              applyViewChain(base, view) as {
                findOne: () => unknown;
              }
            ).findOne();
          });
        };
        return new DbQuerySpec(
          { key: [entityName, "byId", id], scope: sourceCollection },
          { cardinality: "optional" },
          {
            queryBuilder: viewBuild(),
            viewBuild,
            resolveView,
            subscribeView,
            liveQueryTracker: tracker.liveQueries,
          },
        );
      }
      return new DbQuerySpec({
        key: [entityName, "byId", id],
        execute: () => collection.get(id),
      });
    };
    const all = () => {
      if (useNative && sourceCollection) {
        const viewBuild: QueryBuild = (view) => {
          return compileQueryFn(sourceCollection, (q) => {
            const base = q.from({ [alias]: sourceCollection });
            return applyViewChain(base, view);
          });
        };
        return new DbQuerySpec(
          { key: [entityName, "all"], scope: sourceCollection },
          { cardinality: "many" },
          {
            queryBuilder: viewBuild(),
            viewBuild,
            resolveView,
            subscribeView,
            liveQueryTracker: tracker.liveQueries,
          },
        );
      }
      return new DbQuerySpec(
        {
          key: [entityName, "all"],
          execute: () => collection.values(),
        },
        { cardinality: "many" },
      );
    };
    const queries: Record<string, unknown> = {
      byId,
      get: byId,
      require: (id: EntityId) => byId(id).required(),
      all,
      list: all,
    };

    for (const indexName of definition.indexes) {
      const helperName = indexName.endsWith("Id") ? indexName.slice(0, -2) : indexName;
      const methodName = `by${helperName[0]?.toUpperCase() ?? ""}${helperName.slice(1)}`;
      queries[methodName] = (value: unknown) => {
        if (useNative && sourceCollection) {
          const viewBuild: QueryBuild = (view) => {
            return compileQueryFn(sourceCollection, (q) => {
              const base = q
                .from({ [alias]: sourceCollection })
                .where(({ [alias]: row }: Record<string, unknown>) =>
                  eq((row as Record<string, unknown>)[indexName], value),
                );
              return applyViewChain(base, view);
            });
          };
          return new DbQuerySpec(
            { key: [entityName, methodName, value], scope: sourceCollection },
            { cardinality: "many" },
            {
              queryBuilder: viewBuild(),
              viewBuild,
              resolveView,
              subscribeView,
              liveQueryTracker: tracker.liveQueries,
            },
          );
        }
        return new DbQuerySpec(
          {
            key: [entityName, methodName, value],
            execute: () => collection.values().filter((entity) => entity[indexName] === value),
          },
          { cardinality: "many" },
        );
      };
    }

    for (const [relationshipName, relationship] of Object.entries(definition.relationships)) {
      const relatedCollection = collections[relationship.entity as EntityName<Schema>];
      if (!relatedCollection) continue;
      const relatedEngine = relatedCollection.engine;
      const relatedCast = relatedEngine as unknown as
        | Collection<Record<string, unknown>, EntityId>
        | undefined;
      const useNativeRelationship =
        useNative && sourceCollection !== undefined && relatedCast !== undefined;
      const relatedAlias = `${entityName}__${relationshipName}`;

      const inMemoryQuery = (innerId: EntityId) =>
        new DbQuerySpec(
          {
            key: [entityName, relationshipName, innerId],
            execute: () => {
              const source = collection.get(innerId);
              if (!source) return relationship.kind === "many" ? [] : undefined;
              const localValue = source[relationship.local];
              if (relationship.kind === "one") {
                return relatedCollection
                  .values()
                  .find((entity) => entity[relationship.foreign] === localValue);
              }
              return relatedCollection
                .values()
                .filter((entity) => entity[relationship.foreign] === localValue);
            },
          },
          { cardinality: relationship.kind === "many" ? "many" : "optional" },
        );

      if (!useNativeRelationship) {
        queries[relationshipName] = inMemoryQuery;
        continue;
      }

      const localField = relationship.local;
      const foreignField = relationship.foreign;
      const buildRelatedViewSelect = (view: DbView): unknown =>
        compileViewSelect(view, relatedAlias) as never;
      queries[relationshipName] = (id: EntityId) => {
        const viewBuild: QueryBuild = (view) => {
          const selectCb = view && !hasNestedViews(view) ? buildRelatedViewSelect(view) : undefined;
          return (q) => {
            const base = (
              q as unknown as {
                from: (source: Record<string, unknown>) => {
                  where: (cb: (refs: Record<string, unknown>) => unknown) => {
                    join: (
                      source: Record<string, unknown>,
                      on: (refs: Record<string, unknown>) => unknown,
                      kind: "left" | "inner" | "right" | "full",
                    ) => {
                      select: (cb: (refs: Record<string, unknown>) => unknown) => {
                        findOne?: () => unknown;
                      };
                    };
                  };
                };
              }
            ).from({ [alias]: sourceCollection });
            const filtered = base.where(({ [alias]: row }: Record<string, unknown>) =>
              eq((row as Record<string, unknown>)[definition.key], id),
            );
            const joined = filtered.join(
              { [relatedAlias]: relatedCast },
              ({ [relatedAlias]: related, [alias]: row }: Record<string, unknown>) =>
                eq(
                  (related as Record<string, unknown>)[foreignField],
                  (row as Record<string, unknown>)[localField],
                ),
              "left",
            );
            const projected = joined.select(
              (selectCb ?? ((refs: Record<string, unknown>) => refs[relatedAlias])) as never,
            );
            if (relationship.kind === "one") {
              return projected.findOne!();
            }
            return projected;
          };
        };
        return new DbQuerySpec(
          { key: [entityName, relationshipName, id], scope: sourceCollection },
          { cardinality: relationship.kind === "many" ? "many" : "optional" },
          {
            queryBuilder: viewBuild(),
            viewBuild,
            resolveView,
            subscribeView,
            liveQueryTracker: tracker.liveQueries,
          },
        );
      };
    }
    q[entityName] = queries;
  }

  return q as GeneratedQueries<Schema>;
}

function materializeView<Schema extends DbSchema>(
  schema: Schema,
  collections: SchemaCollections<Schema>,
  view: DbView,
  value: unknown,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => materializeView(schema, collections, view, item));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }

  const source = value as Record<string, unknown>;
  const definition = schema.entities[view.entity];
  const result: Record<string, unknown> = {};
  for (const [name, nested] of Object.entries(view.selection)) {
    if (nested === true) {
      result[name] = source[name];
      continue;
    }
    const relationship = definition?.relationships[name];
    const relatedCollection = relationship && collections[relationship.entity];
    if (!relationship || !relatedCollection) {
      result[name] = relationship?.kind === "many" ? [] : undefined;
      continue;
    }
    if (relationship.kind === "one") {
      const joined = source[name];
      if (typeof joined === "object" && joined !== null && !Array.isArray(joined)) {
        result[name] = materializeView(schema, collections, nested, joined);
        continue;
      }
      const localValue = source[relationship.local];
      const firstMatch = relatedCollection
        .values()
        .find((entity) => entity[relationship.foreign] === localValue);
      result[name] = materializeView(schema, collections, nested, firstMatch);
      continue;
    }
    const localValue = source[relationship.local];
    const related = relatedCollection
      .values()
      .filter((entity) => entity[relationship.foreign] === localValue);
    result[name] = materializeView(schema, collections, nested, related);
  }
  return result;
}

function subscribeViewRelationships<Schema extends DbSchema>(
  schema: Schema,
  collections: SchemaCollections<Schema>,
  view: DbView,
  onChange: () => void,
): () => void {
  const engines = new Set<Collection<Record<string, unknown>, EntityId>>();
  collectViewRelationshipEngines(schema, collections, view, engines);
  const subscriptions = [...engines].map((engine) => engine.subscribeChanges(onChange));
  return () => {
    for (const subscription of subscriptions) {
      subscription.unsubscribe();
    }
  };
}

function collectViewRelationshipEngines<Schema extends DbSchema>(
  schema: Schema,
  collections: SchemaCollections<Schema>,
  view: DbView,
  engines: Set<Collection<Record<string, unknown>, EntityId>>,
): void {
  const definition = schema.entities[view.entity];
  for (const [name, nested] of Object.entries(view.selection)) {
    if (nested === true) continue;
    const relationship = definition?.relationships[name];
    const engine = relationship && collections[relationship.entity]?.engine;
    if (engine) {
      engines.add(engine as unknown as Collection<Record<string, unknown>, EntityId>);
    }
    collectViewRelationshipEngines(schema, collections, nested, engines);
  }
}

function buildGeneratedActions<Schema extends DbSchema>(
  schema: Schema,
  collections: SchemaCollections<Schema>,
  tracker: ActionTracker,
  q: GeneratedQueries<Schema>,
  configuredCollections: Partial<
    Record<EntityName<Schema>, QueryCollectionDefinition<Record<string, unknown>>>
  >,
): GeneratedActions<Schema> {
  const actions: Record<string, GeneratedEntityActions> = {};
  const runtimeCollections = collections as unknown as DbCollections;

  for (const entityName of Object.keys(schema.entities)) {
    const collection = runtimeCollections[entityName]!;
    const definition = schema.entities[entityName]!;
    const entityNameTyped = entityName as EntityName<Schema>;
    const entityQueries = q[entityNameTyped];
    const mutations = configuredCollections[entityNameTyped]?.options.mutations;
    const assertKey = (value: Record<string, unknown>, expected?: EntityId): void => {
      const key = value[definition.key];
      if (typeof key !== "string" && typeof key !== "number") {
        throw new Error(`Collection value is missing key "${definition.key}".`);
      }
      if (expected !== undefined && key !== expected) {
        throw new Error(`Collection key "${definition.key}" cannot be changed.`);
      }
    };
    const validate = async (input: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const result = (await definition.schema["~standard"].validate(input)) as StandardSchemaResult<
        Record<string, unknown>
      >;
      if (result.issues) {
        throw new Error(
          result.issues.map((issue) => issue.message).join(", ") ||
            `Validation failed for "${entityName}".`,
        );
      }
      return result.value;
    };
    const action = <Input, Result>(name: string, definition: ActionDefinition<Input, Result>) =>
      createAction(definition, {
        collections: runtimeCollections,
        tracker,
        name: `${entityName}.${name}`,
        q,
      });
    const returnPersisted = async <Value>(
      mutation: DbMutationResult<Value>,
      setTransaction: (transaction: typeof mutation.transaction) => void,
    ): Promise<Value> => {
      setTransaction(mutation.transaction);
      await mutation.transaction?.isPersisted.promise;
      return mutation.value as Value;
    };

    actions[entityName] = {
      create: action("create", {
        affects: () => [entityQueries.all()],
        run: async (context) => {
          const value = await validate(context.input);
          assertKey(value);
          await mutations?.insert?.(value);
          return returnPersisted<Record<string, unknown>>(collection.insert(value), (transaction) =>
            context.setTransaction(transaction),
          );
        },
      }),
      patch: action("patch", {
        affects: ({ input }) => {
          const fields = Object.keys(input.changes);
          if (fields.length === 0) return [];
          return fields.map((field) => entityQueries.byId(input.id).field(field));
        },
        run: async (context) => {
          const { input } = context;
          const current = collection.get(input.id);
          if (!current) {
            throw new Error(`Collection value "${String(input.id)}" was not found.`);
          }
          const value = await validate({ ...current, ...input.changes });
          assertKey(value, input.id);
          await mutations?.update?.(value);
          return returnPersisted<Record<string, unknown>>(
            collection.update(input.id, () => value),
            (transaction) => context.setTransaction(transaction),
          );
        },
      }),
      update: action("update", {
        affects: ({ input }) => [entityQueries.byId(input.id)],
        run: async (context) => {
          const { input } = context;
          const value = await validate(input.value);
          assertKey(value, input.id);
          await mutations?.update?.(value);
          return returnPersisted<Record<string, unknown>>(
            collection.update(input.id, () => value),
            (transaction) => context.setTransaction(transaction),
          );
        },
      }),
      delete: action("delete", {
        affects: ({ input }) => [entityQueries.byId(input.id)],
        run: async (context) => {
          const { input } = context;
          await mutations?.delete?.(input.id);
          return returnPersisted<Record<string, unknown> | undefined>(
            collection.delete(input.id),
            (transaction) => context.setTransaction(transaction),
          );
        },
      }),
    };
  }

  return actions as unknown as GeneratedActions<Schema>;
}

/**
 * Bare-bones {@link QueryCollectionDefinition} builder. Prefer the
 * higher-level entry points in `src/query-collection.ts`,
 * `src/local-storage-collection.ts`, and `src/sync-collection.ts` for
 * most cases. This form is exposed for callers that want to
 * pre-construct the collection themselves and pass it in via
 * `options.collection`.
 *
 * @typeParam Value - the entity row shape.
 */
export function queryCollection<Value extends Record<string, unknown>>(
  _entityName: string,
  options: QueryCollectionOptions<Value>,
): QueryCollectionDefinition<Value> {
  return { options };
}

/**
 * Build a {@link StartDb} from a {@link DbSchema}. The `collections`
 * factory receives a `queryCollection` / `localStorageCollection` /
 * `syncCollection` helper triplet; return a map of
 * {@link QueryCollectionDefinition}s for the entities you want to
 * customize. Entities without a custom definition are backed by a
 * {@link TanStackCollection} created from the entity's schema.
 *
 * @typeParam Schema - the schema, inferred from the argument.
 *
 * @example
 * ```ts
 * const db = createStartDbFromSchema(schema, {
 *   collections: ({ queryCollection }) => ({
 *     post: queryCollection("post", {
 *       queryKey: ["post"],
 *       queryFn: async () => api.posts.list(),
 *       queryClient,
 *     }),
 *   }),
 * });
 *
 * await db.a.post.create({ id: "p1", title: "Hello", likes: 0, secret: "x" });
 * const post = await db.q.post.byId("p1");
 * ```
 */
export function createStartDbFromSchema<Schema extends DbSchema>(
  schema: Schema,
  options: {
    readonly collections?: (helpers: {
      readonly queryCollection: typeof queryCollection;
      readonly localStorageCollection: typeof defineLocalStorageCollection;
      readonly syncCollection: typeof defineSyncCollection;
    }) => Partial<SchemaCollectionDefinitions<Schema>>;
  } = {},
): StartDb<Schema> {
  const configuredCollections = (options.collections?.({
    queryCollection,
    localStorageCollection: defineLocalStorageCollection,
    syncCollection: defineSyncCollection,
  }) ?? {}) as unknown as Partial<
    Record<EntityName<Schema>, QueryCollectionDefinition<Record<string, unknown>>>
  >;
  const collections = Object.fromEntries(
    Object.entries(schema.entities).map(([name, definition]) => [
      name,
      configuredCollections[name as EntityName<Schema>]?.options.collection ??
        configuredCollections[name as EntityName<Schema>]?.options.createCollection?.({
          key: definition.key,
          schema: definition.schema as StandardSchemaV1<unknown, Record<string, unknown>>,
        }) ??
        new TanStackCollection(
          definition.key,
          configuredCollections[name as EntityName<Schema>]?.options.initialValues,
          definition.schema as StandardSchemaV1<unknown, Record<string, unknown>>,
        ),
    ]),
  ) as unknown as SchemaCollections<Schema>;
  const tracker = createActionTracker();
  const q = buildGeneratedQueries(schema, collections, tracker);
  const a = buildGeneratedActions(schema, collections, tracker, q, configuredCollections);

  const db: StartDb<Schema> = {
    schema,
    collections,
    q,
    a,
    pending: createPendingApi(tracker),
    submissions: createSubmissionsApi(tracker),
    view: (entityName, selection) => defineView(schema, entityName, selection) as never,
    viewFragment: defineViewFragment,
    entity: (entityName) => ({
      view: (selection) => defineView(schema, entityName, selection) as never,
      pick: (...fields) =>
        defineView(
          schema,
          entityName,
          Object.fromEntries(fields.map((field) => [field, true])) as never,
        ) as never,
    }),
    component: <View extends DbView>(view: View): DbComponentBuilder<View> =>
      createDbComponent(view) as DbComponentBuilder<View>,
    request: (factory) =>
      createQueryBundle(
        q,
        [factory as unknown as DbQueryBundleStage],
        createDbFileRouteFactory({ db }),
      ),
    action: (name, definition) =>
      createAction(definition, {
        collections: collections as DbCollections,
        tracker,
        name,
        q,
      }),
    extendActions: (factory) => {
      const extended = factory({
        a: db.a,
        c: collections,
        q,
        action: (definition) =>
          createAction(definition, {
            collections: collections as DbCollections,
            tracker,
            q,
          }),
      });
      return {
        ...db,
        a: mergeActionNamespaces(db.a, extended),
      } as unknown as StartDb<Schema, typeof db.a & typeof extended>;
    },
  };

  return db;
}

/**
 * Same as {@link createStartDbFromSchema}, but takes the schema as a
 * property of the `options` argument. Useful when destructuring schema
 * and collections from a single config object.
 *
 * @typeParam Schema - the schema, inferred from `options.schema`.
 *
 * @example
 * ```ts
 * const config = { schema, collections: ({ queryCollection }) => ({ ... }) };
 * const db = createStartDb(config);
 * ```
 */
export function createStartDb<Schema extends DbSchema>(
  options: Parameters<typeof createStartDbFromSchema<Schema>>[1] & {
    readonly schema: Schema;
  },
): StartDb<Schema> {
  return createStartDbFromSchema(options.schema, options);
}

/** Loose shape for an action map. Use this when writing helpers that
 * accept a `StartDb<...>["a"]` and want a permissive argument type. */
export type DbActions = Record<string, unknown>;
