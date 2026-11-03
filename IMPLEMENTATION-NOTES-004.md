# Implementation notes: Spec 004 (cut export, CutterDriver/2)

Scope of this change: the CutterDriver/2 interface and its conformance kit
(Part C), the vendor-neutral cut export core it needs (frame transforms, HPGL,
DXF R12, a layered PDF cut file, job validation, panel segmentation, file and
raw delivery), and the two vendor plugins `cutter-summa-s2` (Part F) and
`cutter-summa-f` (Part G), plus their tests. Everything is implemented from
`docs/specs/004-cut-export.md`, ISO 32000, the public HP-GL/2 reference, the
public AutoCAD R12 DXF reference and the public user manuals cited in
`docs/research/cutter-integration.md`. Vendor and model names appear only in
`plugins/`.

## What was built

### `packages/plugin-sdk` (CutterDriver/2 additions, isolated)

Spec 001 owns the core SDK. This spec only adds cutter-specific modules so they
can be layered onto 001's SDK without forking it:

| File | Purpose |
|---|---|
| `src/stub.ts` | Minimal BPP stub (manifest loading, JSON-RPC framing over stdio, `launchPlugin`, version-range check). Replace with Spec 001's SDK on merge |
| `src/cutter.ts` | CutterDriver/2 types (`CutterProfile`, `ToolDef`, `Range`, `RegistrationModel`, `CutJob`, `Contour`, `CutFrame`, `RegistrationMarks`, ...), `CutterDriverError` codes, `makeExportResult`, `sha256Hex` |
| `src/cutter-bpp.ts` | `serveCutterDriver` (plugin side) and `createCutterDriverClient` (host side), with optional spooling of artifacts to files |
| `src/conformance/cutter.ts` | Conformance kit: `checkCutterProfile`, `sampleCutJob`, `runCutterDriverConformance` (in-process) and `runCutterDriverConformanceProcess` (separate process from a manifest, spooled artifacts, sha256 re-checked on disk) |

`Contour` is a minimal local copy of the Part A output type, so neither package
depends on extraction code.

Additions beyond the spec's sketch, all optional: `RegistrationModel.experimental`
(methods that exist but stay off until the operator opts in),
`RegistrationMarks.method` / `.shape`, and `ExportResult.fileName` / `.mime`.

### `packages/cut-export` (vendor-neutral core)

| File | Purpose |
|---|---|
| `src/geometry.ts` | pt/mm units, half-away-from-zero rounding, fixed and compact number formatting, bbox, signed area, `makeContour`, `safeFileStem` |
| `src/frame.ts` | Origin (4 corners or the origin mark), `swapXY`, `scale`, `offsetMm`; option parsing from untrusted `CutJob.options` |
| `src/hpgl.ts` | HP-GL/2 subset: `IN;`, `SP<n>;` per `penMap`, `PU`/`PD` with at most 256 pairs per `PD`, optional `VS`/`FS` (device-dependent), line-ending option, 40 plotter units per mm |
| `src/dxf.ts` | AutoCAD R12 ASCII (`AC1009`), CRLF, `HEADER`/`TABLES`/`ENTITIES`, `POLYLINE`/`VERTEX`/`SEQEND`, one layer per tool, mm or in, 4 fixed decimals, optional `TEXT` labels and mark `CIRCLE`s |
| `src/pdf-cut.ts` | Deterministic one-page PDF: one OCG per cut layer plus a mark layer of filled circles; no content outside marked-content blocks |
| `src/validate.ts` | `validateCutJob` / `assertValidCutJob`: extent vs. work area, unmapped and unknown tools, parameter ranges, registration method, mark shape and size, origin mark, panels. Collects every error before export |
| `src/segment.ts` | Panel and conveyor-step segmentation by y-range (bbox-max assignment or `allowSplit`), with per-panel marks |
| `src/deliver.ts` | Atomic file and folder drop (hidden temp name, then rename), raw TCP send with timeout, device-path write |

### `plugins/cutter-summa-s2` (roll, Part F)

- Profile: `roll`, user-entered width and optional panel length, tools
  `knife` (drag or tangential), `pen`, `pouncing`; registration `none`, with
  `edge-mark-rows` listed as experimental and only offered when enabled;
  `supportsDeformationComp: ["x","xy","segmented"]`,
  `barcodeJobId: {supported: true, documented: false}`; delivery
  `file`/`usb`/`tcp`; format `hpgl`.
- HPGL export with `SP` per tool, `VS` only on opt-in, never a force command.
- `dmpl` is reserved and fails with `unsupported`. Barcode job ids fail with
  `unsupported`. OPOS-style `edge-mark-rows` fails with `experimental-disabled`
  unless `options.enableExperimentalOpos` is set; even then no mark-reading
  commands are emitted.
- Delivery: file always; raw TCP and USB device path are off by default
  (`delivery.enableUnverified`) until verified on hardware with our own HPGL.
- `test/vendor-neutral.test.ts` scans `packages/` for vendor, model and
  vendor-language names (acceptance 12). It lives in a plugin so the deny-list
  never appears in core.

### `plugins/cutter-summa-f` (flatbed, Part G)

- Profile: `flatbed`, user-entered bed size, origin, conveyor, vacuum zones and
  tools from the generic kind catalog; registration `camera-marks` and `none`,
  circles of exactly the configured size (default 5 mm); delivery
  `folder-import`; formats `pdf-cut` and `dxf`.
- `pdf-cut`: one OCG per method named from `toolMap` (user-overridable by tool id
  or semantic tool), a `Regmark` layer with filled circles, no print data. Open
  paths whose ends are within 0.5 mm are closed (configurable). Warns about
  marks that differ from the configured size and about content beyond the page.
- `dxf`: one layer per method, optional `TEXT` labels, registration circles on
  the `Regmark` layer, coordinates relative to the origin mark.
- Code 39 job-id file naming (8–13 characters) is experimental and must be
  enabled. Machine control stays in the vendor's software; `getStatus` reports
  only whether the import folder is writable.

## Tests (acceptance mapping)

| Acceptance | Where |
|---|---|
| 3 HPGL (golden, round-trip parser ±1 unit, `PD` chunking, `penMap`) | `packages/cut-export/test/hpgl.test.ts` |
| 4 DXF (golden, `dxf-parser`, layers, flags, vertices) | `packages/cut-export/test/dxf.test.ts` |
| 5 Origins × swapXY table | `packages/cut-export/test/frame.test.ts` |
| 7 Conformance kit, separate process, sha256 | `packages/plugin-sdk/test/conformance.test.ts`, `bpp.test.ts`, and both plugin test suites |
| 8 Profiles pass the kit; validation table (roll and flatbed fakes) | `packages/cut-export/test/validate.test.ts`, plugin tests |
| 9 5 m roll job → 4 panels, each contour once, panel marks | `packages/cut-export/test/segment.test.ts` |
| 10 summa-f PDF: layers per `toolMap`, 4 × 5 mm ±0.01 circles, no content outside layers, golden | `plugins/cutter-summa-f/test/driver.test.ts` |
| 11 summa-s2 HPGL golden; `dmpl` / OPOS `unsupported` / `experimental-disabled` | `plugins/cutter-summa-s2/test/driver.test.ts` |
| 12 Vendor-neutral core | `plugins/cutter-summa-s2/test/vendor-neutral.test.ts` |

Goldens live inline in the tests. `.gitattributes` marks `*.hpgl`, `*.dxf` and
`golden/` as `-text` so line endings are never rewritten.

## Deferred

- **Part A** (contour extraction from PDFs) and **Part B** (ordering,
  direction, overcut) in `packages/cut`, with fixtures 1–6 and acceptance 1–2.
  Exporters take `Contour[]` already flattened, in pt.
- **Part D** (generic registration marks drawn through Spec 003's `impose()`
  marks hook) and acceptance 6. The plugins already consume
  `RegistrationMarks` and express coordinates relative to the origin mark.
- **`plugins/cutter-generic`**. All of its export, validation and delivery
  logic lives in `packages/cut-export`, so the plugin is a thin profile and
  manifest on top.
- **Part E** (server routes, hot-folder auto-export), which waits for Spec 001.
- Swapping `plugin-sdk/src/stub.ts` for Spec 001's SDK once it merges.
- Hardware verification of S2 raw TCP and USB delivery (black-box, our own
  HPGL only).
- Lint and license checks from the 001 CI matrix (acceptance 13), which are
  not in this branch yet.

## Root workspace changes

Merged additively onto main's root files: `.gitignore` gains `*.tsbuildinfo`;
`package.json` keeps main's `pnpm -r` scripts and pinned tool versions
(TypeScript 5.8.3, Vitest 3.2.4); `pnpm-workspace.yaml` already lists
`packages/*` and `plugins/*`. New: `.gitattributes`, a root `tsconfig.json`
and a `vitest.config.ts` (an optional `projects` runner; CI uses `pnpm test`).
`packages/nest` is unchanged. The new packages have no `build` script, so
`pnpm -r build` still builds only `packages/nest`.

## Install and test

Node 22 and pnpm 10:

```sh
pnpm install
pnpm typecheck
pnpm test
# one package
pnpm --filter @bax-print/cutter-summa-f test
```

Pinned runtime and dev dependencies: `pdf-lib` 1.17.1, `tsx` 4.19.2 (plugin
processes run via `node --import tsx`), `dxf-parser` 1.1.2 (dev only, MIT),
`typescript` 5.8.3, `vitest` 3.2.4, `@types/node` 22.10.2. No lockfile is
committed.
