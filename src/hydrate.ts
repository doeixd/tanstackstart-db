import type { StartDb } from "./db.ts";
import { DbHydrationError, DbPreloadError } from "./errors.ts";
import type { DbSchema } from "./schema.ts";

/**
 * A serialized snapshot of a {@link StartDb} suitable for SSR hydration
 * and round-tripping to local storage. `collections` is keyed by entity
 * name; the value is the confirmed rows the collection's
 * `dehydrate()` returned.
 */
export interface DbSnapshot {
  readonly collections: Readonly<Record<string, ReadonlyArray<Record<string, unknown>>>>;
}

/**
 * Strategy for what state to capture in a {@link DbSnapshot}.
 *
 * - `"confirmed-only"` (default) — only the rows that have been
 *   persisted to the collection's confirmed store. Pending
 *   optimistic overlays are excluded so SSR payloads and
 *   `localStorage` snapshots never promote unconfirmed writes to
 *   authoritative hydration state.
 * - `"include-pending-for-debug"` — also include any in-flight
 *   optimistic overlay. Useful when debugging optimistic-rollback
 *   regressions, but never ship this to production SSR or storage
 *   because the overlay may never persist.
 */
export type DbSnapshotMode = "confirmed-only" | "include-pending-for-debug";

/**
 * Options for {@link dehydrateDb}.
 *
 * - `snapshot` — select what state to capture. Defaults to
 *   `"confirmed-only"`. The `"include-pending-for-debug"` mode only
 *   takes effect for collections that opt in via the optional
 *   `dehydrateDebug()` adapter method; other collections fall back
 *   to their `dehydrate()` value.
 */
export interface DehydrateDbOptions {
  readonly snapshot?: DbSnapshotMode;
}

/**
 * Build a {@link DbSnapshot} from the current state of a {@link StartDb}.
 * Skips any collection that does not implement `dehydrate()`. The result
 * is a plain object, so it can be `JSON.stringify`'d for SSR or stored
 * in `localStorage` between sessions.
 *
 * @typeParam Schema - the DB's schema, inferred from `db`.
 * @typeParam Actions - the DB's action map, inferred from `db`.
 *
 * @example
 * ```ts
 * const snapshot = dehydrateDb(db);
 * const json = JSON.stringify(snapshot);
 * ```
 *
 * @example
 * ```ts
 * // Capture pending optimistic overlays for SSR debugging.
 * const snapshot = dehydrateDb(db, { snapshot: "include-pending-for-debug" });
 * ```
 */
export function dehydrateDb<Schema extends DbSchema, Actions extends Record<string, unknown>>(
  db: StartDb<Schema, Actions>,
  options: DehydrateDbOptions = {},
): DbSnapshot {
  const mode = options.snapshot ?? "confirmed-only";
  const collections: Array<[string, ReadonlyArray<Record<string, unknown>>]> = [];
  for (const [name, collection] of Object.entries(db.collections)) {
    const values =
      mode === "include-pending-for-debug" && collection.dehydrateDebug
        ? collection.dehydrateDebug()
        : collection.dehydrate?.();
    if (values) collections.push([name, values as ReadonlyArray<Record<string, unknown>>]);
  }
  return {
    collections: Object.fromEntries(collections),
  };
}

/**
 * Apply a {@link DbSnapshot} to a {@link StartDb}. Each collection's
 * `hydrate(values)` hook is called with the rows from the snapshot.
 * Collections that do not exist on the DB are silently skipped; rows
 * that violate the schema (if any) are surfaced as a {@link DbHydrationError}
 * by the collection's `hydrate` implementation.
 *
 * @typeParam Schema - the DB's schema, inferred from `db`.
 * @typeParam Actions - the DB's action map, inferred from `db`.
 *
 * @example
 * ```ts
 * hydrateDb(db, JSON.parse(json) as DbSnapshot);
 * ```
 */
export function hydrateDb<Schema extends DbSchema, Actions extends Record<string, unknown>>(
  db: StartDb<Schema, Actions>,
  snapshot: DbSnapshot,
): void {
  for (const [name, values] of Object.entries(snapshot.collections)) {
    const collection = db.collections[name];
    if (!collection) continue;
    try {
      collection.hydrate?.(values as never);
    } catch (error) {
      throw new DbHydrationError(`Failed to hydrate collection "${name}".`, error);
    }
  }
}

/**
 * Run a list of query specs to completion. Used by SSR loaders that
 * want to confirm a batch of queries before rendering. Each entry must
 * expose an `execute()` method (any {@link DbQuerySpec} does). The
 * returned promise resolves once every `execute()` settles.
 *
 * @example
 * ```ts
 * await preloadDb([
 *   q.post.byId("p1"),
 *   q.user.byId("u1"),
 *   q.posts.list(),
 * ]);
 * ```
 */
export async function preloadDb(
  queries: ReadonlyArray<{ readonly execute: () => Promise<unknown> }>,
): Promise<void> {
  try {
    await Promise.all(queries.map((query) => query.execute()));
  } catch (error) {
    throw new DbPreloadError("Failed to preload database queries.", error);
  }
}
