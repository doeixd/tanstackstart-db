import {
  createLiveQueryCollection,
  queryOnce,
  type Collection,
  type InitialQueryBuilder,
} from "@tanstack/db";
import type { LiveQueryTracker } from "./action.ts";
import { DbNotFoundError } from "./errors.ts";
import { pickView, type DbView, type InferView } from "./view.ts";

/** The cardinality of a query result.
 *
 * - `"one"` and `"optional"` terminate the chain with `findOne()` and
 *   read a single value from the live collection.
 * - `"many"` keeps the chain unterminated and reads the collection as an
 *   array.
 * - `"infinite"` is reserved for paginated queries.
 */
export type QueryCardinality = "one" | "optional" | "many" | "infinite";

/** Whether the query should subscribe to live updates or run once. */
export type QueryMode = "live" | "static";

/** Low-level options for constructing a {@link DbQuerySpec} by hand. Most
 * callers use `q.<entity>.*`, `q.raw(...)`, or the route builder instead of
 * building specs directly. */
export interface DbQueryOptions<Result> {
  /** A stable key used to cache live subscriptions, route resources, and
   * pending-query tracking. The default `queryCollection` factory uses
   * `[entityName, helperName, ...args]`. */
  readonly key: ReadonlyArray<unknown>;
  /** A one-shot executor. Used by non-native specs (e.g. `MemoryCollection`).
   * Mutually exclusive with `query`: if both are provided, `query` wins. */
  readonly execute?: () => Result | Promise<Result>;
  /** A native TanStack DB query-builder closure. The result is fed to
   * `queryOnce(...)` for `execute()` and to `createLiveQueryCollection(...)`
   * for `subscribe(...)`. */
  readonly query?: NativeQueryFn;
  /** The cache scope for `useDbLiveSuspenseQuery` and route resources.
   * Defaults to a module-level singleton, which is the right choice for
   * most apps. */
  readonly scope?: object;
}

/** Static, observable metadata for a {@link DbQuerySpec}. The route
 * builder reads these fields to decide how to load, defer, and hydrate
 * the query. */
export interface QueryMetadata {
  readonly cardinality: QueryCardinality;
  readonly mode: QueryMode;
  readonly deferred: boolean;
  readonly preloadOnly: boolean;
  readonly required: boolean;
  readonly field?: string;
  readonly infiniteOptions?: unknown;
}

/** A native TanStack DB query-builder closure. Created by
 * `compileQueryFn` or by hand. */
export type NativeQueryFn = (q: InitialQueryBuilder) => unknown;

/** A factory that builds a {@link NativeQueryFn} for a given view. Used
 * by the generated query helpers so `.as(View)` can rebuild the native
 * query with the view's `select` projection folded in. */
export type QueryBuild = (view?: DbView) => NativeQueryFn;

type AnyCollection = Collection<Record<string, unknown>, string | number>;

/** Compile a native TanStack DB query-builder closure. The first argument
 * is reserved for future per-collection type inference; the second is the
 * builder callback that receives the `InitialQueryBuilder` and returns
 * the chain (terminated with `findOne()` for single-value specs, or
 * unterminated for array specs).
 *
 * @example
 * ```ts
 * const queryFn = compileQueryFn(collection, (q) =>
 *   q
 *     .from({ post: collection })
 *     .where(({ post }) => eq(post.id, "post_1"))
 *     .findOne(),
 * );
 * ```
 */
export function compileQueryFn(_collection: AnyCollection, build: (q: any) => any): NativeQueryFn {
  return (q) => build(q);
}

/**
 * A query specification. Carries everything the executor and the live
 * subscription need: a stable key, an optional native query-builder
 * closure, an optional one-shot executor, an optional view to project
 * the result with, and a few metadata flags (cardinality, mode, etc.).
 *
 * The chainable methods (`.as`, `.select`, `.one`, `.optional`, `.many`,
 * `.list`, `.infinite`, `.live`, `.static`, `.defer`, `.preloadOnly`,
 * `.required`, `.field`) all return a fresh `DbQuerySpec` with the
 * relevant field updated, leaving the original untouched. `.execute()`
 * resolves the result on demand; `.subscribe(...)` returns a teardown
 * function.
 *
 * @typeParam Result - the value the query resolves to. Inferred from the
 *   underlying options. For view-bound specs the type is narrowed to
 *   `InferView<View>`.
 */
export class DbQuerySpec<Result = unknown> {
  readonly metadata: QueryMetadata;
  readonly queryBuilder?: NativeQueryFn;
  readonly viewBuild?: QueryBuild;
  readonly viewSelect?: (value: unknown) => Result;
  readonly resolveView?: (view: DbView, value: unknown) => unknown;
  readonly subscribeView?: (view: DbView, onChange: () => void) => () => void;
  readonly view?: DbView;
  readonly scope: object;
  readonly liveQueryTracker?: LiveQueryTracker;
  readonly resourceKey: ReadonlyArray<unknown>;

  constructor(
    readonly options: DbQueryOptions<Result>,
    metadata: Partial<QueryMetadata> = {},
    extras: {
      readonly queryBuilder?: NativeQueryFn;
      readonly viewBuild?: QueryBuild;
      readonly viewSelect?: (value: unknown) => Result;
      readonly resolveView?: (view: DbView, value: unknown) => unknown;
      readonly subscribeView?: (view: DbView, onChange: () => void) => () => void;
      readonly view?: DbView;
      readonly scope?: object;
      readonly liveQueryTracker?: LiveQueryTracker;
      readonly resourceKey?: ReadonlyArray<unknown>;
    } = {},
  ) {
    this.metadata = {
      cardinality: "one",
      mode: "live",
      deferred: false,
      preloadOnly: false,
      required: false,
      ...metadata,
    };
    this.queryBuilder = extras.queryBuilder ?? options.query;
    this.viewBuild = extras.viewBuild;
    this.viewSelect = extras.viewSelect;
    this.resolveView = extras.resolveView;
    this.subscribeView = extras.subscribeView;
    this.view = extras.view;
    this.liveQueryTracker = extras.liveQueryTracker;
    this.scope = extras.scope ?? options.scope ?? defaultQueryScope;
    this.resourceKey = extras.resourceKey ?? options.key;
  }

  /**
   * Bind a view to the query. The view is folded into the native
   * `queryBuilder` whenever possible (so `select` runs inside TanStack
   * DB's compiled query), otherwise the view is resolved post-execute.
   * Always sets `viewSelect` to invoke `resolveView` so the result is
   * masked to the view's shape.
   *
   * @typeParam View - the view to bind.
   *
   * @example
   * ```ts
   * const postCards = q.post.byId("p1").as(postCardView);
   * const post = await postCards.execute(); // InferView<typeof postCardView>
   * ```
   */
  as<View extends DbView>(view: View): DbQuerySpec<InferView<View>> {
    const canCompileNative = this.viewBuild !== undefined && this.viewSelect === undefined;
    if (canCompileNative && this.viewBuild) {
      return this.copy<InferView<View>>(
        {},
        {
          queryBuilder: this.viewBuild(view),
          viewSelect: (value) => {
            if (value == null) return value as InferView<View>;
            if (this.resolveView) return this.resolveView(view, value) as InferView<View>;
            return pickView(view, value as never) as InferView<View>;
          },
          view,
          resourceKey: [...this.resourceKey, "as", serializeView(view)],
        },
      );
    }
    const previous = this.viewSelect;
    const resolveView = this.resolveView;
    return this.copy<InferView<View>>(
      {},
      {
        viewSelect: (value) => {
          const raw = previous ? previous(value) : value;
          if (raw == null) return raw as InferView<View>;
          if (resolveView) return resolveView(view, raw) as InferView<View>;
          return pickView(view, raw as never) as InferView<View>;
        },
        view,
        resourceKey: [...this.resourceKey, "as", serializeView(view)],
      },
    );
  }

  /**
   * Apply a function to the query's result. Runs after any bound
   * view's `viewSelect`, so the selector receives the masked value.
   * Must be called after `.as(View)`, not before, otherwise the
   * selector can strip fields the post-execute view materializer
   * needs.
   *
   * @typeParam Selected - the new result type. Inferred from `selector`.
   * @param cacheKey - Optional stable token for React resource caching. Pass
   *   one when `selector` closes over values that are not already represented
   *   by the query key.
   *
   * @example
   * ```ts
   * const titles = q.post.list().as(postCardView).select((posts) => posts.map((p) => p.title));
   * ```
   */
  select<Selected>(
    selector: (value: Result) => Selected,
    cacheKey = selector.toString(),
  ): DbQuerySpec<Selected> {
    const previous = this.viewSelect ?? ((value: unknown) => value as Result);
    return this.copy<Selected>(
      {},
      {
        viewSelect: (value) => selector(previous(value) as Result),
        resourceKey: [...this.resourceKey, "select", cacheKey],
      },
    );
  }

  /** Mark the spec as a single-value query. The executor / live
   * subscription reads the collection as a single row. */
  one(): DbQuerySpec<Result> {
    return this.copy({ cardinality: "one" });
  }

  /** Mark the spec as a single-value query that may resolve to
   * `undefined`. The runtime type widens to `Result | undefined`. */
  optional(): DbQuerySpec<Result | undefined> {
    return this.copy<Result | undefined>({ cardinality: "optional" });
  }

  /** Mark the spec as a list-valued query. The runtime reads the
   * collection as an array. */
  many(): DbQuerySpec<ReadonlyArray<Result>> {
    return this.copy<ReadonlyArray<Result>>({ cardinality: "many" });
  }

  /** Alias for {@link DbQuerySpec.many}. */
  list(): DbQuerySpec<ReadonlyArray<Result>> {
    return this.many();
  }

  /**
   * Wrap the current result as the first page of an infinite-query shape.
   * The runtime shape is `{ pages: ReadonlyArray<Result> }`; `options`
   * are retained as metadata for a pagination layer to consume.
   *
   * @typeParam Options - the pagination options type, free-form. The
   *   helper keeps the input as `unknown` metadata; consumers can
   *   cast when they read `metadata.infiniteOptions`.
   */
  infinite<Options>(options: Options): DbQuerySpec<{ readonly pages: ReadonlyArray<Result> }> {
    const previous = this.viewSelect ?? ((value: unknown) => value as Result);
    return this.copy<{ readonly pages: ReadonlyArray<Result> }>(
      { cardinality: "infinite", infiniteOptions: options },
      {
        viewSelect: (value) => ({ pages: [previous(value) as Result] }),
      },
    );
  }

  /** Mark the spec as live (default). `subscribe` re-emits whenever a
   * source row changes. */
  live(): DbQuerySpec<Result> {
    return this.copy({ mode: "live" });
  }

  /** Mark the spec as static. `subscribe` resolves once with the
   * initial value and does not re-emit. */
  static(): DbQuerySpec<Result> {
    return this.copy({ mode: "static" });
  }

  /** Defer the query during SSR. The route builder records `deferred: true`
   * so the client knows to `useDbLiveQuery` instead of waiting for the
   * initial value. */
  defer(): DbQuerySpec<Result> {
    return this.copy({ deferred: true });
  }

  /** Run the query during SSR for cache warm-up, but do not return
   * the result to the client. The route builder records
   * `preloadOnly: true` so the client omits the query from the loader
   * payload. */
  preloadOnly(): DbQuerySpec<Result> {
    return this.copy({ preloadOnly: true });
  }

  /** Mark the spec as required. The runtime throws {@link DbNotFoundError}
   * if the value resolves to `null` or `undefined`. The static type
   * narrows to `NonNullable<Result>`. */
  required(): DbQuerySpec<NonNullable<Result>> {
    return this.copy<NonNullable<Result>>({ required: true });
  }

  /** Tag the spec with a logical field name. The route builder and
   * the React hooks use this to look up per-field live-query
   * subscriptions. */
  field<const Name extends string>(name: Name): DbQuerySpec<Result> {
    return this.copy({ field: name });
  }

  /** Return the stable key the spec was constructed with. */
  key(): ReadonlyArray<unknown> {
    return this.options.key;
  }

  /** Return the stable key used by React resource caches. Unlike
   * {@link DbQuerySpec.key}, this includes view and selector composition. */
  cacheKey(): ReadonlyArray<unknown> {
    return this.resourceKey;
  }

  /**
   * Resolve the spec once. If a native `queryBuilder` is set, runs it
   * through `queryOnce(...)` and applies the view/selector chain.
   * Otherwise, runs the user-provided `options.execute` callback.
   * Throws {@link DbNotFoundError} if `.required()` is set and the
   * result is nullish.
   */
  async execute(): Promise<Result> {
    const projection = this.viewSelect;
    if (this.queryBuilder) {
      const raw = await executeNative(this.queryBuilder);
      return this.requireResult(projection ? projection(raw) : (raw as Result));
    }
    if (!this.options.execute) {
      throw new Error(`Query ${JSON.stringify(this.key())} has no executor.`);
    }
    const raw = await this.options.execute();
    return this.requireResult(projection ? projection(raw) : raw);
  }

  /**
   * Subscribe to live updates for the spec. The first emission
   * arrives after `preload()` resolves; subsequent emissions fire on
   * every change to the underlying collection. Returns a teardown
   * function that is safe to call multiple times.
   *
   * @param onValue - invoked with the latest value.
   * @param onError - invoked with the load error or any error raised
   *   inside the value projection.
   */
  subscribe(onValue: (value: Result) => void, onError?: (error: unknown) => void): () => void {
    if (!this.queryBuilder) {
      throw new Error(
        `Query ${JSON.stringify(this.key())} cannot subscribe without a native query builder.`,
      );
    }
    const projection = this.viewSelect;
    const collection = createLiveQueryCollection(this.queryBuilder as never) as unknown as {
      subscribeChanges: (cb: () => void) => { unsubscribe: () => void };
      preload(): Promise<void>;
      cleanup(): Promise<void>;
      values(): IterableIterator<unknown>;
      toArray: Array<unknown>;
    };
    let loading = true;
    let unsubscribed = false;
    const isLoading = () => loading;
    const unregister = this.liveQueryTracker?.register(this.key(), isLoading);
    const emit = () => {
      if (unsubscribed) return;
      try {
        const raw = readLiveCollection(collection, this.metadata.cardinality);
        onValue(this.requireResult(projection ? projection(raw) : (raw as Result)));
      } catch (error) {
        onError?.(error);
      }
    };
    const subscription = collection.subscribeChanges(() => {
      if (this.metadata.mode === "live") emit();
    });
    const unsubscribeView =
      this.metadata.mode === "live" && this.view
        ? this.subscribeView?.(this.view, emit)
        : undefined;
    void collection.preload().then(
      () => {
        loading = false;
        emit();
      },
      (error: unknown) => {
        loading = false;
        if (!unsubscribed) onError?.(error);
      },
    );
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      subscription.unsubscribe();
      unsubscribeView?.();
      unregister?.();
      void collection.cleanup();
    };
  }

  private copy<Next = Result>(
    metadata: Partial<QueryMetadata> = {},
    extras: {
      readonly queryBuilder?: NativeQueryFn;
      readonly viewBuild?: QueryBuild;
      readonly viewSelect?: (value: unknown) => Next;
      readonly resolveView?: (view: DbView, value: unknown) => unknown;
      readonly subscribeView?: (view: DbView, onChange: () => void) => () => void;
      readonly view?: DbView;
      readonly scope?: object;
      readonly liveQueryTracker?: LiveQueryTracker;
      readonly resourceKey?: ReadonlyArray<unknown>;
    } = {},
  ): DbQuerySpec<Next> {
    return new DbQuerySpec<Next>(
      this.options as unknown as DbQueryOptions<Next>,
      { ...this.metadata, ...metadata },
      {
        queryBuilder: extras.queryBuilder ?? this.queryBuilder,
        viewBuild: extras.viewBuild ?? this.viewBuild,
        viewSelect: (extras.viewSelect ?? this.viewSelect) as
          | ((value: unknown) => Next)
          | undefined,
        resolveView: extras.resolveView ?? this.resolveView,
        subscribeView: extras.subscribeView ?? this.subscribeView,
        view: extras.view ?? this.view,
        liveQueryTracker: extras.liveQueryTracker ?? this.liveQueryTracker,
        scope: extras.scope ?? this.scope,
        resourceKey: extras.resourceKey ?? this.resourceKey,
      },
    );
  }

  private requireResult<Value>(value: Value): Value {
    if (this.metadata.required && value == null) {
      throw new DbNotFoundError(`Required query ${JSON.stringify(this.key())} returned no result.`);
    }
    return value;
  }
}

const defaultQueryScope = {};

function serializeView(view: DbView): unknown {
  return {
    entity: view.entity,
    selection: Object.fromEntries(
      Object.entries(view.selection).map(([key, nested]) => [
        key,
        nested === true ? true : serializeView(nested),
      ]),
    ),
  };
}

async function executeNative(buildQuery: NativeQueryFn): Promise<unknown> {
  const raw = (await queryOnce(buildQuery as never)) as unknown;
  return stripVirtualProps(raw);
}

function readLiveCollection(
  collection: {
    values(): IterableIterator<unknown>;
    toArray: Array<unknown>;
  },
  cardinality: QueryCardinality,
): unknown {
  let raw: unknown;
  if (cardinality === "one" || cardinality === "optional") {
    const iterator = collection.values().next();
    raw = iterator.done ? undefined : iterator.value;
  } else {
    raw = collection.toArray;
  }
  return stripVirtualProps(raw);
}

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function stripVirtualProps(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripVirtualProps).filter((nested) => nested !== undefined);
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const result: Record<string, unknown> = {};
    for (const [key, nested] of entries) {
      if (DANGEROUS_KEYS.has(key) || key.startsWith("$")) continue;
      const stripped = stripVirtualProps(nested);
      if (stripped !== undefined) result[key] = stripped;
    }
    if (entries.length > 0 && Object.keys(result).length === 0) return undefined;
    return result;
  }
  return value;
}

/**
 * Factory surface for building ad-hoc {@link DbQuerySpec} instances
 * without going through the generated `q.<entity>.*` helpers. Use this
 * when you want to call a server function or a custom fetcher that
 * does not line up with a schema entity.
 */
export interface QueryFactory {
  one<Result>(options: DbQueryOptions<Result>): DbQuerySpec<Result>;
  many<Result>(options: DbQueryOptions<ReadonlyArray<Result>>): DbQuerySpec<ReadonlyArray<Result>>;
  raw<Result>(options: DbQueryOptions<Result>): DbQuerySpec<Result>;
}

/** Default {@link QueryFactory} implementation. `one` and `raw` produce
 * a single-value spec; `many` produces an array-valued spec. */
export const queryFactory: QueryFactory = {
  one: (options) => new DbQuerySpec(options),
  many: (options) => new DbQuerySpec(options, { cardinality: "many" }),
  raw: (options) => new DbQuerySpec(options),
};

/** Extract the result type of a {@link DbQuerySpec}. Useful in typed
 * helpers that wrap a query and want to preserve the underlying shape. */
export type InferDbQueryResult<Query extends DbQuerySpec> =
  Query extends DbQuerySpec<infer Result> ? Result : never;

/** The shape of a list-valued query result. */
export type DbList<Item> = ReadonlyArray<Item>;

/** The shape of an infinite query result. `pages[i]` is the i-th page
 * of items; the query emits a new value whenever a new page is loaded. */
export interface DbInfiniteList<Item> {
  readonly pages: ReadonlyArray<ReadonlyArray<Item>>;
}
