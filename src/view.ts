import type {
  DbRelationship,
  DbSchema,
  EntityDefinition,
  EntityName,
  EntityOutput,
} from "./schema.ts";

/** Brand symbol for {@link DbView} values. Used by the runtime to detect
 * view instances and to keep `pickView` / `materializeView` honest about
 * nested projections. */
export const dbViewSymbol = Symbol("tanstackstart-db.view");

type EntityRecord<Schema extends DbSchema, Name extends EntityName<Schema>> =
  EntityOutput<Schema["entities"][Name]> extends Record<string, unknown>
    ? EntityOutput<Schema["entities"][Name]>
    : never;

/**
 * A view-selection literal. Use `true` to include a field, or a nested
 * {@link DbView} to project through a relationship.
 *
 * @typeParam Entity - the row shape this selection projects from.
 * @typeParam Relationships - the entity's declared relationships; the
 *   selection only allows nested views on declared relationship names.
 *
 * @example
 * ```ts
 * const userCard = db.view("user", { id: true, name: true });
 * const postCard = db.view("post", { id: true, title: true, author: userCard });
 * ```
 */
export type ViewSelection<
  Entity extends Record<string, unknown>,
  Relationships extends Record<string, DbRelationship> = Record<never, never>,
> = {
  readonly [Key in keyof Entity]?: true;
} & RelationshipViewSelection<Relationships>;

type RelationshipViewSelection<Relationships extends Record<string, DbRelationship>> =
  string extends keyof Relationships
    ? Record<never, never>
    : {
        readonly [Key in keyof Relationships]?: DbView<
          unknown,
          unknown,
          Relationships[Key]["entity"]
        >;
      };

/**
 * A schema-validated view. Use `db.view(entityName, selection)` to
 * construct one against a {@link DbSchema}, or `defineView(schema, ...)`
 * outside of a `StartDb` context. The `Entity`, `Result`, and `Name`
 * generics are inferred from the schema and selection literal.
 *
 * @typeParam Entity - the unprojected row shape; informational.
 * @typeParam Result - the projected result of applying the view; this is
 *   what `q.<entity>...as(view).execute()` returns.
 * @typeParam Name - the literal entity name.
 */
export interface DbView<Entity = unknown, Result = unknown, Name extends string = string> {
  readonly [dbViewSymbol]: true;
  readonly entity: Name;
  readonly selection: Readonly<Record<string, true | DbView>>;
  readonly __entity?: Entity;
  readonly __result?: Result;
}

/**
 * The result type of a view selection. For each key in the selection:
 * - if the key is a field on the entity, the result has that field's type;
 * - if the key is a relationship with a `DbView` selection, the result has
 *   the view's `Result` (or `Result | undefined` for `one` relationships,
 *   `ReadonlyArray<Result>` for `many` relationships).
 *
 * @typeParam Entity - the unprojected row shape.
 * @typeParam Selection - the literal selection passed to `db.view(...)`.
 * @typeParam Relationships - the entity's declared relationships.
 */
export type SelectionResult<
  Entity extends Record<string, unknown>,
  Selection extends object,
  Relationships extends Record<string, DbRelationship> = Record<never, never>,
> = Readonly<{
  [Key in keyof Selection]: Key extends keyof Entity
    ? Entity[Key]
    : Key extends keyof Relationships
      ? Selection[Key] extends DbView<unknown, infer Result>
        ? Relationships[Key]["kind"] extends "many"
          ? ReadonlyArray<Result>
          : Result | undefined
        : never
      : never;
}>;

/** The projected result of a {@link DbView}. */
export type InferView<View extends DbView> =
  View extends DbView<unknown, infer Result> ? Result : never;

/** The unprojected row shape that a {@link DbView} applies to. */
export type InferViewEntity<View extends DbView> =
  View extends DbView<infer Entity, unknown> ? Entity : never;

/** A `Partial` of {@link InferView}. Useful for action inputs that only
 * patch a subset of the view's projected fields. */
export type InferViewInput<View extends DbView> = Partial<InferView<View>>;

/**
 * Define a {@link DbView} against a {@link DbSchema}. `db.view(...)` is the
 * idiomatic entry point for `StartDb` consumers; this function exists for
 * cases where the schema is not yet bound to a `StartDb`.
 *
 * @typeParam Schema - the schema being projected against.
 * @typeParam Name - the entity name; must be a key of `Schema["entities"]`.
 * @typeParam Selection - the literal view selection.
 *
 * @param schema - the schema declaring the target entity.
 * @param entityName - the literal entity name.
 * @param selection - the literal view selection. `true` includes a field;
 *   a nested `DbView` projects through a relationship.
 * @returns a {@link DbView} whose `Result` type is the projected shape.
 * @throws when a relationship key in the selection does not match a
 *   declared relationship on the target entity.
 *
 * @example
 * ```ts
 * const userCard = defineView(schema, "user", { id: true, name: true });
 * const postCard = defineView(schema, "post", { id: true, title: true, author: userCard });
 * ```
 */
export function defineView<
  Schema extends DbSchema,
  Name extends EntityName<Schema>,
  const Selection extends ViewSelection<
    EntityRecord<Schema, Name>,
    Schema["entities"][Name]["relationships"]
  >,
>(
  schema: Schema,
  entityName: Name,
  selection: Selection,
): DbView<
  EntityRecord<Schema, Name>,
  SelectionResult<EntityRecord<Schema, Name>, Selection, Schema["entities"][Name]["relationships"]>,
  Name
> {
  validateNestedViews(
    schema.entities[entityName],
    selection as Readonly<Record<string, true | DbView>>,
  );
  return {
    [dbViewSymbol]: true,
    entity: entityName,
    selection: selection as Readonly<Record<string, true | DbView>>,
  };
}

function validateNestedViews(
  definition: EntityDefinition,
  selection: Readonly<Record<string, true | DbView>>,
): void {
  for (const [name, nested] of Object.entries(selection)) {
    if (nested === true) continue;
    const relationship = definition.relationships[name];
    if (!relationship) {
      throw new Error(`View relationship "${name}" is not defined.`);
    }
    if (relationship.entity !== nested.entity) {
      throw new Error(
        `View relationship "${name}" targets "${relationship.entity}", not "${nested.entity}".`,
      );
    }
  }
}

/**
 * Define a literal view selection without binding it to a schema. Useful
 * for declaring reusable selection fragments that are later composed with
 * `defineView(...)` or `db.view(...)`.
 *
 * @typeParam Selection - the literal selection record. Inferred from the
 *   argument.
 *
 * @example
 * ```ts
 * const idOnly = defineViewFragment({ id: true });
 * const postCard = db.view("post", { ...idOnly, title: true });
 * ```
 */
export function defineViewFragment<const Selection extends Readonly<Record<string, true | DbView>>>(
  selection: Selection,
): Selection {
  return selection;
}

/** Alias of {@link defineViewFragment}. Prefer `defineView` for new code. */
export const defineProjection = defineViewFragment;

/**
 * Apply a view's selection to a row. The source row's `true`-selected
 * fields are copied through; nested `DbView` selections recurse into
 * relationship rows. `null` and `undefined` values pass through unchanged.
 *
 * @typeParam View - the view being applied; the `Entity` generic infers the
 *   row shape and the `Result` generic carries through to the return.
 *
 * @param view - the view to apply.
 * @param value - the row to project.
 * @returns the projected result. The type is `InferView<View>`.
 *
 * @example
 * ```ts
 * const card = db.view("user", { id: true, name: true });
 * pickView(card, { id: "u1", name: "Alice", email: "alice@example.com" });
 * // => { id: "u1", name: "Alice" }
 * ```
 */
export function pickView<View extends DbView>(
  view: View,
  value: InferViewEntity<View>,
): InferView<View> {
  const source = value as Record<string, unknown>;
  const selection = view.selection;
  let hasNested = false;
  for (const nested of Object.values(selection)) {
    if (nested !== true) {
      hasNested = true;
      break;
    }
  }
  if (!hasNested) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(selection)) {
      result[key] = source[key];
    }
    return result as InferView<View>;
  }
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(selection)) {
    const selected = source[key];
    const nestedView = selection[key];
    if (nestedView === true) {
      result[key] = selected;
    } else if (selected == null) {
      result[key] = selected;
    } else if (Array.isArray(selected)) {
      result[key] = selected.map((item) =>
        pickView(nestedView as DbView, item as InferViewEntity<typeof nestedView>),
      );
    } else {
      result[key] = pickView(nestedView as DbView, selected as InferViewEntity<typeof nestedView>);
    }
  }
  return result as InferView<View>;
}

/** Alias of {@link pickView}. */
export const maskView = pickView;

/**
 * Build a `(row) => projected` function for a view. Equivalent to
 * `pickView.bind(null, view)` but more readable at call sites.
 *
 * @typeParam View - the view type; carried through to the return.
 *
 * @example
 * ```ts
 * const card = db.view("user", { id: true, name: true });
 * const project = withView(card);
 * project({ id: "u1", name: "Alice", email: "x" }); // => { id: "u1", name: "Alice" }
 * ```
 */
export function withView<View extends DbView>(
  view: View,
): (value: InferViewEntity<View>) => InferView<View> {
  return (value) => pickView(view, value);
}

/**
 * Type-guard that a value has every key a view expects. Returns `true`
 * when `value` is a non-null object and every key in `view.selection` is
 * present in `value`. The check is structural; use {@link pickView} for
 * actual projection.
 *
 * @example
 * ```ts
 * const card = db.view("user", { id: true, name: true });
 * satisfiesView(card, { id: "u1", name: "Alice" }); // => true
 * satisfiesView(card, { id: "u1" }); // => false
 * ```
 */
export function satisfiesView<View extends DbView>(
  view: View,
  value: unknown,
): value is InferView<View> {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  return Object.keys(view.selection).every((key) => key in value);
}

/**
 * Deeply project a row through a view and return a runtime-frozen
 * value. Useful at component boundaries where you want to pass the
 * projected result into `React.memo` children or hand it to a worker
 * without risking accidental mutation.
 *
 * The static type is unchanged from {@link pickView}: the projection is
 * already `Readonly<...>` at the type level. `freezeView` adds a
 * runtime `Object.freeze` to the top level and to every nested
 * relationship projection. The original `value` is not mutated.
 *
 * @typeParam View - the view being applied; the `Entity` generic
 *   infers the row shape and the `Result` generic carries through.
 *
 * @param view - the view to apply.
 * @param value - the row to project.
 * @returns the projected, deeply-frozen result.
 *
 * @example
 * ```ts
 * const card = db.view("user", { id: true, name: true });
 * const frozen = freezeView(card, user);
 * // frozen.name = "Bob"; // throws in strict mode
 * ```
 */
export function freezeView<View extends DbView>(
  view: View,
  value: InferViewEntity<View>,
): InferView<View> {
  const projected = pickView(view, value);
  deepFreeze(projected as Record<string, unknown>);
  return projected;
}

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  if (Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
}

/**
 * `true` if the view contains at least one nested relationship
 * projection. Used by the native-join compiler to decide whether a
 * selection can be folded into a TanStack DB `select` projection or
 * whether the relationships must be resolved post-execution.
 */
export function hasNestedViews(view: DbView): boolean {
  for (const nested of Object.values(view.selection)) {
    if (nested !== true) return true;
  }
  return false;
}

/**
 * Compile a view into a native TanStack DB `select` callback. Used by
 * `as(View)` for views that do not have foldable nested joins.
 *
 * @typeParam Refs - the alias map passed to a `select` callback by
 *   TanStack DB; usually `{ [rowAlias]: row }`.
 *
 * @param view - the view to compile.
 * @param rowAlias - the alias of the source row in the `select` callback.
 * @returns a `select` callback that projects the view's `true` keys from
 *   `refs[rowAlias]`.
 */
export function compileViewSelect<Refs extends Record<string, unknown>>(
  view: DbView,
  rowAlias: string,
): (refs: Refs) => Record<string, unknown> {
  return (refs) => {
    const row = refs[rowAlias as keyof Refs] as Record<string, unknown> | undefined;
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(view.selection)) {
      if (row) {
        result[key] = row[key];
      } else {
        result[key] = undefined;
        void nested;
      }
    }
    return result;
  };
}
