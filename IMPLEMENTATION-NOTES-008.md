# Implementation notes: Spec 008 (job archive, reprint and production history)

Branch: `feat/008-archive-reprint-history`. Spec: [`docs/specs/008-archive-reprint-history.md`](docs/specs/008-archive-reprint-history.md).

These files were written without running a shell. Nothing below has been installed, compiled or run yet. The first CI run is the first real check.

## Built

New workspace packages. Each one exports its TypeScript source (`exports: "./src/index.ts"`), so none of them has a build step. None of them names a vendor, model or device command language.

| Package | Contents |
|---|---|
| `packages/core` (`@bax-print/core`) | `Job` with `reprintOf`, `archivedAt`, `trashedAt`, `legalHold`, `doneAt`, and an orthogonal `lifecycle: active \| archived \| trashed` kept apart from the print status machine (`status.ts`, `lifecycle.ts`). Also `JobTicket`, `ColorSetupRevision`, accounting report types, actors and roles, ULIDs, an injectable clock, and typed errors. |
| `packages/events` (`@bax-print/events`) | CloudEvents 1.0 envelope and validation, an `EventBus` that writes to the outbox before listeners run, an append-only `MemoryOutbox` (updates, deletes, re-appends and in-place mutation are rejected with `AppendOnlyViolationError`), JSON Lines export and per-job/per-device history. |
| `packages/store` (`@bax-print/store`) | The `Storage/1` interface with `LocalDirStorage` (atomic writes, path-escape protection) and `MemoryStorage`, blob key helpers, `MemoryJobRepository`, and `MemoryArchiveIndex` (slim index rows, filtered search, cursor paging). |
| `packages/archive` (`@bax-print/archive`) | `.bpsjob` pack/unpack (ZIP writer/reader per APPNOTE, CRC-32, SHA-256 manifest, schema in `schema/manifest.schema.json`), archive policy evaluator, retention evaluator, reprint setup resolution, search query parsing, import with device/medium remap, XJDF ticket export, and `ArchiveService` tying them together. |
| `apps/server` (`@bax-print/server`) | Fastify 5 HTTP API and the archive scheduler. |

Requirements:

| FR | Where | Notes |
|---|---|---|
| FR1 job package | `archive/src/package.ts`, `zip.ts`, `manifest.ts` | Members: `manifest.json`, `job.json`, `ticket.json`, source files, layout/cut artifacts, previews, color setup revisions, redistributable profiles and `history.jsonl`. Every member has a SHA-256 in the manifest, and `job.json` repeats the source/artifact hashes, so rewriting the manifest doesn't hide tampering. Output is deterministic. Profiles that aren't redistributable are left out, with a warning. |
| FR2 policy | `archive/src/policy.ts`, `duration.ts`, `apps/server/src/scheduler.ts` | Global or per-hot-folder `archiveAfter`, 14 days by default. The boundary is strict (older than the rule). Manual archive is always allowed for finished jobs. |
| FR3 storage | `store/src/local-storage.ts`, `archive-index.ts` | Packages go to a `Storage/1` backend and are read back and verified before the active blobs are deleted. |
| FR4 search | `store/src/archive-index.ts`, `archive/src/search-query.ts` | Text, customer, metadata, date range on a chosen date field, device, medium, size range and tags (all must match), with opaque cursors tied to the sort field. |
| FR5 reprint | `archive/src/reprint-setup.ts`, `service.ts` | Creates a new job with `reprintOf`. On the same device and medium it reuses the original revision unless `useCurrentHead` is set. If the device or medium changes, an explicit setup is required (`ColorSetupRequiredError` → HTTP 422), the setup must belong to the new pair, a `reprint.setup.changed` warning event is published, and layout and cut artifacts are not carried over. |
| FR6 trash and retention | `core/src/lifecycle.ts`, `archive/src/retention.ts` | Trash, then purge after 30 days by default. `legalHold` blocks both trash and purge, and only an admin can remove it. Purge deletes active blobs, the package and the index row, and emits `job.purged`. |
| FR7 history | `events/src/*`, `apps/server/src/jobs.ts` | State changes, steps, operator actions and device accounting reports are outbox events. Usage is stored exactly as reported, with units. Corrections are new `history.correction` events that point at the corrected event. The history is copied into `history.jsonl` in the package. |
| FR8 interchange | `service.ts#importPackage`, `xjdf.ts` | Import checks every hash. Unknown devices or media need a remap (`RemapRequiredError` lists them). A color setup revision that doesn't apply after a remap is dropped, with a warning. Optional XJDF export of the ticket. |

HTTP routes (`apps/server/src/app.ts`): `GET /archive`, `GET /archive/:id`, `GET /archive/:id/package`, `POST /jobs/:id/archive`, `POST /archive/:id/restore`, `POST /archive/:id/reprint`, `POST /archive/import` (body `application/octet-stream`; remaps as query parameters), `DELETE /jobs/:id`, `DELETE /archive/:id`, `GET /trash`, `POST /trash/:id/restore`, `PUT /jobs/:id/legal-hold`, `GET /jobs/:id/history` (JSON Lines), `GET /jobs/:id/xjdf`. Events: `job.archived`, `job.restored`, `job.purged`, plus `job.trashed`, `job.imported`, `job.legalhold.changed` and `reprint.setup.changed`.

Server environment: `BPS_DATA_DIR` (default `./data`, git-ignored), `BPS_HOST` (default `127.0.0.1`), `BPS_PORT` (default `8080`), `BPS_ARCHIVE_AFTER` and `BPS_TRASH_RETENTION` (durations such as `14d` or `P30D`).

Acceptance tests:

1. Unit: `archive/test/package.test.ts` (round-trip hash-identical; tampered member, rewritten manifest, edited history, flipped byte, missing or extra member → `PackageIntegrityError`; manifest schema matches the code) and `archive/test/policy.test.ts` (fake clock, exact selection, strict boundary, hot-folder override). `core/test/lifecycle.test.ts` covers the orthogonal lifecycle.
2. Reprint: `archive/test/reprint.test.ts`, plus the HTTP side in `apps/server/test/api.test.ts`.
3. Retention: `archive/test/retention.test.ts` (fake clock, legal hold survives, `job.purged`, blobs removed) and `apps/server/test/scheduler.test.ts`.
4. History: `apps/server/test/history.test.ts` (a scripted lifecycle equals the expected CloudEvents list ignoring ids and times; update/delete/re-append are rejected; corrections are new events) and `events/test/events.test.ts`.
5. Differential: `archive/test/differential.test.ts` uses the project's own mock pipeline (`test/fixtures/mock-pipeline.ts`). Page boxes are equal, cut geometry is within 0.01 mm, and the render pixel diff is 0. A negative control checks that the comparison catches a changed layout.
6. Checks: `scripts/vendor-neutral.ts` (+ `scripts/vendor-neutral.test.ts`) scans against main's shared `scripts/vendor-names.json`. `archive/test/vendor-neutral.test.ts` runs it over the Spec 008 directories. Root `eslint.config.js` (flat config, typescript-eslint) and `pnpm check:licenses`.

Root changes (additive to main): `lint`, `test:scripts` and `check:vendor-neutral` scripts; ESLint devDependencies; `apps/server` and `scripts/vitest.config.ts` added to the root Vitest projects; `/data/` added to `.gitignore`.

Dependencies (pinned, all on the `docs/LICENSING.md` allowlist): `fastify` 5.2.1 (MIT) and `tsx` 4.19.2 (MIT) in `apps/server`. Dev only: `vitest` 3.2.4, `typescript` 5.8.3, `@types/node` 22.10.2, `eslint`/`@eslint/js` 9.27.0, `typescript-eslint` 8.32.1. Nothing else is used; the ZIP, CRC-32 and XJDF code is our own, and hashing uses `node:crypto`.

## Deferred

- **Persistence.** Job rows, the archive index and the outbox are in memory (`Memory*` classes behind repository interfaces). `node:sqlite` tables (with an append-only trigger on the history table) belong to the Spec 001 store. The server logs a warning about this at startup.
- **S3-compatible `Storage/1`** is a plugin and isn't part of this branch. Only the local directory backend is built in.
- **Spec 005 color setup resolution.** `ColorSetupResolver` is the interface. `StaticColorSetupResolver` is an in-memory stand-in until Spec 005 provides real revisions and profile bytes.
- **Spec 001 core.** `packages/core` isn't on main yet. This branch's `core`, `events` and `store` hold only what Spec 008 needs, and should be folded into the Spec 001 versions when those land. Spec 009's `packages/tile` types don't depend on it yet.
- **Authentication.** The default authenticator treats the loopback caller as admin (single-PC mode). Server mode needs to pass in a real `authenticate`.
- **Dashboard UI** for search, reprint, trash and legal hold.
- **`noUncheckedIndexedAccess`.** Main's base tsconfig turns it on. The Spec 008 package tsconfigs turn it off locally, because this code was written before the rebase. Turning it on is a follow-up.
- **License check list.** The root `check:licenses` allowlist includes `MPL-2.0`, which `docs/LICENSING.md` doesn't list. No Spec 008 dependency needs it. Reconcile the two separately.

## Install and test

Node 22, pnpm 10. There is no lockfile yet, so the first install resolves the pinned versions:

```sh
pnpm install
pnpm -r typecheck
pnpm --filter @bax-print/core --filter @bax-print/events --filter @bax-print/store --filter @bax-print/archive --filter @bax-print/server test
pnpm test:scripts
pnpm lint
pnpm check:vendor-neutral
pnpm check:licenses
BPS_DATA_DIR=./data pnpm --filter @bax-print/server start
```
