# Spec 001: Monorepo skeleton, plugin SDK, job queue, hot-folder intake, community files (Milestone M1)

Target repo: **github.com/BAX-Forward/BAX-Print-Suite** (public, Apache-2.0). Read `docs/ARCHITECTURE.md` and ADR-0001 through ADR-0005 first. This spec implements M1 from `docs/ROADMAP.md`.

## Clean-room rule (read first)
Implement from this spec, the repo's docs, public standards (PDF ISO 32000, CIP4 XJDF concepts, JSON-RPC 2.0, CloudEvents, OpenAPI 3.1), and the public docs of the listed libraries only. Don't reference, copy, or inspect any commercial RIP's files, binaries, docs, or UI, and don't name any commercial RIP product in code, docs, or UI. No vendor SDK files, NDA material, or credentials.

## Hardware-agnostic rule
No printer or cutter vendor, model, or command language in `packages/*`. Add `scripts/check-vendor-neutral.ts` to CI (fails on a configurable vendor-name list in `packages/` and `apps/`; plugins/ and docs/research are exempt).

## Goal
A working, Windows-friendly intake service: a PDF dropped into a watched folder appears as a job with page count, page sizes, and status, visible through a CLI and an HTTP API. Plus the plugin SDK and a mock PrinterDriver that prove the plugin architecture end to end, and the public repo's community and CI scaffolding.

## Stack (ADR-0001)
TypeScript (strict, ESM), Node 22 LTS, pnpm workspaces, Vitest, ESLint, Prettier, Fastify, chokidar, pdf-lib, `node:sqlite`. Dependencies must be on the allowlist in `docs/LICENSING.md`.

## Layout
```
packages/plugin-sdk     BPP v1: JSON-RPC framing, message & interface types (RenderEngine, ColorEngine,
                        Screener, PrinterDriver, CutterDriver, Inspector, Storage), JSON Schemas,
                        manifest schema + validator, host-side PluginHost (spawn, initialize,
                        capability negotiation, ping, cancel, shutdown), plugin-side helper,
                        conformance kit (vitest helpers)
packages/core           Job / JobTicket / JobStep / Media / Device / Profile / HotFolder types,
                        job state machine (pure, no IO)
packages/events         typed in-process event bus, CloudEvents envelope, sqlite outbox
packages/store          Storage + JobRepository interfaces, sqlite implementation, migrations
packages/inspect        Inspector/1 implementation using pdf-lib (in-process built-in)
packages/hotfolder      watcher -> stable-write detection -> hash -> store -> inspect -> job
plugins/printer-mock    mock PrinterDriver/1 as a separate process speaking BPP over stdio;
                        consumes band handles (file transport), writes a summary JSON, emits
                        status/accounting; bps-plugin.json manifest
apps/server             Fastify REST API + SSE /events + hot-folder runner + plugin host; JSON config
apps/cli                `bps jobs list|show <id>|set-status`, `bps hotfolder add <path>`,
                        `bps plugins list|check`
```

## Domain (packages/core)
- **Job:** id (ULID), name, sourcePath, storedPath, sizeBytes, sha256, pageCount, pages[{index, widthPt, heightPt, trimBox?}], status, priority (0–100), hotFolderId?, ticketId?, deviceId?, steps[], createdAt, updatedAt, error?
- **Statuses:** `received → inspecting → ready → (held ⇄ queued) → processing → sent_to_device → printed → done`, plus `sent_to_device → done` (output whose print confirmation is not observable, e.g. handoff), `failed` and `cancelled` (from any non-terminal state). Encode the allowed transitions as a table, with exhaustive tests. Illegal transitions are rejected with a typed error.
- **JobTicket** (minimal for M1): `{intent: {quantity, finishedSize?, mediaIntent?}, process: {}}`. Shape it after XJDF intent/process ideas, in our own names.
- **HotFolder:** id, name, path, enabled, settings {moveProcessedTo, defaultPriority, filePatterns (default `*.pdf`), dedupe (default true), ticketTemplate?}.
- Ingest copies the file into managed storage keyed by job id. The original moves to `<hotfolder>/_processed` or `_failed`. Dedup on sha256 within a hot folder when enabled.
- Every status change emits `job.status.changed` on the event bus (CloudEvents envelope) and writes to the outbox.

## Plugin SDK (packages/plugin-sdk)
- Implements BPP v1 per ARCHITECTURE.md §3: Content-Length framed JSON-RPC 2.0 on stdio, `initialize`/`configure`/`shutdown`, `$/ping`, `$/cancel`, `$/progress`, and band messages with `file` transport (shm is out of scope).
- The manifest JSON Schema plus validator, and semver range checks for `provides[].versions`.
- PluginHost: spawns with a scrubbed env and spool cwd, enforces an initialize timeout (5 s), restarts on crash with backoff, and pipes stderr JSON logs.
- Conformance kit: `runPrinterDriverConformance(manifestPath)` and similar for the other interfaces (types-only stubs are fine for the interfaces not used in M1).
- Published (later) as `@bax-print/plugin-sdk`. Keep it free of imports from other packages.

## API (apps/server)
`GET /health`, `GET /jobs` (filter by status, paginate), `GET /jobs/:id`, `PATCH /jobs/:id {status|priority}` (validated by the state machine), `GET /hotfolders`, `POST /hotfolders`, `GET /plugins`, `POST /jobs/:id/print {deviceId}` (mock driver only in M1), `GET /events` (SSE). OpenAPI 3.1 generated from the schemas at `/openapi.json`. Binds to loopback by default.

## CI (.github/workflows)
- `ci.yml`: matrix windows-latest and ubuntu-latest, Node 22: `pnpm i --frozen-lockfile && pnpm lint && pnpm test && pnpm build`.
- `license-check`: fails on any production dependency whose license is off the allowlist in `docs/LICENSING.md` (MIT, MIT-0, ISC, BSD-2/3-Clause, Apache-2.0, Zlib, 0BSD, Unlicense, CC0-1.0, BlueOak-1.0.0, MPL-2.0). Implement with `license-checker-rseidelsohn` or an equivalent permissively licensed tool, using an allowlist config file. Generate a CycloneDX SBOM artifact.
- **DCO check:** a GitHub Action that verifies every PR commit has a `Signed-off-by` matching its author (e.g. the `dco` workflow from a permissively licensed action, or the DCO GitHub App). Document it in CONTRIBUTING.
- Secret scanning: enable GitHub secret scanning and push protection in repo settings, plus `gitleaks` in CI.

## Community files (copy from `/workspace/print-suite/public/`)
Copy these into the repo root as-is (adjust only paths): `README.md`, `LICENSE`, `NOTICE`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `GOVERNANCE.md`, `.github/CODEOWNERS`, `.github/pull_request_template.md`, `.github/ISSUE_TEMPLATE/*`, `docs/ARCHITECTURE.md`, `docs/LICENSING.md`, `docs/ROADMAP.md`, `docs/adr/0001–0005`, `docs/research/rip-engines.md`. Update the README quickstart once M1 works.

## Acceptance
1. `pnpm i && pnpm test && pnpm build` passes on windows-latest and ubuntu-latest in GitHub Actions. The license-check and DCO checks pass on the PR.
2. Integration test: start the server with a temp hot folder, drop 3 fixture PDFs (generate them in the test with pdf-lib: Letter, 24×36 in, and a 3-page mixed size), and within 5 s all 3 jobs are `ready` with correct page counts and sizes (±0.5 pt). A non-PDF or corrupt file ends up `failed` and in `_failed`.
3. A partially written file (written in chunks over 2 s) is ingested only once, after the writes finish.
4. State-machine tests cover every legal and illegal transition.
5. Plugin test: the host spawns `plugins/printer-mock`, the manifest validates, `initialize` negotiates `PrinterDriver/1`, `POST /jobs/:id/print` sends ≥2 file-transport bands, and the job passes through `sent_to_device` to `printed`. Killing the plugin mid-job sets the step to failed and the plugin restarts. The conformance kit passes for the mock.
6. An SSE client receives `job.status.changed` events for the test above.
7. Community files are present. `rg -i` finds no commercial RIP product names in the repo. The PR template contains the DCO, tests, licensing, and clean-room checkboxes.
8. A license-check negative test: adding a GPL fixture dependency in a test workspace makes the checker fail.

## Out of scope
Dashboard UI and the RIP hot-folder handoff driver (Spec 002, M2), nesting (M3), cut export (M4), real render/color/screening plugins (M5–M7), shared-memory transport, plugin signing.
