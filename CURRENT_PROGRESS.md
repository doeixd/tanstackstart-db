# Current Progress

## Status

Implementation started on 2026-06-01. The repository began as a Vite+ TypeScript
package starter with one placeholder export.

## Completed

- [x] Ran `vp install`.
- [x] Reviewed `GOAL.md`, package configuration, and starter files.
- [x] Created package module scaffolding and public entrypoints.
- [x] Implemented the first framework-neutral core slice:
      schema definitions, Standard Schema typing, memory collections, view masking,
      composable query specs, generated CRUD actions, reusable custom actions,
      `.with(...)` binding, `.extend(...)` local overrides, optimistic rollback,
      pending/submission tracking, and hydration snapshots.
- [x] Added `@tanstack/db` and switched schema-generated collections to a
      TanStack DB-backed local-only adapter.
- [x] Added Standard Schema mutation validation and configured persistence
      callbacks for generated CRUD actions.
- [x] Pass each entity Standard Schema through to the generated TanStack DB
      local-only collection so direct native mutations also receive official
      schema validation, defaults, and transforms. Strip TanStack DB
      `$`-prefixed virtual metadata at the adapter `get()` / `values()`
      boundary so cache and hydration helpers only see entity data.
- [x] Deep-merge custom action namespaces with generated CRUD namespaces and
      assign stable custom action names for submissions.
- [x] Keep custom and derived action `actionName` values live after namespace
      merging, and adapt route pending/submission APIs so exposed aliases such
      as `"likePost"` resolve canonical actions such as `"post.like"`.
- [x] Evaluate reusable action `affects(...)` metadata and invoke
      `invalidate(...)` after successful runs.
- [x] Generate concise index helpers such as `byPost(...)` from `postId`
      indexes and executable relationship queries from schema relationships.
- [x] Track pending fields from evaluated affected query specs.
- [x] Preserve literal schema indexes and relationships in generated query
      helper types, so helpers such as `q.comment.byPost(...)` type-check.
- [x] Accept externally supplied collection adapters through
      `queryCollection(..., { collection })`.
- [x] Add `nativeCollection(key, engine, options?)` for pre-created official
      TanStack DB collections, including entity-specific adapter inference and
      an intentional broad-record escape hatch. Generated CRUD actions and
      native query specs operate on these adapters without recreating their
      sync engine.
- [x] Make hydration explicit for external native adapters: they are excluded
      from `dehydrateDb(...)` snapshots by default and can opt in with
      adapter-provided `dehydrate(engine)` / `hydrate(engine, values)` hooks.
- [x] Add an isolated optional `./query-collection` entrypoint that wraps the
      official `queryCollectionOptions(...)`, passes through entity schemas,
      derives keys from schema metadata, compiles convenience persistence
      handlers, and serializes confirmed state through adapter-specific hooks.
- [x] Added initial server and testing entrypoints.
- [x] Make `createMemoryStartDb(schema)` construct actual engine-free
      `MemoryCollection` adapters so tests deliberately exercise in-memory
      query execution and rollback fallbacks.
- [x] Added an initial typed React route-builder entrypoint.
- [x] Add `@tanstack/react-router` as an optional peer-backed React entrypoint
      dependency and compile fluent DB route builders to official
      `createFileRoute(path)(options)` routes via `.build()`. The builder now
      accumulates `.queries()` / `.views()`, `.actions()`, components,
      boundaries, `.validateSearch()`, `.beforeLoad()`, and `.loaderDeps()`;
      exposes a testable `.load(...)`; and includes typed `useQuery(name)`.
- [x] Add Router loader semantics for `.defer()`, `.preloadOnly()`, and
      `hydrate: "route"`. Deferred specs remain unresolved promises in loader
      data, preload-only specs execute without becoming component data, and
      route hydration loaders include confirmed DB snapshots while hooks keep
      exposing flat route data.
- [x] Retain native live deferred route specs after their initial promise
      resolves. Deferred handles expose the latest `current` value and
      `dispose()`, route reloads replace retained resources, compiled route
      components clean them up on unmount, and loader-only consumers can call
      builder `.dispose()` explicitly.
- [x] Expose the underlying `@tanstack/db` `Collection<Value, EntityId>` on the
      `DbCollection` adapter so generated query specs can compile to native
      query-builder functions.
- [x] Compile generated query specs to TanStack DB query-builder functions and
      execute them with `queryOnce(...)`; fall back to the in-memory executor
      when a collection has no native engine (e.g. `MemoryCollection`).
- [x] Implement live query subscriptions through `createLiveQueryCollection(...)`
      with `subscribeChanges` and `preload()`-driven initial emission; the
      cleanup callback unsubscribes the change feed and tears the live
      collection down.
- [x] Compile simple `db.view()` selections (no nested relationship views) into
      native TanStack DB `select` projections at `.as(View)` time via
      `compileViewSelect(view, rowAlias)` and a per-spec `QueryBuild` factory;
      strip TanStack DB's internal `$`-prefixed virtual props from the result
      so the user receives only the selected, readonly component data.
- [x] Execute and subscribe to native `db.q.raw({ key, query })` escape-hatch
      specs through the same `queryOnce(...)` and live-query collection
      pipeline used by generated query helpers.
- [x] Surface React live-query hooks in `src/react.ts`:
      `useDbLiveQueryState(spec)` returns a discriminated
      `loading | ready | error` state; `useDbLiveQuery(spec)` returns the
      current value (or `undefined` while loading). Both use
      `useSyncExternalStore` and a stable `useCallback` so the subscription
      is only set up once per mount.
- [x] Add `useDbLiveSuspenseQuery(spec)` with a render-phase shared resource
      cache scoped by the native collection and query key. It starts the live
      subscription before the component commits, wakes Suspense after preload,
      streams later updates, isolates identical keys across DB instances, and
      releases retained collections after unmount.
- [x] Add `DbProvider` and context-backed zero-argument React hooks:
      `useDb()`, `useDbCollections()`, `useDbPending()`, and
      `useDbSubmissions()`. Existing explicit DB arguments remain supported.
- [x] Make `useDbStatus()` context-backed, allow `DbProvider` to provide
      explicit status, and provide derived route status to nested route
      component descendants.
- [x] Implement first-pass `createDbComponent(View)` helpers for typed static
      view components and action-aware components with context-backed actions,
      pending state, submissions, and status.
- [x] Add DB-bound `createDbComponent(db).props<Props>().views(...).render(...)`
      helpers for component-owned live queries. Query maps use an aggregate
      Suspense resource so subscriptions start during render, stream updates,
      and clean up after the component unmounts.
- [x] Add relationship-aware nested views: schema relationship names are
      accepted as typed `db.view(...)` selection keys, nested views are checked
      against relationship targets at definition time, and `.as(View)`
      materializes masked nested `one` and `many` results from registered
      collections after native query execution. Nested live views subscribe to
      referenced relationship collections and re-emit when related rows change.
- [x] Return observable `DbActionSubmission` thenables immediately from action
      calls while preserving `await action(...)`. Generated CRUD submissions
      expose the native TanStack DB mutation transaction and wait for its
      `isPersisted.promise`.
- [x] Compile reusable custom `optimistic(...)` / `optimisticLocal(...)`
      handlers through TanStack DB `createOptimisticAction(...)` whenever a
      native collection is present. Confirm local-only writes with
      `engine.utils.acceptMutations(...)` after persistence succeeds, expose
      the native transaction on the submission, and retain package undo records
      only for memory-adapter mutations.
- [x] Add adapter-level confirmed-state dehydration for generated TanStack
      collections. `dehydrateDb(...)` uses `confirmedValues()` when available,
      preventing pending optimistic overlays from being serialized as confirmed
      hydration state.
- [x] Enforce `.required()` query specs during static execution and live
      emissions by raising `DbNotFoundError` for nullish results.
- [x] Run `vp check`, `vp test`, and `vp run build`.

## Current Focus

Realign the prototype action and query runtimes with the implementation-grounded
TanStack DB architecture documented in `GOAL.md`.

## Remaining Work

### Native query compilation (in progress)

- [x] Compile `byId`, `all`, `byIndex`, and relationship (`one`/`many`) specs
      to native TanStack DB query-builder functions.
- [x] Execute compiled specs through `queryOnce(...)` and
      `createLiveQueryCollection(...)` with cardinality and live-mode mapping.
- [x] Chain `select(...)` and `as(View)` through the native pipeline and
      project results with `pickView` at execute time.
- [x] Compile simple `db.view()` selections (no nested relationship views) into
      native `select` projections and strip internal virtual props.
- [x] Surface `useDbLiveQuery` / `useDbLiveQueryState` React hooks backed by
      the compiled native live-query collections.
- [x] Add a first-pass `createDbActionSubmission` / `DbActionSubmission`
      wrapper that exposes the GOAL.md action result contract
      (`transaction`, `persisted`, `result`, `status`, thenable). Actions now
      return this wrapper immediately, generated CRUD submissions retain the
      transaction returned by native collection mutations, and their
      `persisted` promise waits for `transaction.isPersisted.promise`.
- [x] Keep the existing `OptimisticCache` undo layer for in-memory
      collections. `cache.post(id).patch(...)` now routes through
      `collection.update(...)` (instead of `collection.insert(...)`) so it
      no longer trips `DuplicateKeyError` when patching an existing row, and
      `cache.rollback()` reverts via the recorded undo operations.
- [x] Wire the `submit` pipeline so the action's `run` callback throws a
      `DbActionError` (or wraps unknown errors as `DbActionError("Action failed.", cause)`),
      the cache rolls back, the submission resolves to `"failed"`, and
      `dbSubmission.persisted` is also rejected. The `invoke` function
      attaches a no-op `.catch(() => {})` to `persisted` so the failure
      surfaces through `await action(...)` without triggering an unhandled
      rejection warning from Vitest.
- [x] Materialize relationship `one`/`many` nested view projections after
      native query execution, so a view like
      `{ id: true, title: true, author: UserCardView }` produces the expected
      masked result for static execution.
- [x] Compile nested relationship projections into native TanStack DB joins
      rather than materializing them after query execution. The current layer
      keeps native source filtering and execution and retains relationship
      collection subscriptions so related writes re-emit nested live results.
- [x] Add a Suspense-aware `useDbLiveSuspenseQuery` hook backed by a shared,
      render-phase subscription cache keyed by native query scope and
      `spec.key()`.
- [x] Expose native `db.q.raw(...)` query-builder escape-hatch specs.
- [x] Add a generic `nativeCollection(...)` wrapper for externally configured
      TanStack DB collections and sync engines.
- [x] Add optional-package convenience sugar for Query Collection through an
      isolated `./query-collection` entrypoint.
- [x] Add optional-package convenience sugar for other engine-specific
      adapters. `localStorageCollection` (in `./local-storage-collection`)
      wraps `localStorageCollectionOptions` with `mutations: { insert, update, delete }`
      sugar and a storage-driven dehydrate snapshot; `syncCollection` (in
      `./sync-collection`) accepts any pre-created `Collection<Value, TKey>`
      engine and lets users override `dehydrate` / `hydrate` for adapter
      semantics like Electric or PowerSync. Both are wired into the
      `createStartDbFromSchema` `collections` factory.
- [x] Wire reusable custom optimistic actions through
      `createOptimisticAction(...)` and expose their native transactions while
      preserving memory-adapter rollback records.
- [x] Track pending query refresh state for active live query subscriptions.
      `ActionTracker` now exposes a `LiveQueryTracker` registry; generated
      query specs register their native live collections on `subscribe()`,
      the registry keeps the entry live until the cleanup callback fires,
      and `pending.query(name)` returns `true` while any matching entry is
      still loading.

### Other slices

- [x] Add a first-class generic wrapper for externally configured TanStack DB
      collections and sync engines.
- [x] Add optional-package convenience sugar for Query Collection.
- [x] Replace the native-collection custom-action rollback path with TanStack DB
      `createOptimisticAction(...)` transactions while retaining the memory
      adapter fallback.
- [x] Track pending query refresh state beyond affected-query metadata.
- [x] Implement a first Router-backed route loading compiler via `.load(...)`
      and `.build()`.
- [x] Integrate first-pass route hydration snapshots and deferred loader data.
- [x] Resolve route action aliases for pending and submission lookups.
- [x] Add first-pass route status and client hydration wiring.
- [x] Add adapter-derived route refetch/stale status through neutral collection
      status hooks and the official Query Collection utilities.
- [x] Expand fixtures, render helpers, server handlers, tests, and README docs. - Upgraded `src/testing.ts` from stubs to real render helpers
      (`renderDbRoute` driving the route's `load(...)`, `renderDbComponent`
      using `react-dom/server`, plus `waitFor`, `flushMicrotasks`,
      `seedCollections`, `listFixture`, `mockDbAction` returning a real
      `DbActionSubmission`, and `createMemoryStartDb`). - Added 8 new tests for the testing helpers and a type-level inference
      test that exercises `InferEntity` / `InferView` / `InferDbQueryResult`
      at runtime. - Documented every public export in `src/schema.ts`, `src/view.ts`,
      `src/query.ts`, `src/action.ts`, `src/cache.ts`, `src/collection.ts`,
      `src/hydrate.ts`, `src/transaction.ts`, `src/errors.ts`,
      `src/local-storage-collection.ts`, `src/sync-collection.ts`,
      `src/query-collection.ts`, `src/db.ts`, `src/react.ts`, `src/server.ts`,
      and `src/testing.ts` with `@typeParam`, `@param`, `@returns`,
      `@example`, and `@remarks` as appropriate. - Server entry point keeps its thin `createDbServerFn` / `createDbServerHandler`
      shape with full JSDoc; framework-specific server-function integration
      is left to the consumer's chosen framework.

## Notes

- `GOAL.md` is the product design reference.
- TanStack DB integration should remain an adapter boundary: the package adds
  contracts and ergonomics without introducing a competing data engine.
- Audited `GOAL.md` against installed `@tanstack/db` source and current official
  TanStack DB, Router, and Start docs. Added implementation-grounded decisions
  for official collection options, native transactions, live queries, Router
  loaders, Start server functions, adapter-specific hydration, and
  transaction-derived pending state.
- `compileQueryFn(collection, build)` accepts a builder callback that returns a
  TanStack DB `InitialQueryBuilder` closure; the first arg is reserved for
  per-collection type inference. The runtime is intentionally `any`-typed inside
  the builder callback to side-step the deeply generic `QueryBuilder<Context>`
  constraint while keeping the user-facing types driven by the schema.
- `subscribeChanges(...)` returns a `CollectionSubscription` object with an
  `unsubscribe()` method — the cleanup callback in `DbQuerySpec.subscribe(...)`
  must call that method before invoking `cleanup()` on the live collection.
- Each generated spec carries a `QueryBuild` factory (`(view?) => NativeQueryFn`)
  in addition to the resolved `queryBuilder`. `.as(View)` rebuilds the
  `queryBuilder` through that factory so the view is folded into the native
  `select(...)` step before the terminator (`findOne()` or array form).
  `hasNestedViews(view)` gates the native compilation path; views with nested
  relationship selections fall back to the runtime `pickView` projection.
- `stripVirtualProps(...)` recurses through the result returned by
  `queryOnce(...)` and `createLiveQueryCollection(...).values()` to drop the
  internal `$collectionId`, `$key`, `$origin`, `$synced` keys, leaving only the
  user-requested fields.
- Verified after the native query compilation + view projection slice:
  `vp check --fix` and `vp test` pass with 18 tests (10 prior + 8 new covering
  native byId/all/byIndex/relationship execution, live subscription, view
  projection through native `select`, and view projection through the
  relationship join chain).
- Verified after the action-submission-contract slice: `vp check` is clean
  and `vp test` passes 21/21 (unchanged from the previous slice — the
  existing optimistic-rollback test now exercises the new submission
  wrapper and still passes; no new test was added because the wrapper is
  only observable when a real TanStack DB transaction is available, which
  is the next sub-slice).
- Verified after the relationship-aware nested-view slice: `vp check` is clean
  and `vp test` passes 25/25. Added coverage for masked nested `one` and `many`
  results, rejecting unknown or target-mismatched nested relationships, and
  re-emitting a nested live view when its related collection changes. Added
  native `q.raw(...)` execution and subscription coverage.
- Verified after the generated-action transaction and schema pass-through
  slice: `vp check` is clean and `vp test` passes 28/28. Added coverage for
  immediate action submissions with native CRUD transactions, direct engine
  schema defaults, and `.required()` missing-result enforcement.
- Verified after the Suspense live-query slice: `vp check` is clean and
  `vp test` passes 29/29. Added coverage for Suspense wake-up, subsequent live
  updates, and isolation of identical query keys across DB instances.
- Verified after the custom optimistic-action transaction slice: `vp check` is
  clean and `vp test` passes 30/30. Added coverage for visible optimistic state,
  exposed native transaction status, local-only mutation acceptance, and
  persisted optimistic state.
- Verified after the confirmed-state hydration slice: `vp check` is clean and
  `vp test` passes 31/31. Added coverage proving pending optimistic overlays are
  excluded from dehydration snapshots until persistence completes.
- Verified after the external native-adapter slice: `vp check` is clean and
  `vp test` passes 33/33. Added coverage for generated CRUD/query behavior on a
  pre-created official collection, default snapshot exclusion, and explicit
  external hydration hooks.
- Verified after the React context slice: `vp check` is clean and `vp test`
  passes 34/34. Added coverage for resolving DB, collections, pending state,
  and submissions through `DbProvider`.
- Verified after the first Router compiler slice: `vp check` is clean and
  `vp test` passes 35/35. Added coverage for fluent query loading, official
  file-route compilation, Router loader execution, and passthrough route
  options.
- Verified after the Router hydration/deferred slice: `vp check` is clean and
  `vp test` passes 36/36. Added coverage for non-blocking deferred promises,
  preload-only execution, and confirmed route snapshot payloads.
- Verified after the memory testing-helper fix: `vp check` is clean and
  `vp test` passes 37/37. Added coverage proving `createMemoryStartDb(...)`
  uses engine-free fallback queries.
- Verified after the route action-alias slice: `vp check` is clean and
  `vp test` passes 38/38. Added coverage for alias-aware pending state and
  submission lookups, and fixed stale custom `actionName` values.
- Verified after the route status/client hydration slice: `vp check` is clean
  and `vp test` passes 39/39. Added route-scoped critical and deferred loading
  state plus `hydrateDbRoutePayload(...)` and builder `.hydrate(...)` helpers
  for applying route snapshots on the client.
- Verified after the official Query Collection adapter slice: `vp check` is
  clean and `vp test` passes 41/41. Added an isolated `./query-collection`
  entrypoint with schema pass-through, generated key extraction, convenience
  mutation handlers, confirmed-state dehydration, and tested direct-write
  hydration.
- Verified after the adapter-derived route status slice: `vp check` is clean
  and `vp test` passes 42/42. Added neutral collection status hooks, Query
  Collection loading/refetch/stale/error derivation, context-resolved route DB
  tracking, and route-level aggregation.
- Verified after the first component-helper slice: `vp check` is clean and
  `vp test` passes 43/43. Added context-backed `useDbStatus()`, route descendant
  status providers, typed static view components, and action-aware view
  components.
- Verified after the retained deferred live-query slice: `vp check` is clean
  and `vp test` passes 44/44. Added augmented deferred promises with live
  `current` values, explicit disposal, reload replacement, and compiled route
  component unmount cleanup.
- Verified after the component-owned local-query slice: `vp check` is clean
  and `vp test` passes 45/45. Added DB-bound local component view builders,
  typed props staging, aggregate Suspense resources, retained live updates, and
  unmount cleanup.
- Verified after the native-join view-projection slice: `vp check` is clean
  and `vp test` passes 47/47. `buildViewSelectWithJoins(...)` walks the
  view selection and emits left-join clauses for each foldable `one`
  relationship (related collection exposes a native engine). The native
  `select` projection now produces the source fields plus the joined rows;
  `materializeView` recurses with `source[name]` for joined `one` fields and
  still resolves `many` / non-foldable `one` relationships from the
  related collections. `as(View)` now keeps the post-execute
  `materializeView` step in place even on the native path so non-foldable
  fields are filled in after `queryOnce` / `createLiveQueryCollection`.
  Added coverage for foldable `one` joins inside `byId` and `all`
  projections, live re-emit when the joined row or a `many` relationship
  changes, and the post-execute fallback for `one` relationships whose
  related collection has no native engine.
- Verified after the pending query refresh-state slice: `vp check` is clean,
  `vp test` passes 48/48, and `vp run build` is clean. `ActionTracker` now
  exposes a `liveQueries: LiveQueryTracker` registry; generated query specs
  accept the registry through a new `liveQueryTracker` extra, register
  their `preload`-bound loading predicate on `subscribe()`, and unregister
  it in the cleanup callback. `pending.query(name)` now returns `true` while
  any matching entry is still loading, and the local-only engine's
  preload resolves inside a microtask so the predicate flips back to
  `false` by the time the first `onValue` fires. Added coverage proving the
  pending state is `true` synchronously after `subscribe()`, flips to
  `false` after the first emit, and remains `false` after unsubscribe.
- Verified after the README + passthrough helper slice: `vp check` is clean,
  `vp test` passes 49/49, and `vp run build` is clean. Added a typed
  `passthrough<Value>()` Standard Schema helper to `src/schema.ts` for
  unvalidated entity definitions, expanded `README.md` with usage examples
  for schemas, custom collection adapters, view projection, the action
  submission contract, custom optimistic actions, hydration, React hooks,
  route builders, and the Query Collection entrypoint, and added a test
  proving the passthrough helper drives both the action submission contract
  and the standard `q.*` query helpers.
- Verified after the review-pass + `select()` fix slice: `vp check` is clean,
  `vp test` passes 56/56, and `vp run build` is clean. `DbQuerySpec.select(...)`
  now routes through `copy(...)` instead of constructing a fresh spec, so the
  selector is applied once on both the native and in-memory execute paths and
  `viewBuild` / `resolveView` / `subscribeView` / `view` / `liveQueryTracker`
  are preserved for downstream `.as(View)` chaining. Added coverage proving
  `select(selector)` produces the correct projection on `queryOnce` and on
  the in-memory fallback, that `as(View).select(selector)` re-emits when a
  related collection changes, and that the per-spec relationship
  subscription wiring survives `select(...)`.
- Verified after the engine-adapter sugar slice: `vp check` is clean,
  `vp test` passes 59/59, and `vp run build` is clean. Added two isolated
  entrypoints alongside `query-collection.ts`:
  `local-storage-collection.ts` exports a `localStorageCollection(entityName, options)`
  helper that wraps `localStorageCollectionOptions` from `@tanstack/db`,
  adds `mutations: { insert, update, delete }` sugar for forwarding writes
  to a server, and reads the dehydrate snapshot directly from the storage
  API so it matches what the next session would see (including cross-tab
  storage events). `sync-collection.ts` exports a `syncCollection(entityName, options)`
  helper that accepts any pre-created `Collection<Value, TKey>` engine
  (Electric, PowerSync, custom sync engines, etc.) and wraps it in
  `nativeCollection` with optional `dehydrate` / `hydrate` overrides.
  `createStartDbFromSchema` now exposes both helpers in its `collections`
  factory alongside `queryCollection`. Added coverage proving the
  localStorage helper persists generated CRUD through the storage API,
  drives the `mutations` sugar, exposes a storage-driven snapshot, and
  survives a `dehydrateDb` / `hydrateDb` round-trip; and that the
  sync-collection helper exposes a custom `dehydrate` projection and a
  custom `hydrate` callback for cross-DB snapshots.
- Verified after the JSDoc / public-types polish slice: `vp check` is
  clean, `vp test` passes 67/67, and `vp run build` is clean. Every
  public export across `src/schema.ts`, `src/view.ts`, `src/query.ts`,
  `src/action.ts`, `src/cache.ts`, `src/collection.ts`, `src/hydrate.ts`,
  `src/transaction.ts`, `src/errors.ts`,
  `src/local-storage-collection.ts`, `src/sync-collection.ts`,
  `src/query-collection.ts`, `src/db.ts`, `src/react.ts`, `src/server.ts`,
  and `src/testing.ts` now carries a JSDoc block with `@typeParam`,
  `@param`, `@returns`, `@example`, and `@remarks` as appropriate;
  generics on `DbQuerySpec`, `InferDbQueryResult`, `InferEntity`,
  `InferView`, `StartDb`, `QueryCollectionDefinition`,
  `GeneratedEntityActions`, `GeneratedEntityQueries`, `OptimisticCache`,
  `EntityCache`, `SelectedEntityCache`, `NativeCollection`,
  `TanStackCollection`, `MemoryCollection`, `nativeCollection`,
  `createDbActionSubmission`, `DbActionSubmission`, `mockDbAction`,
  `seedCollections`, `useDbLiveQuery`, `useDbLiveSuspenseQuery`, etc.
  infer correctly. Upgraded `src/testing.ts` render helpers from stubs
  to real implementations driving the route's `load(...)` and
  `react-dom/server`. Added 8 new tests covering
  `createMemoryStartDb`, `seedCollections`, `fixture`, `listFixture`,
  `mockDbAction`, `renderDbComponent`, `waitFor`, `flushMicrotasks`,
  and a runtime type-level inference check for `InferEntity` /
  `InferView` / `InferDbQueryResult`.
- [x] Verified after the review-pass + docs slice: `vp check` is clean,
      `vp test` passes 97/97, and `vp run build` is clean. Added the
      `DbConflictError` and `DbOfflineError` classes plus their
      `isDbConflictError` / `isDbOfflineError` type-guards in
      `src/errors.ts`; the `freezeView` deep-freeze helper in
      `src/view.ts`; the `createInfiniteQuery`, `DbInfiniteQuerySpec`,
      `DbInfiniteState`, `InfiniteOptions`, and `isDbInfiniteQuerySpec`
      exports in a new `src/infinite.ts`; and the
      `useDbLiveInfiniteQuery` / `useDbLiveInfiniteSuspenseQuery` React
      hooks plus route-builder integration (infinite specs are attached
      to deferred route data and warmed via `firstPage()`) in
      `src/react.ts`. Fixed a pagination bug where
      `getNextPageParam` returning `null` did not flip `hasNextPage`
      to `false`; the runtime now uses `== null` for both the
      early-out and `hasNextPage` computation. Added 7 new tests
      covering the first-page live subscription, multi-page `loadMore`
      with a `null` cursor terminator, the React hooks, the route
      builder's spec attachment + SSR warming, `freezeView`'s
      deep-freeze contract, the new error type-guards, and
      `actionName` preservation through `.with(...)`, `.extend(...)`,
      and route-level aliasing. Split the review-tied sections of
      `README.md` into detailed deep-dive files under `docs/`
      (`views.md`, `relationships.md`, `pagination.md`,
      `authorization.md`, `optimistic-conflict-offline.md`,
      `action-aliases.md`, `query-keys.md`, plus a `devtools.md`
      placeholder for the v0.2 Devtools surface). The package
      remains pre-stable.
- [x] Verified after the four follow-up slices (auto-affects,
      `db.component` flagship, hydration strategies, docs pass):
      `vp check` is clean, `vp test` passes 106/106, and
      `vp run build` is clean. **Slice 1 — auto-affects for generated
      CRUD**: every generated CRUD action in `src/db.ts` now ships
      with an auto-derived `affects(...)` so `pending.field(entity,
"fieldname")` and `pending.query("entity")` work for free.
      `create` affects `[q.<entity>.all()]`, `patch` affects
      `[q.<entity>.byId(id).field(name)]` for each `name` in
      `changes`, and `update` / `delete` affect `[q.<entity>.byId(id)]`.
      Added 2 new tests in `tests/index.test.ts` proving
      `submission.affected` carries the auto-derived specs and that
      the `pending.field` lookup matches the auto-derived
      `byId(id).field(name)` spec through a parked action. **Slice 2
      — `db.component(View)` flagship**: added a `component` method
      to the `StartDb` interface in `src/db.ts` that mirrors the
      view-bound `createDbComponent(view)` overload. `db.component`
      reads the DB from the call site (via the React context inside
      the builder), so the render callback only needs to receive
      the projected row plus `actions` / `pending` / `status` /
      `submissions`. Added 1 new test exercising both the simple
      form and the `.actions(...).render(...)` chain. `createDbComponent`
      is preserved (it also covers the no-arg and bound-db overloads).
      **Slice 3 — hydration strategies**: added `DbSnapshotMode`
      and `DehydrateDbOptions` to `src/hydrate.ts`; `dehydrateDb` now
      accepts a `snapshot` option that toggles between
      `"confirmed-only"` (default — exclude pending optimistic
      overlays) and `"include-pending-for-debug"` (preserve them for
      SSR / localStorage debugging). Added an optional `dehydrateDebug()`
      method to the `DbCollection` interface (implemented on
      `TanStackCollection` and `MemoryCollection`; `NativeCollection`
      opts in via its existing options). Added `snapshot` to
      `DbRouteDefaults` and forwarded it through the route loader.
      Exported `DbSnapshotMode` and `DehydrateDbOptions` from
      `src/index.ts`. Added 2 new tests proving the debug snapshot
      preserves the in-flight overlay, and that the route builder
      forwards `snapshot: "include-pending-for-debug"` into the SSR
      payload. **Slice 4 — docs pass**: added a "Positioning"
      section to `README.md` with the "not Fate" framing, the
      "TanStack DB power + app-level contracts" positioning, and a
      catalogued escape-hatch surface (`db.q.raw`, `useDb`,
      `useCollections`, `nativeCollection`, `route.useDb`); added a
      "Three levels" section (Level 1: schema to CRUD, Level 2:
      views + components + routes, Level 3: custom actions +
      relationships + adapters + devtools); updated the React
      section to use `db.component(View)` as the flagship view-bound
      builder while keeping the `createDbComponent(db).props<...>()`
      example for component-owned queries; added a "Hydration"
      subsection documenting the snapshot and hydration strategies
      (route / root / manual). Added a new `docs/design.md` covering
      the positioning, the "what this package is not" list, the
      layered architecture diagram, the escape-hatch rationale, the
      "actions own their behavior" principle, the auto-affects
      rationale, the readonly-view guarantee, and the route-owned
      hydration rationale. Added a new section to
      `docs/action-aliases.md` documenting the generated CRUD
      auto-affects, and a new section to
      `docs/optimistic-conflict-offline.md` documenting the snapshot
      strategies. Updated `docs/README.md` to add `design.md` to
      the topic table and the reading order. The package remains
      pre-stable; the Devtools surface is the only review item
      still deferred to v0.2.
