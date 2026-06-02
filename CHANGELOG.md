# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.0.1]: https://github.com/doeixd/tanstackstart-db/releases/tag/v0.0.1
