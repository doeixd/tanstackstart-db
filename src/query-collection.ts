import {
  createCollection,
  type Collection,
  type DeleteMutationFnParams,
  type InsertMutationFnParams,
  type UpdateMutationFnParams,
} from "@tanstack/db";
import {
  queryCollectionOptions,
  type QueryCollectionConfig,
  type QueryCollectionUtils,
} from "@tanstack/query-db-collection";
import type { QueryFunctionContext, QueryKey } from "@tanstack/query-core";
import { nativeCollection, type EntityId } from "./collection.ts";
import { queryCollection as defineQueryCollection, type QueryCollectionDefinition } from "./db.ts";
import type { StandardSchemaV1 } from "./schema.ts";

type QueryFn<Value> = (
  context: QueryFunctionContext<QueryKey>,
) => ReadonlyArray<Value> | Promise<ReadonlyArray<Value>>;

/** Sugar for the `onInsert`/`onUpdate`/`onDelete` hooks when you want
 * plain values, ids, and `Partial<Value>` changes rather than digging
 * through `transaction.mutations`. */
export interface QueryCollectionMutations<Value extends Record<string, unknown>> {
  readonly insert?: (values: ReadonlyArray<Value>) => unknown;
  readonly update?: (
    values: ReadonlyArray<{
      readonly id: EntityId;
      readonly changes: Partial<Value>;
    }>,
  ) => unknown;
  readonly delete?: (ids: ReadonlyArray<EntityId>) => unknown;
}

/** Options for {@link queryCollection}. The `Omit` removes the two
 * fields the helper fills in (`getKey` defaults to the entity's
 * declared `key`, `schema` falls through to the schema's per-entity
 * validator). The remaining fields are forwarded to
 * `@tanstack/query-db-collection`'s `queryCollectionOptions`. */
export type QueryDbCollectionOptions<Value extends Record<string, unknown>> = Omit<
  QueryCollectionConfig<Value, QueryFn<Value>, unknown, QueryKey, EntityId>,
  "getKey" | "schema"
> & {
  readonly getKey?: (value: Value) => EntityId;
  readonly schema?: StandardSchemaV1<unknown, Value>;
  readonly mutations?: QueryCollectionMutations<Value>;
};

export type QueryCollectionApiOptions<Value extends Record<string, unknown>> = Omit<
  QueryDbCollectionOptions<Value>,
  "queryFn" | "mutations"
> & {
  readonly list: QueryFn<Value>;
  readonly create?: (values: ReadonlyArray<Value>) => unknown;
  readonly update?: (
    values: ReadonlyArray<{
      readonly id: EntityId;
      readonly changes: Partial<Value>;
    }>,
  ) => unknown;
  readonly delete?: (ids: ReadonlyArray<EntityId>) => unknown;
};

function confirmedValues<Value extends Record<string, unknown>>(
  engine: Collection<Value, EntityId>,
): ReadonlyArray<Value> {
  return [...engine._state.syncedData.values()];
}

/**
 * Build a {@link QueryCollectionDefinition} for an entity backed by
 * `@tanstack/query-db-collection`. The returned definition is what
 * `createStartDbFromSchema(...)` expects from its `collections`
 * factory.
 *
 * - `queryFn` is the standard TanStack Query fetcher. Pass it as if
 *   you were building a `useQuery`.
 * - `mutations` is sugar around the three `onInsert`/`onUpdate`/`onDelete`
 *   hooks. The rows/ids/changes are derived from `transaction.mutations`
 *   for you, so you can write `mutations: { insert: (rows) => api.insert(rows) }`
 *   without manual mapping.
 * - `dehydrate` reads from `_state.syncedData` (the rows the Query
 *   collection has confirmed). `hydrate` calls `utils.writeUpsert(...)`
 *   for SSR seeding. `status` exposes `isLoading`/`isRefetching`/`isStale`/
 *   `lastError` for `useDbStatus`.
 *
 * @typeParam Value - the entity row shape.
 *
 * @example
 * ```ts
 * const posts = queryCollection<Post>("post", {
 *   queryKey: ["post", id],
 *   queryFn: async () => api.posts.list(),
 *   queryClient,
 *   mutations: {
 *     insert: (rows) => api.posts.create(rows),
 *     update: (updates) => api.posts.update(updates),
 *     delete: (ids) => api.posts.remove(ids),
 *   },
 * });
 * ```
 */
export function queryCollection<Value extends Record<string, unknown>>(
  entityName: string,
  options: QueryDbCollectionOptions<Value>,
): QueryCollectionDefinition<Value> {
  return defineQueryCollection(entityName, {
    createCollection: ({ key, schema }) => {
      const { mutations, ...config } = options;
      const insertMutation = mutations?.insert;
      const updateMutation = mutations?.update;
      const deleteMutation = mutations?.delete;
      const engine = createCollection(
        queryCollectionOptions({
          ...config,
          id: config.id ?? entityName,
          getKey: config.getKey ?? ((value: Value) => value[key] as EntityId),
          schema: config.schema ?? schema,
          onInsert:
            config.onInsert ??
            (insertMutation
              ? async ({ transaction }: InsertMutationFnParams<Value, EntityId>) => {
                  await insertMutation(
                    transaction.mutations.map((mutation) => mutation.modified as Value),
                  );
                }
              : undefined),
          onUpdate:
            config.onUpdate ??
            (updateMutation
              ? async ({ transaction }: UpdateMutationFnParams<Value, EntityId>) => {
                  await updateMutation(
                    transaction.mutations.map((mutation) => ({
                      id: mutation.key,
                      changes: mutation.changes as Partial<Value>,
                    })),
                  );
                }
              : undefined),
          onDelete:
            config.onDelete ??
            (deleteMutation
              ? async ({ transaction }: DeleteMutationFnParams<Value, EntityId>) => {
                  await deleteMutation(transaction.mutations.map((mutation) => mutation.key));
                }
              : undefined),
        } as never),
      ) as Collection<Value, EntityId> & {
        readonly utils: QueryCollectionUtils<Value, EntityId>;
      };

      return nativeCollection(key, engine, {
        dehydrate: confirmedValues,
        hydrate: (collection, values) => {
          (
            collection as Collection<Value, EntityId> & {
              readonly utils: QueryCollectionUtils<Value, EntityId>;
            }
          ).utils.writeUpsert([...values]);
        },
        status: (collection) => {
          const utils = (
            collection as Collection<Value, EntityId> & {
              readonly utils: QueryCollectionUtils<Value, EntityId>;
            }
          ).utils;
          const queryKey =
            typeof config.queryKey === "function" ? config.queryKey({}) : config.queryKey;
          return {
            isLoading: utils.isLoading,
            isRefetching: utils.isRefetching,
            isStale: config.queryClient.getQueryCache().find({ queryKey })?.isStale() ?? false,
            error: utils.lastError,
          };
        },
      });
    },
  });
}

/**
 * Convenience wrapper for the common API-backed Query Collection shape.
 * `list` becomes the Query Collection `queryFn`, while `create` / `update` /
 * `delete` are mapped to generated CRUD mutation hooks.
 */
export function queryCollectionFromApi<Value extends Record<string, unknown>>(
  entityName: string,
  options: QueryCollectionApiOptions<Value>,
): QueryCollectionDefinition<Value> {
  const { list, create, update, delete: deleteValues, ...rest } = options;
  return queryCollection(entityName, {
    ...rest,
    queryFn: list,
    mutations: {
      insert: create,
      update,
      delete: deleteValues,
    },
  });
}
