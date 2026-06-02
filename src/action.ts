import { createOptimisticCache, type OptimisticCache } from "./cache.ts";
import type { DbCollections } from "./collection.ts";
import { DbAuthError } from "./errors.ts";
import { createDbActionSubmission, type DbActionSubmission } from "./transaction.ts";
import { createOptimisticAction, type Transaction } from "@tanstack/db";

/**
 * The context passed to every action lifecycle hook (`optimistic`, `run`,
 * `invalidate`, `authorize`, `onSuccess`, `onError`, `onSettled`).
 *
 * - `input` is the parsed input, after the `input` validator ran.
 * - `cache` is the {@link OptimisticCache} for memory-adapter entities.
 *   Native collection mutations should go through `db.collections.*.update(...)`
 *   instead of `cache`, so the underlying TanStack DB transaction can be
 *   surfaced on the submission.
 * - `setTransaction` should be called by the `run` callback when it
 *   produces a TanStack DB transaction, so the submission's `transaction`
 *   field can reflect it.
 *
 * @typeParam Input - the action's parsed input type.
 */
export interface ActionContext<Input> {
  readonly input: Input;
  readonly cache: OptimisticCache;
  setTransaction(transaction: Transaction | undefined): void;
}

/**
 * A composable action definition. Pass one to `createAction(...)` to obtain
 * a callable {@link DbAction}. Every field is optional except `run`.
 *
 * @typeParam Input - the action input type. Inferred from the validator or
 *   the `run` callback.
 * @typeParam Result - the action result type. Inferred from the `run`
 *   callback.
 *
 * @example
 * ```ts
 * const likePost: ActionDefinition<{ postId: string }, number> = {
 *   authorize: ({ input }) => input.postId.startsWith("post_"),
 *   run: ({ input, setTransaction }) => {
 *     const result = db.collections.post.update(input.postId, (current) => ({
 *       ...current,
 *       likes: current.likes + 1,
 *     }));
 *     setTransaction(result.transaction);
 *     return result.value.likes;
 *   },
 *   onSuccess: (likes) => console.log("likes is now", likes),
 * };
 * ```
 */
export interface ActionDefinition<Input, Result> {
  /** Optional input validator. Receives the raw input and returns the
   * parsed input. */
  readonly input?: (input: Input) => Input;
  /** Optional list of queries affected by this action. Used by the route
   * builder to mark dependent specs as pending while the action runs. */
  readonly affects?: (context: ActionContext<Input> & { readonly q: unknown }) => unknown;
  /** Optional optimistic overlay for native collections. Runs synchronously
   * inside the TanStack DB transaction. */
  readonly optimistic?: (context: ActionContext<Input>) => void;
  /** Optional optimistic overlay for the memory adapter. Use this when you
   * want optimistic state to fall back to the in-memory cache on
   * `localOnlyCollectionOptions`-backed entities. */
  readonly optimisticLocal?: (context: ActionContext<Input>) => void;
  /** The action's main work. May be async. */
  readonly run: (context: ActionContext<Input>) => Result | Promise<Result>;
  /** Optional post-success invalidation hook. */
  readonly invalidate?: (context: ActionContext<Input>) => unknown;
  /** Optional authorization gate. Returning `false` (or a promise
   * resolving to `false`) throws a {@link DbActionError}. */
  readonly authorize?: (context: ActionContext<Input>) => boolean | Promise<boolean>;
  /** Optional post-success hook. Receives the resolved result. */
  readonly onSuccess?: (result: Result, context: ActionContext<Input>) => void | Promise<void>;
  /** Optional post-error hook. Receives the thrown error. */
  readonly onError?: (error: unknown, context: ActionContext<Input>) => void | Promise<void>;
  /** Optional post-settled hook. Runs after `onSuccess` or `onError`. */
  readonly onSettled?: (context: ActionContext<Input>) => void | Promise<void>;
}

/**
 * A submission record stored in {@link ActionTracker.submissions}. Extends
 * {@link DbActionSubmission} with internal timing and metadata used by
 * `db.pending` and `db.submissions`.
 *
 * @typeParam Input - the action input type.
 * @typeParam Result - the action result type.
 */
export interface Submission<Input = unknown, Result = unknown> extends DbActionSubmission<
  Input,
  Result
> {
  readonly startedAt: number;
  affected?: unknown;
  completedAt?: number;
  error?: unknown;
}

/**
 * A registry of live-query loading predicates. Each registered predicate
 * reports whether its native collection is still loading its first result.
 * `pending.query(name)` returns `true` while any registered predicate whose
 * key includes `name` reports `true`.
 */
export interface LiveQueryTracker {
  /** Register a loading predicate for a query key. Returns an unregister
   * function the caller must invoke when the subscription tears down. */
  register(key: ReadonlyArray<unknown>, isLoading: () => boolean): () => void;
  /** `true` if any registered predicate whose key includes `name` is
   * currently loading. */
  isLoading(name: string): boolean;
  /** The total number of registered predicates across all keys. */
  size(): number;
}

/**
 * The internal tracker that backs `db.pending` and `db.submissions`. Holds
 * the in-flight submission set, the per-action-name submission history,
 * and the {@link LiveQueryTracker} registry.
 */
export interface ActionTracker {
  readonly pending: Set<Submission>;
  readonly submissions: Map<string, Submission[]>;
  readonly liveQueries: LiveQueryTracker;
}

/**
 * Create a fresh {@link ActionTracker}. Used internally by
 * `createStartDb(...)`; tests can also use this to drive `db.pending` and
 * `db.submissions` against hand-built submissions.
 */
export function createActionTracker(): ActionTracker {
  const registry = new Map<ReadonlyArray<unknown>, Set<() => boolean>>();
  let predicateCount = 0;
  const liveQueries: LiveQueryTracker = {
    register: (key, isLoading) => {
      let set = registry.get(key);
      if (!set) {
        set = new Set();
        registry.set(key, set);
      }
      set.add(isLoading);
      predicateCount += 1;
      return () => {
        if (set && set.delete(isLoading)) {
          predicateCount -= 1;
          if (set.size === 0) {
            registry.delete(key);
          }
        }
      };
    },
    isLoading: (name) => {
      for (const [key, set] of registry) {
        if (!key.includes(name)) continue;
        for (const isLoading of set) {
          if (isLoading()) return true;
        }
      }
      return false;
    },
    size: () => predicateCount,
  };
  return { pending: new Set(), submissions: new Map(), liveQueries };
}

/**
 * A composable, callable action. The function call returns a
 * {@link DbActionSubmission} immediately and runs the action asynchronously.
 * The chainable methods (`.with(...)`, `.affects(...)`, `.optimistic(...)`,
 * etc.) return a new action with the additional field set, leaving the
 * original untouched.
 *
 * @typeParam Input - the action input type. Defaults to `void` for actions
 *   that take no input.
 * @typeParam Result - the action result type. Defaults to `void`.
 *
 * @example
 * ```ts
 * const likePost = createAction(
 *   {
 *     run: ({ input, setTransaction }) => {
 *       const result = db.collections.post.update(input.postId, (current) => ({
 *         ...current,
 *         likes: current.likes + 1,
 *       }));
 *       setTransaction(result.transaction);
 *       return result.value;
 *     },
 *   },
 *   { collections: db.collections, tracker: db.tracker, name: "post.like" },
 * );
 *
 * const submission = likePost({ postId: "post_1" });
 * await submission.persisted;
 * ```
 */
export interface DbAction<Input = void, Result = void> {
  (input: Input): DbActionSubmission<Input, Result>;
  /** The stable action name (e.g. `"post.like"`). Set by the route
   * builder or by `__setActionName(...)`. */
  readonly actionName?: string;
  __setActionName(name: string): void;
  /** Bind a subset of the input. Returns a new action whose required input
   * is the keys of `Input` minus the bound keys. */
  with<Bound extends Partial<Input>>(input: Bound): DbAction<Omit<Input, keyof Bound>, Result>;
  /** Merge additional {@link ActionDefinition} fields into a new action. */
  extend(extension: Partial<ActionDefinition<Input, Result>>): DbAction<Input, Result>;
  /** Replace the input validator. The new validator's input type becomes
   * the new action's `Input`. */
  input<NextInput>(validator: (input: NextInput) => NextInput): DbAction<NextInput, Result>;
  /** Set the `affects` factory. */
  affects(
    factory: NonNullable<ActionDefinition<Input, Result>["affects"]>,
  ): DbAction<Input, Result>;
  /** Set the `optimistic` overlay. */
  optimistic(
    handler: NonNullable<ActionDefinition<Input, Result>["optimistic"]>,
  ): DbAction<Input, Result>;
  /** Reserved for future view-typed return narrowing. Currently returns
   * the same action. */
  returns<View>(_view: View): DbAction<Input, Result>;
  /** Set the `invalidate` hook. */
  invalidate(
    factory: NonNullable<ActionDefinition<Input, Result>["invalidate"]>,
  ): DbAction<Input, Result>;
  /** Set the `authorize` gate. */
  authorize(
    handler: NonNullable<ActionDefinition<Input, Result>["authorize"]>,
  ): DbAction<Input, Result>;
  /** Set the `onSuccess` hook. */
  onSuccess(
    handler: NonNullable<ActionDefinition<Input, Result>["onSuccess"]>,
  ): DbAction<Input, Result>;
  /** Set the `onError` hook. */
  onError(
    handler: NonNullable<ActionDefinition<Input, Result>["onError"]>,
  ): DbAction<Input, Result>;
  /** Set the `onSettled` hook. */
  onSettled(
    handler: NonNullable<ActionDefinition<Input, Result>["onSettled"]>,
  ): DbAction<Input, Result>;
}

/**
 * The error type thrown by failed actions. Wraps the original cause
 * (any thrown value, including non-Error values) so callers can
 * distinguish user code from framework code with
 * {@link isDbActionError}.
 *
 * @example
 * ```ts
 * try {
 *   await likePost({ postId: "post_1" });
 * } catch (error) {
 *   if (isDbActionError(error)) {
 *     console.error("Action failed:", error.cause);
 *   }
 * }
 * ```
 */
export class DbActionError extends Error {
  readonly name = "DbActionError";
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
  }
}

/** Type-guard for {@link DbActionError}. */
export function isDbActionError(error: unknown): error is DbActionError {
  return error instanceof DbActionError;
}

export function createAction<Input, Result>(
  definition: ActionDefinition<Input, Result>,
  options: {
    readonly collections: DbCollections;
    readonly tracker: ActionTracker;
    name?: string;
    readonly boundInput?: Partial<Input>;
    readonly q?: unknown;
  },
): DbAction<Input, Result> {
  const invoke = (providedInput: Input): DbActionSubmission<Input, Result> => {
    const mergedInput =
      options.boundInput === undefined
        ? providedInput
        : ({
            ...options.boundInput,
            ...(typeof providedInput === "object" && providedInput !== null ? providedInput : {}),
          } as Input);
    const input = definition.input?.(mergedInput) ?? mergedInput;
    const cache = createOptimisticCache(options.collections);
    let transaction: Transaction | undefined;
    const context: ActionContext<Input> = {
      input,
      cache,
      setTransaction: (nextTransaction) => {
        transaction = nextTransaction;
      },
    };
    const affected = definition.affects?.({
      ...context,
      q: options.q,
    });

    let submission: Submission<Input, Result>;
    const executeRun = async (acceptMutations?: () => void): Promise<Result> => {
      try {
        const result = await definition.run(context);
        await definition.invalidate?.(context);
        acceptMutations?.();
        cache.commit();
        return result;
      } catch (error) {
        cache.rollback();
        throw error instanceof DbActionError ? error : new DbActionError("Action failed.", error);
      }
    };
    const dbSubmission = createDbActionSubmission<Input, Result>({
      input,
      getTransaction: () => transaction,
      run: async () => {
        try {
          if (definition.authorize && !(await definition.authorize(context))) {
            throw new DbActionError("Action authorization failed.", new DbAuthError());
          }
          if (
            hasNativeCollection(options.collections) &&
            (definition.optimistic || definition.optimisticLocal)
          ) {
            let result: Result | undefined;
            const mutate = createOptimisticAction<Input>({
              onMutate: () => {
                definition.optimistic?.(context);
                definition.optimisticLocal?.(context);
              },
              mutationFn: async (_input, { transaction: nativeTransaction }) => {
                result = await executeRun(() =>
                  acceptNativeMutations(options.collections, nativeTransaction),
                );
              },
            });
            const nativeTransaction = mutate(input);
            context.setTransaction(nativeTransaction);
            await nativeTransaction.isPersisted.promise;
            return result as Result;
          }
          definition.optimistic?.(context);
          definition.optimisticLocal?.(context);
          return executeRun();
        } catch (error) {
          cache.rollback();
          throw error instanceof DbActionError ? error : new DbActionError("Action failed.", error);
        }
      },
      onError: (error) => {
        submission.error = error;
        void Promise.resolve(definition.onError?.(error, context)).catch(() => {});
      },
      onSettled: () => {
        submission.completedAt = Date.now();
        options.tracker.pending.delete(submission);
        void Promise.resolve(definition.onSettled?.(context)).catch(() => {});
      },
    });
    submission = Object.assign(dbSubmission, {
      startedAt: Date.now(),
      affected,
    });
    options.tracker.pending.add(submission);
    if (options.name) {
      const submissions = options.tracker.submissions.get(options.name) ?? [];
      submissions.push(submission);
      options.tracker.submissions.set(options.name, submissions);
    }

    dbSubmission.persisted.catch(() => {});
    void dbSubmission.result
      .then((result) => definition.onSuccess?.(result, context))
      .catch(() => {
        // The result promise remains the action's error surface.
      });
    return dbSubmission;
  };

  const derive = <NextInput, NextResult>(
    nextDefinition: ActionDefinition<NextInput, NextResult>,
    extra: { readonly boundInput?: Partial<NextInput> } = {},
  ) =>
    createAction(nextDefinition, {
      collections: options.collections,
      tracker: options.tracker,
      name: options.name,
      boundInput: options.boundInput as Partial<NextInput> | undefined,
      q: options.q,
      ...extra,
    });

  const action = Object.assign(invoke, {
    __setActionName: (name: string) => {
      options.name = name;
    },
    with: <Bound extends Partial<Input>>(input: Bound) =>
      derive(definition, {
        boundInput: { ...options.boundInput, ...input },
      }) as unknown as DbAction<Omit<Input, keyof Bound>, Result>,
    extend: (extension: Partial<ActionDefinition<Input, Result>>) =>
      derive({ ...definition, ...extension }),
    input: <NextInput>(validator: (input: NextInput) => NextInput) =>
      derive({ ...definition, input: validator } as unknown as ActionDefinition<NextInput, Result>),
    affects: (affects: NonNullable<ActionDefinition<Input, Result>["affects"]>) =>
      derive({ ...definition, affects }),
    optimistic: (optimistic: NonNullable<ActionDefinition<Input, Result>["optimistic"]>) =>
      derive({ ...definition, optimistic }),
    returns: <View>(_view: View) => derive(definition),
    invalidate: (invalidate: NonNullable<ActionDefinition<Input, Result>["invalidate"]>) =>
      derive({ ...definition, invalidate }),
    authorize: (authorize: NonNullable<ActionDefinition<Input, Result>["authorize"]>) =>
      derive({ ...definition, authorize }),
    onSuccess: (onSuccess: NonNullable<ActionDefinition<Input, Result>["onSuccess"]>) =>
      derive({ ...definition, onSuccess }),
    onError: (onError: NonNullable<ActionDefinition<Input, Result>["onError"]>) =>
      derive({ ...definition, onError }),
    onSettled: (onSettled: NonNullable<ActionDefinition<Input, Result>["onSettled"]>) =>
      derive({ ...definition, onSettled }),
  }) as unknown as DbAction<Input, Result>;
  Object.defineProperty(action, "actionName", {
    get: () => options.name,
  });
  return action;
}

function hasNativeCollection(collections: DbCollections): boolean {
  return Object.values(collections).some((collection) => collection.engine);
}

function acceptNativeMutations(collections: DbCollections, transaction: Transaction): void {
  const accepted = new Set<object>();
  for (const collection of Object.values(collections)) {
    const engine = collection.engine;
    if (!engine || accepted.has(engine)) continue;
    accepted.add(engine);
    const acceptMutations = (
      engine.utils as { acceptMutations?: (transaction: Transaction) => void }
    ).acceptMutations;
    acceptMutations?.(transaction);
  }
}

export type InferDbActionInput<Action extends DbAction> =
  Action extends DbAction<infer Input, unknown> ? Input : never;

export type InferDbActionResult<Action extends DbAction> =
  Action extends DbAction<unknown, infer Result> ? Result : never;
