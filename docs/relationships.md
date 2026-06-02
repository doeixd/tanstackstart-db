# Relationships

Relationships are the **first-class links** between entities in your schema.
They are declared once, drive the typed `q.*` relationship helpers, gate
which nested views are valid, and tell the runtime how to fold projections
into native joins.

This document covers:

- Declaring relationships in the schema (`api.one` and `api.many`).
- The helpers the schema generates (`byPost(...)`, `q.post.comments`).
- What the runtime does with each kind of relationship during query
  execution, view projection, and live subscription.
- Foldable joins and the post-execute materialization step.

For the views that consume relationships, see
[`docs/views.md`](./views.md).

---

## 1. Declaring a relationship

Inside `entity(validator, { ... })`, the `relationships` callback receives a
`api` helper and returns a record of named relationships. Use `api.one(...)`
for foreign-key joins and `api.many(...)` for reverse joins:

```ts
import { defineDbSchema, entity, passthrough } from "@doeixd/tanstackstart-db/schema";

export const schema = defineDbSchema({
  entities: {
    user: entity(passthrough<{ id: string; name: string }>(), {
      key: "id",
    }),
    post: entity(passthrough<{ id: string; authorId: string; title: string; likes: number }>(), {
      key: "id",
      indexes: ["authorId"],
      relationships: (api) => ({
        author: api.one("user", { local: "authorId", foreign: "id" }),
        comments: api.many("comment", { local: "id", foreign: "postId" }),
      }),
    }),
    comment: entity(passthrough<{ id: string; postId: string; body: string }>(), { key: "id" }),
  },
});
```

`api.one(target, { local, foreign })` says: "this row's `local` field is a
foreign key into `target`'s `foreign` field." The cardinality is **one**:
each row has zero or one related row.

`api.many(target, { local, foreign })` says: "for each row, find every
`target` row whose `foreign` equals this row's `local`." The cardinality is
**many**: each row has zero or more related rows.

The relationship kind is the source of truth for both view projection
(`one` → `Result | undefined`, `many` → `ReadonlyArray<Result>`) and the
runtime's join / post-execute behavior.

---

## 2. Helpers generated from relationships

### Index helpers (`byPost`, `byAuthor`)

For each schema index, the package generates a `by<Index>(value)` helper
on `q.<entity>`. For `indexes: ["authorId"]` on `post`, that produces
`q.post.byAuthor(authorId)`.

Indexes are also inferred from relationship `local` fields when convenient;
the explicit `indexes` declaration is the contract.

### Relationship helpers

For each declared relationship, the package generates a typed
`q.<entity>.<relationship>(source)` helper. The helper executes a query that
returns all related rows for a given source row:

```ts
const post = await db.q.post.byId("post_1").execute();

const author = await db.q.user.byId(post.authorId).execute();
const comments = await db.q.comment.byPost(post.id).execute();
// or, equivalently:
// const comments = await db.q.post.comments(post).execute();
```

The relationship helper respects the relationship kind: `one` helpers
return a single row (or `undefined`); `many` helpers return an array.

---

## 3. The runtime's three relationship paths

During query execution and view projection, the runtime picks one of three
paths per relationship:

### (a) Foldable native join

A `one` relationship is **foldable** when the related collection exposes a
native TanStack DB engine. The native-join compiler walks the view selection
and emits left-join clauses for each foldable `one` relationship. The native
`select` projection produces the source fields plus the joined rows. The
post-execute `materializeView` step recurses with `source[name]` for joined
`one` fields.

This is the fast path. No post-execute iteration, no per-row collection
lookup; the engine returns the joined result.

### (b) Post-execute materialization

`many` relationships, and `one` relationships whose related collection has
no native engine, are resolved **after** native query execution. The runtime
keeps the post-execute `materializeView` step in place even on the native
path so non-foldable fields are filled in after `queryOnce` /
`createLiveQueryCollection`. The post-execute step also subscribes to the
related collection, so writes to the related row re-emit the nested live
result.

This is the most common path for `many` relationships. The result is
reactive, just sourced from the related collection after execution rather
than from a native join.

### (c) Dropped selection

A relationship key in a view selection that does not match a declared
relationship is rejected at view-construction time. The `defineView`
validator throws `View relationship "<name>" is not defined.`. A nested view
whose `entity` does not match the relationship's target is also rejected
with `View relationship "<name>" targets "<actual>", not "<expected>".`.

There is no "silently drop" path. The error is intentional and early.

---

## 4. Foldable joins in practice

Given:

```ts
const userCard = db.view("user", { id: true, name: true });
const postCard = db.view("post", {
  id: true,
  title: true,
  likes: true,
  author: userCard, // foldable: `user` exposes a native engine
});
```

`db.q.post.byId("post_1").as(postCard).execute()` compiles to a native
TanStack DB query that joins `post` to `user` on `post.authorId = user.id`
and projects the source fields plus the joined row. The post-execute
`materializeView` step is still in place for non-foldable fields; with a
fully foldable view it becomes a no-op for the `author` field.

Live subscriptions re-emit when:

- a write touches the source `post` row, or
- a write touches the joined `user` row (so the nested `author` projection
  updates without re-querying the post).

The `many` path is different: a write to a `comment` row re-emits the
parent `post` subscription because the runtime also subscribes to the
related collection.

---

## 5. Defining `api.one` / `api.many` outside a `db`

`api.one` and `api.many` are convenience wrappers that capture the entity
name and field names. The bare `one(...)` and `many(...)` exports accept
the same shape:

```ts
import { one, many } from "@doeixd/tanstackstart-db/schema";

const authorRel = one("user", { local: "authorId", foreign: "id" });
const commentsRel = many("comment", { local: "id", foreign: "postId" });
```

Both forms are interchangeable inside a `relationships` callback.

---

## 6. Common pitfalls

- **Relationship kind mismatch.** A `one` view projection is `T | undefined`,
  not `T`. A `many` view projection is `ReadonlyArray<T>`. Swapping the two
  is a type error at view construction, not at runtime.
- **Stale helpers after a relationship rename.** Renaming a relationship
  updates the typed helper name on `q.<entity>.<relationship>`. Code that
  referenced the old name becomes a type error.
- **Missing indexes for `many` joins.** A `many` reverse join is typically
  backed by an index on the `foreign` field of the target entity. Without
  one, the runtime falls back to a per-row lookup; the result is correct but
  not indexed.
- **Forgetting `key`.** Every entity needs a `key`. A relationship that
  points at an entity without a key is a schema error.
