# Spec 002: Dashboard and RIP hot-folder handoff (Milestone M2)

Target repo: **github.com/BAX-Forward/BAX-Print-Suite**. Read `docs/ARCHITECTURE.md` (§3 plugins, §6 API, §10 dashboard), ADR-0003, ADR-0005 and **ADR-0006** (added by this spec) first.

## Clean-room rule (read first)
Same as Spec 001. Build from this spec, the repo docs, and public docs of the listed libraries only. Don't model the UI on any commercial RIP's screens, and don't name commercial RIP products in code, docs, UI, fixtures, or config examples (use "external RIP" or "target hot folder").

## Goal
1. A web dashboard for operators: job list with filters, job detail with screen-preview thumbnails, status and priority actions, and hot-folder management. It uses **only** the public REST and SSE API.
2. A `handoff` **PrinterDriver plugin** that delivers queued jobs' PDFs into a configured external hot folder (for an existing RIP), records the result, and moves the job to `sent_to_device`.

## Dependencies on Spec 001 (and stubs)
| Needs from 001 | Used for | If 001 isn't merged yet: stub |
|---|---|---|
| `packages/core` Job/HotFolder types and state machine | UI types (via OpenAPI), handoff transitions | Code against the generated OpenAPI types. Server-side: import from `@bax-print/core` and add a temp `core-stub` exporting the 001 types and a transition table |
| REST: `GET/PATCH /jobs`, `GET/POST /hotfolders`, `GET /plugins`, `POST /jobs/:id/print`, `/openapi.json` | All UI screens | `apps/dashboard/mock/` with an **MSW** (MIT) handler set that implements those endpoints from `openapi.json` fixtures. The UI must run against MSW with `pnpm --filter dashboard dev:mock` |
| `GET /events` SSE (CloudEvents `job.status.changed`) | Live updates | MSW SSE handler, or a 20-line `scripts/fake-sse.ts` |
| `packages/plugin-sdk` PluginHost, PrinterDriver/1, manifest, conformance kit | Handoff plugin | Minimal stub `packages/plugin-sdk/src/stub.ts`: Content-Length JSON-RPC framing, `initialize`/`shutdown`, and a PrinterDriver/1 type. Replace it with the real SDK on merge (the types must match ARCHITECTURE §3.3) |

**Parallelism:** UI work can start immediately against MSW. The handoff plugin can start against the SDK stub. Integration acceptance (tests 5–8) needs 001 merged.

## Part A: Additions to the API (owned by this spec, added to apps/server)
- `GET /jobs/:id/file`: streams the stored PDF (`application/pdf`, `Content-Disposition: inline`). Path is resolved only from the job record (no client paths).
- `GET /jobs/:id/preview?page=N&w=320`: **reserved contract.** Returns `501` with `{reason:"no-render-engine"}` in M2, and is filled in by the RenderEngine in M5. The UI falls back to pdf.js.
- `PATCH /hotfolders/:id` (enable/disable, settings), `DELETE /hotfolders/:id` (stops the watcher; never deletes files on disk).
- `GET /devices`, `POST /devices`, `PATCH /devices/:id`: Device records (ARCHITECTURE §4) of `kind: "printer"` bound to a driver plugin id plus config.
- `GET /jobs` gains `q` (name contains), `hotFolderId`, `deviceId`, `sort` (`createdAt|priority|name`, `-` prefix for desc), and cursor pagination `{items, nextCursor}`.
- All additions appear in `/openapi.json`. Each endpoint gets a contract test.

## Part B: Dashboard (`apps/dashboard`)
Stack per ADR-0006: React 18, Vite, TypeScript, TanStack Query/Table, React Router, `openapi-typescript`, `pdfjs-dist`, CSS modules. Built assets go to `apps/dashboard/dist` and are served by the server at `/ui`.

### Screens
1. **Jobs** (`/ui/jobs`): table with columns name, status (badge), priority, pages, size (first page, in/mm toggle), hot folder, device, created, updated. Filters: status (multi), hot folder, device, text search. Sort on columns, cursor-paged "load more". Live updates via SSE (row status changes without a reload; new jobs appear at the top when sorted by created desc). Bulk select: hold, queue, cancel, set priority.
2. **Job detail** (`/ui/jobs/:id`): metadata, page list with size and trim box, **thumbnails rendered by pdf.js in a Web Worker** (lazy, max 320 px, labeled "Screen preview"), the step and audit timeline (from `job.steps` and events), the error panel when failed, and actions.
3. **Actions:** only transitions the state machine allows are enabled. The UI fetches allowed transitions from a new `GET /jobs/:id/transitions` (added by this spec, backed by the core table), so the UI never hard-codes rules. Priority via slider/number (0–100). "Send to device" picks a Device and calls `POST /jobs/:id/print`.
4. **Hot folders** (`/ui/hotfolders`): list, add (path, name, patterns, default priority, dedupe, processed-folder option), enable/disable, remove. Server-side path validation errors are shown inline.
5. **Devices** (`/ui/devices`): list and add devices for installed driver plugins (`GET /plugins`). Config form rendered from the plugin's JSON Schema (`configSchema` in the manifest; see Part C).
6. Global: connection indicator (SSE state), toast on failures, keyboard-accessible, WCAG 2.1 AA contrast, en-US strings in one module (i18n-ready).

### Rules
- No direct file-system or DB access, and no endpoints outside `/openapi.json`. A lint rule forbids `fetch` outside the generated client.
- Large lists: virtualized rows past 200 items.

## Part C: Handoff PrinterDriver plugin (`plugins/printer-handoff`)
A separate process speaking BPP v1 (ADR-0003). Apache-2.0, no extra deps beyond the SDK.

### Interface addition: PrinterDriver/1.1 (minor, additive)
- Capability `accepts: ["bands"] | ["document"] | both`. The handoff plugin advertises `accepts: ["document"]`, `documentTypes: ["application/pdf"]`.
- New method `submitDocument({jobId, handle, fileName, ticket}) → {status: "delivered"|"failed", deliveredPath?, bytes?, sha256?, error?}`, where `handle` is a host spool file reference (file transport).
- The host routes `POST /jobs/:id/print` to `submitDocument` when the device's driver accepts documents. Add this to `plugin-sdk` types, JSON Schema, and conformance kit, and record it in ARCHITECTURE §3.3.
- Manifest gains optional `configSchema` (JSON Schema) for device config.

### Behavior
- Device config: `{targetDir, fileNamePattern (default "{jobName}_{jobId}.pdf"), conflict: "suffix"|"overwrite"|"fail" (default suffix), writeTicketSidecar: bool (default false; writes {base}.json with our ticket), verifyAfterCopy: bool (default true)}`.
- Delivery is atomic: copy to `targetDir/.bps-partial-<uuid>.tmp`, fsync, then rename to the final name (same volume). This keeps the external RIP from picking up partial files. Verify size and sha256 after the copy if configured.
- Sanitize file names (strip `<>:"/\|?*`, control chars, trailing dots and spaces; cap at 150 chars). Reject `targetDir` symlink and junction escapes.
- Manifest permissions: `fs: ["spool:r", "config:targetDir:rw"]`, `network: false`.
- Retries: up to 3, with exponential backoff (1 s, 4 s, 16 s) on transient errors (EBUSY, EPERM, ENOSPC is not transient). Then fail.
- `getStatus()` reports `ready` if targetDir is writable, otherwise `offline` with a reason. Polled every 30 s by the host, emitting `device.status`.
- `cancel()`: if the copy isn't finished, abort and remove the temp file. A delivered file is never deleted.

### Auto-dispatch (server)
- Device option `autoDispatch: true`: the scheduler takes jobs in `queued` with `deviceId` set (or matching a hot-folder → device routing rule `HotFolder.settings.defaultDeviceId`), ordered by priority desc then createdAt, max concurrency per device (default 1).
- Transitions: `queued → processing` (step `output` started) → on `delivered`, `sent_to_device` (plus step output result: deliveredPath, bytes, sha256, time) → stays there. Operators may mark `done` (handoff can't observe printing; this is allowed by the `sent_to_device → done` edge). On failure: `failed` with the error, step failed.
- Every transition emits events. A delivery record is written to the job's audit.

## Acceptance
1. `pnpm build` produces dashboard assets. `GET /ui` serves them. The Spec 001 CI matrix still passes on Windows and Linux.
2. Contract tests for every new endpoint (status codes, schema validation against `/openapi.json`).
3. Unit: the handoff plugin passes the PrinterDriver conformance kit (document mode). File-name sanitizer table tests. Conflict modes. Atomic rename (the final file never exists partially: a watcher test sees no partial final-name file across 50 runs of a 50 MB copy). Symlink escape rejected.
4. Unit: the scheduler orders by priority then age, respects concurrency 1, and retries then fails as specified.
5. Integration: a server with hot folder H and handoff device D (targetDir T, autoDispatch, H → D routing). Drop 3 PDFs in H, and within 10 s all 3 are in T with the right names and sha256, and the jobs are `sent_to_device` with a delivery record. Make T read-only and the next job ends `failed` after 3 retries, and device status goes `offline`.
6. **Playwright e2e** (Chromium; Windows and Linux in CI), against a real server with temp dirs:
   a. Jobs list shows fixture jobs. The status filter "failed" shows only failed jobs. Text search narrows results.
   b. Dropping a PDF in the hot folder makes a new row appear without a reload (SSE), reaching `ready`.
   c. Job detail renders ≥1 thumbnail canvas with non-blank pixels for the 3-page fixture, and shows correct page sizes.
   d. Hold → queue via action buttons. Disallowed actions are disabled (from `/transitions`).
   e. Set priority 90 and the list order updates under the priority sort.
   f. Hot folder add (valid path) works. An invalid path shows an inline error. Disable stops ingestion (a file dropped afterwards creates no job within 5 s).
   g. Add a handoff device via the generated config form, send a job, and the status becomes `sent_to_device` with the delivered path shown. Mark done.
7. `pnpm --filter dashboard dev:mock` runs the UI entirely on MSW (smoke Playwright test in mock mode).
8. Accessibility: `@axe-core/playwright` (MPL-2.0; dev-only, allowed) reports no serious or critical violations on the Jobs, Job detail, and Hot folders pages.
9. License check passes. No commercial RIP names (`rg -i` check from 001).

## Out of scope
Auth/RBAC (server mode), RIP-accurate previews (M5), nesting UI (M3), cut UI (M4), reading results back from external RIPs.
