import type { DbQuerySpec } from "./query.ts";

/** Brand symbol used to detect {@link DbInfiniteQuerySpec} values at
 * runtime. Mirrors `dbViewSymbol` for views. */
export const dbInfiniteSymbol = Symbol("tanstackstart-db.infinite");

/**
 * Options for cursor-based pagination. A page is a `DbQuerySpec<Page>`;
 * the cursor (`Param`) is whatever the application uses to advance
 * (a page number, an opaque cursor string, an `updatedAt` timestamp,
 * etc.). The runtime treats `Param` as opaque — it forwards the value
 * to `pageSpec` and stores it in `pageParams`.
 *
 * @typeParam Page - the per-page result type. Inferred from the spec
 *   returned by `pageSpec`.
 * @typeParam Param - the cursor type. Inferred from
 *   `initialPageParam` and `getNextPageParam`.
 *
 * @example
 * ```ts
 * const recentPosts = createInfiniteQuery({
 *   pageSpec: (cursor: string | undefined) =>
 *     q.post.all().as(postCardView).static(),
 *   initialPageParam: undefined,
 *   getNextPageParam: (lastPage) => lastPage.at(-1)?.id,
 * });
 * ```
 */
export interface InfiniteOptions<Page, Param> {
  /** Build a per-page spec for the given cursor. The runtime invokes
   * this once for the initial page and again for every subsequent
   * page returned by `getNextPageParam`. */
  readonly pageSpec: (param: Param) => DbQuerySpec<Page>;
  /** Cursor used to build the first page. */
  readonly initialPageParam: Param;
  /** Extract the next cursor from the last loaded page. Return
   * `null` or `undefined` to signal that no more pages are available.
   * The runtime treats both as "end of pagination". */
  readonly getNextPageParam: (
    lastPage: Page,
    allPages: ReadonlyArray<Page>,
  ) => Param | null | undefined;
}

/**
 * The reactive state of a {@link DbInfiniteQuerySpec}. The state
 * updates whenever a new page resolves, the source collection
 * changes, or `loadMore()` is called.
 *
 * @typeParam Page - per-page result type.
 * @typeParam Param - cursor type.
 */
export type DbInfiniteState<Page, Param> =
  | { readonly status: "loading" }
  | {
      readonly status: "ready";
      readonly pages: ReadonlyArray<Page>;
      readonly pageParams: ReadonlyArray<Param>;
      readonly hasNextPage: boolean;
      readonly isLoadingNext: boolean;
      readonly error?: unknown;
    }
  | { readonly status: "error"; readonly error: unknown };

/**
 * A paginated live query. Holds a builder that produces a
 * {@link DbQuerySpec} per page, plus the cursor logic that decides
 * whether another page is available.
 *
 * `useDbLiveInfiniteQuery(spec)` (in `@doeixd/tanstackstart-db/react`)
 * subscribes to the live state. `firstPage()` is intended for routes
 * that need a single SSR-resolved page; the route builder calls it
 * during loader execution.
 *
 * @typeParam Page - per-page result type.
 * @typeParam Param - cursor type.
 *
 * @example
 * ```ts
 * const inf = createInfiniteQuery({
 *   pageSpec: (cursor) => q.post.all().as(postCardView).static(),
 *   initialPageParam: undefined,
 *   getNextPageParam: (last) => last.at(-1)?.id,
 * });
 *
 * const { pages, hasNextPage, loadMore } = useDbLiveInfiniteQuery(inf);
 * ```
 */
export interface DbInfiniteQuerySpec<Page, Param> {
  readonly [dbInfiniteSymbol]: true;
  readonly options: InfiniteOptions<Page, Param>;
  /** Latest snapshot of the pagination state. Mutates as pages load. */
  readonly current: DbInfiniteState<Page, Param>;
  /** Load the next page if `hasNextPage` is `true`. No-op when the
   * infinite spec is already loading the next page. */
  loadMore(): Promise<void>;
  /** Subscribe to state changes. Returns a teardown function. */
  subscribe(
    onChange: (state: DbInfiniteState<Page, Param>) => void,
    onError?: (error: unknown) => void,
  ): () => void;
  /** Resolve the first page only. Used by route loaders that need a
   * single SSR-resolved value. */
  firstPage(): Promise<Page>;
  /** Release retained subscriptions. Subsequent `loadMore()` calls
   * fail. Safe to call multiple times. */
  dispose(): void;
}

/**
 * Construct a {@link DbInfiniteQuerySpec} from an
 * {@link InfiniteOptions} block. The runtime is framework-neutral; the
 * React entrypoint provides hooks that consume it.
 *
 * @typeParam Page - per-page result type. Inferred from
 *   `options.pageSpec`'s return value.
 * @typeParam Param - cursor type. Inferred from
 *   `options.initialPageParam` and `options.getNextPageParam`.
 *
 * @param options - pagination options.
 * @returns a live, paginated query spec.
 *
 * @example
 * ```ts
 * const inf = createInfiniteQuery({
 *   pageSpec: (cursor: number) => q.post.page(cursor).as(postCardView).static(),
 *   initialPageParam: 0,
 *   getNextPageParam: (_, pages) => pages.length,
 * });
 * ```
 */
export function createInfiniteQuery<Page, Param>(
  options: InfiniteOptions<Page, Param>,
): DbInfiniteQuerySpec<Page, Param> {
  type State = DbInfiniteState<Page, Param>;
  const listeners = new Set<(state: State) => void>();
  let state: State = { status: "loading" };
  let pageUnsubscribers: Array<() => void> = [];
  let isLoadingNext = false;
  let disposed = false;

  const notify = (next: State) => {
    state = next;
    for (const listener of listeners) listener(next);
  };

  const subscribePage = (
    param: Param,
    onPage: (page: Page) => void,
    onError: (err: unknown) => void,
  ) => {
    const spec = options.pageSpec(param);
    if (!spec.queryBuilder) {
      let cancelled = false;
      void spec
        .execute()
        .then((value) => {
          if (cancelled) return;
          onPage(value);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          onError(error);
        });
      const cancel = () => {
        cancelled = true;
      };
      pageUnsubscribers.push(cancel);
      return cancel;
    }
    const unsubscribe = spec.subscribe(onPage, onError);
    pageUnsubscribers.push(unsubscribe);
    return unsubscribe;
  };

  const startInitial = () => {
    let firstPageValue: Page | undefined;
    let firstError: unknown;
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      if (firstError !== undefined) {
        notify({ status: "error", error: firstError });
        return;
      }
      if (firstPageValue === undefined) {
        notify({ status: "error", error: new Error("Initial page resolved to no value.") });
        return;
      }
      const pages: Array<Page> = [firstPageValue];
      const pageParams: Array<Param> = [options.initialPageParam];
      const nextParam = options.getNextPageParam(firstPageValue, pages);
      notify({
        status: "ready",
        pages,
        pageParams,
        hasNextPage: nextParam != null,
        isLoadingNext: false,
      });
    };
    subscribePage(
      options.initialPageParam,
      (value) => {
        firstPageValue = value;
        if (resolved) {
          // Live update on the first page; surface it.
          const previous = state;
          if (previous.status === "ready") {
            const nextPages = [value, ...previous.pages.slice(1)];
            notify({
              ...previous,
              pages: nextPages,
            });
          }
        } else {
          finish();
        }
      },
      (error) => {
        firstError = error;
        finish();
      },
    );
  };

  const loadMore = (): Promise<void> => {
    if (disposed) return Promise.reject(new Error("Infinite query was disposed."));
    if (state.status !== "ready") {
      return Promise.reject(new Error("Cannot load more pages before the first page resolves."));
    }
    const currentState = state;
    if (!currentState.hasNextPage || isLoadingNext) return Promise.resolve();
    const lastPage = currentState.pages[currentState.pages.length - 1] as Page;
    const nextParam = options.getNextPageParam(lastPage, currentState.pages);
    if (nextParam == null) {
      notify({ ...currentState, hasNextPage: false });
      return Promise.resolve();
    }
    isLoadingNext = true;
    notify({ ...currentState, isLoadingNext: true });
    return new Promise<void>((resolve, reject) => {
      let nextValue: Page | undefined;
      let nextError: unknown;
      let resolved = false;
      const finish = () => {
        if (resolved) return;
        resolved = true;
        isLoadingNext = false;
        if (nextError !== undefined) {
          notify({ ...currentState, isLoadingNext: false, error: nextError });
          reject(nextError);
          return;
        }
        if (nextValue === undefined) {
          const error = new Error("Next page resolved to no value.");
          notify({ ...currentState, isLoadingNext: false, error });
          reject(error);
          return;
        }
        const pages = [...currentState.pages, nextValue];
        const pageParams = [...currentState.pageParams, nextParam];
        const following = options.getNextPageParam(nextValue, pages);
        notify({
          status: "ready",
          pages,
          pageParams,
          hasNextPage: following != null,
          isLoadingNext: false,
        });
        resolve();
      };
      subscribePage(
        nextParam,
        (value) => {
          nextValue = value;
          finish();
        },
        (error) => {
          nextError = error;
          finish();
        },
      );
    });
  };

  const subscribe = (
    onChange: (next: State) => void,
    onError?: (error: unknown) => void,
  ): (() => void) => {
    if (disposed) return () => {};
    const wrapped = (next: State) => {
      if (next.status === "error" && onError) onError(next.error);
      onChange(next);
    };
    listeners.add(wrapped);
    return () => {
      listeners.delete(wrapped);
    };
  };

  const firstPage = (): Promise<Page> => {
    if (disposed) return Promise.reject(new Error("Infinite query was disposed."));
    return new Promise<Page>((resolve, reject) => {
      const unsubscribe = options.pageSpec(options.initialPageParam).subscribe(
        (value) => {
          unsubscribe();
          resolve(value);
        },
        (error) => {
          unsubscribe();
          reject(error);
        },
      );
    });
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    for (const unsubscribe of pageUnsubscribers) unsubscribe();
    pageUnsubscribers = [];
    listeners.clear();
  };

  startInitial();

  const spec: DbInfiniteQuerySpec<Page, Param> = {
    [dbInfiniteSymbol]: true,
    options,
    get current() {
      return state;
    },
    loadMore,
    subscribe,
    firstPage,
    dispose,
  };
  return spec;
}

/** Type-guard for {@link DbInfiniteQuerySpec}. */
export const isDbInfiniteQuerySpec = <Page, Param>(
  value: unknown,
): value is DbInfiniteQuerySpec<Page, Param> =>
  typeof value === "object" &&
  value !== null &&
  (value as { [dbInfiniteSymbol]?: true })[dbInfiniteSymbol] === true;
