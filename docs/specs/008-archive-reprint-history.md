# Spec 008: Job archive, reprint and production history (Milestones M1/M2 extension)

Target repo: **github.com/BAX-Forward/BAX-Print-Suite**. Read `docs/ARCHITECTURE.md` (§4 data model, §5 event bus, §3.3 `Storage/1`) and Spec 001 first.

## Clean-room rule (read first)
Same as Spec 001. Build from this spec, CIP4 JDF/XJDF audit concepts, CloudEvents 1.0, the ZIP format (APPNOTE), and library docs. Don't copy any commercial RIP's archive layout, retention settings or wording. No commercial product names.

## Goal
1. Move completed jobs into an **archive** as self-contained **job packages**.
2. **Reprint** a job with the exact parameters and color setup revisions it used.
3. Keep an **immutable production history** per job and device.

## User stories
- As an operator, I find last spring's order for a returning customer and reprint it in two clicks.
- As a manager, I want the active queue to stay short without losing old jobs.
- As an owner, I want to know what was printed, on which machine, by whom, and how much material it used.
- As an admin, I want a safety window before anything is permanently deleted, and a way to protect jobs under dispute.

## Functional requirements
- **FR1 Job package (our format, `.bpsjob`):** a ZIP with `manifest.json` (schema in `packages/archive/schema`; package version, job id, SHA-256 of every member), the original source file(s), `ticket.json` (JobTicket incl. Spec 007 edits and Spec 006 mark specs), referenced `ColorSetupRevision` ids plus copies of their profiles when redistributable (Spec 005), layout and cut artifacts, preview thumbnails, and `history.jsonl`.
- **FR2 Archive policy:** per hot folder or global rule `archiveAfter` (duration since `done`). Default 14 days: long enough to cover typical reprint/correction requests on a finished order, short enough to keep the active list small. A scheduler runs the policy; manual archive is always allowed.
- **FR3 Storage:** archive target is a `Storage/1` backend (local directory built-in; S3-compatible via plugin). Archived jobs keep a slim index row (name, customer, dates, device, medium, size, tags) in the database.
- **FR4 Search:** filter by text, customer/metadata, date range, device, medium, size range, tags; cursor-paged.
- **FR5 Reprint:** creates a **new job** linked by `reprintOf`, restoring the package. Options: copies, target device, medium/preset. If the device or medium differs from the original, the stored color setup revision no longer applies; the user must pick a setup, and a warning is recorded. Same device + medium uses the original revision unless the user opts into the current head.
- **FR6 Trash and retention:** deleted jobs go to trash; purge after a retention window (default 30 days, aligning with common monthly billing/dispute cycles). A `legalHold` flag blocks purge and deletion until removed by an admin.
- **FR7 History:** every job state change, step, operator action and device accounting report is an event in the outbox (ARCHITECTURE §5) and is copied into `history.jsonl` as CloudEvents. History is append-only; corrections are new events. Device-reported ink and media usage are stored as reported, with units.
- **FR8 Interchange:** import of a `.bpsjob` from another installation (validates hashes, remaps unknown devices/media to user choices). Optional XJDF export of the ticket via the adapter.

## Interfaces with existing packages and plugins
| Package | Change |
|---|---|
| `packages/core` | `Job.reprintOf`, `Job.archivedAt`, `Job.legalHold`, `Job.trashedAt`; archive states kept outside the print status machine (an orthogonal `lifecycle: active|archived|trashed`) |
| `packages/store` | Index tables; `Storage/1` used for packages |
| `packages/events` | History export from the outbox |
| `packages/archive` (new) | pack/unpack, policy evaluator, search |
| `apps/server` | `/archive` search, `POST /jobs/:id/archive`, `POST /archive/:id/reprint`, `POST /archive/import`, `DELETE`, `/trash`; events `job.archived`, `job.restored`, `job.purged` |
| Spec 005 | Provides `ColorSetupRevision` resolution |

## Acceptance tests
1. **Unit (Vitest):** pack → unpack round-trip yields hash-identical members; a tampered member fails with `PackageIntegrityError`; policy evaluator archives exactly the jobs whose `done` time is older than the rule (fake clock).
2. **Reprint:** same device + medium reuses the original revision id; different medium requires an explicit setup and records a `reprint.setup.changed` warning event.
3. **Retention:** fake clock past the window purges trash except `legalHold` jobs; purge emits `job.purged` and removes storage blobs.
4. **History:** event sequence of a scripted job lifecycle equals the expected CloudEvents list (ignoring ids/times); attempts to update a history row are rejected.
5. **Differential (own fixtures):** reprint a fixture job and compare the imposed PDF and cut file of original and reprint: page boxes equal, cut geometry identical within 0.01 mm, render pixel diff 0 with the mock pipeline.
6. Lint, license, vendor-neutral checks pass.

## References (public)
CIP4 XJDF 2.x (audit and resource concepts); CloudEvents 1.0; PKWARE APPNOTE (ZIP).

## Out of scope
Billing/invoicing; MIS integration beyond XJDF export; deduplicated cross-job blob storage (later optimization).
