import type { StartDb } from "./db.ts";
import { dehydrateDb, hydrateDb, type DbSnapshot } from "./hydrate.ts";
import type { DbQuerySpec } from "./query.ts";

/**
 * Run a set of queries on a server-side DB and capture a snapshot for
 * hydration. The returned object is the JSON-serialisable payload you
 * can ship to the client and pass to {@link hydrateDbRoute}.
 *
 * @example
 * ```ts
 * export const loader = async () =>
 *   preloadDbRoute({
 *     db,
 *     queries: ({ q }) => ({
 *       post: q.post.byId("p1"),
 *       user: q.user.byId("u1"),
 *     }),
 *   });
 * ```
 */
export async function preloadDbRoute<Queries extends Record<string, DbQuerySpec>>(options: {
  readonly db: StartDb;
  readonly queries: (context: { readonly q: StartDb["q"] }) => Queries;
}): Promise<{
  readonly data: { [Key in keyof Queries]: Awaited<ReturnType<Queries[Key]["execute"]>> };
  readonly snapshot: DbSnapshot;
}> {
  const queries = options.queries({ q: options.db.q });
  const entries = await Promise.all(
    Object.entries(queries).map(async ([name, query]) => [name, await query.execute()]),
  );
  return {
    data: Object.fromEntries(entries) as {
      [Key in keyof Queries]: Awaited<ReturnType<Queries[Key]["execute"]>>;
    },
    snapshot: dehydrateDb(options.db),
  };
}

/** Alias of {@link dehydrateDb}. Captured in the route loader payload
 * so the client can seed its DB before rendering. */
export const dehydrateDbRoute = dehydrateDb;
/** Alias of {@link hydrateDb}. Apply a loader payload to a client DB
 * before the React tree reads from it. */
export const hydrateDbRoute = hydrateDb;

/**
 * Wrap a server-side handler with a typed async signature. This is a
 * thin wrapper intended for tests, scripts, and environments that
 * already have a `StartDb` in scope. For production TanStack Start
 * routes, prefer the framework's own `createServerFn` — the signature
 * this returns is the same shape so you can swap implementations
 * without changing call sites.
 *
 * @typeParam Input - the handler input. Inferred from `handler`.
 * @typeParam Result - the handler result. Inferred from `handler`.
 */
export function createDbServerFn<Input, Result>(
  handler: (input: Input) => Result | Promise<Result>,
): (input: Input) => Promise<Result> {
  return async (input) => handler(input);
}

/**
 * Alias of {@link createDbServerFn}. Kept for callers that prefer the
 * `Handler` naming convention used by some SolidStart codebases.
 */
export function createDbServerHandler<Input, Result>(
  handler: (input: Input) => Result | Promise<Result>,
): (input: Input) => Promise<Result> {
  return createDbServerFn(handler);
}
