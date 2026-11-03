# Implementation notes: Spec 006 (finishing marks and job labels)

Built from `docs/specs/006-finishing-marks-and-labels.md`, ISO 32000 (optional content, Form XObjects, Separation colour spaces), ISO/IEC 18004, ISO/IEC 16022 and the Mustache spec. No commercial mark set, label layout or option names were used.

## Built

Package `packages/marks` (`@bax-print/marks`, Apache-2.0, vendor-neutral):

| Requirement | Where |
|---|---|
| FR1 mark kinds: `crop`, `trim-line`, `grommet`, `hem-line`, `sew-line`, `fold-line`, `custom` (single-page PDF as a Form XObject, or SVG drawn as paths; named anchors or repeat interval) | `src/schema.ts`, `src/marks-local.ts`, `src/grommets.ts`, `src/svg-symbol.ts`, `src/symbols.ts` |
| FR2 `BPS Marks` OCG, `BPS-Marks` Separation (alternate 100 % K); `registration` (/All) or `process-k` options | `src/pdf-writer.ts`, `src/content.ts` |
| FR3 non-destructive: marks are `MarkSpec` parameters; the original page content is wrapped in `q/Q` and left untouched; planning is pure and deterministic | `src/plan.ts`, `src/draw.ts` |
| FR4 job label: our Mustache-compatible template (documented field list, `upper`/`mm`/`in` filters, unknown fields render empty with a warning, no HTML escaping, PDF string escaping); placement outside the bleed on a chosen edge; space reservation through the Spec 003 `reserve(edge, mm)` API; "medium too narrow" warnings | `src/template.ts`, `src/pdf-string.ts`, `src/label.ts`, `src/reserve.ts` |
| FR4 font: **BPS Stroke**, a single-stroke font written for this project (Apache-2.0), drawn as vector paths. No font file is embedded, so output is the same on every machine. | `src/stroke-font.ts` |
| FR5 2-D code: QR (error correction M, via MIT `qrcode`) or Data Matrix ECC 200 (our own encoder); `bps:job/<id>[/panel/<r>-<c>]` or HTTPS job-page URL; module ≥ 0.5 mm; quiet zone 4 modules for QR | `src/codes/` |
| FR6 `MarkPreset` JSON: parse, import/export, selection by job → hot folder → queue, per-job override (merge by id or kind, remove, `label: null`) | `src/presets.ts` |
| FR7 geometry and code payloads merged into `/BPS_Layout`; `labelCodes()` for `CutJob.options.labelCode` | `src/metadata.ts` |
| Spec 003 hook: `draw()`, `marksHook()`, `composeHooks()` | `src/draw.ts` |
| Spec 004 collision check: registration clearance zones; `MarkCollisionError` is thrown before anything is rendered | `src/collision.ts` |
| `JobTicket.finishing` types (`MarkSpec`, `LabelSpec`, `MarkPreset`, `FinishingOverride`) | `src/schema.ts` |
| Label preview SVG (the body for `GET /jobs/:id/label-preview.svg`) | `src/label-preview.ts` |

Repo tooling (lint, licence and vendor-neutral checks) is deferred to Spec 001, which owns the shared root scripts.

### Acceptance tests → test files

1. Unit tests:
   - Grommet placement (2000 mm → 5 marks, 4 × 487.5 mm) plus fast-check properties: `test/grommets.test.ts`
   - Crop marks never intersect the bleed box (random boxes): `test/crop.test.ts`
   - Template fields, unknown fields, HTML escaping off, PDF escaping on: `test/template.test.ts`
   - QR and Data Matrix decoding (jsQR, Apache-2.0; ZXing, MIT), including a pdf.js render of the drawn code and the module-size check: `test/codes.test.ts`
2. PDF structure: OCG, Separation, and a pdf.js render with the OCG hidden that matches the unmarked imposition (±1/255) inside each trim box: `test/pdf-structure.test.ts`
3. Differential against `test/fixtures/expected-marks.json` (0.05 mm): `test/differential.test.ts`
4. Collision → `MarkCollisionError` before rendering: `test/collision.test.ts`
5. Lint, license check and vendor-neutral check are run by `pnpm check`.

Other tests: `mark-kinds.test.ts` (hem, sew, fold, custom), `metadata.test.ts` (FR3 reproducibility, FR7, hook), `presets.test.ts`, `reserve.test.ts`, `label-preview.test.ts`.

## Deferred

These packages don't exist in this branch yet (Specs 001–004 are not implemented here), so their integration is left for when they land:

- `packages/core`: add `finishing?: JobTicketFinishing` to `JobTicket`, importing the types from `@bax-print/marks`.
- `packages/nest` (Spec 003): pass `marksHook(...)` as `opts.marks`, and call `reserveSpace(...)` with the nester's margin reserver. `src/layout-types.ts` holds a structural copy of the hook context and placement shapes. Swap it for the real Spec 003 types once that package exists.
- `packages/cut` (Spec 004): pass its registration marks as `registration` to `draw()` / `planFinishing()`. Compose its hook before ours with `composeHooks()`.
- `apps/server`: `/mark-presets` CRUD (on top of `parsePreset`, `importPresets` and `exportPresets`) and `GET /jobs/:id/label-preview.svg` (on top of `labelPreviewSvg`).
- Device plugins (printers listed in their capability profiles; cutters through `CutterDriver/2`, which is unchanged): document where a plugin reads `labelCode` from `CutJob.options`, and how a RIP plugin routes or suppresses the `BPS-Marks` separation. Vendor and model names stay in `plugins/` and capability profiles.
- Glyph coverage: BPS Stroke covers printable ASCII. Other characters lose their diacritics or print as `?`, with a warning. A full OFL outline font can be added later if non-Latin labels are needed.

## Commands

Requires Node 22 and pnpm 10.

```sh
pnpm install
pnpm -r typecheck
pnpm -r build
pnpm --filter @bax-print/marks test   # or: pnpm test
pnpm check                            # lint + license check + vendor-neutral check
```

`@napi-rs/canvas` (a dev dependency for the pdf.js pixel test) ships prebuilt binaries and needs no build script. No lockfile is committed. All dependency versions are pinned exactly in `package.json`.

Commits must be signed off: `git commit -s`.
