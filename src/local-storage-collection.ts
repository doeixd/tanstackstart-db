import {
  createCollection,
  localStorageCollectionOptions,
  type Collection,
  type DeleteMutationFnParams,
  type InsertMutationFnParams,
  type LocalStorageCollectionConfig,
  type LocalStorageCollectionUtils,
  type UpdateMutationFnParams,
} from "@tanstack/db";
import { nativeCollection, type EntityId, type DbCollectionStatus } from "./collection.ts";
import { queryCollection as defineQueryCollection, type QueryCollectionDefinition } from "./db.ts";
import type { StandardSchemaV1 } from "./schema.ts";

/** Sugar for the `onInsert`/`onUpdate`/`onDelete` hooks of the local
 * storage collection. Rows, ids, and `Partial<Value>` changes are
 * derived from `transaction.mutations` for you, mirroring the
 * {@link QueryCollectionMutations} shape. */
export type LocalStorageDbCollectionMutations<Value extends Record<string, unknown>> = {
  readonly insert?: (values: ReadonlyArray<Value>) => unknown;
  readonly update?: (
    values: ReadonlyArray<{
      readonly id: EntityId;
      readonly changes: Partial<Value>;
    }>,
  ) => unknown;
  readonly delete?: (ids: ReadonlyArray<EntityId>) => unknown;
};

/** Options for {@link localStorageCollection}. The `Omit` removes the
 * five fields the helper fills in: `getKey` defaults to the entity's
 * declared `key`, `schema` falls through to the schema's per-entity
 * validator, `storageKey` is the user-provided value, and the three
 * `onInsert`/`onUpdate`/`onDelete` hooks are derived from `mutations`. */
export type LocalStorageDbCollectionOptions<
  Value extends Record<string, unknown>,
  TKey extends string | number = string | number,
> = Omit<
  LocalStorageCollectionConfig<Value, StandardSchemaV1<unknown, Value>, TKey>,
  "getKey" | "schema" | "storageKey" | "onInsert" | "onUpdate" | "onDelete"
> & {
  readonly storageKey: string;
  readonly getKey?: (value: Value) => TKey;
  readonly schema?: StandardSchemaV1<unknown, Value>;
  readonly mutations?: LocalStorageDbCollectionMutations<Value>;
};

/**
 * Build a {@link QueryCollectionDefinition} for an entity persisted in
 * the browser's `localStorage` (or any compatible storage, including a
 * `createMemoryStorage()` instance in tests).
 *
 * - `storageKey` is required and is what `localStorage` keys against.
 * - `mutations` is sugar around the three `onInsert`/`onUpdate`/`onDelete`
 *   hooks. The rows/ids/changes are derived from `transaction.mutations`
 *   for you.
 * - `dehydrate` reads from the configured storage directly (`storage.getItem(storageKey)`)
 *   and unwraps the `{ data, versionKey }` envelope so the snapshot
 *   matches what the next browser session will see, including cross-tab
 *   `storage` events.
 * - `hydrate` walks the values and tries `engine.insert` first, falling
 *   back to `engine.update` if the row already exists.
 *
 * @typeParam Value - the entity row shape.
 *
 * @example
 * ```ts
 * const posts = localStorageCollection<Post>("post", {
 *   storageKey: "posts",
 *   mutations: {
 *     insert: (rows) => api.posts.create(rows),
 *     update: (updates) => api.posts.update(updates),
 *     delete: (ids) => api.posts.remove(ids),
 *   },
 * });
 * ```
 */
export function localStorageCollection<Value extends Record<string, unknown>>(
  entityName: string,
  options: LocalStorageDbCollectionOptions<Value>,
): QueryCollectionDefinition<Value> {
  return defineQueryCollection<Value>(entityName, {
    createCollection: ({ key, schema }) => {
      const {
        mutations,
        storageKey,
        getKey: getKeyOverride,
        schema: schemaOverride,
        ...config
      } = options;
      const insertMutation = mutations?.insert;
      const updateMutation = mutations?.update;
      const deleteMutation = mutations?.delete;
      const engine = createCollection(
        localStorageCollectionOptions({
          ...config,
          id: config.id ?? entityName,
          storageKey,
          getKey: (getKeyOverride ?? ((value: Value) => value[key] as EntityId)) as never,
          schema: (schemaOverride ?? schema) as never,
          onInsert: insertMutation
            ? async ({ transaction }: InsertMutationFnParams<Value, EntityId>) => {
                await insertMutation(
                  transaction.mutations.map((mutation) => mutation.modified as Value),
                );
              }
            : undefined,
          onUpdate: updateMutation
            ? async ({ transaction }: UpdateMutationFnParams<Value, EntityId>) => {
                await updateMutation(
                  transaction.mutations.map((mutation) => ({
                    id: mutation.key,
                    changes: mutation.changes as Partial<Value>,
                  })),
                );
              }
            : undefined,
          onDelete: deleteMutation
            ? async ({ transaction }: DeleteMutationFnParams<Value, EntityId>) => {
                await deleteMutation(transaction.mutations.map((mutation) => mutation.key));
              }
            : undefined,
        } as never),
      ) as Collection<Value, EntityId> & {
        readonly utils: LocalStorageCollectionUtils;
      };
      const storage = config.storage ?? globalThis.localStorage;

      return nativeCollection<Value>(key, engine, {
        dehydrate: (_engine) => {
          const raw = storage?.getItem(storageKey);
          if (!raw) return [];
          try {
            const parsed = JSON.parse(raw) as Record<string, { data: Value }>;
            return Object.values(parsed).map((entry) => entry.data);
          } catch {
            return [];
          }
        },
        hydrate: (engine, values) => {
          for (const value of values) {
            try {
              engine.insert(value as never);
            } catch {
              engine.update(value[key] as EntityId, () => value);
            }
          }
        },
        status: (_engine): DbCollectionStatus => {
          return {};
        },
      });
    },
  });
}
