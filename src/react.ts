import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { PendingApi, StartDb, SubmissionsApi } from "./db.ts";
import { dehydrateDb, hydrateDb, type DbSnapshot, type DbSnapshotMode } from "./hydrate.ts";
import {
  isDbInfiniteQuerySpec,
  type DbInfiniteQuerySpec,
  type DbInfiniteState,
} from "./infinite.ts";
import type { DbQuerySpec, InferDbQueryResult } from "./query.ts";
import type { DbView, InferView } from "./view.ts";
import { createFileRoute } from "@tanstack/react-router";

type QueryMap = Record<string, DbQuerySpec>;
type AnyStartDb = StartDb<any, any>;
type QueryData<Queries extends QueryMap> = {
  readonly [Key in keyof Queries]: InferDbQueryResult<Queries[Key]>;
};

export interface DbRouteQueryContext<
  Db extends AnyStartDb,
  Data extends Record<string, unknown> = Record<string, never>,
> {
  readonly params: Record<string, string>;
  readonly q: Db["q"];
  readonly data: Data;
}

const dbRouteFragmentStages = Symbol("tanstackstart-db.route-fragment-stages");

type DbRouteFragmentStage<Db extends AnyStartDb = AnyStartDb> = (
  context: DbRouteQueryContext<Db, Record<string, unknown>>,
) => QueryMap;

/**
 * A reusable route-data contract. Fragments are ordinary query factories with
 * hidden stage metadata so {@link composeDbRouteFragments} can run dependent
 * fragments in order inside one Router loader execution.
 */
export interface DbRouteFragment<
  Db extends AnyStartDb,
  InputData extends Record<string, unknown>,
  Queries extends QueryMap,
> {
  (context: DbRouteQueryContext<Db, InputData>): Queries;
  readonly [dbRouteFragmentStages]?: ReadonlyArray<DbRouteFragmentStage<Db>>;
}

/**
 * The payload a route loader returns. `data` is the resolved query
 * result, and `snapshot` is the {@link DbSnapshot} captured at load
 * time. The client uses `snapshot` to seed its DB before reading
 * `data` so the first render is consistent with the server.
 */
export interface DbRouteLoaderPayload {
  readonly data: Record<string, unknown>;
  readonly snapshot: DbSnapshot;
}

/**
 * A deferred value that resolves when the live query first emits.
 * Implements `Promise<Value>` so it can be awaited inside an async
 * component; also exposes a synchronous `current` snapshot and a
 * `dispose()` teardown for the underlying subscription.
 *
 * @typeParam Value - the resolved value type.
 */
export interface DbDeferredValue<Value> extends Promise<Value> {
  readonly current: Value | undefined;
  readonly error: unknown;
  dispose(): void;
}

/**
 * Apply a server-rendered {@link DbRouteLoaderPayload} to a DB. Hydrates
 * the snapshot (so the collections are seeded with the rows the server
 * confirmed) and returns the route data for the client to consume.
 *
 * @typeParam Db - the DB type, inferred from `db`.
 */
export function hydrateDbRoutePayload<Db extends AnyStartDb>(
  db: Db,
  payload: DbRouteLoaderPayload,
): Record<string, unknown> {
  hydrateDb(db, payload.snapshot);
  return payload.data;
}

const DbContext = createContext<unknown>(undefined);
const DbStatusContext = createContext<DbStatus | undefined>(undefined);

/**
 * Provide a {@link StartDb} to the React tree. Wrap your root layout
 * (or any subtree that needs `useDb()`) with `<DbProvider db={db}>`.
 * An optional `status` value can be passed to override the value
 * surfaced by `useDbStatus` (otherwise the route builder's status
 * wins).
 *
 * @typeParam Db - the DB type, inferred from `props.db`.
 */
export function DbProvider<Db>(props: {
  readonly db: Db;
  readonly status?: DbStatus;
  readonly children?: ReactNode;
}): ReactNode {
  const children =
    props.status === undefined
      ? props.children
      : createElement(DbStatusContext.Provider, { value: props.status }, props.children);
  return createElement(DbContext.Provider, { value: props.db }, children);
}

/**
 * Discriminated union representing a live query subscription state.
 * - `"loading"` — the initial preload has not completed yet.
 * - `"ready"` — the latest value is `value`.
 * - `"error"` — the query or its projection threw; the error is in `error`.
 */
export type DbLiveQueryState<T> =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly value: T }
  | { readonly status: "error"; readonly error: unknown };

/**
 * Subscribe a component to a {@link DbQuerySpec} and return the
 * live state. The state never goes "back" to loading once it
 * becomes ready; subsequent updates re-emit with the new value.
 *
 * @typeParam Result - the spec's result type. Inferred from `spec`.
 */
export function useDbLiveQueryState<Result>(spec: DbQuerySpec<Result>): DbLiveQueryState<Result> {
  const specKey = JSON.stringify(spec.cacheKey());
  const specRef = useRef(spec);
  const identityRef = useRef({ scope: spec.scope, key: specKey });
  const stateRef = useRef<DbLiveQueryState<Result>>({ status: "loading" });
  if (identityRef.current.scope !== spec.scope || identityRef.current.key !== specKey) {
    identityRef.current = { scope: spec.scope, key: specKey };
    stateRef.current = { status: "loading" };
  }
  specRef.current = spec;
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      return specRef.current.subscribe(
        (value) => {
          const current = stateRef.current;
          if (current.status === "ready" && current.value === value) {
            onStoreChange();
            return;
          }
          stateRef.current = { status: "ready", value };
          onStoreChange();
        },
        (error) => {
          stateRef.current = { status: "error", error };
          onStoreChange();
        },
      );
    },
    [spec.scope, specKey],
  );
  const getSnapshot = useCallback(() => stateRef.current, []);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Subscribe a component to a {@link DbQuerySpec} and return the
 * current value, or `undefined` while the initial preload is in
 * flight. Errors are swallowed (use {@link useDbLiveQueryState}
 * if you need them).
 *
 * @typeParam Result - the spec's result type. Inferred from `spec`.
 */
export function useDbLiveQuery<Result>(spec: DbQuerySpec<Result>): Result | undefined {
  const state = useDbLiveQueryState(spec);
  return state.status === "ready" ? state.value : undefined;
}

interface SuspenseResource<Result> {
  readonly key: string;
  readonly scope: object;
  readonly promise: Promise<void>;
  readonly listeners: Set<() => void>;
  readonly unsubscribe: () => void;
  state: DbLiveQueryState<Result>;
  retainCount: number;
}

const suspenseResources = new WeakMap<object, Map<string, SuspenseResource<unknown>>>();

function getSuspenseResource<Result>(spec: DbQuerySpec<Result>): SuspenseResource<Result> {
  const key = JSON.stringify([spec.cacheKey(), spec.metadata]);
  let scopedResources = suspenseResources.get(spec.scope);
  if (!scopedResources) {
    scopedResources = new Map();
    suspenseResources.set(spec.scope, scopedResources);
  }
  const existing = scopedResources.get(key);
  if (existing) return existing as SuspenseResource<Result>;

  let wake = () => {};
  const resource: SuspenseResource<Result> = {
    key,
    scope: spec.scope,
    promise: new Promise<void>((resolve) => {
      wake = resolve;
    }),
    listeners: new Set(),
    unsubscribe: () => {},
    state: { status: "loading" },
    retainCount: 0,
  };
  const notify = () => {
    for (const listener of resource.listeners) listener();
  };
  const unsubscribe = spec.subscribe(
    (value) => {
      resource.state = { status: "ready", value };
      wake();
      notify();
    },
    (error) => {
      resource.state = { status: "error", error };
      wake();
      notify();
    },
  );
  Object.defineProperty(resource, "unsubscribe", { value: unsubscribe });
  scopedResources.set(key, resource as SuspenseResource<unknown>);
  return resource;
}

/**
 * Subscribe a component to a {@link DbQuerySpec} and suspend until the
 * initial value resolves. Internally shares subscriptions across
 * components via a `WeakMap<scope, Map<key, Resource>>` cache, so two
 * components that ask for the same spec will share a single
 * underlying subscription. Throws the loading promise while loading
 * and the error if the query fails; returns the value once ready.
 *
 * @typeParam Result - the spec's result type. Inferred from `spec`.
 */
export function useDbLiveSuspenseQuery<Result>(spec: DbQuerySpec<Result>): Result {
  const resource = getSuspenseResource(spec);
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      resource.listeners.add(onStoreChange);
      return () => resource.listeners.delete(onStoreChange);
    },
    [resource],
  );
  const getSnapshot = useCallback(() => resource.state, [resource]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    resource.retainCount++;
    return () => {
      resource.retainCount--;
      if (resource.retainCount === 0) {
        resource.unsubscribe();
        suspenseResources.get(resource.scope)?.delete(resource.key);
      }
    };
  }, [resource]);

  if (state.status === "loading") throw resource.promise;
  if (state.status === "error") throw state.error;
  return state.value;
}

interface InfiniteResource<Page, Param> {
  readonly key: string;
  readonly listeners: Set<() => void>;
  readonly unsubscribe: () => void;
  state: DbInfiniteState<Page, Param>;
  retainCount: number;
}

const infiniteResources = new WeakMap<object, Map<string, InfiniteResource<unknown, unknown>>>();

function getInfiniteResource<Page, Param>(
  spec: DbInfiniteQuerySpec<Page, Param>,
): InfiniteResource<Page, Param> {
  const key =
    spec.options.initialPageParam === undefined
      ? "default"
      : JSON.stringify(spec.options.initialPageParam);
  let scopedResources = infiniteResources.get(spec.options as unknown as object);
  if (!scopedResources) {
    scopedResources = new Map();
    infiniteResources.set(spec.options as unknown as object, scopedResources);
  }
  const existing = scopedResources.get(key);
  if (existing) return existing as InfiniteResource<Page, Param>;
  const listeners = new Set<() => void>();
  const resource: InfiniteResource<Page, Param> = {
    key,
    listeners,
    unsubscribe: () => {},
    state: spec.current,
    retainCount: 0,
  };
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const unsubscribe = spec.subscribe(
    (state) => {
      resource.state = state;
      notify();
    },
    () => {
      notify();
    },
  );
  Object.defineProperty(resource, "unsubscribe", { value: unsubscribe });
  scopedResources.set(key, resource as InfiniteResource<unknown, unknown>);
  return resource;
}

export type DbLiveInfiniteQueryResult<Page, Param> = Omit<
  Extract<DbInfiniteState<Page, Param>, { status: "ready" }>,
  "isLoadingNext" | "error"
> & {
  readonly status: DbInfiniteState<Page, Param>["status"];
  readonly isLoadingNext: boolean;
  readonly error?: unknown;
  readonly loadMore: () => void;
};

/**
 * Subscribe a component to a {@link DbInfiniteQuerySpec} and return the
 * live pagination state plus a `loadMore` trigger. The state never
 * reverts to `"loading"` after the first page resolves; subsequent
 * updates re-emit with the next page appended.
 *
 * @typeParam Page - per-page result type. Inferred from `spec`.
 * @typeParam Param - cursor type. Inferred from `spec`.
 *
 * @example
 * ```tsx
 * const { pages, hasNextPage, loadMore } = useDbLiveInfiniteQuery(recentPosts);
 * return (
 *   <>
 *     {pages.map((page, i) => <PageList key={i} items={page} />)}
 *     {hasNextPage && <button onClick={loadMore}>Load more</button>}
 *   </>
 * );
 * ```
 */
export function useDbLiveInfiniteQuery<Page, Param>(
  spec: DbInfiniteQuerySpec<Page, Param>,
): DbLiveInfiniteQueryResult<Page, Param> {
  const resource = getInfiniteResource(spec);
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      resource.listeners.add(onStoreChange);
      return () => resource.listeners.delete(onStoreChange);
    },
    [resource],
  );
  const getSnapshot = useCallback(() => resource.state, [resource]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    resource.retainCount++;
    return () => {
      resource.retainCount--;
      if (resource.retainCount === 0) {
        resource.unsubscribe();
        infiniteResources.get(spec.options as unknown as object)?.delete(resource.key);
      }
    };
  }, [resource, spec]);

  const loadMore = useCallback(() => {
    void spec.loadMore().catch(() => {
      // Errors surface through `state.error` via the subscription.
    });
  }, [spec]);

  if (state.status === "loading") {
    return {
      status: "loading",
      pages: [] as ReadonlyArray<Page>,
      pageParams: [] as ReadonlyArray<Param>,
      hasNextPage: false,
      isLoadingNext: false,
      loadMore,
    } as unknown as DbLiveInfiniteQueryResult<Page, Param>;
  }
  if (state.status === "error") {
    return {
      status: "error",
      pages: [] as ReadonlyArray<Page>,
      pageParams: [] as ReadonlyArray<Param>,
      hasNextPage: false,
      isLoadingNext: false,
      error: state.error,
      loadMore,
    } as unknown as DbLiveInfiniteQueryResult<Page, Param>;
  }
  return {
    status: "ready",
    pages: state.pages,
    pageParams: state.pageParams,
    hasNextPage: state.hasNextPage,
    isLoadingNext: state.isLoadingNext,
    error: state.error,
    loadMore,
  };
}

interface InfiniteSuspenseResource<Page, Param> {
  readonly key: string;
  readonly promise: Promise<void>;
  readonly listeners: Set<() => void>;
  readonly unsubscribe: () => void;
  state: Extract<DbInfiniteState<Page, Param>, { status: "ready" } | { status: "error" }>;
  retainCount: number;
}

const infiniteSuspenseResources = new WeakMap<
  object,
  Map<string, InfiniteSuspenseResource<unknown, unknown>>
>();

function getInfiniteSuspenseResource<Page, Param>(
  spec: DbInfiniteQuerySpec<Page, Param>,
): InfiniteSuspenseResource<Page, Param> {
  const key =
    spec.options.initialPageParam === undefined
      ? "default"
      : JSON.stringify(spec.options.initialPageParam);
  let scopedResources = infiniteSuspenseResources.get(spec.options as unknown as object);
  if (!scopedResources) {
    scopedResources = new Map();
    infiniteSuspenseResources.set(spec.options as unknown as object, scopedResources);
  }
  const existing = scopedResources.get(key);
  if (existing) return existing as InfiniteSuspenseResource<Page, Param>;
  let wake = () => {};
  const listeners = new Set<() => void>();
  const initial: Extract<
    DbInfiniteState<Page, Param>,
    { status: "ready" } | { status: "error" }
  > = {
    status: "loading",
  } as never;
  const resource: InfiniteSuspenseResource<Page, Param> = {
    key,
    listeners,
    unsubscribe: () => {},
    state: initial,
    promise: new Promise<void>((resolve) => {
      wake = resolve;
    }),
    retainCount: 0,
  };
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const unsubscribe = spec.subscribe(
    (state) => {
      if (state.status === "ready") {
        resource.state = state as never;
        wake();
      } else if (state.status === "error") {
        resource.state = state as never;
        wake();
      }
      notify();
    },
    () => {
      wake();
      notify();
    },
  );
  Object.defineProperty(resource, "unsubscribe", { value: unsubscribe });
  scopedResources.set(key, resource as InfiniteSuspenseResource<unknown, unknown>);
  return resource;
}

/**
 * Subscribe a component to a {@link DbInfiniteQuerySpec} and suspend
 * until the first page resolves. Subsequent pages stream in without
 * suspending. Identical initial params share a single subscription
 * within the spec's scope.
 *
 * @typeParam Page - per-page result type. Inferred from `spec`.
 * @typeParam Param - cursor type. Inferred from `spec`.
 *
 * @example
 * ```tsx
 * function RecentPosts({ spec }: { spec: DbInfiniteQuerySpec<Post, string | undefined> }) {
 *   const { pages, hasNextPage, loadMore } = useDbLiveInfiniteSuspenseQuery(spec);
 *   // ...
 * }
 * ```
 */
export function useDbLiveInfiniteSuspenseQuery<Page, Param>(
  spec: DbInfiniteQuerySpec<Page, Param>,
): DbLiveInfiniteQueryResult<Page, Param> {
  const resource = getInfiniteSuspenseResource(spec);
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      resource.listeners.add(onStoreChange);
      return () => resource.listeners.delete(onStoreChange);
    },
    [resource],
  );
  const getSnapshot = useCallback(() => resource.state, [resource]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    resource.retainCount++;
    return () => {
      resource.retainCount--;
      if (resource.retainCount === 0) {
        resource.unsubscribe();
        infiniteSuspenseResources.get(spec.options as unknown as object)?.delete(resource.key);
      }
    };
  }, [resource, spec]);

  const loadMore = useCallback(() => {
    void spec.loadMore().catch(() => {
      // Errors surface through `state.error` via the subscription.
    });
  }, [spec]);

  if (state.status === "error") {
    return {
      status: "error",
      pages: [] as ReadonlyArray<Page>,
      pageParams: [] as ReadonlyArray<Param>,
      hasNextPage: false,
      isLoadingNext: false,
      error: state.error,
      loadMore,
    } as unknown as DbLiveInfiniteQueryResult<Page, Param>;
  }
  return {
    status: "ready",
    pages: state.pages,
    pageParams: state.pageParams,
    hasNextPage: state.hasNextPage,
    isLoadingNext: state.isLoadingNext,
    error: state.error,
    loadMore,
  };
}

interface OwnedQueriesResource {
  readonly key: string;
  readonly scope: object;
  readonly promise: Promise<void>;
  readonly listeners: Set<() => void>;
  readonly unsubscribe: () => void;
  state:
    | { readonly status: "loading" }
    | { readonly status: "ready"; readonly data: Record<string, unknown> }
    | { readonly status: "error"; readonly error: unknown };
  retainCount: number;
}

const ownedQueriesResources = new WeakMap<object, Map<string, OwnedQueriesResource>>();

function getOwnedQueriesResource(scope: object, queries: QueryMap): OwnedQueriesResource {
  const key = JSON.stringify(
    Object.keys(queries)
      .sort()
      .map((name) => [name, queries[name]!.cacheKey(), queries[name]!.metadata]),
  );
  let scopedResources = ownedQueriesResources.get(scope);
  if (!scopedResources) {
    scopedResources = new Map();
    ownedQueriesResources.set(scope, scopedResources);
  }
  const existing = scopedResources.get(key);
  if (existing) return existing;

  let wake = () => {};
  const listeners = new Set<() => void>();
  const values: Record<string, unknown> = {};
  const loading = new Set(Object.keys(queries));
  const cleanups: Array<() => void> = [];
  const resource: OwnedQueriesResource = {
    key,
    scope,
    promise: new Promise<void>((resolve) => {
      wake = resolve;
    }),
    listeners,
    unsubscribe: () => {
      for (const cleanup of cleanups) cleanup();
    },
    state: { status: "loading" },
    retainCount: 0,
  };
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const update = (name: string, value: unknown) => {
    values[name] = value;
    loading.delete(name);
    if (loading.size === 0) {
      resource.state = { status: "ready", data: { ...values } };
      wake();
      notify();
    }
  };
  const fail = (error: unknown) => {
    resource.state = { status: "error", error };
    wake();
    notify();
  };
  for (const [name, query] of Object.entries(queries)) {
    if (query.queryBuilder) {
      cleanups.push(query.subscribe((value) => update(name, value), fail));
    } else {
      void query.execute().then((value) => update(name, value), fail);
    }
  }
  if (loading.size === 0) {
    resource.state = { status: "ready", data: {} };
    wake();
  }
  scopedResources.set(key, resource);
  return resource;
}

function useDbOwnedQueries<Queries extends QueryMap>(
  scope: object,
  queries: Queries,
): QueryData<Queries> {
  const resource = getOwnedQueriesResource(scope, queries);
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      resource.listeners.add(onStoreChange);
      return () => resource.listeners.delete(onStoreChange);
    },
    [resource],
  );
  const getSnapshot = useCallback(() => resource.state, [resource]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    resource.retainCount++;
    return () => {
      resource.retainCount--;
      if (resource.retainCount === 0) {
        resource.unsubscribe();
        ownedQueriesResources.get(resource.scope)?.delete(resource.key);
      }
    };
  }, [resource]);

  if (state.status === "loading") throw resource.promise;
  if (state.status === "error") throw state.error;
  return state.data as QueryData<Queries>;
}

/**
 * Strategy for how a route's SSR loader exposes its DB snapshot to the
 * client.
 *
 * - `"route"` (default) — the route's loader wraps its resolved data
 *   in a {@link DbRouteLoaderPayload} so the client can hydrate the
 *   DB on mount. The simplest choice when the root layout is purely
 *   structural.
 * - `"root"` — the route's loader returns its raw data only. A
 *   parent layout (or root provider) is expected to capture the
 *   snapshot and hydrate the DB once, then every child route sees
 *   the hydrated state without re-sending the snapshot.
 * - `"manual"` — the route's loader returns its raw data only and
 *   does not produce a snapshot. The application is responsible
 *   for calling `hydrateDb(db, snapshot)` at the appropriate point
 *   (e.g. inside a custom route guard, after authentication, or
 *   when loading from `localStorage`).
 */
export type DbRouteHydrateStrategy = "route" | "root" | "manual";

/**
 * Route-wide defaults passed to `createDbFileRouteFactory({ defaults })`
 * or to `builder.options(defaults)`. Each option tunes how the route
 * builder behaves during SSR and on the client.
 *
 * - `ssr` — `false` to skip the SSR `loader` entirely.
 * - `live` — `false` to force the queries into `static` mode on the
 *   client (no live updates).
 * - `hydrate` — strategy for how the SSR loader hands the DB
 *   snapshot to the client. See {@link DbRouteHydrateStrategy}.
 * - `snapshot` — strategy for what state to capture in the
 *   hydration snapshot. `"confirmed-only"` (default) excludes
 *   pending optimistic overlays; `"include-pending-for-debug"`
 *   keeps them for SSR debugging. The route's `hydrate` strategy
 *   must be `"route"` for the snapshot to actually be sent to the
 *   client.
 * - `requireViews` — `true` rejects specs that are not bound to a
 *   view.
 */
export interface DbRouteDefaults {
  readonly ssr?: boolean;
  readonly live?: boolean;
  readonly hydrate?: DbRouteHydrateStrategy;
  readonly snapshot?: DbSnapshotMode;
  readonly requireViews?: boolean;
}

export interface DbRoutePlugin {
  readonly name: string;
}

/**
 * The route builder returned by `createDbFileRouteFactory(path)`. The
 * fluent API composes a TanStack Router file route from your DB's
 * queries, actions, and a render component.
 *
 * - `validateSearch`, `beforeLoad`, `loaderDeps`, `options` —
 *   forwarded to `@tanstack/react-router`'s `createFileRoute`.
 * - `queries` / `views` — append a loader stage sourcing data from the
 *   DB. `views` is an alias for `queries` that exists for readability.
 *   Later stages can use `data` resolved by earlier stages.
 * - `actions` — derive a per-route action map from `a`, `data`, and
 *   `q`. Expose canonical actions directly, alias them for the page, or
 *   partially bind inputs already known from route data.
 * - `component`, `pendingComponent`, `errorComponent`,
 *   `notFoundComponent` — the React components to render.
 * - `load` — run the loader directly. Returns the resolved data.
 * - `hydrate` — apply a server payload to the client DB.
 * - `dispose` — release deferred resources (call this on unmount).
 * - `build` — return the underlying TanStack Router route.
 * - `useData`, `useActions`, `usePending`, `useStatus`,
 *   `useSubmissions`, `useDb`, `useCollections`, `useQuery` —
 *   React hooks that read from the route's bound state.
 *
 * @typeParam Db - the DB type, inferred from `createDbFileRouteFactory`.
 * @typeParam Data - the loader's data shape, derived from `queries`.
 * @typeParam Actions - the route's action map, derived from `actions`.
 */
export interface DbRouteBuilder<
  Db extends AnyStartDb,
  Data extends Record<string, unknown> = Record<string, never>,
  Actions extends Record<string, unknown> = Record<string, never>,
> {
  readonly path: string;
  readonly db: Db;
  validateSearch(validator: unknown): DbRouteBuilder<Db, Data, Actions>;
  beforeLoad(handler: unknown): DbRouteBuilder<Db, Data, Actions>;
  loaderDeps(handler: unknown): DbRouteBuilder<Db, Data, Actions>;
  queries<Queries extends QueryMap>(
    factory: DbRouteFragment<Db, Data, Queries>,
  ): DbRouteBuilder<Db, Data & QueryData<Queries>, Actions>;
  views<Queries extends QueryMap>(
    factory: DbRouteFragment<Db, Data, Queries>,
  ): DbRouteBuilder<Db, Data & QueryData<Queries>, Actions>;
  actions<NextActions extends Record<string, unknown>>(
    factory: (context: {
      readonly a: Db["a"];
      readonly data: Data;
      readonly q: Db["q"];
    }) => NextActions,
  ): DbRouteBuilder<Db, Data, NextActions>;
  component(
    component: (
      props: Data & {
        readonly actions: Actions;
        readonly pending: Db["pending"];
        readonly submissions: Db["submissions"];
        readonly status: DbStatus;
      },
    ) => unknown,
  ): DbRouteBuilder<Db, Data, Actions>;
  pendingComponent(component: () => unknown): DbRouteBuilder<Db, Data, Actions>;
  errorComponent(component: (error: unknown) => unknown): DbRouteBuilder<Db, Data, Actions>;
  notFoundComponent(component: () => unknown): DbRouteBuilder<Db, Data, Actions>;
  options(options: DbRouteDefaults): DbRouteBuilder<Db, Data, Actions>;
  load(options: {
    readonly params?: Record<string, string>;
    readonly context?: unknown;
  }): Promise<Data>;
  hydrate(payload: DbRouteLoaderPayload, context?: unknown): Data;
  dispose(): void;
  build(): unknown;
  useData(): Data;
  useActions(): Actions;
  usePending(): Db["pending"];
  useStatus(): DbStatus;
  useSubmissions(): Db["submissions"];
  useDb(): Db;
  useCollections(): Db["collections"];
  useQuery<Name extends keyof Data>(name: Name): Data[Name];
}

/**
 * Surface returned by `useDbStatus()`. Aggregates the route's loader
 * state with each collection's `status()` and exposes deferred
 * per-query loading indicators.
 *
 * - `isLoading` — `true` while the initial loader is in flight.
 * - `isHydrating` — `true` while applying a server payload.
 * - `isRefetching` — `true` if any collection is currently
 *   refetching.
 * - `isStale` — `true` if any collection is marked stale.
 * - `error` — the first error from the loader or any collection.
 * - `deferred` — per-deferred-query loading state.
 */
export interface DbStatus {
  readonly isLoading: boolean;
  readonly isHydrating: boolean;
  readonly isRefetching: boolean;
  readonly isStale: boolean;
  readonly error?: unknown;
  readonly deferred: Readonly<
    Record<string, { readonly isLoading: boolean; readonly error?: unknown }>
  >;
}

const emptyStatus: DbStatus = {
  isLoading: false,
  isHydrating: false,
  isRefetching: false,
  isStale: false,
  deferred: {},
};

interface DbRouteBuilderState<Db extends AnyStartDb> {
  readonly db: Db;
  readonly path: string;
  readonly getClient?: (context: unknown) => Db;
  statusDb?: Db;
  defaults: DbRouteDefaults;
  routerOptions: Record<string, unknown>;
  queryStages: Array<DbRouteFragmentStage<Db>>;
  actionFactory?: (context: {
    readonly a: Db["a"];
    readonly data: Record<string, unknown>;
    readonly q: Db["q"];
  }) => Record<string, unknown>;
  component?: (props: Record<string, unknown>) => unknown;
  pendingComponent?: () => unknown;
  errorComponent?: (error: unknown) => unknown;
  notFoundComponent?: () => unknown;
  route?: {
    readonly useLoaderData: () => Record<string, unknown>;
  };
  status: {
    isLoading: boolean;
    isHydrating: boolean;
    isRefetching: boolean;
    isStale: boolean;
    error?: unknown;
    deferred: Record<string, { isLoading: boolean; error?: unknown }>;
  };
  deferredResources: Map<string, DbDeferredValue<unknown>>;
  data: Record<string, unknown>;
}

function getRouteStatus<Db extends AnyStartDb>(state: DbRouteBuilderState<Db>): DbStatus {
  const collectionStatuses = Object.values((state.statusDb ?? state.db).collections).map(
    (collection) => collection.status?.() ?? {},
  );
  return {
    ...state.status,
    isLoading: state.status.isLoading || collectionStatuses.some((status) => status.isLoading),
    isRefetching: collectionStatuses.some((status) => status.isRefetching),
    isStale: collectionStatuses.some((status) => status.isStale),
    error: state.status.error ?? collectionStatuses.find((status) => status.error)?.error,
  };
}

function createDeferredValue<Result>(
  query: DbQuerySpec<Result>,
  status: { isLoading: boolean; error?: unknown },
): DbDeferredValue<Result> {
  let current: Result | undefined;
  let error: unknown;
  let settle: ((value: Result) => void) | undefined;
  let reject: ((error: unknown) => void) | undefined;
  let settled = false;
  let unsubscribe = () => {};
  const promise = new Promise<Result>((resolve, rejectPromise) => {
    settle = resolve;
    reject = rejectPromise;
  }) as DbDeferredValue<Result>;
  void Object.defineProperties(promise, {
    current: { get: () => current },
    error: { get: () => error },
    dispose: {
      value: () => {
        unsubscribe();
        unsubscribe = () => {};
      },
    },
  });
  unsubscribe = query.subscribe(
    (value) => {
      current = value;
      status.isLoading = false;
      if (!settled) {
        settled = true;
        settle?.(value);
      }
    },
    (nextError) => {
      error = nextError;
      status.isLoading = false;
      status.error = nextError;
      if (!settled) {
        settled = true;
        reject?.(nextError);
      }
    },
  );
  return promise;
}

function disposeDeferredResources<Db extends AnyStartDb>(state: DbRouteBuilderState<Db>): void {
  for (const resource of state.deferredResources.values()) resource.dispose();
  state.deferredResources.clear();
}

async function loadRouteData<Db extends AnyStartDb>(
  state: DbRouteBuilderState<Db>,
  options: { readonly params?: Record<string, string>; readonly context?: unknown },
): Promise<Record<string, unknown>> {
  state.status.isLoading = true;
  state.status.error = undefined;
  const db = state.getClient?.(options.context) ?? state.db;
  state.statusDb = db;
  disposeDeferredResources(state);
  state.status.deferred = {};
  try {
    const params = options.params ?? {};
    const data: Record<string, unknown> = {};
    for (const stage of state.queryStages) {
      const queries = stage({ params, q: db.q, data });
      const entries = await Promise.all(
        Object.entries(queries).map(async ([name, initialQuery]) => {
          if (isDbInfiniteQuerySpec<unknown, unknown>(initialQuery)) {
            const infiniteSpec = initialQuery as DbInfiniteQuerySpec<unknown, unknown>;
            const deferredStatus = { isLoading: true } as {
              isLoading: boolean;
              error?: unknown;
            };
            state.status.deferred[name] = deferredStatus;
            // Warm the underlying collection during SSR so the first
            // page is available on the client without an extra fetch.
            void infiniteSpec.firstPage().then(
              () => {
                deferredStatus.isLoading = false;
              },
              (error: unknown) => {
                deferredStatus.isLoading = false;
                deferredStatus.error = error;
              },
            );
            return [name, infiniteSpec] as const;
          }
          if (state.defaults.requireViews && !initialQuery.view) {
            throw new Error(`Route query "${name}" requires a view.`);
          }
          const query = state.defaults.live === false ? initialQuery.static() : initialQuery;
          if (query.metadata.preloadOnly) {
            await query.execute();
            return undefined;
          }
          if (query.metadata.deferred) {
            const deferredStatus = { isLoading: true } as {
              isLoading: boolean;
              error?: unknown;
            };
            state.status.deferred[name] = deferredStatus;
            if (query.metadata.mode === "live" && query.queryBuilder) {
              const deferred = createDeferredValue(query, deferredStatus);
              state.deferredResources.set(name, deferred);
              return [name, deferred] as const;
            }
            const result = query.execute();
            void result.then(
              () => {
                deferredStatus.isLoading = false;
              },
              (error: unknown) => {
                deferredStatus.isLoading = false;
                deferredStatus.error = error;
              },
            );
            return [name, result] as const;
          }
          return [name, await query.execute()] as const;
        }),
      );
      Object.assign(data, Object.fromEntries(entries.filter((entry) => entry !== undefined)));
    }
    state.data = data;
    return data;
  } catch (error) {
    state.status.error = error;
    throw error;
  } finally {
    state.status.isLoading = false;
  }
}

function isDbRouteLoaderPayload(value: unknown): value is DbRouteLoaderPayload {
  return typeof value === "object" && value !== null && "data" in value && "snapshot" in value;
}

function flattenActionAliases(
  actions: Record<string, unknown>,
  path: ReadonlyArray<string> = [],
  accumulator: Map<string, string> = new Map(),
): Map<string, string> {
  for (const [name, value] of Object.entries(actions)) {
    const nextPath = [...path, name];
    if (
      typeof value === "function" &&
      "actionName" in value &&
      typeof (value as { actionName?: unknown }).actionName === "string"
    ) {
      const canonical = (value as { actionName: string }).actionName;
      const dotted = nextPath.join(".");
      accumulator.set(name, canonical);
      if (dotted !== name) accumulator.set(dotted, canonical);
    } else if (typeof value === "object" && value !== null) {
      flattenActionAliases(value as Record<string, unknown>, nextPath, accumulator);
    }
  }
  return accumulator;
}

function resolveRouteActionName(aliases: ReadonlyMap<string, string>, alias: string): string {
  return aliases.get(alias) ?? alias;
}

function buildRouteActionAliases(actions: Record<string, unknown>): ReadonlyMap<string, string> {
  return flattenActionAliases(actions);
}

function createRoutePending(pending: PendingApi, aliases: ReadonlyMap<string, string>): PendingApi {
  return {
    any: () => pending.any(),
    action: (name, input) => pending.action(resolveRouteActionName(aliases, name), input),
    field: (entity, field) => pending.field(entity, field),
    query: (name) => pending.query(name),
  };
}

function createRouteSubmissions(
  submissions: SubmissionsApi,
  aliases: ReadonlyMap<string, string>,
): SubmissionsApi {
  return {
    latest: (name) => submissions.latest(resolveRouteActionName(aliases, name)),
    all: (name) => submissions.all(resolveRouteActionName(aliases, name)),
    forInput: (name, input) => submissions.forInput(resolveRouteActionName(aliases, name), input),
  };
}

function createRouteBuilder<Db extends AnyStartDb>(
  state: DbRouteBuilderState<Db>,
): DbRouteBuilder<Db> {
  const getData = () => {
    const loaded = state.route?.useLoaderData() ?? state.data;
    return isDbRouteLoaderPayload(loaded) ? loaded.data : loaded;
  };
  const getActions = () => {
    const data = getData();
    const db = state.statusDb ?? state.db;
    return state.actionFactory?.({ a: db.a, data, q: db.q }) ?? {};
  };
  const getPending = () =>
    createRoutePending((state.statusDb ?? state.db).pending, buildRouteActionAliases(getActions()));
  const getSubmissions = () =>
    createRouteSubmissions(
      (state.statusDb ?? state.db).submissions,
      buildRouteActionAliases(getActions()),
    );
  const builder = {
    path: state.path,
    db: state.db,
    validateSearch: (validator: unknown) => {
      state.routerOptions.validateSearch = validator;
      return builder;
    },
    beforeLoad: (handler: unknown) => {
      state.routerOptions.beforeLoad = handler;
      return builder;
    },
    loaderDeps: (handler: unknown) => {
      state.routerOptions.loaderDeps = handler;
      return builder;
    },
    queries: (factory: DbRouteFragment<Db, Record<string, unknown>, QueryMap>) => {
      state.queryStages.push(...getRouteFragmentStages(factory));
      return builder;
    },
    views: (factory: DbRouteFragment<Db, Record<string, unknown>, QueryMap>) => {
      state.queryStages.push(...getRouteFragmentStages(factory));
      return builder;
    },
    actions: (factory: DbRouteBuilderState<Db>["actionFactory"]) => {
      state.actionFactory = factory;
      return builder;
    },
    component: (component: DbRouteBuilderState<Db>["component"]) => {
      state.component = component;
      return builder;
    },
    pendingComponent: (component: DbRouteBuilderState<Db>["pendingComponent"]) => {
      state.pendingComponent = component;
      return builder;
    },
    errorComponent: (component: DbRouteBuilderState<Db>["errorComponent"]) => {
      state.errorComponent = component;
      return builder;
    },
    notFoundComponent: (component: DbRouteBuilderState<Db>["notFoundComponent"]) => {
      state.notFoundComponent = component;
      return builder;
    },
    options: (options: DbRouteDefaults) => {
      state.defaults = { ...state.defaults, ...options };
      return builder;
    },
    load: (options: { readonly params?: Record<string, string>; readonly context?: unknown }) =>
      loadRouteData(state, options),
    hydrate: (payload: DbRouteLoaderPayload, context?: unknown) => {
      state.status.isHydrating = true;
      try {
        const db = state.getClient?.(context) ?? state.db;
        state.statusDb = db;
        return hydrateDbRoutePayload(db, payload);
      } finally {
        state.status.isHydrating = false;
      }
    },
    dispose: () => disposeDeferredResources(state),
    build: () => {
      if (state.route) return state.route;
      const route = createFileRoute(state.path as never)({
        ...state.routerOptions,
        ssr: state.defaults.ssr,
        loader: ({
          params,
          context,
        }: {
          readonly params: Record<string, string>;
          readonly context: unknown;
        }) =>
          loadRouteData(state, { params, context }).then((data) => {
            if (state.defaults.hydrate !== "route") return data;
            const db = state.getClient?.(context) ?? state.db;
            return {
              data,
              snapshot: dehydrateDb(db, { snapshot: state.defaults.snapshot }),
            } satisfies DbRouteLoaderPayload;
          }),
        pendingComponent: state.pendingComponent,
        errorComponent: state.errorComponent
          ? ({ error }: { readonly error: unknown }) => state.errorComponent?.(error)
          : undefined,
        notFoundComponent: state.notFoundComponent,
        component: state.component
          ? () => {
              useEffect(() => () => disposeDeferredResources(state), []);
              const status = getRouteStatus(state);
              return createElement(
                DbStatusContext.Provider,
                { value: status },
                state.component?.({
                  ...getData(),
                  actions: getActions(),
                  pending: getPending(),
                  submissions: getSubmissions(),
                  status,
                }) as ReactNode,
              );
            }
          : undefined,
      } as never);
      state.route = route as unknown as DbRouteBuilderState<Db>["route"];
      return route;
    },
    useData: getData,
    useActions: getActions,
    usePending: getPending,
    useStatus: () => getRouteStatus(state),
    useSubmissions: getSubmissions,
    useDb: () => state.statusDb ?? state.db,
    useCollections: () => (state.statusDb ?? state.db).collections,
    useQuery: (name: string) => getData()[name],
  };
  return builder as DbRouteBuilder<Db>;
}

/**
 * Build a factory for {@link DbRouteBuilder}s bound to a specific
 * {@link StartDb}. Call the factory with a TanStack Router path (e.g.
 * `"/posts/$postId"`) to start composing a route.
 *
 * - `db` is the default DB used by the route's loader. If you need a
 *   per-request client DB, pass `getClient(context)`. The context
 *   is whatever the TanStack Router loader passes through
 *   (`{ request, ... }` in SSR; `undefined` on the client).
 * - `defaults` are {@link DbRouteDefaults} that apply to every
 *   builder returned by the factory.
 *
 * @typeParam Db - the DB type, inferred from `options.db`.
 */
export function createDbFileRouteFactory<Db extends AnyStartDb>(options: {
  readonly db: Db;
  readonly getClient?: (context: unknown) => Db;
  readonly defaults?: DbRouteDefaults;
}): DbFileRouteFactory<Db> {
  const factory = (path: string) =>
    createRouteBuilder({
      db: options.db,
      path,
      getClient: options.getClient,
      defaults: options.defaults ?? {},
      routerOptions: {},
      queryStages: [],
      status: {
        ...emptyStatus,
        deferred: {},
      },
      deferredResources: new Map(),
      data: {},
    });
  return Object.assign(factory, {
    fragment: <Queries extends QueryMap>(
      fragment: DbRouteFragment<Db, Record<string, never>, Queries>,
    ) => createDbRouteFragment(fragment),
  });
}

/** DB-bound file-route factory. Besides creating route builders, it exposes
 * `fragment(...)` so reusable route data contracts receive the same typed
 * `q` surface as the routes that consume them. */
export interface DbFileRouteFactory<Db extends AnyStartDb> {
  (path: string): DbRouteBuilder<Db>;
  fragment<Queries extends QueryMap>(
    factory: DbRouteFragment<Db, Record<string, never>, Queries>,
  ): DbRouteFragment<Db, Record<string, never>, Queries>;
}

/**
 * Identity helper for a route's `queries`/`views` factory. Exists so
 * route fragments can be written as standalone functions and re-used
 * across routes without wrapping them by hand.
 *
 * @typeParam Factory - the factory type. Returned unchanged.
 */
export function createDbRouteFragment<
  Db extends AnyStartDb,
  InputData extends Record<string, unknown> = Record<string, never>,
  Queries extends QueryMap = QueryMap,
>(factory: DbRouteFragment<Db, InputData, Queries>): DbRouteFragment<Db, InputData, Queries> {
  return factory;
}

/**
 * Compose two route fragments into one staged route-data contract. The
 * second fragment receives the first fragment's resolved results through
 * `data`, while both remain inside the same Router loader execution.
 *
 * @typeParam First - the first factory's signature.
 * @typeParam Second - the second factory's signature. The two must
 *   accept the same arguments.
 */
export function composeDbRouteFragments<
  Db extends AnyStartDb,
  InputData extends Record<string, unknown>,
  FirstQueries extends QueryMap,
  SecondQueries extends QueryMap,
>(
  first: DbRouteFragment<Db, InputData, FirstQueries>,
  second: DbRouteFragment<Db, InputData & QueryData<FirstQueries>, SecondQueries>,
): DbRouteFragment<Db, InputData, FirstQueries & SecondQueries> {
  const stages = [...getRouteFragmentStages(first), ...getRouteFragmentStages(second)];
  const fragment = ((context: DbRouteQueryContext<Db, InputData>) => ({
    ...first(context),
    ...second(context as DbRouteQueryContext<Db, InputData & QueryData<FirstQueries>>),
  })) as DbRouteFragment<Db, InputData, FirstQueries & SecondQueries>;
  Object.defineProperty(fragment, dbRouteFragmentStages, { value: stages });
  return fragment;
}

function getRouteFragmentStages<
  Db extends AnyStartDb,
  InputData extends Record<string, unknown>,
  Queries extends QueryMap,
>(
  factory: DbRouteFragment<Db, InputData, Queries> | undefined,
): ReadonlyArray<DbRouteFragmentStage<Db>> {
  if (!factory) return [];
  return factory[dbRouteFragmentStages] ?? [factory as unknown as DbRouteFragmentStage<Db>];
}

type DbComponentViewProps<View extends DbView> = {
  readonly [Name in View["entity"]]: InferView<View>;
};

export interface DbComponentBuilder<View extends DbView> {
  readonly view: View;
  (
    render: (props: DbComponentViewProps<View>) => ReactNode,
  ): (props: DbComponentViewProps<View>) => ReactNode;
  actions<Actions extends Record<string, unknown>>(
    factory: (context: { readonly a: AnyStartDb["a"] }) => Actions,
  ): {
    render(
      render: (
        props: DbComponentViewProps<View> & {
          readonly actions: Actions;
          readonly pending: PendingApi;
          readonly status: DbStatus;
          readonly submissions: SubmissionsApi;
        },
      ) => ReactNode,
    ): (props: DbComponentViewProps<View>) => ReactNode;
  };
}

interface DbLocalComponentBuilder<Db extends AnyStartDb, Props extends Record<string, unknown>> {
  props<NextProps extends Record<string, unknown>>(): DbLocalComponentBuilder<Db, NextProps>;
  views<Queries extends QueryMap>(
    factory: (context: { readonly props: Props; readonly q: Db["q"] }) => Queries,
  ): {
    render(render: (props: Props & QueryData<Queries>) => ReactNode): (props: Props) => ReactNode;
  };
}

/**
 * Build a render-bound component for a {@link DbView}. The view's
 * output type is inferred from the view's selection, and the
 * rendered component receives the projected row plus a (optional)
 * `actions` map.
 *
 * Three overloads:
 * - `createDbComponent<Props>()` — the no-db flavour: call `.views(...).render(...)`
 *   to read queries from a {@link DbProvider} at the top of the tree.
 * - `createDbComponent(db)` — the bound-db flavour: `.views(...).render(...)`
 *   reads queries from `db` directly (no provider needed).
 * - `createDbComponent(view)` — the view-bound flavour: the render
 *   callback receives the view's projected row.
 *
 * @typeParam View - the view's type, inferred from the argument.
 * @typeParam Props - the component's props type, inferred from the
 *   builder's `props<NextProps>()` chain.
 */
export function createDbComponent<
  Props extends Record<string, unknown> = Record<string, never>,
>(): DbLocalComponentBuilder<AnyStartDb, Props>;
export function createDbComponent<
  Db extends AnyStartDb,
  Props extends Record<string, unknown> = Record<string, never>,
>(db: Db): DbLocalComponentBuilder<Db, Props>;
export function createDbComponent<View extends DbView>(view: View): DbComponentBuilder<View>;
export function createDbComponent<View extends DbView>(
  viewOrDb?: View | AnyStartDb,
): DbComponentBuilder<View> | DbLocalComponentBuilder<AnyStartDb, Record<string, unknown>> {
  if (!viewOrDb || ("q" in viewOrDb && "a" in viewOrDb)) {
    const boundDb = viewOrDb as AnyStartDb | undefined;
    return {
      props: () => createDbComponent(boundDb as AnyStartDb),
      views: <Props extends Record<string, unknown>, Queries extends QueryMap>(
        factory: (context: { readonly props: Props; readonly q: AnyStartDb["q"] }) => Queries,
      ) =>
        ({
          render: (render: (props: Props & QueryData<Queries>) => ReactNode) => (props: Props) => {
            const db = useDb(boundDb);
            const data = useDbOwnedQueries(db, factory({ props, q: db.q }));
            return render({ ...props, ...data });
          },
        }) as const,
    };
  }
  const view = viewOrDb;
  const builder = (render: (props: DbComponentViewProps<View>) => ReactNode) => render;
  builder.view = view;
  builder.actions = <Actions extends Record<string, unknown>>(
    factory: (context: { readonly a: AnyStartDb["a"] }) => Actions,
  ) => ({
    render:
      (
        render: (
          props: DbComponentViewProps<View> & {
            readonly actions: Actions;
            readonly pending: PendingApi;
            readonly status: DbStatus;
            readonly submissions: SubmissionsApi;
          },
        ) => ReactNode,
      ) =>
      (props: DbComponentViewProps<View>) => {
        const db = useDb();
        return render({
          ...props,
          actions: factory({ a: db.a }),
          pending: db.pending,
          status: useDbStatus(),
          submissions: db.submissions,
        });
      },
  });
  return builder;
}

/**
 * Identity helper for a route's `actions` factory. Use this to give a
 * group of actions a label in the type system (and for readability
 * in code review) without wrapping them.
 *
 * @typeParam Actions - the action map type. Returned unchanged.
 */
export function createDbActionGroup<Actions>(actions: Actions): Actions {
  return actions;
}

/**
 * Read the {@link StartDb} from the nearest {@link DbProvider} (or
 * from the explicit `db` argument, if you prefer to bind a DB
 * directly to a hook). Throws if no DB is reachable.
 *
 * @typeParam Db - the DB type. Inferred from the explicit `db`
 *   argument, or from the provider's value.
 */
export function useDb<Db extends AnyStartDb = AnyStartDb>(db?: Db): Db {
  const context = useContext(DbContext);
  const resolved = db ?? (context as Db | undefined);
  if (!resolved) {
    throw new Error("useDb() requires a DbProvider or an explicit db argument.");
  }
  return resolved as Db;
}

/**
 * Read the typed `collections` map from a {@link StartDb}. The
 * returned object is the same as `useDb(db).collections`.
 *
 * @typeParam Db - the DB type, inferred from `db` or the provider.
 */
export const useDbCollections = <Db extends AnyStartDb = AnyStartDb>(db?: Db) =>
  useDb(db).collections;
/** Identity helper for an action in a component. Exists for
 * readability in JSX (`useDbAction(likePost)` reads more clearly than
 * `likePost`). */
export const useDbAction = <Action>(action: Action) => action;
/**
 * Read the {@link PendingApi} from the current {@link StartDb}.
 *
 * @typeParam Db - the DB type, inferred from `db` or the provider.
 */
export const useDbPending = <Db extends AnyStartDb = AnyStartDb>(db?: Db) => useDb(db).pending;
/**
 * Read the current {@link DbStatus}. If no route builder is bound
 * to the current context, the empty status is returned.
 */
export const useDbStatus = (): DbStatus => useContext(DbStatusContext) ?? emptyStatus;
/**
 * Read the {@link SubmissionsApi} from the current {@link StartDb}.
 *
 * @typeParam Db - the DB type, inferred from `db` or the provider.
 */
export const useDbSubmissions = <Db extends AnyStartDb = AnyStartDb>(db?: Db) =>
  useDb(db).submissions;

/** Extract the loader's data shape from a {@link DbRouteBuilder}. */
export type InferDbRouteData<Route> =
  Route extends DbRouteBuilder<AnyStartDb, infer Data, Record<string, unknown>> ? Data : never;
/** Extract the actions map from a {@link DbRouteBuilder}. */
export type InferDbRouteActions<Route> =
  Route extends DbRouteBuilder<AnyStartDb, Record<string, unknown>, infer Actions>
    ? Actions
    : never;
/** Extract the full component-prop shape from a {@link DbRouteBuilder}.
 * Equivalent to `InferDbRouteData<Route> & { actions: InferDbRouteActions<Route> }`. */
export type InferDbRouteComponentProps<Route> = InferDbRouteData<Route> & {
  readonly actions: InferDbRouteActions<Route>;
};
