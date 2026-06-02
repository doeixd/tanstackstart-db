import type { Transaction } from "@tanstack/db";

/** Lifecycle status of an action submission.
 *
 * - `"pending"` — the action has been called but `run` has not started.
 * - `"persisting"` — `run` is executing; the native transaction (if any)
 *   has not yet committed.
 * - `"completed"` — `run` resolved; the result promise has settled.
 * - `"failed"` — `run` threw; the result and persisted promises reject.
 */
export type DbActionStatus = "pending" | "persisting" | "completed" | "failed";

/**
 * The observable return value of a {@link DbAction} call. The submission is
 * returned synchronously and remains "pending" until the action's `run`
 * callback begins, then transitions to "persisting", "completed", or
 * "failed". The submission is thenable so `await action(input)` keeps
 * working as before.
 *
 * - `input` is the parsed input (after the `input` validator ran).
 * - `transaction` is the native TanStack DB transaction, when the action
 *   went through `createOptimisticAction(...)` or produced a transaction
 *   via `setTransaction(...)`.
 * - `persisted` resolves when the native transaction (or, for memory
 *   collections, the undo records) has been committed; rejects if the
 *   action threw.
 * - `result` resolves with the action's return value, or rejects with the
 *   thrown error.
 * - `status` is the current {@link DbActionStatus}.
 *
 * @typeParam Input - the action input type.
 * @typeParam Result - the action result type.
 *
 * @example
 * ```ts
 * const submission = likePost({ postId: "post_1" });
 * submission.status; // "pending" | "persisting"
 * await submission.persisted;
 * submission.status; // "completed" | "failed"
 * const value = await submission; // Result, or throws
 * ```
 */
export interface DbActionSubmission<Input, Result> {
  readonly input: Input;
  readonly transaction?: Transaction;
  readonly persisted: Promise<void>;
  readonly result: Promise<Result>;
  readonly status: DbActionStatus;
  then<TResult1 = Result, TResult2 = never>(
    onfulfilled?: ((value: Result) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2>;
}

/** Options for {@link createDbActionSubmission}. Used internally by
 * `createAction`; library users typically receive submissions from action
 * calls rather than constructing them by hand. */
export interface CreateSubmissionOptions<Input, Result> {
  readonly input: Input;
  /** Lazy accessor for the native transaction. Read by the `transaction`
   * getter so the value is captured at the latest possible moment. */
  readonly getTransaction?: () => Transaction | undefined;
  readonly run: () => Result | Promise<Result>;
  readonly onError?: (error: unknown) => void;
  readonly onSettled?: () => void;
}

/** Build a {@link DbActionSubmission}. The `run` callback is invoked
 * inside a microtask so `status` transitions to `"persisting"` before any
 * user code observes it. */
export function createDbActionSubmission<Input, Result>({
  input,
  getTransaction,
  run,
  onError,
  onSettled,
}: CreateSubmissionOptions<Input, Result>): DbActionSubmission<Input, Result> {
  let resolveResult: ((value: Result) => void) | undefined;
  let rejectResult: ((error: unknown) => void) | undefined;
  const resultPromise = new Promise<Result>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  let resolvePersisted: (() => void) | undefined;
  let rejectPersisted: ((error: unknown) => void) | undefined;
  const persistedPromise = new Promise<void>((resolve, reject) => {
    resolvePersisted = resolve;
    rejectPersisted = reject;
  });

  let currentStatus: DbActionStatus = "pending";

  void Promise.resolve()
    .then(() => {
      currentStatus = "persisting";
      return run();
    })
    .then(
      (value) => {
        currentStatus = "completed";
        resolveResult?.(value);
        resolvePersisted?.();
        onSettled?.();
      },
      (error: unknown) => {
        currentStatus = "failed";
        rejectResult?.(error);
        rejectPersisted?.(error);
        onError?.(error);
        onSettled?.();
      },
    );

  return {
    input,
    get transaction() {
      return getTransaction?.();
    },
    persisted: persistedPromise,
    result: resultPromise,
    get status() {
      return currentStatus;
    },
    // oxlint-disable-next-line unicorn/no-thenable
    then(onfulfilled, onrejected) {
      return resultPromise.then(onfulfilled, onrejected);
    },
  };
}

/** Type-guard for {@link DbActionSubmission}. Useful when an action is
 * passed across a function boundary and the caller wants to confirm the
 * returned value carries the submission contract. */
export function isDbActionSubmission<Input, Result>(
  value: unknown,
): value is DbActionSubmission<Input, Result> {
  return (
    typeof value === "object" &&
    value !== null &&
    "persisted" in value &&
    "result" in value &&
    "status" in value
  );
}
