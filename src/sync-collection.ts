import { type Collection, DuplicateKeyError, DuplicateKeySyncError } from "@tanstack/db";
import { nativeCollection, type EntityId } from "./collection.ts";
import { queryCollection as defineQueryCollection, type QueryCollectionDefinition } from "./db.ts";

/** Options for {@link syncCollection}. Pass a pre-built TanStack DB
 * `Collection<Value, TKey>` (Electric, PowerSync, custom sync, etc.)
 * and the helper wraps it as a {@link QueryCollectionDefinition} so it
 * can be plugged into `createStartDbFromSchema(...)`.
 *
 * - `key` defaults to the schema entity's declared key.
 * - `dehydrate` defaults to reading `engine._state.syncedData.values()`.
 * - `hydrate` defaults to inserting missing rows and updating existing
 *   ones. Race conditions where a concurrent sync inserts the same key
 *   between our existence check and insert are recovered by falling
 *   through to an `update`. Any other error (e.g. schema validation,
 *   missing key) is re-thrown so the caller can surface it. */
export type SyncDbCollectionOptions<
  Value extends Record<string, unknown>,
  TKey extends string | number = string | number,
> = {
  readonly engine: Collection<Value, TKey>;
  readonly key?: string;
  readonly dehydrate?: (engine: Collection<Value, TKey>) => ReadonlyArray<Value> | undefined;
  readonly hydrate?: (engine: Collection<Value, TKey>, values: ReadonlyArray<Value>) => void;
};

function defaultDehydrate<Value extends Record<string, unknown>>(
  engine: Collection<Value, EntityId>,
): ReadonlyArray<Value> | undefined {
  try {
    return [...engine._state.syncedData.values()] as Value[];
  } catch {
    return undefined;
  }
}

function defaultHydrate<Value extends Record<string, unknown>>(
  engine: Collection<Value, EntityId>,
  values: ReadonlyArray<Value>,
  key: string,
): void {
  for (const value of values) {
    const id = value[key] as EntityId;
    if (engine.get(id)) {
      engine.update(id, (draft) => {
        Object.assign(draft, value);
      });
      continue;
    }
    try {
      engine.insert(value as never);
    } catch (error) {
      if (error instanceof DuplicateKeyError || error instanceof DuplicateKeySyncError) {
        // Best-effort: a concurrent sync may have inserted this row
        // between our `engine.get(id)` check and the `insert` call. Fall
        // through to an `update` so the snapshot row wins.
        if (!engine.get(id)) throw error;
        engine.update(id, (draft) => {
          Object.assign(draft, value);
        });
        continue;
      }
      throw error;
    }
  }
}

/**
 * Build a {@link QueryCollectionDefinition} for an entity backed by a
 * pre-existing TanStack DB `Collection<Value, TKey>`. Use this when you
 * have a custom sync engine (Electric, PowerSync, a long-poll, etc.)
 * and want the optimistic cache, view projection, and `dehydrate`/
 * `hydrate` plumbing to ride on top of it.
 *
 * The default `dehydrate` reads the engine's confirmed state, and the
 * default `hydrate` upserts (insert if missing, update if present) while
 * tolerating concurrent inserts of the same key. Pass overrides if your
 * engine exposes a richer surface (e.g. a `writeUpsert` utility).
 *
 * @typeParam Value - the entity row shape.
 * @typeParam TKey - the engine's key type. Defaults to `string | number`.
 *
 * @example
 * ```ts
 * import { electricCollectionOptions } from "@tanstack/electric-db-collection";
 * import { syncCollection } from "tanstackstart-db";
 *
 * const posts = syncCollection<Post>("post", {
 *   engine: createCollection(electricCollectionOptions({
 *     id: "post",
 *     shapeOptions: { url: "/api/posts/stream" },
 *     getKey: (p) => p.id,
 *   })),
 *   key: "id",
 *   dehydrate: (engine) => [...engine._state.syncedData.values()],
 * });
 * ```
 */
export function syncCollection<Value extends Record<string, unknown>>(
  entityName: string,
  options: SyncDbCollectionOptions<Value>,
): QueryCollectionDefinition<Value> {
  const engine = options.engine as unknown as Collection<Value, EntityId>;
  return defineQueryCollection<Value>(entityName, {
    createCollection: ({ key }) =>
      nativeCollection<Value>(options.key ?? key, engine, {
        dehydrate: options.dehydrate ? () => options.dehydrate!(options.engine) : defaultDehydrate,
        hydrate: options.hydrate
          ? (_target, values) => options.hydrate!(options.engine, values)
          : (target, values) => defaultHydrate(target, values, options.key ?? key),
      }) as never,
  });
}
