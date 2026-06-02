# Optimistic updates, conflicts, and offline behavior

The action lifecycle has three failure modes: **optimistic rollback** when
the run fails, **conflict** when the server rejects a write, and **offline**
when the client cannot reach the server. Each is a distinct error shape and
each has a different recovery path. This document is the contract.

This document covers:

- Optimistic overlays and rollback.
- The `DbConflictError` shape and how to detect a server-side conflict.
- The `DbOfflineError` shape and how to detect an offline failure.
- Recovery patterns: retry, queue, discard.

For the action submission contract (the `DbActionSubmission` returned
synchronously from `action(input)`), see
[`README.md`](../README.md#actions-and-optimistic-state). For
authorization errors (the other common failure mode), see
[`docs/authorization.md`](./authorization.md).

---

## 1. Optimistic state

Generated CRUD actions and custom actions both go through the same
lifecycle. The two optimistic hooks are:

- `optimistic(context)` — runs synchronously inside the TanStack DB
  transaction for native collections.
- `optimisticLocal(context)` — runs synchronously for the memory adapter
  fallback. Use this when the entity is backed by
  `localOnlyCollectionOptions` rather than a native engine.

Both hooks receive the same `ActionContext<Input>`. They are expected to
perform the optimistic mutation; the runtime then awaits the action's
`run` and the native transaction's `isPersisted.promise`.

The action's `run` callback may also call `setTransaction(nativeTransaction)`
to attach a native TanStack DB transaction to the submission. The
`setTransaction` accessor is the only contract between `run` and the
`DbActionSubmission`; the runtime reads the latest value at the
`submission.transaction` getter.

---

## 2. Rollback

If `run` throws, the runtime:

1. Wraps the error in `DbActionError` (or re-throws the existing
   `DbActionError`).
2. Calls `cache.rollback()` to revert the optimistic overlays.
3. Marks the submission as `"failed"`.
4. Rejects `submission.persisted` and `submission.result` with the wrapped
   error.
5. Invokes `onError(error, context)` and `onSettled(context)`.

The cache rollback covers both the memory adapter's recorded undo
operations and any in-flight TanStack DB transaction that has not yet been
accepted via `engine.utils.acceptMutations(...)`. The native transaction
aborts as part of the rollback; the optimistic overlay is reverted; the
collection's confirmed state is unchanged.

A non-throwing `run` resolves the submission to `"completed"`, accepts the
native mutations, and resolves `submission.persisted`. The optimistic
overlay is now persisted state; there is no rollback.

---

## 3. `DbConflictError`

```ts
import { DbConflictError, isDbConflictError } from "@doeixd/tanstackstart-db";

export class DbConflictError extends Error {
  readonly name = "DbConflictError";
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
  }
}
```

`DbConflictError` is raised by sync-engine adapters (Electric, PowerSync,
or a custom resolver) when a write collides with:

- a server-assigned revision,
- an already-merged transaction, or
- a row that was modified by another client.

The adapter's policy decides what `cause` looks like; the package does not
invent a conflict resolver. A typical `cause` is the server's rejection
payload (`{ revision: "...", attemptedAt: "..." }`), but the package does
not type it.

### Detection

```ts
import { isDbConflictError } from "@doeixd/tanstackstart-db";

await submission.result.catch((error) => {
  if (isDbConflictError(error.cause)) {
    return refetchAndRetry();
  }
  throw error;
});
```

The check is on `error.cause`, not on `error` itself. The action's run-time
error wrapper is `DbActionError`; `DbConflictError` is the inner cause
from the adapter. This layering lets the action's `onError` hook see the
canonical outer error while consumers that care about the specific
failure shape can still inspect the cause.

### Recovery

The package does **not** ship a conflict resolver. The recommended
recovery is:

1. Refetch the affected collection to pick up the server's authoritative
   state.
2. Re-evaluate the user's intent against the new state.
3. Either retry the action (with a new input derived from the fresh
   state) or surface a "your change could not be applied" message to the
   user.

A common pattern is to call `db.q.<entity>.all().execute()` (or the
relationship helper) inside the catch block, then prompt the user to
confirm the merge. The optimistic state has already been rolled back, so
the refetched state is the source of truth.

---

## 4. `DbOfflineError`

```ts
import { DbOfflineError, isDbOfflineError } from "@doeixd/tanstackstart-db";

export class DbOfflineError extends Error {
  readonly name = "DbOfflineError";
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
  }
}
```

`DbOfflineError` is raised by collection adapters that detect the client is
offline and cannot proceed. The Query Collection raises it for
server-required reads; the `localStorage` adapter raises it only if the
storage API rejects synchronously.

### Detection

```ts
import { isDbOfflineError } from "@doeixd/tanstackstart-db";

await submission.result.catch((error) => {
  if (isDbOfflineError(error.cause)) {
    return queueForLater();
  }
  throw error;
});
```

Same pattern as `DbConflictError`: the check is on `error.cause`.

### Recovery

Optimistic writes that have not yet been persisted are kept in the
action's `DbActionSubmission` so the caller can decide whether to retry,
queue, or discard. The package does **not** ship a retry queue; this is a
deliberate boundary so the consumer can choose between:

- **Retry** — call the action again once the network is back. The
  submission has the same `input`; the new run will be a fresh
  optimistic-overlay + persistence cycle.
- **Queue** — store the submission in a service-worker queue or a
  persistent store and replay it later. The package exposes the
  submission's `input`, `transaction`, and `startedAt` so a queue can
  reconstruct the deferred work.
- **Discard** — call `submission.persisted.catch(() => {})` to silence the
  unhandled-rejection warning and let the user know the change was
  dropped. The optimistic overlay has already been rolled back; the
  collection's confirmed state is unchanged.

A blanket "retry on a timer" loop is **not** recommended: it will retry
on every transient failure (including `DbConflictError`) without
distinguishing the cause.

---

## 5. Putting it together: an `onError` dispatcher

A typical `onError` hook dispatches on the inner error shape:

```ts
import { isDbAuthError, isDbConflictError, isDbOfflineError } from "@doeixd/tanstackstart-db";

const likePost = action<{ id: string }>({
  run: ({ input }) => {
    /* ... */
  },
  onError: (error, context) => {
    const cause = (error as { cause?: unknown }).cause;
    if (isDbAuthError(cause)) {
      return showToast("You are not allowed to do that.");
    }
    if (isDbConflictError(cause)) {
      return refetchAndPrompt(context.input);
    }
    if (isDbOfflineError(cause)) {
      return queue(context.input);
    }
    throw error;
  },
});
```

The dispatcher is a consumer concern; the package exposes the type-guards
and the error shapes but does not pick a policy.

---

## 6. The action submission lifecycle

For completeness, the action submission's full status sequence is:

| `status`       | When                                                          |
| -------------- | ------------------------------------------------------------- |
| `"pending"`    | The action has been called; `run` has not started.            |
| `"persisting"` | `run` is executing; the native transaction has not committed. |
| `"completed"`  | `run` resolved; `persisted` and `result` have settled.        |
| `"failed"`     | `run` threw (or `authorize` returned `false`); rejection.     |

The submission is thenable so `await action(input)` keeps working as
before. `submission.transaction` reads the latest native transaction at
getter time, so the value is the most-recently-attached one even if
`setTransaction` was called after the submission was created.

---

## 7. Common pitfalls

- **Treating `DbConflictError` and `DbOfflineError` as the same failure.**
  Conflict means the server rejected the write; offline means the client
  never reached the server. The recovery paths are different (refetch vs.
  retry). The type-guards let the dispatcher distinguish them cheaply.
- **Silently swallowing `DbActionError`.** A blanket
  `submission.persisted.catch(() => {})` hides every error, including
  `DbAuthError`, `DbConflictError`, `DbOfflineError`, and any custom
  failure the action throws. Use it only when the caller has already
  decided to discard the submission; otherwise dispatch on the cause.
- **Forgetting `setTransaction`.** Without it,
  `submission.transaction` is `undefined` even though the action
  produced a native transaction. The runtime cannot infer that the
  action went through TanStack DB; the explicit `setTransaction` call
  is the contract.
- **Re-throwing inside `onError`.** The `onError` hook is supposed to
  return; a re-throw is treated as an unhandled rejection by the
  surrounding promise chain. The dispatcher pattern above is the
  recommended shape.

---

## 8. Snapshot strategies for debugging

By default, `dehydrateDb(db)` captures only confirmed state — pending
optimistic overlays are excluded so SSR payloads and `localStorage`
snapshots never promote unconfirmed writes to authoritative hydration
state. This is the right default for production.

When debugging an optimistic-rollback regression, the
`"include-pending-for-debug"` snapshot mode preserves the in-flight
overlay:

```ts
// Confirmed only (default):
const snapshot = dehydrateDb(db);
// snapshot.collections.post[0].likes === 0   <-- original value
//                                       (the optimistic +1 is excluded)

// Pending included (debug):
const debugSnapshot = dehydrateDb(db, { snapshot: "include-pending-for-debug" });
// debugSnapshot.collections.post[0].likes === 1   <-- the optimistic overlay
```

The route builder forwards `defaults.snapshot` to the loader, so a
route declared with `defaults: { hydrate: "route", snapshot: "include-pending-for-debug" }`
includes pending overlays in the SSR payload.

This mode is opt-in because a debug snapshot is unsafe to ship: the
pending overlay may never persist, and rehydrating with it would
silently re-apply an aborted write. Use it only for development or
explicit debugging tooling.
