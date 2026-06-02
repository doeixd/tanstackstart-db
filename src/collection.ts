import {
  createCollection,
  localOnlyCollectionOptions,
  type Collection,
  type Transaction,
} from "@tanstack/db";
import type { StandardSchemaV1 } from "./schema.ts";

/** Row identifier accepted by the optimistic cache and collection
 * adapters. Strings and numbers are both supported because the choice
 * depends on the schema — UUIDs as strings, autoincrement as numbers. */
export type EntityId = string | number;

/**
 * The return shape of every collection mutation. `value` is the row that
 * was inserted / updated / deleted (or the prior value, in the case of
 * `delete`); `transaction` is the native TanStack DB transaction when the
 * collection has an `engine`, so callers can `await` `transaction.isPersisted.promise`
 * if they need to wait for the commit.
 *
 * @typeParam Value - the entity row shape.
 */
export interface DbMutationResult<Value> {
  readonly value: Value;
  readonly transaction?: Transaction;
}

/** Subset of TanStack DB's `CollectionStatus` projected to the fields
 * `DbCollection` callers care about. The `?` on every field means
 * implementations can return `{}` when they have no opinion. */
export interface DbCollectionStatus {
  readonly isLoading?: boolean;
  readonly isRefetching?: boolean;
  readonly isStale?: boolean;
  readonly error?: unknown;
}

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isSafeKey(key: string): boolean {
  return !DANGEROUS_KEYS.has(key);
}

function stripVirtualProps<Value extends Record<string, unknown>>(value: Value): Value {
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (!isSafeKey(key) || key.startsWith("$") || nested === undefined) continue;
    result[key] = nested;
  }
  return result as Value;
}

function replaceDraft(draft: Record<string, unknown>, next: Record<string, unknown>): void {
  for (const key of Object.keys(draft)) {
    if (
      isSafeKey(key) &&
      !key.startsWith("$") &&
      !Object.prototype.hasOwnProperty.call(next, key)
    ) {
      draft[key] = undefined;
    }
  }
  for (const [key, value] of Object.entries(next)) {
    if (!isSafeKey(key) || key.startsWith("$")) continue;
    draft[key] = value;
  }
}

/**
 * The collection contract used by the optimistic cache, queries, and
 * generated CRUD. There are three concrete implementations:
 *
 * - {@link NativeCollection} — wraps any TanStack DB `Collection`
 *   (Electric, PowerSync, Query, LocalStorage, etc.) and exposes
 *   `engine` so the native query compiler can fold views into the
 *   `queryBuilder` and `select`.
 * - {@link TanStackCollection} — wraps `localOnlyCollectionOptions`,
 *   which gives you TanStack DB's transaction/undo machinery without
 *   syncing to a backend. Always has an `engine`.
 * - {@link MemoryCollection} — a pure JS `Map` adapter. Deliberately
 *   has no `engine`, so it falls through to the in-memory executor and
 *   is what unit tests use.
 *
 * The optional members (`confirmedValues`, `dehydrate`, `hydrate`,
 * `status`) are implemented by the native and TanStack variants; the
 * `MemoryCollection` only implements the core CRUD. `engine` is optional
 * so the in-memory executor can detect "no native engine" at runtime.
 *
 * @typeParam Value - the entity row shape.
 */
export interface DbCollection<Value extends Record<string, unknown>> {
  readonly key: string;
  readonly engine?: Collection<Value, EntityId>;
  get(id: EntityId): Value | undefined;
  values(): ReadonlyArray<Value>;
  confirmedValues?(): ReadonlyArray<Value>;
  dehydrate?(): ReadonlyArray<Value> | undefined;
  /**
   * Optional debug-mode dehydrate that returns the current collection
   * state, including any pending optimistic overlays. Used by
   * `dehydrateDb(db, { snapshot: "include-pending-for-debug" })` so
   * SSR or local-storage snapshots can preserve the optimistic
   * overlay for debugging. When omitted, the `dehydrate` value is
   * used (i.e. confirmed state only).
   */
  dehydrateDebug?(): ReadonlyArray<Value> | undefined;
  hydrate?(values: ReadonlyArray<Value>): void;
  status?(): DbCollectionStatus;
  insert(value: Value): DbMutationResult<Value>;
  update(id: EntityId, updater: (value: Value) => Value): DbMutationResult<Value>;
  delete(id: EntityId): DbMutationResult<Value | undefined>;
}

/** Per-adapter hooks for {@link NativeCollection}. `dehydrate` and
 * `hydrate` are opt-in because external engines have different confirmed
 * state and write-through semantics. `status` defaults to `{}`. */
export interface NativeCollectionOptions<Value extends Record<string, unknown>> {
  readonly dehydrate?: (engine: Collection<Value, EntityId>) => ReadonlyArray<Value> | undefined;
  readonly hydrate?: (engine: Collection<Value, EntityId>, values: ReadonlyArray<Value>) => void;
  readonly status?: (engine: Collection<Value, EntityId>) => DbCollectionStatus;
}

export class NativeCollection<
  Value extends Record<string, unknown>,
> implements DbCollection<Value> {
  constructor(
    readonly key: string,
    readonly engine: Collection<Value, EntityId>,
    readonly options: NativeCollectionOptions<Value> = {},
  ) {}

  get(id: EntityId): Value | undefined {
    const value = this.engine.get(id) as Value | undefined;
    return value ? stripVirtualProps(value) : undefined;
  }

  values(): ReadonlyArray<Value> {
    return [...this.engine.values()].map((value) => stripVirtualProps(value as Value));
  }

  dehydrate(): ReadonlyArray<Value> | undefined {
    return this.options.dehydrate?.(this.engine)?.map(stripVirtualProps);
  }

  hydrate(values: ReadonlyArray<Value>): void {
    this.options.hydrate?.(this.engine, values);
  }

  status(): DbCollectionStatus {
    return this.options.status?.(this.engine) ?? {};
  }

  insert(value: Value): DbMutationResult<Value> {
    return { value, transaction: this.engine.insert(value as never) };
  }

  update(id: EntityId, updater: (value: Value) => Value): DbMutationResult<Value> {
    const current = this.get(id);
    if (!current) {
      throw new Error(`Collection value "${String(id)}" was not found.`);
    }
    const next = updater(current);
    const transaction = this.engine.update(id, (draft) => {
      replaceDraft(draft, next);
    });
    return { value: next, transaction };
  }

  delete(id: EntityId): DbMutationResult<Value | undefined> {
    const current = this.get(id);
    const transaction = current ? this.engine.delete(id) : undefined;
    return { value: current, transaction };
  }
}

/**
 * Wrap any pre-existing TanStack DB `Collection` as a {@link DbCollection}
 * with optimistic cache and view-folding support. Use this when you have
 * an Electric, PowerSync, Query, or custom `Collection` and want the
 * generated CRUD, native view projection, and `dehydrate`/`hydrate`
 * plumbing to ride on top of it.
 *
 * @typeParam Value - the entity row shape, inferred from `engine`.
 *
 * @example
 * ```ts
 * import { electricCollectionOptions } from "@tanstack/electric-db-collection";
 * import { nativeCollection, queryCollection } from "tanstackstart-db";
 *
 * const engine = createCollection(electricCollectionOptions({
 *   id: "post",
 *   shapeOptions: { url: "/api/posts/stream" },
 *   getKey: (p) => p.id,
 * }));
 *
 * const posts = nativeCollection("post", engine);
 * // pass `posts` into a custom `collections` factory for createStartDbFromSchema.
 * ```
 */
export function nativeCollection<Value extends Record<string, unknown>>(
  key: string,
  engine: Collection<Value, EntityId>,
  options: NativeCollectionOptions<Value> = {},
): NativeCollection<Value> {
  return new NativeCollection(key, engine, options);
}

/**
 * A `DbCollection` backed by `localOnlyCollectionOptions`. Useful when
 * you want TanStack DB's transaction / undo machinery and live-query
 * invalidation, but do not need to sync to a backend. The adapter keeps
 * a strong `engine` reference, so the native query compiler will fold
 * view projections into `select(...)` automatically.
 *
 * @typeParam Value - the entity row shape.
 */
export class TanStackCollection<
  Value extends Record<string, unknown>,
> implements DbCollection<Value> {
  readonly engine: Collection<Value, EntityId>;

  constructor(
    readonly key: string,
    initialValues: ReadonlyArray<Value> = [],
    schema?: StandardSchemaV1<unknown, Value>,
  ) {
    this.engine = createCollection(
      localOnlyCollectionOptions({
        getKey: (value: Value) => value[this.key] as EntityId,
        initialData: [...initialValues],
        schema,
      } as never),
    ) as Collection<Value, EntityId>;
  }

  get(id: EntityId): Value | undefined {
    const value = this.engine.get(id) as Value | undefined;
    return value ? stripVirtualProps(value) : undefined;
  }

  values(): ReadonlyArray<Value> {
    return [...this.engine.values()].map((value) => stripVirtualProps(value as Value));
  }

  confirmedValues(): ReadonlyArray<Value> {
    return [...this.engine._state.syncedData.values()].map((value) => stripVirtualProps(value));
  }

  dehydrate(): ReadonlyArray<Value> {
    return this.confirmedValues();
  }

  dehydrateDebug(): ReadonlyArray<Value> {
    return this.values();
  }

  hydrate(values: ReadonlyArray<Value>): void {
    for (const value of values) {
      const id = value[this.key] as EntityId;
      if (this.get(id)) {
        this.update(id, () => value);
      } else {
        this.insert(value);
      }
    }
  }

  insert(value: Value): DbMutationResult<Value> {
    return { value, transaction: this.engine.insert(value as never) };
  }

  update(id: EntityId, updater: (value: Value) => Value): DbMutationResult<Value> {
    const current = this.get(id);
    if (!current) {
      throw new Error(`Collection value "${String(id)}" was not found.`);
    }
    const next = updater(current);
    const transaction = this.engine.update(id, (draft) => {
      replaceDraft(draft, next);
    });
    return { value: next, transaction };
  }

  delete(id: EntityId): DbMutationResult<Value | undefined> {
    const current = this.get(id);
    const transaction = current ? this.engine.delete(id) : undefined;
    return { value: current, transaction };
  }
}

/**
 * Pure JS `Map`-backed collection. Has no `engine`, so the in-memory
 * executor takes over (i.e. `queryBuilder`-based native projection is
 * skipped and views are resolved post-execute). Use this for unit tests
 * and one-off scripts.
 *
 * @typeParam Value - the entity row shape.
 */
export class MemoryCollection<
  Value extends Record<string, unknown>,
> implements DbCollection<Value> {
  readonly #values = new Map<EntityId, Value>();

  constructor(
    readonly key: string,
    initialValues: ReadonlyArray<Value> = [],
  ) {
    for (const value of initialValues) {
      this.insert(value);
    }
  }

  get(id: EntityId): Value | undefined {
    return this.#values.get(id);
  }

  values(): ReadonlyArray<Value> {
    return [...this.#values.values()];
  }

  dehydrate(): ReadonlyArray<Value> {
    return this.values();
  }

  dehydrateDebug(): ReadonlyArray<Value> {
    return this.values();
  }

  hydrate(values: ReadonlyArray<Value>): void {
    for (const value of values) this.insert(value);
  }

  insert(value: Value): DbMutationResult<Value> {
    const id = value[this.key];
    if (typeof id !== "string" && typeof id !== "number") {
      throw new Error(`Collection value is missing key "${this.key}".`);
    }

    this.#values.set(id, value);
    return { value };
  }

  update(id: EntityId, updater: (value: Value) => Value): DbMutationResult<Value> {
    const current = this.get(id);
    if (!current) {
      throw new Error(`Collection value "${String(id)}" was not found.`);
    }

    const next = updater(current);
    this.#values.set(id, next);
    return { value: next };
  }

  delete(id: EntityId): DbMutationResult<Value | undefined> {
    const current = this.get(id);
    this.#values.delete(id);
    return { value: current };
  }
}

/** A `DbCollection` map keyed by entity name. The shape every
 * `collections` factory in {@link createStartDb} / {@link createStartDbFromSchema}
 * has to satisfy. */
export type DbCollections = Record<string, DbCollection<Record<string, unknown>>>;
