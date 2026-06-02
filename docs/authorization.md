# Authorization

Authorization is the **per-action gate** that decides whether a request
should be allowed to run. It is intentionally narrow: the package does not
ship a role / permission system, a session manager, or a server-function
integration. It exposes a single `authorize` hook on the action definition
and a single `DbAuthError` to flag a denial.

This document covers:

- The `authorize` hook and the `DbAuthError` it raises on `false`.
- Where `authorize` runs in the action lifecycle.
- Patterns for shared gates (`requireUser`, `requireRole`).
- How authorization interacts with optimistic writes, transactions, and
  `onError`.

For the optimistic / conflict / offline contract (which lives in the same
lifecycle), see [`docs/optimistic-conflict-offline.md`](./optimistic-conflict-offline.md).

---

## 1. The `authorize` hook

```ts
import { action, db } from "./db";

const updatePost = action<{ id: string; title: string }, void>({
  authorize: ({ input }) => input.id.startsWith("post_"),
  run: ({ input }) => {
    db.collections.post.update(input.id, (current) => ({
      ...current,
      title: input.title,
    }));
  },
});
```

`authorize(context)` receives the same `ActionContext<Input>` as the rest of
the lifecycle. The contract is:

- Return `true` (or a promise resolving to `true`) to allow the action.
- Return `false` (or a promise resolving to `false`) to deny. The action
  raises `DbAuthError`, the cache rolls back any optimistic work, and
  `submission.result` rejects with `DbActionError("Action authorization
failed.", new DbAuthError())`.

`authorize` is **optional**. An action without an `authorize` hook is
unrestricted; the runtime still wraps the rest of the lifecycle in the
standard try/catch / rollback / `onError` path, but no gate runs.

---

## 2. Where `authorize` runs

`authorize` is the **first** hook in the lifecycle. The order is:

1. `authorize` — gate. If it returns `false`, the action short-circuits
   with `DbAuthError`. No optimistic work runs, no `setTransaction` is
   called, and `run` is never invoked.
2. `optimistic` / `optimisticLocal` — synchronous optimistic overlays for
   native collections and the memory adapter, respectively.
3. `run` — the action's main work. May be async. May call `setTransaction`
   to attach a native TanStack DB transaction to the submission.
4. `invalidate` — post-success invalidation hook (after `run` resolves).
5. `onSuccess` / `onError` — terminal hooks.
6. `onSettled` — runs after `onSuccess` or `onError`.

If `authorize` throws (rather than returning `false`), the throw is wrapped
in `DbActionError` and routed through the same error path as a `run`
failure: cache rollback, `submission.result` rejection, `onError` invoked
with the wrapped error.

---

## 3. Shared gates

There is no built-in role system; shared gates are user-defined functions
that return a `(context) => boolean` predicate. Three patterns are common.

### Per-action inline predicate

```ts
const renamePost = action<{ id: string; title: string }>({
  authorize: ({ input }) => input.id.startsWith("post_"),
  run: ({ input }) => {
    /* ... */
  },
});
```

Useful for the simplest cases. The predicate is local to the action and
inlined in its definition.

### Shared predicate factory

```ts
const requirePrefix =
  (prefix: string) =>
  ({ input }: { input: { id: string } }) =>
    input.id.startsWith(prefix);

const renamePost = action<{ id: string; title: string }>({
  authorize: requirePrefix("post_"),
  run: ({ input }) => {
    /* ... */
  },
});
```

Useful when several actions share the same gate. The factory pattern keeps
the predicate close to the action and keeps the action definition concise.

### Server-side `requireUser` / `requireRole`

For gates that depend on a request-scoped user (server functions, route
loaders), pass the user as a closure over the action definition or read it
from a request-scoped context inside `authorize`. The package does not
provide a session manager; consumers wire their own.

```ts
import { getRequestUser } from "./auth";

function makeAuthorizedAction<Input, Result>(
  def: ActionDefinition<Input, Result>,
): ActionDefinition<Input, Result> {
  return {
    ...def,
    authorize: async (context) => {
      const user = await getRequestUser();
      if (!user) return false;
      if (def.authorize && !(await def.authorize(context))) return false;
      return true;
    },
  };
}
```

This is a pattern, not a built-in. The package's job is to expose the
`authorize` hook; session plumbing is the consumer's responsibility.

---

## 4. Authorization and optimistic state

`authorize` runs **before** `optimistic` and `optimisticLocal`. A denied
action never produces an optimistic overlay; the cache is not mutated;
the submission transitions directly to `"failed"` and `submission.result`
rejects.

This is intentional: optimistic state should not be visible to a user who
is not authorized to perform the action. If you need to test the
authorization contract without affecting real cache state, mock the action
through the testing entrypoint's `mockDbAction(...)` helper, which returns
a `DbActionSubmission` that does not touch the cache.

---

## 5. Authorization errors

A denial surfaces through three channels:

1. `submission.result` rejects with `DbActionError` whose `cause` is a
   `DbAuthError`.
2. `submission.status` becomes `"failed"`.
3. The action's `onError` hook receives the same wrapped error.

`isDbAuthError(error)` is the package's type-guard for the inner
`DbAuthError`. Use it to distinguish a denial from a `run` failure:

```ts
import { isDbAuthError } from "@doeixd/tanstackstart-db";

await submission.result.catch((error) => {
  if (isDbAuthError(error.cause)) {
    return showToast("You are not allowed to do that.");
  }
  throw error;
});
```

---

## 6. Extending an action's authorization

`.authorize(...)` and `.extend({ authorize })` add or replace the gate on
a derived action. The merge is shallow: a derived action that does not
specify `authorize` keeps the original; a derived action that does specify
`authorize` replaces it.

```ts
const renameAnyPost = renamePost.authorize(() => true);
const adminOnlyRename = renamePost.authorize(
  ({ input }) => isAdmin(currentUser) && input.id.startsWith("admin_"),
);
```

`extend` is the broader escape hatch. It accepts a
`Partial<ActionDefinition<Input, Result>>` and merges the provided fields
with the original. Use `extend` for multi-field changes
(`{ authorize, run, onSuccess }`); use `authorize` for a single-field
override.

---

## 7. Common pitfalls

- **Performing side effects in `authorize`.** `authorize` is supposed to
  be a predicate. Reading from the cache, calling the network, or
  mutating state inside `authorize` will run on every action invocation
  and is not part of the rollback contract.
- **Throwing instead of returning `false`.** A throw is treated as a
  runtime error and routed through the standard error path. A `false`
  return is the documented way to deny.
- **Forgetting to await async gates.** `authorize` is
  `boolean | Promise<boolean>`. An unawaited promise resolves to
  `Promise<true>` or `Promise<false>`, both of which are truthy at the
  type level. Always `await`.
- **Treating `DbAuthError` as the only denial shape.** Wrapping custom
  errors in `DbAuthError` (e.g. `throw new DbAuthError("Not allowed.")`)
  is supported but uncommon. The recommended pattern is to return `false`
  and let the runtime raise the canonical `DbAuthError`.
