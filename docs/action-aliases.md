# Action aliases

Action aliases are how a route exposes an action under a **different name**
without renaming the canonical action. The alias is the route-level view
of an action; the canonical name is the schema-level identifier. The route
builder keeps them in sync so `pending.action("alias")` and
`submissions.latest("alias")` work even when the canonical name is
`"post.patch"`.

This document covers:

- The action chain: `.with(...)`, `.extend(...)`, `.authorize(...)`,
  `.input(...)`, `.affects(...)`, `.optimistic(...)`.
- How the canonical name is set and preserved.
- Route-level aliasing: the route builder's `.actions(...)` callback and
  the alias-resolution that backs `pending` and `submissions` lookups.
- Why re-binding is type-system-rejected.

For the action submission contract that aliases feed into, see
[`README.md`](../README.md#actions-and-optimistic-state).

---

## 1. The action chain

`db.a.<entity>.<verb>` is a callable `DbAction<Input, Result>` with a small
chainable API. The most-used methods are:

- **`.with(boundInput)`** — bind a partial input. The bound keys are
  removed from the resulting action's required input. `actionName` is
  preserved.
- **`.extend(extension)`** — merge a `Partial<ActionDefinition<Input, Result>>`
  into the original. The merge is shallow: any field you set replaces the
  original. `actionName` is preserved.
- **`.authorize(handler)`** — set the `authorize` gate. The handler is
  `(context) => boolean | Promise<boolean>`. See
  [`docs/authorization.md`](./authorization.md).
- **`.input(validator)`** — set the input validator. The validator is a
  `(input) => input` Standard Schema-style function.
- **`.affects(handler)`** — set the `affects` predicate. The predicate
  declares the query specs the action invalidates; the route builder
  uses it to mark dependent specs as pending.
- **`.optimistic(handler)`** — set the `optimistic` overlay for native
  collections.

Each chain method returns a **new** `DbAction` derived from the original;
the original is not mutated. This is what makes aliasing safe: the route
can hold a reference to the derived action and the canonical action is
unaffected.

```ts
const likePost = db.a.post.patch.with({ id: "post_1" });
// likePost.actionName === "post.patch"

const withLogging = likePost.extend({
  onSuccess: (result) => console.log("liked", result),
});
// withLogging.actionName === "post.patch"
```

---

## 2. Canonical names

Every action in the generated CRUD namespace has a canonical name of the
shape `"<entity>.<verb>"` — `"post.patch"`, `"post.create"`, etc. Custom
actions added through `db.extendActions(...)` get their own canonical
names, also of the shape `"<entity>.<verb>"`.

The canonical name is the **identity** the action carries through
`.with(...)` and `.extend(...)`. Re-binding the input does not rename the
action. This is what makes the route-level alias safe: the route can
expose `likePost` as an alias for `post.patch` and the canonical name
is unchanged.

The canonical name is also the key under which submissions are stored
internally (`tracker.submissions.get("post.patch")`). The route builder
uses it to resolve aliases back to the canonical submission record.

---

## 3. Route-level aliasing

The route builder's `.actions(callback)` returns a record of
`{ alias: action }` pairs. The callback receives `{ a, data }` — the
generated action namespace `a` and the data resolved by the route's
earlier stages.

```ts
const postRoute = createDbFileRoute("/posts/$postId")
  .views(postPageFragment)
  .actions(({ a, data }) => ({
    renamePost: a.post.patch.with({ id: data.post.id }),
    deletePost: a.post.delete.with({ id: data.post.id }),
  }));
```

`renamePost` and `deletePost` are the route's aliases. Internally, both
are bound actions whose `actionName` is still `"post.patch"` and
`"post.delete"` respectively. The route builder keeps a map of
`alias → canonicalName` so that lookups by alias can be resolved back to
the canonical submission.

The component receives the alias keys:

```tsx
.component(({ post, actions, pending, submissions }) => (
  <PostPage
    post={post}
    renaming={pending.action("renamePost")}
    lastRename={submissions.latest("renamePost")}
    onRename={(title) => actions.renamePost({ changes: { title } })}
    onDelete={() => actions.deletePost({})}
  />
));
```

`pending.action("renamePost")` returns the in-flight status of the
**canonical** `"post.patch"` action; the alias is just a lookup key. The
same is true for `submissions.latest("renamePost")`.

---

## 4. Why re-binding is type-rejected

After `.with({ id: "post_1" })`, the derived action's `Input` is
`Omit<Input, "id">` — the bound key is no longer required. Calling
`.with({ id: "post_2" })` on the derived action is a type error: `"id"`
is not assignable to `Omit<...>`. This is intentional:

- The bound input is **meant** to be set once at the route boundary, not
  re-bound on every render. The type system enforces that the bound input
  is a fixed part of the route's contract.
- The canonical name is set on the **action chain itself**, not on the
  bound input. Re-binding does not change the canonical name, so allowing
  it would create two derived actions with the same canonical name and
  different bound inputs, which the runtime would have to disambiguate.

If you need a different bound input, derive a new action:

```ts
const renamePost1 = a.post.patch.with({ id: "post_1" });
const renamePost2 = a.post.patch.with({ id: "post_2" });
```

---

## 5. `actionName` preservation

The canonical name is preserved across:

- **`.with(boundInput)`** — `renamePost.actionName === "post.patch"`.
- **`.extend({ ... })`** — `withLogging.actionName === "post.patch"`.
- **Route-level aliasing** — `renamePost.actionName === "post.patch"`
  (the alias `"renamePost"` is a route-level key, not a name on the
  action itself).

This is the contract the route builder relies on for alias resolution.
The submission's `actionName` is the canonical name; the route's
`pending` / `submissions` registries store the canonical name as the
key; the alias is a separate index that resolves to it.

---

## 6. Composing aliases

`composeDbRouteFragments(...)` is the route-level way to compose action
maps. The composed fragment's action keys are unions of the fragments'
action keys, with later fragments overriding earlier ones when the keys
collide.

```ts
import { composeDbRouteFragments } from "@doeixd/tanstackstart-db/react";

const postWithComments = composeDbRouteFragments(postPageFragment, ({ a, data }) => ({
  renamePost: a.post.patch.with({ id: data.post.id }),
}));
```

The composed action map has the same alias semantics as a single-stage
`.actions(...)` callback. The alias-resolution table is built once per
route at `.build()` time.

---

## 7. Action shape vs route shape

A subtle but important distinction: the **action shape** and the **route
shape** are different things.

- The action shape is the callable `DbAction<Input, Result>`. The bound
  input is part of the action's input; the canonical name is part of the
  action's identity.
- The route shape is the record of `{ alias: action }` pairs. The alias
  is a key in the route's `actions` object, not a name on the action
  itself.

Route consumers see the alias as a key on `actions`, `pending`, and
`submissions`. The canonical name is what the runtime uses to look up
submissions and pending state; the alias is a convenience for code that
already knows the route's contract.

---

## 8. Common pitfalls

- **Re-binding the same key.** As noted, the type system rejects
  `.with({ id })` after `.with({ id })`. Derive a new action instead.
- **Renaming the canonical name.** There is no API for renaming the
  canonical name. The name is the action's identity; the alias is a
  route-level convention.
- **Forgetting `data` in the action callback.** The callback receives
  `{ a, data }`; if a derived action depends on data resolved by an
  earlier stage, the callback's destructuring must include `data`.
  Otherwise the derived action is built before the data is available.
- **Treating the alias as a name on the action.** The alias is a route
  key, not an action field. The action's identity is the canonical
  name. Inspecting `action.actionName` on a route-bound action returns
  the canonical name, not the alias.

---

## 9. Generated CRUD auto-affects

The generated CRUD namespace (`db.a.<entity>.<verb>`) ships with
auto-derived `affects(...)` so `pending.field(entity, "fieldname")`
and `pending.query("entity")` work without writing any `affects` by
hand. The auto-affects are the smallest set that drives both
lookups:

| Verb     | Auto-affects                                                           |
| -------- | ---------------------------------------------------------------------- |
| `create` | `[q.<entity>.all()]` — any list query now contains the new row.        |
| `patch`  | `[q.<entity>.byId(id).field(name)]` for each `name` in `changes`.      |
| `update` | `[q.<entity>.byId(id)]` — whole-row replacement, no field granularity. |
| `delete` | `[q.<entity>.byId(id)]` — row removal.                                 |

This is what makes the canonical use case work for free:

```ts
await db.a.post.patch({ id: "post_1", changes: { title: "New" } });
// pending.field({ id: "post_1" }, "title") is true while running
// pending.field({ id: "post_1" }, "likes") is false (no spec for "likes")
// pending.query("post") is true
```

Custom actions defined through `db.extendActions(...)` do not get
auto-affects — they need an explicit `affects(...)` to participate in
the route pending state. Use the same return shape (`DbQuerySpec[]`)
so the route builder can mark dependent specs as pending.

The auto-affects can be overridden with `.extend({ affects: ... })`,
for example to mark a relationship query as affected when a patch
changes the relationship's foreign key.
