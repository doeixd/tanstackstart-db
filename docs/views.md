# Views

Views describe the **shape a component or route needs** without leaking the
full entity. They are the boundary at which your schema meets your UI: a view
selects fields, materializes declared relationships, and produces a
`Readonly<...>` projection that the rest of the application can rely on.

This document covers:

- What a view is and how to define one.
- Field selection and nested relationship projections.
- Readonly, deep-freeze, and runtime masking.
- View composition (`defineViewFragment`, `InferView`, `InferViewInput`).
- View-aware query specs (`.as(view)`), the `pickView` / `withView` / `maskView`
  helpers, and the native-join compiler.

For the schema-side relationship declarations that views depend on, see
[`docs/relationships.md`](./relationships.md).

---

## 1. Defining a view

A view is a typed field mask. The DB-bound entry point is `db.view(name, selection)`:

```ts
import { db } from "./db";
import { schema } from "./schema";

const userCard = db.view("user", { id: true, name: true });
const postCard = db.view("post", {
  id: true,
  title: true,
  likes: true,
  author: userCard, // declared `api.one("user", ...)` on `post`
});
```

The selection literal uses `true` to include a field and a nested
[`DbView`](./../src/view.ts) to project through a relationship. Anything not
mentioned in the selection is dropped from the projected result.

The constructor validates the selection at definition time: relationship keys
must point at a declared `api.one(...)` / `api.many(...)` relationship, and the
nested view's `entity` must match the relationship's target entity. Mistakes
become immediate `Error` throws, not silent type drift.

When a view is needed outside a `StartDb` context, use `defineView(schema, name, selection)`
directly:

```ts
import { defineView } from "@doeixd/tanstackstart-db";

const userCard = defineView(schema, "user", { id: true, name: true });
```

### Fragments

`defineViewFragment(selection)` returns a literal selection record that can
be reused across views:

```ts
import { defineViewFragment } from "@doeixd/tanstackstart-db";

const idOnly = defineViewFragment({ id: true });

const postCard = db.view("post", { ...idOnly, title: true });
const userCard = db.view("user", { ...idOnly, name: true });
```

`defineProjection` is an alias of `defineViewFragment` for callers who prefer
the older name.

---

## 2. Result type and `InferView<View>`

The view's `Result` generic is **the projected shape**. The static type of
`postCard.execute()` is the result of walking the selection: field keys keep
their entity types, nested `one` views become `Result | undefined`, nested
`many` views become `ReadonlyArray<Result>`.

```ts
import type { InferView, InferViewInput } from "@doeixd/tanstackstart-db";

type PostCard = InferView<typeof postCard>;
// Readonly<{
//   id: string;
//   title: string;
//   likes: number;
//   author: { id: string; name: string } | undefined;
// }>

type PostCardPatch = InferViewInput<typeof postCard>;
// Partial<PostCard>, useful for action inputs
```

`InferViewInput<View>` is the same projection made `Partial`. It is convenient
for action inputs that only patch a subset of the view's projected fields.

---

## 3. Projecting a row at runtime

Three helpers project a row through a view at runtime:

- `pickView(view, row)` — returns the projected value.
- `withView(view)` — returns `(row) => pickView(view, row)`.
- `maskView` — alias of `pickView`.

```ts
import { pickView, withView, maskView } from "@doeixd/tanstackstart-db";

const card = db.view("user", { id: true, name: true });

pickView(card, { id: "u1", name: "Ada", email: "x" });
// => { id: "u1", name: "Ada" }

maskView(card, { id: "u2", name: "Bo", email: "y" });
// => { id: "u2", name: "Bo" }

const project = withView(card);
project({ id: "u3", name: "Cy", email: "z" });
// => { id: "u3", name: "Cy" }
```

`null` and `undefined` rows pass through unchanged. For each nested `DbView`
selection, `pickView` recurses into either a single value (`one`) or a mapped
array (`many`).

`satisfiesView(view, value)` is a structural type-guard: `true` when `value`
is a non-null object with every key the view expects. The projection itself
is not performed; this is useful as a precondition.

---

## 4. Deep-freeze at component boundaries

The projected result is already `Readonly<...>` at the type level, but the
runtime object is mutable. `freezeView(view, row)` projects **and** deep-freezes
the result:

```ts
import { freezeView } from "@doeixd/tanstackstart-db";

const card = db.view("user", { id: true, name: true });
const frozen = freezeView(card, user);

// frozen.name = "Bob"; // throws in strict mode
```

`freezeView` is the right choice at component boundaries that hand the
projection to `React.memo` children, to a worker, or anywhere you want to make
mutation impossible rather than just discouraged. The original row is **not**
mutated; only the projected result is frozen.

`hasNestedViews(view)` returns `true` if the view contains at least one nested
relationship projection. The native-join compiler uses this to decide whether
a selection can be folded into a TanStack DB `select` projection or whether
relationships must be resolved after execution.

---

## 5. Using views in query specs

`.as(view)` binds a view to a query spec. The runtime:

1. Compiles the view's `true`-selected fields into a native TanStack DB
   `select` projection when the selection is simple (no nested relationship
   views).
2. Resolves nested `one` / `many` relationship selections post-execute for
   relationships whose target collection has no native engine, or when the
   selection includes foldable `one` joins, by emitting a native TanStack DB
   join clause and keeping the post-execute materialization step in place for
   non-foldable fields.
3. Strips the internal `$`-prefixed virtual metadata TanStack DB adds (such as
   `$collectionId`, `$key`, `$origin`, `$synced`) so the caller only sees the
   projected fields.

```ts
const post = await db.q.post.byId("post_1").as(postCard).execute();
// post: PostCard

const live = db.q.post.byId("post_1").as(postCard).live();
const unsubscribe = live.subscribe((next) => {
  console.log(next); // re-emits on writes to `post` or its `author`
});
```

For live query subscriptions on views with relationship projections, the
runtime also subscribes to the related collection so that writes to the
related row re-emit the nested live result.

---

## 6. View helpers at a glance

| Export               | Purpose                                                                   |
| -------------------- | ------------------------------------------------------------------------- |
| `db.view`            | Schema-bound view constructor.                                            |
| `defineView`         | Schema-bound view constructor for callers without a `StartDb`.            |
| `defineViewFragment` | Literal-only selection fragment for composition.                          |
| `defineProjection`   | Alias of `defineViewFragment`.                                            |
| `pickView`           | Project a row through a view.                                             |
| `maskView`           | Alias of `pickView`.                                                      |
| `withView`           | `(row) => pickView(view, row)`.                                           |
| `freezeView`         | Project **and** deep-freeze the result.                                   |
| `satisfiesView`      | Structural type-guard that a value has every key a view expects.          |
| `hasNestedViews`     | `true` if the view contains at least one nested relationship projection.  |
| `compileViewSelect`  | Compile a view's `true` keys into a native TanStack DB `select` callback. |
| `InferView`          | The projected `Result` type of a view.                                    |
| `InferViewEntity`    | The unprojected row shape a view applies to.                              |
| `InferViewInput`     | `Partial<InferView<View>>` for action input shapes.                       |
| `dbViewSymbol`       | Brand symbol on `DbView` values; used by `isDbView` and internal code.    |
| `isDbView`           | Type-guard for {@link DbView} values.                                     |

---

## 7. Common pitfalls

- **Stale views after schema change.** A view is a literal: if the schema
  drifts (e.g. the relationship is renamed), the constructor will throw with
  the new validation. The error is intentionally early.
- **Confusing the two generics.** `InferView<View>` is the projected shape
  the caller sees. `InferViewEntity<View>` is the unprojected row shape the
  view applies to (useful for action inputs that need to know the full
  underlying row, including fields the view drops).
- **Mutating a `Readonly<...>` type.** The static type is `Readonly<...>`, but
  at runtime the object is still mutable. Use `freezeView` if you want
  runtime enforcement.
- **Treating `null` and `undefined` as equal.** `pickView` passes `null` /
  `undefined` rows through unchanged. A view applied to a missing `one`
  relationship will not throw; the result will simply be `undefined`.
