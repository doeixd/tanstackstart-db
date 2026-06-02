/**
 * Thrown by route loaders when a query resolves to no result for a
 * non-optional spec (e.g. `q.post.byId(id).required()`).
 */
export class DbRouteError extends Error {}

/**
 * Thrown by `.required()` query specs and by route loaders when a query
 * returns `null` or `undefined`. Carries no `cause`; the original key is
 * available through the surrounding context.
 */
export class DbNotFoundError extends Error {}

/** Thrown by `authorize(...)` action hooks when the gate returns `false`. */
export class DbAuthError extends Error {
  readonly name = "DbAuthError";
}

/** Thrown by `preloadDb(...)` when one of the queries rejects during a
 * batch preload. The first rejection's error is the cause. */
export class DbPreloadError extends Error {
  readonly name = "DbPreloadError";
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
  }
}

/** Thrown by `hydrateDb(...)` when the snapshot's `collections` record
 * cannot be applied because an adapter's `hydrate` hook throws. Unknown
 * collection names are skipped so snapshots remain forward-compatible. */
export class DbHydrationError extends Error {
  readonly name = "DbHydrationError";
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
  }
}

/**
 * Thrown by sync-engine adapters (Electric, PowerSync, or a custom
 * resolver) when a write collides with a server-assigned revision, an
 * already-merged transaction, or a row that was modified by another
 * client. The adapter's policy decides what `cause` looks like; the
 * package does not invent a conflict resolver.
 *
 * See `docs/optimistic-conflict-offline.md` for the full contract.
 */
export class DbConflictError extends Error {
  readonly name = "DbConflictError";
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
  }
}

/**
 * Thrown by collection adapters that detect the client is offline and
 * cannot proceed. The Query Collection raises this for
 * server-required reads; the `localStorage` adapter raises it only if
 * the storage API rejects synchronously. Optimistic writes that have
 * not yet been persisted are kept in the action's `DbActionSubmission`
 * so the caller can decide whether to retry, queue, or discard.
 */
export class DbOfflineError extends Error {
  readonly name = "DbOfflineError";
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
  }
}

/** Type-guard for {@link DbRouteError}. */
export const isDbRouteError = (error: unknown): error is DbRouteError =>
  error instanceof DbRouteError;
/** Type-guard for {@link DbNotFoundError}. */
export const isDbNotFound = (error: unknown): error is DbNotFoundError =>
  error instanceof DbNotFoundError;
/** Type-guard for {@link DbAuthError}. */
export const isDbAuthError = (error: unknown): error is DbAuthError => error instanceof DbAuthError;
/** Type-guard for {@link DbPreloadError}. */
export const isDbPreloadError = (error: unknown): error is DbPreloadError =>
  error instanceof DbPreloadError;
/** Type-guard for {@link DbHydrationError}. */
export const isDbHydrationError = (error: unknown): error is DbHydrationError =>
  error instanceof DbHydrationError;
/** Type-guard for {@link DbConflictError}. */
export const isDbConflictError = (error: unknown): error is DbConflictError =>
  error instanceof DbConflictError;
/** Type-guard for {@link DbOfflineError}. */
export const isDbOfflineError = (error: unknown): error is DbOfflineError =>
  error instanceof DbOfflineError;
