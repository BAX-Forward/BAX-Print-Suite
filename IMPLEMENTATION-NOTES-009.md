# Implementation notes: Spec 009 (tiling and panels)

Branch: `feat/009-tiling-and-panels`. Spec: [`docs/specs/009-tiling-and-panels.md`](docs/specs/009-tiling-and-panels.md).

These files were written without running a shell. Nothing below has been installed, compiled or run yet. The first CI run is the first real check.

## Built

New pure package `packages/tile` (`@bax-print/tile`), with no vendor or device names:

| Requirement | Where | Notes |
|---|---|---|
| FR1 grid by count or max size; custom `seamsX[]` / `seamsY[]` | `src/tile.ts`, `src/axis.ts` | Explicit seams override the grid on their axis. Bad input comes back as `issues` and is never thrown. |
| FR2 overlap (default 25 mm) / butt / gap, set per seam | `src/axis.ts` | `seamTreatmentsX/Y` entries fall back to `seam`, then to a 25 mm overlap. A gap is centred on the seam. |
| FR3 visible vs printed accounting; device and medium validation | `src/tile.ts` | The printed size is always checked against `printableWidthMm`, `mediaWidthMm` and `maxLengthMm`. `allowRotation` turns a panel 90° only when that is the only way it fits. |
| FR4 auto-suggest | `src/suggest.ts` | Picks the fewest panels, then equal widths (`widthToleranceMm`), then fewest keep-out hits, then unrotated panels. |
| FR5 identity and labels | `src/labels.ts`, `src/marks.ts` | Labels run `A1`, `A2`, … in row-major order from the top-left. Rows go past Z as AA, AB, …. `panelTemplateFields()` gives `panel.row` / `panel.col` for Spec 006. `placePanelLabel()` puts the label in a hidden overlap strip. |
| FR6 seam ticks | `src/marks.ts` | Geometry only, in the panel frame. Spec 006 draws the ticks in the marks OCG. |
| FR7 output | `src/nest-item.ts`, `src/pdf.ts` | `toNestItems()` builds NestItem-shaped items with a `clipBox` and the id `<job>/panel/<r>-<c>`. `panelPdf()` writes one page per panel as a Form XObject (BBox = printed area) under a clip path, with nothing rasterized. Pass one panel to reprint just that panel. |
| FR8 cut paths | `src/clip.ts` | `clipContours()` / `contoursForPanels()`. Fragments get `clip: "open"`; contours entirely inside a panel are `whole` and keep their geometry. |
| FR9 templates | `src/template.ts` | `TileTemplate` JSON with `absolute` (mm) or `relative` (fraction) seams. `parseTileTemplate()` validates untrusted input. |

Acceptance tests (`packages/tile/test`):

1. Unit: `tile.test.ts` (3000 × 1000 mm → 3 columns, printed widths ≤ 1300, visible widths sum to 3000), `tile.property.test.ts` (fast-check: exact cover with no overlap, limits respected, custom seams kept), `labels.test.ts` (3 × 4 grid → `A1..C4`). There are also `suggest`, `marks`, `nest-item` and `template` tests.
2. Imposition: `pdf.test.ts` renders each panel with pdf.js and compares it with a crop of the full-page render (±3/255), including both neighbours' overlap strips and the bleed. It also checks the Form XObject and BBox structure and that the output contains no images.
3. Cut: `clip.test.ts`. A circle across an overlap or butt seam gives two `open` fragments. A contour inside one panel comes back unchanged within 0.01 mm.
4. Differential: `differential.test.ts` reassembles the panels virtually against the unsplit render. Visible pixels differing must be 0, with full coverage and no double coverage. The fixture is generated in code by `test/fixtures/artwork.ts`.
5. `license.test.ts` checks that direct dependencies are pinned and on the `docs/LICENSING.md` allowlist. `vendor-neutral.test.ts` scans the package against `scripts/vendor-names.json`, which lives outside `packages/` so the core package names no vendor.

Dependencies (pinned): `pdf-lib` 1.17.1 (MIT); dev only: `pdfjs-dist` 5.3.31 (Apache-2.0), `fast-check` 3.23.2, `vitest` 3.2.4, `typescript` 5.8.3, `@types/node` 22.15.3.

## Deferred

- **`packages/core`** (Spec 001) doesn't exist on this branch. `TileSpec`, `Panel` and `TileTemplate` live in `packages/tile/src/types.ts` for now and should move to core, with core re-exporting them, along with `JobTicket.tiling`.
- **`packages/nest`** (`impose()` honouring `clipBox`), **`packages/cut`** (moving `clipContours` there) and **`packages/marks`** (drawing labels and ticks) don't exist yet. `panelPdf()` stands in for clipped imposition until then.
- **Clipper2**: FR8 names polygon booleans with Clipper2, but its allowlist decision is still pending (Spec 003). Clipping a polyline to an axis-aligned panel rectangle only needs Liang–Barsky line clipping, so no new dependency was added. Swap it in if non-rectangular panels are ever needed.
- **`apps/server`** (`POST /jobs/:id/tiling`, `/tile-templates`, panels recorded on the job and in the Spec 008 history) and the **FR10 dashboard editor** are separate PRs, as the spec says.
- **Lint**: ESLint/Prettier setup belongs to Spec 001 and isn't on this branch. `tsc --noEmit` covers `src/`. Test files are only checked by Vitest's transpile.
- **Repo-wide vendor-neutral script** (`scripts/check-vendor-neutral.ts`, Spec 001): the shared name list is added here. The script itself, which also covers `apps/`, is still to do.

## Install and test

Node 22, pnpm 10. There is no lockfile yet, so the first install resolves the pinned versions:

```sh
pnpm install
pnpm --filter @bax-print/tile typecheck
pnpm --filter @bax-print/tile test
pnpm --filter @bax-print/tile build
```

The pdf.js render tests rely on `@napi-rs/canvas`, an optional dependency of `pdfjs-dist` that pnpm installs by default with prebuilt binaries. Don't install with `--no-optional`.
