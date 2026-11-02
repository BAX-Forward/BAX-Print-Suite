# Spec 009: Tiling oversized graphics into panels (Milestone M3 extension)

Target repo: **github.com/BAX-Forward/BAX-Print-Suite**. Read Spec 003 (layout, imposition) and Spec 004 (cut contours, panels) first.

## Clean-room rule (read first)
Same as Spec 001. Build from this spec, ISO 32000 (page boxes, Form XObjects, clipping) and generic installation practice for wallcoverings, murals and vehicle graphics. Don't copy any commercial RIP's tiling options, defaults, labels or editor. No commercial product names.

## Goal
`packages/tile`: split a graphic larger than the printable area into **panels** with seams, overlap or gap, labels and alignment marks, producing panel items that nest (Spec 003) and cut (Spec 004) like any other item.

## User stories
- As an installer, I want a 6 m wall mural split into panels that overlap so seams don't show gaps after the material shrinks.
- As a vehicle wrapper, I want seams moved away from door handles and body lines.
- As an operator, I want each panel numbered so the installer hangs them in order.
- As an operator, I want to reprint panel B3 alone after it's damaged.

## Functional requirements
- **FR1 Grid definition:** by panel **count** (columns × rows) or by maximum panel **size**; seams uniform or individually positioned (`seamsX[]`, `seamsY[]` in mm from the artwork origin).
- **FR2 Seam treatment** per seam: `overlap` (both neighbours extend by `overlapMm`; default 25 mm, roughly one inch, a common wallcovering and vinyl overlap that tolerates installer error and material movement), `butt` (0), or `gap` (positive spacing for e.g. framed sections).
- **FR3 Size accounting:** user chooses whether panel size limits refer to **visible** size or **printed** size (visible + overlap + bleed). Validation uses the printed size against the device profile's printable width and maximum length (capability profile, §3.8) and the medium width (Spec 005).
- **FR4 Auto-suggest:** propose the grid with the fewest panels satisfying the limits; tie-break on equal panel widths, then on seams avoiding a user-drawn "keep-out" region list (e.g. faces, text).
- **FR5 Panel identity:** each panel gets `row`, `col`, and a sequential index; label naming defaults to letter for row and number for column (`A1`, `A2`, …), the convention used on construction drawings. Labels use Spec 006 templates (`panel.row`, `panel.col`) and may be placed in the overlap area so they're hidden after install.
- **FR6 Alignment marks:** optional ticks at seam positions within the overlap, drawn via Spec 006 marks in the marks OCG.
- **FR7 Output:** each panel becomes a `NestItem` referencing the source page with a clip box (Form XObject + clip; no rasterization). Panels are individually printable and reprintable (Spec 008 records panel ids).
- **FR8 Cut paths:** source contours (Spec 004) are clipped to each panel's printed area with polygon booleans (Clipper2, allowlist decision pending per Spec 003); open fragments are flagged so the operator decides whether to cut them.
- **FR9 Templates:** save a grid definition (relative or absolute) as a reusable `TileTemplate` JSON.
- **FR10 Editor:** dashboard view with draggable seams, live panel dimensions and validation (separate PR after 002).

## Interfaces with existing packages and plugins
| Package | Change |
|---|---|
| `packages/tile` (new, pure) | `tile(page, TileSpec, limits) → Panel[]`; `suggest(...)` |
| `packages/nest` (003) | Accepts panel `NestItem`s; `impose()` honours each item's clip box |
| `packages/cut` (004) | `clipContours(contours, rect)` |
| `packages/marks` (006) | Panel labels and seam ticks |
| `packages/core` | `TileSpec`, `Panel`, `TileTemplate`; `JobTicket.tiling` |
| `apps/server` | `POST /jobs/:id/tiling` (preview), `/tile-templates`; panels recorded on the job |

## Acceptance tests
1. **Unit (Vitest):**
   - 3000 × 1000 mm art, max printed width 1300 mm, overlap 25 mm, `printed` accounting → 3 columns; each printed width ≤ 1300; visible widths sum to 3000.
   - Property test (fast-check): union of visible panel areas equals the artwork exactly, without overlap; every printed panel fits the limits; custom seams preserved.
   - Labels: grid 3 × 4 yields `A1..C4` in row-major order.
2. **Imposition:** pdf.js render of each panel matches the corresponding crop of the full-page render (±3/255 at sampled points), including the overlap strip present on both neighbours.
3. **Cut:** a circle spanning a seam is split into two fragments flagged `open`; a contour fully inside one panel is unchanged (geometry within 0.01 mm).
4. **Differential (own fixtures):** reassemble panels virtually (translate by seam offsets, discard overlap) and compare against the unsplit render: pixel diff 0 in visible areas.
5. Lint, license, vendor-neutral checks pass.

## References (public)
ISO 32000-2 §8.10 (Form XObjects), §8.5.4 (clipping); Clipper2 docs.

## Out of scope
Perspective/distortion compensation for curved surfaces; automatic content-aware seam placement (beyond keep-out regions); multi-medium panels in one job.
