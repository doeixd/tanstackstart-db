# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.3] - 2026-06-03

### Added

- `paginatedCollectionOptions()` for cursor-based paginated TanStack DB collections (`@doeixd/tanstackstart-db/pagination`)
  - Forward, backward, or bidirectional pagination via `direction`
  - `loadNextPage()` / `loadPreviousPage()` / `refetchFirstPage()` utilities
  - Built-in deduplication by `getKey`
  - `useListView()` React hook with reactive `[items, loadNext, loadPrevious, state]` tuple
  - `useRefetchPaginated()` for stable refresh callbacks
  - New subpath export `./pagination` in `package.json`
- Tests: 9 new integration tests for `paginatedCollectionOptions` (initial sync, loadNext, loadPrevious, dedup, refetch, errors, no-op)

## [0.0.2] - 2026-06-03

### Added

- `defineEntity()` object-form alias for `entity()` — named fields for larger schemas
- `DbQueryBundle`, `DbQueryBundleContext`, `DbQueryBundleStage` exports for composable query pipelines
- `EntityCache` and `SelectedEntityCache` type exports for optimistic cache integration
- New docs: `tutorial.md`, `requests.md`, `actions-live-views.md`

### Changed

- Expanded query bundle infrastructure in `db.ts` and `react.ts`
- Query collection adapter improvements

## [0.0.1] - 2026-06-02

### Added

- Initial release
- Schema-first entity definitions with Standard Schema validators
- Generated typed query helpers (`byId`, `all`, indexed, relationships)
- Generated optimistic CRUD actions (`create`, `patch`, `update`, `delete`)
- Custom action extensions via `extendActions`
- View masking with nested relationship projections
- Collection adapters: local, Query Collection, localStorage, sync engines
- React hooks: live queries, Suspense queries, infinite queries, status
- View-bound component builders with action integration
- DB file route builders for TanStack Router
- Route fragments and composition
- Action aliases with nested namespace resolution
- SSR hydration with confirmed-state snapshots
- Testing utilities: memory DBs, fixtures, mocks, render helpers

[0.0.3]: https://github.com/doeixd/tanstackstart-db/releases/tag/v0.0.3
[0.0.2]: https://github.com/doeixd/tanstackstart-db/releases/tag/v0.0.2
[0.0.1]: https://github.com/doeixd/tanstackstart-db/releases/tag/v0.0.1
