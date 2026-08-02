# Architecture

Slopwork separates stable domain contracts from replaceable I/O and delivery
adapters. Dependencies point inward; type-only imports follow the same rule as
runtime imports because they still couple ownership and make future refactors
cross layer boundaries.

## Dependency direction

1. **Core (`src/core/`)** owns entity schemas, identifiers, clocks, exit-aware
   errors, the derived-index contract, and the `StorageBackend` port. Core has
   no dependency on another `src/` area.
2. **Domain (`src/tickets/`, `src/sessions/`)** owns pure workflow and derived
   behavior. It depends on core contracts and may share domain helpers across
   those two directories. It never imports CLI, repo, storage adapters, or web.
3. **Flatfile repository (`src/repo/`)** implements file persistence and index
   construction. It depends inward on core and pure domain derivations.
4. **Storage adapters (`src/storage/`)** implement or select the core-owned
   port. The flatfile adapter delegates to repo; the remote adapter implements
   the same port. `storage/backend.ts` is a compatibility re-export, not the
   contract owner.
5. **Delivery/composition (`src/cli/`, `src/web/`)** wires ports, adapters, and
   domain behavior into user-facing commands and read-only HTTP routes.

The canonical shared modules are:

- `src/core/errors.ts`: `SlopError`; `src/cli/errors.ts` adds reporting and
  preserves the legacy export.
- `src/core/db-index.ts`: `DbIndex`, row/problem/fingerprint schemas and DTOs,
  load results, and pure problem formatters. `src/repo/db-index.ts` owns I/O and
  keeps compatibility exports.
- `src/core/storage-contract.ts`: `StorageBackend`, transaction marker,
  event/query DTOs, and tolerant-read results.

## Narrow exceptions

CLI composition imports repository discovery and path primitives
(`RepoPaths`, `repoPaths`, `requireRepoRoot`, `findRepoRoot`, `ensureDbDirs`)
because backend selection cannot happen until a repository is located. `init`
and `edit` may also import `atomicWriteFile`: initialization writes files before
a backend exists, while edit must restore raw bytes after an invalid editor
result. These are explicit symbol-level exceptions, not permission for CLI
commands to call ticket/session/event data access directly.

## Enforcement

`tests/acceptance/G2.test.ts` recursively discovers every production `.ts` and
`.tsx` file, resolves local `import` and `export ... from` declarations, and
treats type and runtime edges equally. It enforces the layer matrix above,
checks the CLI repository exception by allowed symbol, and runs deterministic
strongly connected component detection over the full module graph. Tests may
import adapters directly to construct fixtures; production modules may not
bypass the rules.
