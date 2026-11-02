# Implementation notes: Spec 003 (nesting and roll-media layout)

Scope of this change: Parts A–C of `docs/specs/003-nesting.md`, which cover the
`packages/nest` library, imposition, SVG preview, CLI and benchmarks, plus
their tests. Part D (server integration) is deferred. See below.

## What was built

`packages/nest` (`@bax-print/nest`, Apache-2.0). The only runtime dependency is
`pdf-lib` 1.17.1. The package has no dependency on other workspace packages and
contains no device vendor or model names.

| File | Purpose |
|---|---|
| `src/types.ts` | `RollMedia`, `NestItem`, `NestOptions`, `Placement`, `Layout`, `Nester` (spec types, extended as listed below) |
| `src/prepare.ts` | Input validation, rotation/lock resolution, copy expansion, sort orders, group adjacency, strip lower bound |
| `src/maxrects.ts` | MaxRects (Jylänki 2010): split and prune, with BSSF, BLSF, BAF and BL heuristics |
| `src/skyline.ts` | Skyline (Jylänki 2010): Bottom-Left and Min-Waste-Fit, with a waste map |
| `src/strip.ts` | Gutter inflation (usable width + gutter, footprint + gutter) and panel overflow for `maxLengthPt` |
| `src/auto.ts` | `auto`: every packer × sort combination, then seeded local search (swap, move and orientation flip). Stops at the lower bound, `maxIterations` or `timeBudgetMs` (default 500 ms) |
| `src/nesters.ts` | `MaxRectsNester`, `SkylineNester`, `AutoNester`, `createNester`, `nest()` |
| `src/layout.ts` | `Layout` assembly, utilization, and canonical `layoutToJson` (byte-identical for equal input and seed) |
| `src/rng.ts` | Seeded PRNG (mulberry32). No `Math.random` anywhere |
| `src/impose.ts` | `impose()`, `readLayoutMetadata()` and frame helpers |
| `src/svg.ts` | `toSvg()` |
| `src/units.ts`, `src/cli.ts`, `src/bin.ts` | `mm/cm/in/pt` parsing and the `bps nest` CLI (binary `bps-nest`; a leading `nest` argument is accepted) |
| `bench/` | Generated perfect packings (guillotine splits, n = 10…200, 10 seeds each), the shop-like mix on a 1626 mm roll, `thresholds.json`, a CI threshold test, and `run.ts`, which prints the table and writes `bench/RESULTS.md` |

### `impose()` signature

```ts
export async function impose(
  layout: Layout,
  sources: ReadonlyMap<string, ImposeSource>,
  opts: ImposeOptions = {},
): Promise<Uint8Array>;

export interface ImposeSource {
  readonly pdfBytes: Uint8Array;
  readonly pageIndex: number;
  readonly box: "trim" | "bleed";
}

export interface ImposeOptions {
  marks?: (ctx: MarksContext) => void | Promise<void>;
  onWarning?: (warning: ImposeWarning) => void;
}

export interface MarksContext {
  readonly page: PDFPage;   // pdf-lib page
  readonly layout: Layout;
  readonly frame: Frame;    // { originX, originY, scale }: page = origin + scale × (x, y)
  readonly panel: number;   // Layout.panels index shown on this page
}
```

`sources` is keyed by `NestItem.id`. Pages are embedded as Form XObjects through
pdf-lib `embedPage`. Each page is clipped to a footprint-sized box centered on
the requested source box, so `"trim"` plus `bleedPt` gives trim + bleed. Pages
are drawn with an exact quarter-turn matrix. Behavior:

- **Pages:** there is one page per panel. Page size is roll width × (lead + panel length + trail). The lead edge is at the bottom of the page.
- **Optional content:** OCGs from the sources are merged into the output catalog.
- **OutputIntents:** the first source's OutputIntents are copied. If sources disagree, `impose()` emits an `output-intent-conflict` warning.
- **Transparency groups:** a source page `/Group` is carried to the output page.
- **Layout metadata:** stored as JSON under `/BPS_Layout` in the document info dictionary, with fields `version`, `layout`, `pages` and `warnings`. `readLayoutMetadata()` reads it back.
- **Warnings:** a warning never throws. Each one is reported through `onWarning` and also stored in the metadata. The codes are `missing-source`, `unreadable-source`, `page-out-of-range`, `box-mismatch` and `output-intent-conflict`.

### Spec deviations and additions (all additive)

- **`impose` return type:** it returns `Promise<Uint8Array>`, because pdf-lib is async.
- **Type additions:**
  - `Placement.panel`.
  - `Layout.panels` and `Layout.media`.
  - `Unplaced.copies`.
  - A new unplaced reason, `invalid-size`, for NaN, negative or zero sizes and negative bleed. This keeps the rule of no exceptions for bad input.
  - A `maxside-desc` sort order.
  - `NestOptions.maxIterations`, a cap on the local search. Tests use it so their results don't depend on the machine.
- **Marks context:** `MarksContext` adds `panel`.
- **Rotation direction:** rotation is counter-clockwise, following the PDF convention.
- **Locks:** `orientation` overrides `grain`, which overrides `rotation`.
- **`auto` tie-break:** fewer overflow pieces, then shorter length, then fewer rotations. Utilization is fixed for a given set of placed pieces, so the utilization tie-break from the spec reduces to length.
- **Metadata format:** layout metadata is written as a document-info JSON entry, not XMP. The spec allows either.

### Documented limits

- **Annotations:** annotations (and `/B`, `/Thumb`, `/PieceInfo`, `/Metadata`, `/AA`, `/StructParents`) are dropped from embedded pages.
- **Page rotation:** a source page's `/Rotate` is not applied.
- **OC configuration:** merged OC configuration keeps `OCGs`, `Order` and `OFF`. Other default-config entries (`RBGroups`, `Locked`, `AS`) are not merged.
- **Groups:** `group` adjacency is best-effort, and it disables reordering moves in `auto`'s local search.
- **Time budget:** when `timeBudgetMs` cuts the search short, `auto` can vary between machines. With the iteration cap reached first, it is fully deterministic.

## Tests (Vitest)

| Acceptance | Test |
|---|---|
| 1 trivial cases, locks, determinism | `test/nest.test.ts` (each of maxrects, skyline, auto) |
| 1 no overlap / inside usable area, 1,000 fast-check cases per algorithm | `test/property.test.ts` |
| 2 utilization thresholds | `bench/thresholds.test.ts` + `bench/thresholds.json` |
| 3 MaxRects BSSF, 500 items < 200 ms (×3 when `CI` is set) | `test/performance.test.ts` |
| 4 page size (pdf-lib and pdf.js), `/Separation /TestSpot` + OCG, center-color sampling for 0/90/180/270 with and without bleed, clipping, OutputIntent, `/BPS_Layout` round-trip | `test/impose.test.ts` |
| 5 valid XML, `rect.item` count, golden output | `test/svg.test.ts` |
| 6 marks hook squares found by pdf.js sampling (two panels, async hook) | `test/impose.test.ts` |
| CLI and unit parsing | `test/cli.test.ts` |

Fixture PDFs are generated in `test/fixtures.ts` with pdf-lib, so no binary
fixtures are committed. `test/render.ts` renders with `pdfjs-dist` (legacy
build) on `@napi-rs/canvas`. It installs the `DOMMatrix`, `Path2D` and
`ImageData` globals and passes its own `CanvasFactory`.

**Not run in this session.** The session that wrote these files had no shell
access, so no command was run. The impose, SVG and CLI tests were written
without being executed. Run them before merging. The most likely point of
friction is the pdf.js/canvas setup in `test/render.ts` (the `CanvasFactory`
option name and the canvas polyfills differ between pdfjs-dist releases).

## Install, test, bench

```sh
pnpm install
pnpm --filter @bax-print/nest typecheck
pnpm --filter @bax-print/nest test
pnpm --filter @bax-print/nest build
pnpm --filter @bax-print/nest bench   # writes packages/nest/bench/RESULTS.md (generated, not committed)
```

CLI after the build:

```sh
node packages/nest/dist/bin.js nest --roll 1626mm --margins 10mm --gutter 5mm --rotation any \
  items.json -o out.pdf --svg out.svg --json layout.json
```

Dependencies are pinned to exact versions. No lockfile is committed.

## Deferred

- **Part D:** the `POST /layouts` and `GET /layouts/:id[/preview.svg]` endpoints, OpenAPI, the `layout.created` event and the dashboard action. All of these wait for Spec 001/002.
- **Phase 2 true-shape nesting:** `TrueShapeNester`, NFP and Clipper2. Only the `Nester` interface (`supportsShapes`, `NestItem.shape`) exists. Adding Clipper2 (BSL-1.0) to the license allowlist needs a maintainer decision.
- **Hopper & Turton (2001) benchmark instances:** these are not downloaded or committed until their license is confirmed.
- **Repository CI:** lint and license-check wiring and the 001 CI matrix are not part of this package change.
- **`bench/RESULTS.md`:** must be generated by running the bench.
- **`Media` alias:** `RollMedia` should be aliased to the core `Media` type once Spec 001 lands.
