import type { DbCollection, DbCollections, EntityId } from "./collection.ts";
import type { Transaction } from "@tanstack/db";

/** Patch descriptor accepted by {@link SelectedEntityCache.patch} and
 * {@link EntityCache.patch}. Each field may be a literal value or a
 * function `(current) => next` for read-modify-write updates. */
type Patch<Value extends Record<string, unknown>> = {
  readonly [Key in keyof Value]?: Value[Key] | ((current: Value[Key]) => Value[Key]);
};

type Undo = () => void;

/**
 * Per-entity optimistic cache. The cache is callable so that
 * `cache.user("u1")` returns a {@link SelectedEntityCache} bound to that
 * id, while `cache.user.insert(value)` operates on the whole entity.
 *
 * - `insert(value)` — upsert the row and record an undo. Returns the
 *   inserted value.
 * - `insertIntoList(query, value)` — placeholder for list-shaped queries;
 *   currently delegates to `insert(value)`.
 * - `patch(id, patch)` — read-modify-write a row by id. Throws if the row
 *   is missing.
 * - `delete(id)` — remove a row and record an undo. Returns the previous
 *   value or `undefined` if it was missing.
 *
 * @typeParam Value - the entity row shape.
 */
export interface EntityCache<Value extends Record<string, unknown>> {
  (id: EntityId): SelectedEntityCache<Value>;
  insert(value: Value): Value;
  insertIntoList(_query: unknown, value: Value): Value;
  patch(id: EntityId, patch: Patch<Value>): Value;
  merge(id: EntityId, patch: Patch<Value>): Value;
  increment(id: EntityId, field: keyof Value, by?: number): Value;
  delete(id: EntityId): Value | undefined;
  remove(id: EntityId): Value | undefined;
}

/** Entity cache bound to a specific row id. Returned by
 * `cache.user("u1")`. */
export interface SelectedEntityCache<Value extends Record<string, unknown>> {
  patch(patch: Patch<Value>): Value;
  merge(patch: Patch<Value>): Value;
  increment(field: keyof Value, by?: number): Value;
  delete(): Value | undefined;
  remove(): Value | undefined;
}

/**
 * The optimistic cache passed to an action's `onMutate` handler. It
 * mirrors the DB's collections as entity caches and exposes helpers for
 * generating optimistic ids and timestamps, batching writes, and rolling
 * back if the action throws.
 *
 * - `cache.<entity>(id).patch({ ... })` — patch a single row.
 * - `cache.<entity>.insert(value)` — insert or replace a row.
 * - `cache.<entity>.delete(id)` — remove a row.
 * - `cache.optimisticId(prefix)` — generate a stable id with the given
 *   prefix for the optimistic insert.
 * - `cache.now()` — produce an ISO timestamp.
 * - `cache.transaction(handler)` — run `handler` with the same cache
 *   reference (useful for grouping writes).
 * - `cache.rollback()` — revert every write recorded since the cache was
 *   created. Used automatically by `createAction(...)` when `run` throws.
 * - `cache.commit()` — drop the undo records without reverting. Use this
 *   when the action succeeds and you want to keep the optimistic writes.
 */
export type OptimisticCache = Record<string, EntityCache<Record<string, unknown>>> & {
  optimisticId(prefix: string): string;
  now(): string;
  transaction<T>(handler: (cache: OptimisticCache) => T): T;
  rollback(): void;
  commit(): void;
};

function applyPatch(
  previous: Record<string, unknown>,
  patch: Patch<Record<string, unknown>>,
): Record<string, unknown> {
  const next = { ...previous };
  for (const [key, value] of Object.entries(patch)) {
    next[key] =
      typeof value === "function" ? (value as (current: unknown) => unknown)(next[key]) : value;
  }
  return next;
}

function createEntityCache(
  collection: DbCollection<Record<string, unknown>>,
  undo: Undo[],
): EntityCache<Record<string, unknown>> {
  const recordUndo = (revert: Undo) => {
    if (!collection.engine) undo.push(revert);
  };
  const methods = {
    insert: (value: Record<string, unknown>) => {
      const id = value[collection.key] as EntityId;
      const previous = collection.get(id);
      collection.insert(value);
      recordUndo(() => {
        if (previous) {
          collection.insert(previous);
        } else {
          collection.delete(id);
        }
      });
      return value;
    },
    insertIntoList: (_query: unknown, value: Record<string, unknown>) => methods.insert(value),
    patch: (id: EntityId, patch: Patch<Record<string, unknown>>) => {
      const previous = collection.get(id);
      if (!previous) {
        throw new Error(`Collection value "${String(id)}" was not found.`);
      }
      const next = collection.update(id, (current) => applyPatch(current, patch)).value;
      recordUndo(() => collection.update(id, () => previous));
      return next;
    },
    increment: (id: EntityId, field: string, by = 1) =>
      methods.patch(id, {
        [field]: (current: unknown) => {
          const number = current == null ? 0 : Number(current);
          if (!Number.isFinite(number)) {
            throw new Error(`Cannot increment non-numeric field "${field}".`);
          }
          return number + by;
        },
      }),
    delete: (id: EntityId) => {
      const previous = collection.delete(id).value;
      if (previous) {
        recordUndo(() => collection.insert(previous));
      }
      return previous;
    },
  };
  return Object.assign(
    (id: EntityId): SelectedEntityCache<Record<string, unknown>> => ({
      patch: (patch) => methods.patch(id, patch),
      merge: (patch) => methods.patch(id, patch),
      increment: (field, by) => methods.increment(id, String(field), by),
      delete: () => methods.delete(id),
      remove: () => methods.delete(id),
    }),
    {
      ...methods,
      merge: methods.patch,
      remove: methods.delete,
    },
  );
}

export function createOptimisticCache(collections: DbCollections): OptimisticCache {
  const undo: Undo[] = [];
  const cache: Record<string, unknown> = {
    optimisticId: (prefix: string) => `${prefix}_optimistic_${crypto.randomUUID()}`,
    now: () => new Date().toISOString(),
    transaction: <T>(handler: (cache: OptimisticCache) => T) => handler(proxy),
    rollback: () => {
      for (const revert of undo.reverse()) {
        revert();
      }
      undo.length = 0;
    },
    commit: () => {
      undo.length = 0;
    },
  };

  for (const [name, collection] of Object.entries(collections)) {
    const entityCache = createEntityCache(collection, undo);
    cache[name] = entityCache;
  }

  const proxy = cache as unknown as OptimisticCache;
  return proxy;
}

export type { Transaction };
