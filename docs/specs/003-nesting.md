# Spec 003: Nesting and roll-media layout (Milestone M3)

Target repo: **github.com/BAX-Forward/BAX-Print-Suite**. Read `docs/ARCHITECTURE.md` (§2 pipeline, §4 data model, §7 banding) first.

## Clean-room rule (read first)
Same as Spec 001. Implement from this spec, published algorithm literature (cited below), and public docs of the listed libraries. Don't study or mimic any commercial RIP's nesting behavior or UI. No commercial product names.

## Goal
`packages/nest`: a pure TypeScript library (no IO in the core algorithm) that places items on roll media and produces:
1. a **Layout** (placements, media length used, utilization %),
2. an **imposed PDF** (pdf-lib) with each item placed, ready for the render or handoff stage,
3. an **SVG preview**.

Media is generic: a **roll** (fixed width, open length) or a **sheet/bed** (fixed width and `maxLengthPt`, e.g. a flatbed working area or cut sheet). Overflow produces additional sheets or panels. No device vendor or model appears in this package; device limits come from capability profiles (ARCHITECTURE §3.8).

Phase 1 is rectangle nesting (bounding boxes). Phase 2 is true-shape nesting from cut contours, behind the **same `Nester` interface**.

## Dependencies on Spec 001 (and stubs)
| Needs | From | Stub if not merged |
|---|---|---|
| Job, page sizes (`pages[].widthPt/heightPt/trimBox`), stored PDF path | 001 `packages/core`, `packages/store` | `packages/nest` takes plain inputs (`NestItem[]`, byte arrays). It has **no** dependency on core for the algorithm. The adapter in `apps/server` maps jobs to items |
| Media record (roll width, margins) | ARCHITECTURE §4 `Media` (001 adds the type) | Local `RollMedia` type in `packages/nest`, re-exported or aliased once core has `Media` |
| Events / API | 001 server and event bus | API endpoints in Part D are added only after 001 merges. The library and CLI need nothing from 001 |
| Cut contours (phase 2) | Spec 004 `packages/cut` `Contour` type | Phase 2 only. Phase 1 doesn't need 004 |

**Parallelism:** Parts A–C (library, imposition, SVG, benchmarks) start immediately and in parallel with 001, 002, and 004. Part D (API, UI hook) waits for 001. Spec 004 consumes the imposition hook from Part B (`marks` callback), so publish that interface first (day 1).

## Part A: Model and algorithms

### Types (`packages/nest/src/types.ts`)
```ts
type Unit = number;            // PDF points (1/72 in) everywhere internally
interface RollMedia { widthPt: Unit; margins: {left: Unit; right: Unit; lead: Unit; trail: Unit}; maxLengthPt?: Unit }
type Rotation = 0 | 90 | 180 | 270;
interface NestItem {
  id: string; jobId?: string; pageIndex?: number;
  widthPt: Unit; heightPt: Unit;        // trim size (or bleed box, see bleedPt)
  bleedPt?: Unit;                        // extra on each side, included in the footprint
  quantity: number;                      // expanded into copies
  rotation: "none" | "90" | "any";       // allowed set: none={0}, 90={0,90}, any={0,90,180,270} (rect phase)
  lock?: { grain?: "along-roll" | "across-roll"; orientation?: Rotation }; // locks override `rotation`
  group?: string;                        // optional: keep same-group items adjacent (best effort)
  shape?: Polygon[];                     // phase 2 true-shape (outer + holes), ignored by rect nesters
}
interface NestOptions { gutterPt: Unit; algorithm: "maxrects" | "skyline" | "auto"; heuristic?: string;
  sort?: "area-desc" | "height-desc" | "width-desc" | "perimeter-desc" | "input"; seed?: number; timeBudgetMs?: number }
interface Placement { itemId: string; copy: number; xPt: Unit; yPt: Unit; rotation: Rotation; footprint: {w: Unit; h: Unit} }
interface Layout { placements: Placement[]; mediaWidthPt: Unit; lengthUsedPt: Unit;
  utilization: number;  // sum(item trim areas incl. bleed) / (usable width × lengthUsed), 0..1
  unplaced: {itemId: string; reason: "too-wide" | "max-length" | "locked-orientation"}[];
  algorithm: string; elapsedMs: number }
interface Nester { readonly id: string; readonly supportsShapes: boolean; nest(media: RollMedia, items: NestItem[], opts: NestOptions): Layout }
```
- **Coordinate system:** origin at the lead-edge left corner of the usable area (inside the margins). x runs across the roll, y along the feed (roll length). A placement's (x, y) is the footprint's bottom-left in that frame, **after rotation**.
- **Gutter:** the minimum gap between footprints. Implement by inflating each footprint by `gutter/2` per side and shrinking the usable width by `gutter` (so items can touch the margins), then deflating on output.
- **Locks:** `grain: "along-roll"` means the item's height axis must run along y, so only 0/180 are allowed. "across-roll" means 90/270. `orientation` fixes the exact rotation. Locks override `rotation`.
- **Validation:** an item that doesn't fit the usable width in any allowed rotation goes to `unplaced: too-wide`. No exceptions for user input errors.

### Algorithms (phase 1)
Strip packing (fixed width, minimize length):
1. **MaxRects** (Jylänki 2010): free-rectangle list, split and prune. Heuristics: Best Short Side Fit (BSSF), Best Long Side Fit, Best Area Fit, Bottom-Left. The roll is modeled as a bin of width W and length `maxLengthPt ?? sum(heights)`.
2. **Skyline** (Jylänki 2010): Bottom-Left and Min-Waste-Fit, with a waste map.
3. **auto:** run both algorithms across the heuristic × sort combinations within `timeBudgetMs` (default 500 ms) and return the layout with the smallest `lengthUsedPt` (tie: higher utilization, then fewer rotations). Deterministic given `seed`.
- Complexity target: 500 items in < 200 ms per single run on a mid-range laptop.
- Results must be deterministic: same input, same output (stable sorts, seeded RNG only).

### Phase 2 interface (design now, implement later)
- `TrueShapeNester implements Nester` with `supportsShapes = true`. It uses `item.shape` (from Spec 004 contours, offset by the gutter) and falls back to the bounding box when shape is absent.
- Planned approach: no-fit polygon (NFP) placement with a bottom-left fill and a genetic or local-search order (literature: Bennell & Oliveira 2008 tutorial). Polygon offset and boolean ops via **Clipper2** (Boost Software License 1.0). **Needs an addition to the license allowlist (BSL-1.0 is permissive). Maintainer decision.**
- Phase 2 must pass all phase 1 tests when shapes are rectangles.

## Part B: Imposition (`packages/nest/src/impose.ts`)
- `impose(layout, sources: Map<itemId, {pdfBytes, pageIndex, box: "trim"|"bleed"}>, opts) → Uint8Array (PDF)` using **pdf-lib** `embedPdf`/`embedPage` and `drawPage` with rotation.
- Output page size: width = roll width, height = lead margin + lengthUsed + trail margin. A single page (one roll segment). Split into multiple pages (panels) if `lengthUsed > maxLengthPt`.
- Clip each placement to its box (trim + bleed) so neighboring art doesn't overlap.
- Preserve: spot colors and DeviceN, optional content, and transparency groups. These come through because pages are embedded as Form XObjects. **Copy the first source's OutputIntent** to the output and warn (event plus layout warning) if the sources have conflicting OutputIntents. Note: pdf-lib may not carry every page-level resource (e.g. annotations are dropped by design). Document that limit.
- Write layout metadata into the output PDF as an XMP or `/BPS_Layout` document-info JSON entry (placements, version) so downstream steps can recover positions.
- **Marks hook (consumed by Spec 004):** `opts.marks?: (ctx: {page: PDFPage, layout, frame: {originX, originY, scale}}) => void | Promise<void>`. It's called after placements are drawn, in the same frame as Part A coordinates.

## Part C: SVG preview and CLI
- `toSvg(layout, {labels: true}) → string`: the media rect, margins (hatched), and each footprint with its id and rotation arrow. Width in px is configurable, and the viewBox is in points.
- CLI: `bps nest --roll 1626mm --margins 10mm --gutter 5mm --rotation any items.json -o out.pdf --svg out.svg --json layout.json`, where `items.json` is NestItem[] plus PDF paths. Units accept `mm|cm|in|pt`.

## Part D: Server integration (after 001)
- `POST /layouts {jobIds[], mediaId|roll, options}` → Layout plus an imposed PDF stored as a new derived Job (`sourceJobs[]` recorded, status `ready`). `GET /layouts/:id`, `GET /layouts/:id/preview.svg`. Added to OpenAPI. Emits `layout.created`.
- Dashboard (002) gets a "Nest selected" action only once 002 is merged (a separate small PR).

## Benchmarks (`packages/nest/bench`)
- **Generated perfect packings** (known optimum): recursively guillotine-split a W × L strip into n rectangles (n = 10, 25, 50, 100, 200; 10 seeds each), then shuffle. The optimum length is L (utilization 100%). We generate these ourselves, so there are no dataset license questions.
- **Literature sets:** the Hopper & Turton (2001) strip-packing instances have known optimal heights. Reference them only by **downloading in the bench script** if their terms allow. Don't commit them until their license is confirmed.
- **Shop-like mixes:** sizes from a seeded generator (e.g. 24×36, 18×24, 11×17, 36×48 in, banners 2×6 ft) at quantities 1–20 on a 64 in (1626 mm) roll.
- `pnpm --filter nest bench` prints a table: algorithm, heuristic, n, mean utilization, worst, length/optimum, time. Results go into `bench/RESULTS.md`, generated.

## Acceptance
1. **Unit:**
   - Trivial cases are exact:
     - 4 identical 10×10 in squares on a 20 in roll, gutter 0, give length = 20 in and 100% utilization.
     - A single item wider than the roll in all allowed rotations ends up in `unplaced: too-wide`.
     - An item 30 in wide on a 25 in roll with `rotation: "90"` and height 20 in is placed rotated.
   - No two footprints overlap (after inflation by the gutter). All placements are inside the usable area. Property test with `fast-check` (MIT), 1,000 random cases per algorithm.
   - Locks: `grain: along-roll` items never appear at 90/270. `orientation: 180` is honored.
   - Determinism: the same input and seed give byte-identical layout JSON.
2. **Utilization thresholds** (CI, generated perfect packings, `auto` with a 500 ms budget):
   - n ≤ 25: mean length/optimum ≤ 1.10.
   - n = 50–200: mean utilization ≥ **90%**, worst ≥ **85%**.
   - Shop-like mix (40 items): utilization ≥ **85%**.
   - Thresholds are written to `bench/thresholds.json`. Lowering them requires maintainer review.
3. **Performance:** a single MaxRects BSSF run with 500 items takes < 200 ms (CI tolerance ×3 on shared runners).
4. **Imposition:**
   - The output PDF opens in pdf-lib and pdf.js with the expected page size (±0.5 pt).
   - For a fixture with a spot color "TestSpot" and an OCG layer, the output still contains a `/Separation /TestSpot` color space and the OCG (checked by parsing resources).
   - Rendering the output with pdf.js and sampling the center pixel of each placement matches the source page's center color (±3/255) for unrotated and rotated placements.
   - The `/BPS_Layout` metadata round-trips.
5. **SVG:** valid XML. The number of `<rect class="item">` equals the number of placements. A golden snapshot for a fixed layout.
6. Marks hook: a test hook draws a 1 pt square at each placement's origin, and pdf.js sampling finds them at the expected positions.
7. Lint, license check, and the 001 CI matrix pass. No commercial product names.

## References (public)
- J. Jylänki, *A Thousand Ways to Pack the Bin: A Practical Approach to Two-Dimensional Rectangle Bin Packing* (2010).
- E. Hopper, B. Turton, "An empirical investigation of meta-heuristic and heuristic algorithms for a 2D packing problem," *EJOR* 128 (2001).
- J. A. Bennell, J. F. Oliveira, "The geometry of nesting problems: A tutorial," *EJOR* 184 (2008).
- pdf-lib docs: https://pdf-lib.js.org/ · Clipper2: https://github.com/AngusJohnson/Clipper2

## Out of scope
True-shape implementation (phase 2 of M3, a separate PR behind the same interface), sheet (non-roll) media and multi-roll optimization, tiling and paneling with overlap (future spec), color bars.
