/**
 * The Standard Schema v1 contract. `Input` and `Output` are declared through
 * the phantom `types` field; the runtime `validate` function is the source of
 * truth for parsing and validation.
 *
 * @typeParam Input - the shape accepted by `validate`. Defaults to `unknown`.
 * @typeParam Output - the shape produced by a successful validation. Defaults
 *   to `Input`.
 *
 * @example
 * ```ts
 * import { z } from "zod";
 *
 * const postSchema: StandardSchemaV1<{ id: string; title?: string }, { id: string; title: string }> = {
 *   "~standard": {
 *     version: 1,
 *     vendor: "zod",
 *     validate: (value) => {
 *       const parsed = z.object({ id: z.string(), title: z.string() }).safeParse(value);
 *       return parsed.success
 *         ? { value: parsed.data }
 *         : { issues: parsed.error.issues.map((i) => ({ message: i.message })) };
 *     },
 *   },
 * };
 * ```
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
    readonly types?: {
      readonly input: Input;
      readonly output: Output;
    };
  };
}

/**
 * The result of a Standard Schema `validate` call. Either a `value` is
 * produced (the schema accepted and possibly transformed the input), or
 * `issues` are returned.
 *
 * @typeParam Output - the success output type of the schema.
 */
export type StandardSchemaResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<{ readonly message: string }> };

/** The cardinality of a relationship: `one` (foreign key) or `many` (reverse). */
export type RelationshipKind = "one" | "many";

/**
 * A schema-relationship declaration. Relationships are looked up by name from
 * the entity definition and used both to generate `q.<entity>.<relationship>(id)`
 * query helpers and to validate `db.view(...)` nested selections.
 *
 * @typeParam Kind - `"one"` or `"many"`. Determines whether the runtime resolves
 *   a single related row or an array of related rows.
 *
 * @example
 * ```ts
 * const authorRel: DbRelationship<"one"> = {
 *   kind: "one",
 *   entity: "user",
 *   local: "authorId",
 *   foreign: "id",
 * };
 * ```
 */
export interface DbRelationship<
  Kind extends RelationshipKind = RelationshipKind,
  Entity extends string = string,
> {
  readonly kind: Kind;
  readonly entity: Entity;
  readonly local: string;
  readonly foreign: string;
}

/** Configuration for `entity(...)` excluding the optional `indexes` and
 * `relationships` fields, which are passed through with their literal types
 * preserved. */
export interface EntityOptions {
  /** The field of the entity that uniquely identifies each row. */
  readonly key: string;
  /**
   * Optional indexed fields. Each index becomes a `q.<entity>.by<Field>(value)`
   * helper on the generated `q.*` API. Indexes also enable native TanStack DB
   * range lookups.
   */
  readonly indexes?: ReadonlyArray<string>;
  /**
   * Optional relationship declarations. Each key becomes a
   * `q.<entity>.<relationshipName>(id)` helper that returns the related rows.
   */
  readonly relationships?: (helpers: RelationshipHelpers) => Record<string, DbRelationship>;
}

/**
 * A schema-typed entity declaration. Created by `entity(...)`. The `Schema`,
 * `Indexes`, and `Relationships` types are preserved literally so the
 * generated `q.*` query helpers, `q.<entity>.by<Field>(value)` index
 * helpers, and `q.<entity>.<relationship>(id)` relationship helpers all
 * type-check without manual annotations.
 *
 * @typeParam Schema - the Standard Schema used to validate the entity.
 * @typeParam Indexes - the literal tuple of indexed field names.
 * @typeParam Relationships - the literal record of named relationships.
 */
export interface EntityDefinition<
  Schema extends StandardSchemaV1 = StandardSchemaV1,
  Indexes extends ReadonlyArray<string> = ReadonlyArray<string>,
  Relationships extends Record<string, DbRelationship> = Record<string, DbRelationship>,
> {
  readonly schema: Schema;
  readonly key: string;
  readonly indexes: Indexes;
  readonly relationships: Relationships;
}

/**
 * The `api` object passed to the `relationships` factory in `entity(...)`.
 * Use `api.one(...)` for single-row foreign keys and `api.many(...)` for
 * reverse relationships. The returned values are stored on the entity
 * definition and reused by generated `q.*` helpers and view validation.
 *
 * @example
 * ```ts
 * entity(passthrough<{ id: string; authorId: string }>(), {
 *   key: "id",
 *   relationships: (api) => ({
 *     author: api.one("user", { local: "authorId", foreign: "id" }),
 *     comments: api.many("comment", { local: "id", foreign: "postId" }),
 *   }),
 * });
 * ```
 */
export interface RelationshipHelpers<LocalField extends string = string> {
  /**
   * Declare a `one` relationship. The local field on the source entity holds
   * the key of the related row in the target entity.
   */
  one<const Entity extends string>(
    entity: Entity,
    options: Omit<DbRelationship, "entity" | "kind" | "local"> & { readonly local: LocalField },
  ): DbRelationship<"one", Entity>;
  /**
   * Declare a `many` relationship. The foreign field on the target entity
   * holds the key of the source row.
   */
  many<const Entity extends string>(
    entity: Entity,
    options: Omit<DbRelationship, "entity" | "kind" | "local"> & { readonly local: LocalField },
  ): DbRelationship<"many", Entity>;
}

/**
 * A schema is a record of named entity definitions. Pass the result of
 * `defineDbSchema(...)` to `createStartDbFromSchema(...)` to obtain a
 * `StartDb` with generated query helpers, actions, views, and React
 * bindings.
 *
 * @typeParam Entities - the literal record of entities. Inferred from
 *   `defineDbSchema({ entities: { ... } })`.
 */
export interface DbSchema<
  Entities extends Record<string, EntityDefinition> = Record<string, EntityDefinition>,
> {
  readonly entities: Entities;
}

/**
 * The `Input` phantom type of an entity's Standard Schema, or `unknown` if
 * the schema does not declare a phantom `Input`.
 */
export type EntityInput<Entity extends EntityDefinition> =
  Entity["schema"]["~standard"]["types"] extends { readonly input: infer Input } ? Input : unknown;

/**
 * The `Output` phantom type of an entity's Standard Schema, or `unknown` if
 * the schema does not declare a phantom `Output`. This is the type of a row
 * after parsing — it is what `q.*.execute()` returns and what generated CRUD
 * actions accept.
 */
export type EntityOutput<Entity extends EntityDefinition> =
  Entity["schema"]["~standard"]["types"] extends {
    readonly output: infer Output;
  }
    ? Output
    : unknown;

/** The literal union of entity names in a schema. */
export type EntityName<Schema extends DbSchema> = Extract<keyof Schema["entities"], string>;

/** The literal key field name of an entity, inferred from its `Output` shape. */
export type EntityKey<Entity extends EntityDefinition> =
  EntityOutput<Entity> extends Record<string, unknown>
    ? Extract<keyof EntityOutput<Entity>, string>
    : string;

/** Alias of {@link EntityOutput}. Use this for "what does a row of this
 * entity look like?" questions. */
export type InferEntity<Entity extends EntityDefinition> = EntityOutput<Entity>;
/** Alias of {@link EntityInput}. Use this for "what does an action accept
 * for this entity?" questions. */
export type InferEntityInput<Entity extends EntityDefinition> = EntityInput<Entity>;
/** Alias of {@link EntityOutput}. Prefer this for "what does a query return
 * for this entity?" questions. */
export type InferEntityOutput<Entity extends EntityDefinition> = EntityOutput<Entity>;

const relationshipHelpers: RelationshipHelpers = {
  one: (entity, options) => ({ kind: "one", entity, ...options }),
  many: (entity, options) => ({ kind: "many", entity, ...options }),
};

type SchemaOutput<Schema extends StandardSchemaV1> = Schema["~standard"]["types"] extends {
  readonly output: infer Output;
}
  ? Output
  : unknown;

type SchemaField<Schema extends StandardSchemaV1> =
  SchemaOutput<Schema> extends Record<string, unknown>
    ? Extract<keyof SchemaOutput<Schema>, string>
    : string;

/**
 * Declare a schema-typed entity. The `schema` argument is a Standard Schema
 * (Zod, Valibot, ArkType, or `passthrough<...>()` for unvalidated
 * definitions). The optional `indexes` become typed
 * `q.<entity>.by<Field>(value)` helpers, and the optional `relationships`
 * factory returns the entity's named relationships.
 *
 * @typeParam Schema - the Standard Schema type. Inferred from the argument.
 * @typeParam Indexes - a literal tuple of indexed field names. Preserved
 *   literally so `q.<entity>.by<Field>(...)` is typed as
 *   `(value: unknown) => DbQuerySpec<...>` keyed on the literal name.
 * @typeParam Relationships - a literal record of named relationships. The
 *   type of each `q.<entity>.<relationship>(id)` helper is keyed on the
 *   relationship's kind (`"one"` or `"many"`).
 *
 * @param schema - the Standard Schema used to validate the entity.
 * @param options - the key, optional indexes, and optional relationships.
 * @returns an {@link EntityDefinition} suitable for `defineDbSchema`.
 *
 * @example
 * ```ts
 * import { z } from "zod";
 *
 * const postEntity = entity(
 *   z.object({ id: z.string(), title: z.string(), authorId: z.string() }),
 *   {
 *     key: "id",
 *     indexes: ["authorId"],
 *     relationships: (api) => ({
 *       author: api.one("user", { local: "authorId", foreign: "id" }),
 *     }),
 *   },
 * );
 *
 * const userEntity = entity(
 *   z.object({ id: z.string(), name: z.string() }),
 *   { key: "id" },
 * );
 *
 * const schema = defineDbSchema({ entities: { post: postEntity, user: userEntity } });
 * ```
 */
export function entity<
  const Schema extends StandardSchemaV1,
  const Indexes extends ReadonlyArray<SchemaField<Schema>> = [],
  const Relationships extends Record<string, DbRelationship> = Record<never, never>,
>(
  schema: Schema,
  options: Omit<EntityOptions, "key" | "indexes" | "relationships"> & {
    readonly key: SchemaField<Schema>;
    readonly indexes?: Indexes;
    readonly relationships?: (helpers: RelationshipHelpers<SchemaField<Schema>>) => Relationships;
  },
): EntityDefinition<Schema, Indexes, Relationships> {
  return {
    schema,
    key: options.key,
    indexes: options.indexes ?? ([] as unknown as Indexes),
    relationships: options.relationships?.(relationshipHelpers) ?? ({} as Relationships),
  };
}

/**
 * Object-form alias of {@link entity}. Useful when larger schemas read better
 * with named fields instead of a positional `entity(schema, options)` call.
 */
export function defineEntity<
  const Schema extends StandardSchemaV1,
  const Indexes extends ReadonlyArray<SchemaField<Schema>> = [],
  const Relationships extends Record<string, DbRelationship> = Record<never, never>,
>(
  options: Omit<EntityOptions, "key" | "indexes" | "relationships"> & {
    readonly schema: Schema;
    readonly key: SchemaField<Schema>;
    readonly indexes?: Indexes;
    readonly relationships?: (helpers: RelationshipHelpers<SchemaField<Schema>>) => Relationships;
  },
): EntityDefinition<Schema, Indexes, Relationships> {
  const { schema, ...entityOptions } = options;
  return entity(schema, entityOptions);
}

/**
 * Combine a record of named entities into a {@link DbSchema}. Pass the result
 * to `createStartDbFromSchema(schema)` to construct a `StartDb`.
 *
 * @typeParam Entities - the literal record of entity definitions. Inferred
 *   from the `entities` argument.
 *
 * @example
 * ```ts
 * const schema = defineDbSchema({
 *   entities: {
 *     user: entity(passthrough<{ id: string; name: string }>(), { key: "id" }),
 *     post: entity(
 *       passthrough<{ id: string; authorId: string; title: string }>(),
 *       { key: "id", indexes: ["authorId"] },
 *     ),
 *   },
 * });
 * ```
 */
export function defineDbSchema<const Entities extends Record<string, EntityDefinition>>(options: {
  readonly entities: Entities;
}): DbSchema<Entities> {
  for (const [entityName, definition] of Object.entries(options.entities)) {
    for (const [relationshipName, relationship] of Object.entries(definition.relationships)) {
      if (!(relationship.entity in options.entities)) {
        throw new Error(
          `Entity "${entityName}" relationship "${relationshipName}" targets unknown entity "${relationship.entity}".`,
        );
      }
    }
  }
  return options;
}

/**
 * Build a `one` relationship outside of an `entity(...)` declaration. Most
 * callers should use the `api.one(...)` helper inside the
 * `relationships` factory — this top-level function is for cases where the
 * relationship is constructed dynamically.
 *
 * @example
 * ```ts
 * const authorRel = one("user", { local: "authorId", foreign: "id" });
 * ```
 */
export function one<const Entity extends string>(
  entityName: Entity,
  options: Omit<DbRelationship, "entity" | "kind">,
): DbRelationship<"one", Entity> {
  return relationshipHelpers.one(entityName, options);
}

/**
 * Build a `many` relationship outside of an `entity(...)` declaration. Most
 * callers should use the `api.many(...)` helper inside the `relationships`
 * factory — this top-level function is for cases where the relationship is
 * constructed dynamically.
 *
 * @example
 * ```ts
 * const commentsRel = many("comment", { local: "id", foreign: "postId" });
 * ```
 */
export function many<const Entity extends string>(
  entityName: Entity,
  options: Omit<DbRelationship, "entity" | "kind">,
): DbRelationship<"many", Entity> {
  return relationshipHelpers.many(entityName, options);
}

/**
 * Build a schema-driven "field reference" string. Useful for typed action
 * `affects` and `pending.field` integrations. The returned value is the
 * literal field name; the type system carries the name through generics.
 *
 * @typeParam Name - the literal field name. Inferred from the argument.
 */
export function field<const Name extends string>(name: Name): Name {
  return name;
}

/**
 * Alias of {@link field}. Use `ref(...)` for relationship references and
 * `field(...)` for plain field references; both return the literal name
 * string.
 *
 * @typeParam Name - the literal field name. Inferred from the argument.
 */
export function ref<const Name extends string>(name: Name): Name {
  return name;
}

/**
 * Tag a literal field name as an index. Currently informational — index
 * declarations live on the entity itself, and this helper is reserved for
 * future use by schema pre-processors.
 *
 * @typeParam Name - the literal field name. Inferred from the argument.
 */
export function index<const Name extends string>(name: Name): Name {
  return name;
}

/**
 * Tag a literal field name as a unique constraint. Reserved for future use
 * by schema pre-processors that want to surface uniqueness to generated
 * actions.
 *
 * @typeParam Name - the literal field name. Inferred from the argument.
 */
export function unique<const Name extends string>(name: Name): Name {
  return name;
}

/**
 * Create a Standard Schema that performs no validation. Useful for
 * prototyping, internal-only entities, and cases where the runtime shape
 * is already trusted. The phantom `types` field carries `Value` through
 * the type system so `EntityOutput` and `EntityInput` resolve to
 * `Value`.
 *
 * @typeParam Value - the entity shape. Inferred from the type argument.
 * @returns a `StandardSchemaV1<unknown, Value>` that accepts any input and
 *   casts it to `Value`.
 *
 * @example
 * ```ts
 * const user = entity(passthrough<{ id: string; name: string }>(), { key: "id" });
 * type User = InferEntityOutput<typeof user>; // { id: string; name: string }
 * ```
 */
export function passthrough<Value>(): StandardSchemaV1<unknown, Value> {
  return {
    "~standard": {
      version: 1,
      vendor: "tanstackstart-db",
      validate: (value: unknown) => ({ value: value as Value }),
      types: undefined as unknown as { input: Value; output: Value },
    },
  };
}
