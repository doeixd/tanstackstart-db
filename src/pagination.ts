import type { Collection, CollectionConfig, UtilsRecord } from "@tanstack/db";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import type { StandardSchemaV1 } from "./schema.ts";
import type { DbView, InferView } from "./index.ts";
import { pickView } from "./view.ts";

/**
 * Parameters passed to the `fetchPage` callback. The runtime fills in the
 * cursor fields based on the pagination direction and current state.
 */
export interface FetchPageParams {
  /** Load items with a cursor greater than this value. */
  readonly after?: string | number;
  /** Load items with a cursor less than this value. */
  readonly before?: string | number;
  /** Maximum number of items to return. */
  readonly limit: number;
  /** Whether this is the initial page load. */
  readonly isInitial?: boolean;
}

/**
 * Result returned by the `fetchPage` callback.
 *
 * @typeParam TItem - the item type being paginated.
 */
export interface FetchPageResult<TItem extends object> {
  /** The items for this page. */
  readonly items: ReadonlyArray<TItem>;
  /** Whether more pages are available after this one. Defaults to `true` if the page is full. */
  readonly hasNextPage?: boolean;
  /** Whether more pages are available before this one. Only relevant for backward pagination. */
  readonly hasPreviousPage?: boolean;
  /** Total number of items across all pages. Optional. */
  readonly totalCount?: number;
}

/**
 * Configuration for a paginated collection.
 *
 * The collection syncs data page-by-page, growing incrementally as pages
 * are loaded. Items are deduplicated by `getKey`, so calling
 * `loadNextPage` twice with the same cursor is safe.
 *
 * @typeParam TItem - the item type stored in the collection.
 *
 * @example
 * ```ts
 * const comments = createCollection(
 *   paginatedCollectionOptions({
 *     id: 'comments',
 *     getKey: (c) => c.id,
 *     pageSize: 10,
 *     cursor: 'id',
 *     direction: 'both',
 *     fetchPage: async ({ after, before, limit }) => {
 *       const params = new URLSearchParams();
 *       if (after !== undefined) params.set('after', String(after));
 *       if (before !== undefined) params.set('before', String(before));
 *       params.set('limit', String(limit));
 *       const response = await fetch(`/api/comments?${params}`);
 *       return response.json();
 *     },
 *   })
 * );
 * ```
 */
export interface PaginatedCollectionConfig<TItem extends object> {
  /** Optional collection ID. If omitted, the collection is anonymous. */
  readonly id?: string;
  /** Function to extract the unique key from an item. Used for deduplication. */
  readonly getKey: (item: TItem) => string | number;
  /** Optional schema for validation. */
  readonly schema?: StandardSchemaV1;
  /** Number of items per page. Must be a positive integer. */
  readonly pageSize: number;
  /** Field name to use as the cursor. Must be a string or number field on `TItem`. */
  readonly cursor: keyof TItem & string;
  /** Direction of pagination. Defaults to `"forward"` only. */
  readonly direction?: "forward" | "backward" | "both";
  /**
   * Fetch a page of items. Called for the initial page and every
   * subsequent `loadNextPage` / `loadPreviousPage` call.
   *
   * The runtime passes cursor parameters based on the current state and
   * the requested direction. Return `{ items, hasNextPage?, hasPreviousPage?, totalCount? }`.
   */
  readonly fetchPage: (params: FetchPageParams) => Promise<FetchPageResult<TItem>>;
}

/**
 * Pagination state exposed via collection utilities.
 */
export interface PaginationState {
  /** Whether more pages are available after the current set. */
  readonly hasNextPage: boolean;
  /** Whether more pages are available before the current set. */
  readonly hasPreviousPage: boolean;
  /** Whether a `loadNextPage` call is in flight. */
  readonly isLoadingNext: boolean;
  /** Whether a `loadPreviousPage` call is in flight. */
  readonly isLoadingPrevious: boolean;
  /** The last error from a `loadNextPage` or `loadPreviousPage` call. Cleared on next successful load. */
  readonly error?: unknown;
  /** Total number of items across all pages, if reported by the server. */
  readonly totalCount?: number;
  /** Number of items currently loaded in the collection. */
  readonly loadedCount: number;
}

/**
 * Pagination utilities exposed via `collection.utils`.
 *
 * @typeParam TItem - the item type stored in the collection.
 */
export interface PaginationUtils<TItem extends object> extends UtilsRecord {
  /**
   * Load the next page of items. Always defined; the function itself is a
   * no-op if there are no more pages or a load is already in flight. Check
   * `getState().hasNextPage` to decide whether to show a "load more" button.
   */
  readonly loadNextPage: () => Promise<void>;
  /**
   * Load the previous page of items. `undefined` when `direction` is not
   * `"backward"` or `"both"`. Otherwise always defined; check
   * `getState().hasPreviousPage` to decide whether to render the trigger.
   */
  readonly loadPreviousPage: (() => Promise<void>) | undefined;
  /**
   * Refetch the first page, clearing all previously loaded data. Useful
   * for refresh buttons. The function is a no-op if a load is already in
   * flight.
   */
  readonly refetchFirstPage: () => Promise<void>;
  /** Subscribe to pagination state changes. Returns a teardown function. */
  readonly subscribe: (callback: () => void) => () => void;
  /** Get the current pagination state snapshot. */
  readonly getState: () => PaginationState;
  /**
   * Get the current collection instance. Useful for direct access to
   * the underlying TanStack DB collection.
   */
  readonly getCollection: () => Collection<TItem, string | number> | undefined;
}

type SyncCollection<TItem extends object, TKey extends string | number> = {
  readonly toArray: () => Array<TItem>;
  readonly size: number;
  readonly has: (key: TKey) => boolean;
  readonly get: (key: TKey) => TItem | undefined;
  readonly subscribeChanges: (callback: () => void) => { unsubscribe: () => void };
};

type SyncWriteMessage<TItem extends object, TKey extends string | number> =
  | { readonly type: "insert"; readonly value: TItem }
  | { readonly type: "delete"; readonly key: TKey };

type SyncPrimitives<TItem extends object, TKey extends string | number> = {
  readonly begin: () => void;
  readonly write: (message: SyncWriteMessage<TItem, TKey>) => void;
  readonly commit: () => void;
  readonly markReady: () => void;
};

/**
 * Create a paginated collection options object.
 *
 * The returned object is a valid `CollectionConfig` that can be passed to
 * TanStack DB's `createCollection`. The collection syncs data page-by-page:
 * - On mount, the first page is fetched and inserted.
 * - `loadNextPage()` / `loadPreviousPage()` fetch subsequent pages and
 *   append / prepend items to the collection.
 * - Items are deduplicated by `getKey`, so duplicate fetches are safe.
 *
 * @typeParam TItem - the item type stored in the collection.
 *
 * @example
 * ```ts
 * const comments = createCollection(
 *   paginatedCollectionOptions({
 *     id: 'comments',
 *     getKey: (c) => c.id,
 *     pageSize: 10,
 *     cursor: 'id',
 *     direction: 'both',
 *     fetchPage: async ({ after, limit }) => {
 *       const response = await fetch(`/api/comments?after=${after}&limit=${limit}`);
 *       return response.json();
 *     },
 *   })
 * );
 *
 * // Load more pages
 * await comments.utils.loadNextPage();
 *
 * // Query all synced data
 * const allComments = db.q.comment.all().execute();
 * ```
 */
export function paginatedCollectionOptions<TItem extends object>(
  config: PaginatedCollectionConfig<TItem>,
): CollectionConfig<TItem> & { utils: PaginationUtils<TItem> } {
  if (!Number.isInteger(config.pageSize) || config.pageSize <= 0) {
    throw new Error(
      `paginatedCollectionOptions: pageSize must be a positive integer, got ${config.pageSize}`,
    );
  }

  const direction = config.direction ?? "forward";
  const supportsBackward = direction === "backward" || direction === "both";

  // Mutable state tracked across the lifetime of the collection
  let nextCursor: string | number | undefined;
  let previousCursor: string | number | undefined;
  let hasNextPage = true;
  let hasPreviousPage = supportsBackward;
  let isLoadingNext = false;
  let isLoadingPrevious = false;
  let error: unknown;
  let totalCount: number | undefined;
  let collectionRef: SyncCollection<TItem, string | number> | undefined;
  let syncPrimitives: SyncPrimitives<TItem, string | number> | undefined;
  let isDisposed = false;

  const subscribers = new Set<() => void>();
  const loadedKeys = new Set<string | number>();

  const notify = () => {
    if (isDisposed) return;
    for (const callback of subscribers) {
      callback();
    }
  };

  const extractCursor = (item: TItem): string | number | undefined => {
    const value = item[config.cursor];
    if (typeof value === "string" || typeof value === "number") {
      return value;
    }
    return undefined;
  };

  const applyPage = (
    items: ReadonlyArray<TItem>,
    params: FetchPageParams,
    result: FetchPageResult<TItem>,
  ): void => {
    // Deduplicate by key - skip items already loaded
    const newItems: Array<TItem> = [];
    for (const item of items) {
      const key = config.getKey(item);
      if (loadedKeys.has(key)) continue;
      loadedKeys.add(key);
      newItems.push(item);
    }

    if (newItems.length === 0) return;

    if (!syncPrimitives) return;

    syncPrimitives.begin();
    for (const item of newItems) {
      syncPrimitives.write({ type: "insert", value: item });
    }
    syncPrimitives.commit();

    // Update cursors based on fetched items
    if (newItems.length > 0) {
      const lastItem = newItems[newItems.length - 1];
      const firstItem = newItems[0];
      const newNext = extractCursor(lastItem);
      const newPrev = extractCursor(firstItem);
      if (newNext !== undefined) nextCursor = newNext;
      if (newPrev !== undefined) previousCursor = newPrev;
    }

    // Update pagination availability
    if (result.hasNextPage !== undefined) {
      hasNextPage = result.hasNextPage;
    } else if (!params.before) {
      hasNextPage = newItems.length >= config.pageSize;
    }
    if (supportsBackward) {
      if (result.hasPreviousPage !== undefined) {
        hasPreviousPage = result.hasPreviousPage;
      } else if (params.after) {
        hasPreviousPage = newItems.length >= config.pageSize;
      }
    }

    if (result.totalCount !== undefined) {
      totalCount = result.totalCount;
    }
  };

  const fetchAndApplyPage = async (params: FetchPageParams): Promise<void> => {
    const result = await config.fetchPage(params);
    if (isDisposed) return;
    applyPage(result.items, params, result);
  };

  const sync = async (params: {
    readonly collection: SyncCollection<TItem, string | number>;
    readonly begin: () => void;
    readonly write: (message: SyncWriteMessage<TItem, string | number>) => void;
    readonly commit: () => void;
    readonly markReady: () => void;
  }) => {
    const { begin, write, commit, markReady, collection } = params;
    collectionRef = collection;
    syncPrimitives = { begin, write, commit, markReady };

    try {
      const result = await config.fetchPage({
        limit: config.pageSize,
        isInitial: true,
      });

      if (isDisposed) return;

      // Track keys for deduplication
      const initialItems: Array<TItem> = [];
      for (const item of result.items) {
        const key = config.getKey(item);
        if (!loadedKeys.has(key)) {
          loadedKeys.add(key);
          initialItems.push(item);
        }
      }

      if (initialItems.length > 0) {
        begin();
        for (const item of initialItems) {
          write({ type: "insert", value: item });
        }
        commit();
      }

      if (initialItems.length > 0) {
        const lastItem = initialItems[initialItems.length - 1];
        const firstItem = initialItems[0];
        const newNext = extractCursor(lastItem);
        const newPrev = extractCursor(firstItem);
        if (newNext !== undefined) nextCursor = newNext;
        if (newPrev !== undefined) previousCursor = newPrev;
      }

      if (result.hasNextPage !== undefined) {
        hasNextPage = result.hasNextPage;
      } else {
        hasNextPage = initialItems.length >= config.pageSize;
      }
      if (supportsBackward) {
        if (result.hasPreviousPage !== undefined) {
          hasPreviousPage = result.hasPreviousPage;
        } else {
          hasPreviousPage = initialItems.length >= config.pageSize;
        }
      }
      if (result.totalCount !== undefined) {
        totalCount = result.totalCount;
      }

      markReady();
      notify();
    } catch (err) {
      error = err;
      markReady();
      notify();
    }
  };

  const loadNextPage = async (): Promise<void> => {
    if (isDisposed) return;
    if (!hasNextPage || isLoadingNext || nextCursor === undefined) return;

    isLoadingNext = true;
    error = undefined;
    notify();

    try {
      await fetchAndApplyPage({
        after: nextCursor,
        limit: config.pageSize,
      });
    } catch (err) {
      error = err;
      throw err;
    } finally {
      isLoadingNext = false;
      notify();
    }
  };

  const loadPreviousPage = async (): Promise<void> => {
    if (isDisposed) return;
    if (!supportsBackward) return;
    if (!hasPreviousPage || isLoadingPrevious || previousCursor === undefined) return;

    isLoadingPrevious = true;
    error = undefined;
    notify();

    try {
      await fetchAndApplyPage({
        before: previousCursor,
        limit: config.pageSize,
      });
    } catch (err) {
      error = err;
      throw err;
    } finally {
      isLoadingPrevious = false;
      notify();
    }
  };

  const refetchFirstPage = async (): Promise<void> => {
    if (isDisposed) return;
    if (isLoadingNext || isLoadingPrevious) return;
    if (!syncPrimitives) return;

    // Delete all existing items via sync primitives
    const keysToDelete = Array.from(loadedKeys);
    if (keysToDelete.length > 0) {
      syncPrimitives.begin();
      for (const key of keysToDelete) {
        syncPrimitives.write({ type: "delete", key });
      }
      syncPrimitives.commit();
    }
    loadedKeys.clear();

    // Reset cursors
    nextCursor = undefined;
    previousCursor = undefined;
    hasNextPage = true;
    hasPreviousPage = supportsBackward;
    totalCount = undefined;
    error = undefined;

    notify();

    isLoadingNext = true;
    notify();

    try {
      const result = await config.fetchPage({
        limit: config.pageSize,
        isInitial: true,
      });

      if (isDisposed) return;

      const initialItems: Array<TItem> = [];
      for (const item of result.items) {
        const key = config.getKey(item);
        if (!loadedKeys.has(key)) {
          loadedKeys.add(key);
          initialItems.push(item);
        }
      }

      if (initialItems.length > 0) {
        syncPrimitives.begin();
        for (const item of initialItems) {
          syncPrimitives.write({ type: "insert", value: item });
        }
        syncPrimitives.commit();
      }

      if (initialItems.length > 0) {
        const lastItem = initialItems[initialItems.length - 1];
        const firstItem = initialItems[0];
        const newNext = extractCursor(lastItem);
        const newPrev = extractCursor(firstItem);
        if (newNext !== undefined) nextCursor = newNext;
        if (newPrev !== undefined) previousCursor = newPrev;
      }

      if (result.hasNextPage !== undefined) {
        hasNextPage = result.hasNextPage;
      } else {
        hasNextPage = initialItems.length >= config.pageSize;
      }
      if (supportsBackward) {
        if (result.hasPreviousPage !== undefined) {
          hasPreviousPage = result.hasPreviousPage;
        } else {
          hasPreviousPage = initialItems.length >= config.pageSize;
        }
      }
      if (result.totalCount !== undefined) {
        totalCount = result.totalCount;
      }
    } catch (err) {
      error = err;
      throw err;
    } finally {
      isLoadingNext = false;
      notify();
    }
  };

  const subscribe = (callback: () => void): (() => void) => {
    subscribers.add(callback);
    return () => {
      subscribers.delete(callback);
    };
  };

  const getState = (): PaginationState => ({
    hasNextPage,
    hasPreviousPage,
    isLoadingNext,
    isLoadingPrevious,
    error,
    totalCount,
    loadedCount: loadedKeys.size,
  });

  const getCollection = (): Collection<TItem, string | number> | undefined => {
    return collectionRef as unknown as Collection<TItem, string | number> | undefined;
  };

  return {
    id: config.id,
    getKey: config.getKey,
    schema: config.schema as never,
    startSync: true,
    sync: {
      sync: sync as never,
    },
    utils: {
      loadNextPage,
      loadPreviousPage: supportsBackward ? loadPreviousPage : undefined,
      refetchFirstPage,
      subscribe,
      getState,
      getCollection,
    },
  };
}

/**
 * Options for {@link useListView}.
 *
 * @typeParam TItem - the item type in the collection.
 * @typeParam View - the view type to project items through.
 */
export interface UseListViewOptions<TItem extends object, View extends DbView> {
  /** The paginated collection instance. */
  readonly collection: Collection<TItem, string | number> & {
    readonly utils: PaginationUtils<TItem>;
  };
  /** The view to project items through. */
  readonly view: View;
}

/**
 * State returned by {@link useListView}.
 */
export interface ListViewState {
  readonly hasNextPage: boolean;
  readonly hasPreviousPage: boolean;
  readonly isLoadingNext: boolean;
  readonly isLoadingPrevious: boolean;
  readonly error?: unknown;
  readonly totalCount?: number;
  readonly loadedCount: number;
}

/**
 * React hook for paginated list views with cursor-based pagination.
 *
 * Returns a tuple of `[items, loadNext, loadPrevious, state]`:
 * - `items` - all loaded items projected through the view
 * - `loadNext` - function to load the next page, or `undefined` if no more pages or a load is in flight
 * - `loadPrevious` - function to load the previous page, or `undefined` if at the start or unsupported
 * - `state` - pagination state (hasNextPage, hasPreviousPage, loading flags, counts)
 *
 * The hook subscribes to both the pagination state and the collection's
 * change events, so it re-renders when new items are loaded or pagination
 * state changes.
 *
 * @typeParam TItem - the item type in the collection.
 * @typeParam View - the view type to project items through.
 *
 * @example
 * ```ts
 * const comments = createCollection(
 *   paginatedCollectionOptions({
 *     getKey: (c) => c.id,
 *     pageSize: 10,
 *     cursor: 'id',
 *     direction: 'both',
 *     fetchPage: async ({ after, limit }) => {
 *       const response = await fetch(`/api/comments?after=${after}&limit=${limit}`);
 *       return response.json();
 *     },
 *   })
 * );
 *
 * function PostComments() {
 *   const [comments, loadNext, loadPrevious, state] = useListView({
 *     collection: comments,
 *     view: CommentView,
 *   });
 *
 *   return (
 *     <div>
 *       {loadPrevious && <button onClick={loadPrevious}>Load older</button>}
 *       {comments.map((comment) => (
 *         <CommentCard key={comment.id} comment={comment} />
 *       ))}
 *       {loadNext && <button onClick={loadNext}>Load newer</button>}
 *     </div>
 *   );
 * }
 * ```
 */
export function useListView<TItem extends object, View extends DbView>(
  options: UseListViewOptions<TItem, View>,
): [
  items: ReadonlyArray<InferView<View>>,
  loadNext: (() => Promise<void>) | undefined,
  loadPrevious: (() => Promise<void>) | undefined,
  state: ListViewState,
] {
  const { collection, view } = options;

  const paginationState = useSyncExternalStore(
    collection.utils.subscribe,
    collection.utils.getState,
    collection.utils.getState,
  );

  const versionRef = useMemo(() => ({ current: 0 }), []);

  useSyncExternalStore(
    (callback) => {
      const subscription = (
        collection as unknown as SyncCollection<TItem, string | number>
      ).subscribeChanges(() => {
        versionRef.current += 1;
        callback();
      });
      return () => subscription.unsubscribe();
    },
    () => versionRef.current,
    () => versionRef.current,
  );

  const rawItems = useMemo(
    () => (collection as unknown as SyncCollection<TItem, string | number>).toArray(),
    // versionRef.current changes when the collection changes, so this recomputes
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [collection, versionRef.current],
  );

  const items = useMemo(
    () => rawItems.map((item) => pickView(view, item as never)),
    [rawItems, view],
  );

  const loadNext = useMemo(
    () =>
      paginationState.hasNextPage && !paginationState.isLoadingNext
        ? collection.utils.loadNextPage
        : undefined,
    [paginationState.hasNextPage, paginationState.isLoadingNext, collection.utils.loadNextPage],
  );

  const loadPrevious = useMemo(() => {
    if (!collection.utils.loadPreviousPage) return undefined;
    return paginationState.hasPreviousPage && !paginationState.isLoadingPrevious
      ? collection.utils.loadPreviousPage
      : undefined;
  }, [
    paginationState.hasPreviousPage,
    paginationState.isLoadingPrevious,
    collection.utils.loadPreviousPage,
  ]);

  return [items, loadNext, loadPrevious, paginationState];
}

/**
 * Imperative refetch function. Calls `collection.utils.refetchFirstPage()`.
 * Useful for refresh buttons.
 */
export function useRefetchPaginated<TItem extends object>(
  collection: Collection<TItem, string | number> & { readonly utils: PaginationUtils<TItem> },
): () => Promise<void> {
  return useCallback(() => collection.utils.refetchFirstPage(), [collection]);
}
