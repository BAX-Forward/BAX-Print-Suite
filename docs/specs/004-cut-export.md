# Spec 004: Cut contour extraction and cut export (Milestone M4)

Target repo: **github.com/BAX-Forward/BAX-Print-Suite**. Read `docs/ARCHITECTURE.md` (§3.3 CutterDriver, §4) and ADR-0003 and ADR-0005 first.

## Clean-room rule (read first)
Same as Spec 001. Use only ISO 32000 (PDF), the public HP-GL/2 reference, the public AutoCAD R12 DXF reference, vendors' **publicly downloadable** user manuals (cited in `docs/research/cutter-integration.md`), and the library docs listed. Don't analyze any commercial RIP's or cut server's output files, or any cutter vendor's drivers. Vendor-specific cutter protocols that need an SDK go in separate repos (ADR-0005).

## Goal
1. `packages/cut`: extract cut contours from PDFs and flatten them into polylines.
2. `plugins/cutter-generic`: a **CutterDriver/2** plugin (roll and flatbed profile model) (separate process, BPP) that exports **HPGL** (HP-GL/2 subset) and **DXF R12 ASCII**.
3. Two vendor plugins, `cutter-summa-s2` and `cutter-summa-f`, built only on publicly documented behavior (Parts F–G).
4. Registration marks drawn into the imposed print PDF through Spec 003's marks hook, with cut coordinates expressed relative to those marks.

## Dependencies (and stubs)
| Needs | From | Stub if not merged |
|---|---|---|
| plugin-sdk: BPP framing, PluginHost, CutterDriver/2 types, conformance kit | 001 | Same minimal `plugin-sdk/src/stub.ts` as Spec 002, plus this CutterDriver/2 type (Part C). Must match ARCHITECTURE §3.3 |
| Job, stored PDF | 001 core and store | `packages/cut` takes `Uint8Array` PDFs. No core dependency |
| Layout plus `impose()` marks hook | 003 Part B | `SingleLayout` stub: one placement at (0, 0), rotation 0, of the job's page, plus a 10-line `imposeSingle()` that embeds the page with pdf-lib and calls the hook. Swap for 003 on merge |
| API and events | 001 server | Part E only, after 001 |

**Parallelism:** Part A (extraction) and Part C (exporters) start immediately, in parallel with 001–003. Part D (marks) needs only 003's hook signature, which 003 publishes on day 1. Part E waits for 001.

## Part A: Contour extraction (`packages/cut/src/extract.ts`)
- Parse PDFs with **pdf-lib** for object access and stream decoding. Implement our **own content-stream interpreter** (ISO 32000-1 §8–9 operators) that tracks only what we need:
  - Graphics state: `q`/`Q`, `cm`, current stroke and fill color spaces and colors (`CS`/`cs`/`SC`/`SCN`/`sc`/`scn`, and `G`/`g`/`RG`/`rg`/`K`/`k` to reset), line width (`w`).
  - Paths: `m l c v y h re`. Painting: `S s f F f* B B* b b* n`. Clipping is ignored for cut purposes, but recorded.
  - Form XObjects (`Do`) recursively, with their `/Matrix`. Images and text are skipped (text outlines aren't contours in M4).
  - Marked content: `BDC /OC /name` and `EMC`, resolving OCG names from `/Properties` (including OCMDs: use the member OCG names).
- **Contour selection** (config `CutConfig`):
  - `spotNames`: case-insensitive, whitespace- and underscore-insensitive match against Separation colorant names (and DeviceN single-colorant names). Default `["CutContour", "Thru-cut", "ThroughCut", "KissCut", "Kiss-cut"]`.
  - `layerNames`: OCG names. Default `["CutContour", "Cut", "Thru-cut"]`.
  - A path counts as a contour when it's **stroked or filled** while the current color space is a matching spot, **or** it lies inside a matching OC layer. Default: it must be **stroked** for the layer rule, configurable.
  - Tool mapping: `toolMap: { [nameOrLayer]: "kiss" | "thru" | "crease" | "pen" }`. Defaults: `CutContour` and `KissCut` map to kiss, `Thru-cut` and `ThroughCut` map to thru.
- **Flattening:** cubic Béziers are flattened by adaptive subdivision until the max distance from chord to curve is ≤ `tolerancePt` (default **0.1 mm ≈ 0.283 pt**). `re` becomes 4 segments. Apply the CTM to user space, and the page's `/Rotate` and `/UserUnit`.
- **Box:** contours are expressed relative to the page **TrimBox** (fallback CropBox, then MediaBox) bottom-left, in points. Contours fully outside the box are reported as warnings.
- **Output:** `Contour { id, tool, source: {kind: "spot"|"layer", name}, closed: boolean, points: [x, y][] /* pt */, bbox, areaSigned }`.
- **Cleanup:** merge consecutive duplicate points (< 0.01 pt). Close paths whose end is within `closeTolerancePt` (default 0.1 mm) of the start. Drop zero-length contours.

## Part B: Path ordering and direction (`packages/cut/src/order.ts`)
- **Direction:** config `direction: "ccw" | "cw" | "keep"` (default `ccw` in the cutter frame, after the origin and axis transform in Part C). Closed contours are reversed as needed using the signed area.
- **Inside-first:** contours entirely contained in another (point-in-polygon on bbox and first vertex) are cut **before** their container, so parts don't move before their holes are cut. Through-cuts always come last within their group, after kiss-cuts.
- **Travel optimization:** greedy nearest-neighbor from the origin, constrained by the inside-first order and by tool order (`toolOrder`, default `["pen", "crease", "kiss", "thru"]`). For closed contours, rotate the start vertex to the nearest point (or to a corner if `startAtCorner`).
- **Optional:** `overcutMm` (default 0) extends a closed contour past its start along the first segment(s).

## Part C: CutterDriver/2 and the generic plugins (`plugins/cutter-generic`)
CutterDriver/2 supersedes the 1.x sketch in ARCHITECTURE (pre-1.0, nothing ships on /1). One interface covers **roll** and **flatbed** cutters through a declared profile. Core never branches on vendor or model.

### Interface (added to plugin-sdk)
```ts
type MachineClass = "roll" | "flatbed";
interface ToolDef { id: string; kind: "drag-knife" | "tangential-knife" | "kiss" | "thru" | "crease" | "perforate" | "pen" | "router" | "drill" | "v-cut" | string;
  params: { speed?: Range; force?: Range; depth?: Range; offset?: Range; passes?: Range }; module?: string /* flatbed module slot */ }
interface Range { min: number; max: number; unit: string; step?: number }
interface RegistrationModel {
  methods: ("none" | "corner-marks" | "edge-mark-rows" | "camera-marks" | "camera-contour" | string)[];
  markShapes?: ("circle" | "square")[]; markSizeMm?: Range;
  supportsDeformationComp?: ("x" | "xy" | "segmented")[];   // e.g. scale along feed only, both axes, per-segment
  barcodeJobId?: { supported: boolean; documented: boolean }; // vendor barcode formats are plugin-private
}
interface CutterProfile {
  class: MachineClass;
  workArea: { widthMm: number; lengthMm?: number /* flatbed bed length; roll: undefined = open */ };
  roll?: { maxPanelLengthMm?: number; supportsSheetOff?: boolean; supportsPanelAdvance: boolean; loadOrigin: Corner };
  flatbed?: { bedOrigin: Corner; vacuumZones?: number; conveyor?: boolean };
  tools: ToolDef[]; toolSlots?: number;
  registration: RegistrationModel;
  delivery: ("file" | "folder-import" | "usb" | "tcp" | "serial" | string)[];   // how jobs reach the machine
  formats: string[];   // e.g. ["hpgl","dxf"]; plugin-specific ids allowed
}
interface CutJob {
  jobId: string; contours: Contour[];      // contour.tool = a semantic tool ("kiss","thru",...)
  toolMap: Record<string, { toolId: string; speed?: number; force?: number; depth?: number; passes?: number }>;
  frame: CutFrame; marks?: RegistrationMarks;
  segmentation?: { panels: { y0Mm: number; y1Mm: number; marks: string[] }[] };   // roll panels / flatbed conveyor steps
  options: Record<string, unknown>
}
interface CutterDriver {
  describe(deviceConfig) => CutterProfile;              // static from manifest + dynamic (detected) values
  formats(): {id, mime, ext, optionsSchema: JSONSchema}[];
  export(job: CutJob, format: string) => {handle, bytes, sha256, warnings: string[]};
  send?(job: CutJob, deviceConfig) => {status: "delivered"|"failed", detail?};   // folder drop, raw TCP, USB...
  getStatus?(deviceConfig) => {state: "ready"|"busy"|"offline"|"unknown", reason?};
  cancel?(jobId) => void;
}
```
- **Panels and segmentation (core, generic):** for roll jobs longer than `roll.maxPanelLengthMm` or with registration rows, core splits contours into panels by y-range (contours crossing a boundary are assigned to the panel containing their bbox max, or split if `allowSplit`). Each panel references its own marks. Flatbed jobs longer than `workArea.lengthMm` split the same way into conveyor steps if `flatbed.conveyor`, otherwise the job fails validation.
- **Validation:** core checks job extent vs. work area, tools in `toolMap` exist in the profile, parameter values fall inside `Range`, and registration method is supported. All errors are reported before export.
- **Plugins shipped in the public repo:** `cutter-generic` (formats `hpgl`, `dxf`; delivery `file` and `folder-import`, optional raw `tcp`/`serial` passthrough of the generated HPGL to a user-configured endpoint) and vendor plugins in Parts F–G, which only declare profiles and map generic options to documented commands or import formats.

### Units, origin, axes (shared options)
- `origin: "bottom-left" | "top-left" | "bottom-right" | "top-right"` (default bottom-left), `swapXY: boolean` (default false; for cutters whose X axis is the feed axis), `offsetMm: [x, y]`, `scale: [sx, sy]` (default 1, for calibration).
- If marks are present, the origin is the **origin mark center** (Part D), otherwise the frame corner.
- Coordinates are rounded to the output unit with half-away-from-zero rounding. The rounding is documented and golden-tested.

### HPGL export (`format: "hpgl"`)
- HP-GL/2 subset: `IN;`, then per tool `SP<n>;` where `n` comes from `penMap` (default `kiss=1, thru=2, crease=3, pen=4`), `PU x,y;`, `PD x1,y1,x2,y2,...;` (≤ 256 coordinate pairs per `PD`, then continue), `PU;` at the end, `SP0;`.
- Units: plotter units, **40 per mm (1016 per inch)**, integers.
- Optional `VS<speed>;` and `FS<force>;` are only emitted if set in options and marked "device-dependent" in the schema (`FS` isn't part of the HP-GL/2 base set. Cutters vary).
- Line ending option: `""` | `"\n"` (default `"\n"` after each `;`, for readability).
### DXF export (`format: "dxf"`)
- AutoCAD **R12 ASCII** (`$ACADVER AC1009`), with CRLF line endings, a minimal `HEADER` (`$ACADVER`, `$EXTMIN`, `$EXTMAX`), a `TABLES` section with a `LAYER` table defining one layer per tool (`CUT_KISS`, `CUT_THRU`, `CREASE`, `PEN`; names configurable), and `ENTITIES` as `POLYLINE` (flag 1 if closed) + `VERTEX` + `SEQEND` (`LWPOLYLINE` is R14+, so it's not used).
- Units: **mm** by default (option `in`). R12 has no `$INSUNITS`, so units are stated in a `999` comment and in the plugin docs.
- Numbers: fixed 4 decimals, `.` decimal separator regardless of locale.

## Part D: Registration marks (`packages/cut/src/marks.ts`)
- An open, generic mark set (not vendor-specific): **solid filled circles** in 100% K, plus an optional `Registration`-colorant variant.
  - `diameterMm` (default 5), `insetMm` from the layout edges (default 10), and `pattern: "corners-4" | "corners-3" | "edges-n" | "edge-rows"`, plus `shape: "circle" | "square"` (`edge-rows` = rows of marks down both long edges with optional bottom/top/intermediate cross lines, for sensor-based roll registration) (`edges-n` adds intermediate marks every `spacingMm`, default 500, along both long edges for long rolls).
  - `corners-3` omits the top-right mark, a common orientation cue.
  - An optional thin `crop` line at the start and end for manual alignment.
- Marks are drawn through Spec 003's `impose()` marks hook. The layout reserves the mark zone by adding `insetMm + diameterMm + clearanceMm` (default clearance 3 mm) to the margins. If the margins are smaller, they're increased automatically, with a warning.
- `RegistrationMarks { marks: {id, xPt, yPt, dPt}[], originMarkId }` is returned and saved with the layout, then passed to `CutJob`. Cut coordinates are transformed into the **mark frame**: layout placement transforms (translation and rotation from Spec 003) apply to each job's contours, then translate to the origin mark.
- Vendor-specific mark systems (barcodes, OPOS-like lines, camera targets) are **out of scope** for this repo unless their specs are publicly documented. Those go in separate plugins.

## Part E: Server integration (after 001)
- `POST /jobs/:id/cut-export {format, options}` and `POST /layouts/:id/cut-export` (after 003) → creates step `cut` → the plugin `export` → stored artifact, `GET /artifacts/:id`. Events `step.*`. OpenAPI updated.
- Hot-folder setting `cut: {enabled, format, options}` auto-exports when a job becomes `ready`.

## Part F: `plugins/cutter-summa-s2` (roll cutter, documented commands only)
Source basis: public Summa S Class 2 user manual and Summa Cutter Tools manual (see `docs/research/cutter-integration.md`). No partner-only material is used in this repo.
- **Profile:** `class: roll`, work area from device config (model width, e.g. 160 cm class; user-entered, since remote query requires undocumented commands), tools `drag-knife`, `pen`, `pouncing` (tangential-knife models: `tangential-knife`), registration `edge-mark-rows` (sensor) with `supportsDeformationComp: ["x","xy","segmented"]`, `barcodeJobId: {supported: true, documented: false}`, delivery `["file","usb","tcp"]`, formats `["hpgl"]`.
- **Implemented (public basis):** output in **HP-GL / HP-GL/2** (the S2 language menu must be set to HP-GL or HP-GL/2, which is documented). Tool selection via `SP<n>;` (works when the cutter's "Tool command" setting is enabled, which is documented). Velocity `VS` only if the user opts in. Force and offset are set **on the cutter or in Summa's tools**, by default not sent.
- **Delivery:** `file` (always), plus `tcp` raw-socket send to a user-entered host and port and `usb` via an OS printer queue or device path chosen by the user. The manuals document USB and Ethernet connectivity but not the raw-TCP port or protocol. **Stub until verified on Erik's machine** (black-box test with our own HPGL only; no reverse-engineering of Summa software).
- **OPOS contour registration: optional stub.** Mark appearance (squares, X/XY/XY2/XYXtra row layouts) is publicly described, but the command sequence that starts OPOS reading and the exact mark geometry and tolerances are not in public docs. Ship `registration: "edge-mark-rows"` as `experimental: true`, disabled by default. The mark *drawing* uses Part D's generic edge-rows pattern with configurable square size and spacing. Enable it only after Summa provides documentation that permits open implementation, or obtain it in a separate private plugin (ADR-0005).
- **DM/PL: optional stub.** It's Summa's preferred language, but no public command reference was found. The format id `dmpl` is reserved and returns `unsupported` until documented.
- **Barcode job identification: not implemented** (undocumented format, activation-code-locked feature).
- **Workaround that is fully supported:** export HPGL plus a print PDF with generic marks to a folder for Summa's own cutter software to drive OPOS and the barcode workflow. This keeps OPOS working today with no vendor code in our repo.

## Part G: `plugins/cutter-summa-f` (flatbed, documented import path)
Source basis: the public GoProduce (Flatbed Edition) user manual and release notes.
- **Profile:** `class: flatbed`, `workArea` from device config (bed size per model, user-entered), tools/modules from device config (catalog of generic kinds: `drag-knife`, `tangential-knife`, `kiss`, `thru`, `crease`, `perforate`, `router`, `drill`, `v-cut`, `pen`), registration `["camera-marks","none"]`, `markShapes: ["circle"]`, delivery `["folder-import"]`, formats `["pdf-cut","dxf"]`.
- **Job delivery:** we **don't drive the machine.** GoProduce (proprietary) stays the machine controller. The plugin writes files into a GoProduce **hot folder** (a documented import mode; requires Summa's paid Pro Pack) or a folder the operator opens manually (basic edition imports PDF, DXF, SVG).
- **PDF cut file (`pdf-cut`):** one optional-content layer per method/tool, named from `toolMap` (e.g. `Thru-cut`, `Kiss-cut`, `Crease`), a `Regmark` layer with **5 mm circles** (the publicly documented default GoProduce looks for on that layer), and no print data (or print data on an excluded layer). Open paths within 0.5 mm get closed (matches documented import behavior).
- **DXF:** one layer per method, plus `TEXT` labels optional (documented import feature).
- **Layer/method naming** is user-configurable, because GoProduce maps layers to methods in its own material and action settings.
- **Barcode-driven job load: optional.** GoProduce documents barcode import with file names of 8–13 characters. We support a generic **Code 39** job-id barcode in the print marks (an open symbology) and name the cut file to match. Camera-read barcode format details beyond that are undocumented, so it's marked `experimental`.
- **SDK: excluded.** A "GoProduce SDK programmer guide" exists on Summa's support site. Its license terms aren't reviewed, so it is **not** used in the public repo. Any SDK integration goes in a separate private plugin (ADR-0005).

## Fixtures and goldens (`packages/cut/test/fixtures`, generated)
Generated in tests with pdf-lib by writing raw content streams (no third-party files):
1. `rect-spot.pdf`: a 100×50 mm rectangle stroked in `/Separation /CutContour`, art underneath in CMYK.
2. `circle-bezier.pdf`: a circle of radius 40 mm from 4 cubic Béziers, in spot `CutContour`.
3. `nested-thru.pdf`: an outer rounded rect in `Thru-cut` with two inner circles in `CutContour`.
4. `layer.pdf`: a path in an OCG named `Cut`, using a non-spot color.
5. `form-xobject-rotated.pdf`: a contour inside a Form XObject with a `/Matrix` rotation of 30°, the page `/Rotate 90`, and a TrimBox offset.
6. `decoys.pdf`: a `CutContour` name used on a *fill-only image mask*, plus a similar spot name `Cut Contour 2`, which must be excluded unless configured.
Goldens: `*.hpgl` and `*.dxf` with LF/CRLF exactly as specified. Updated only with `UPDATE_GOLDEN=1` and reviewer approval.

## Acceptance
1. **Extraction:**
   - (1): 1 closed contour, tool kiss, bbox 100×50 mm ±0.05 mm.
   - (2): max radial deviation from a true circle ≤ tolerance + 0.01 mm. Point count grows as tolerance shrinks (0.5 mm vs. 0.05 mm).
   - (3): 3 contours, with 2 kiss inside 1 thru.
   - (4): extracted via the layer rule.
   - (5): coordinates match the analytically transformed expected values ±0.02 mm.
   - (6): matches only per the spec rules.
2. **Ordering:** inner contours come before outer ones. Kiss comes before thru. All closed contours are CCW in the output frame (signed area > 0) by default and CW when configured. Overcut extends by the requested length ±0.05 mm.
3. **HPGL:** goldens match byte for byte. Parsing our own output with a small test parser reproduces the contours ±1 plotter unit. The `PD` chunking limit is honored. Pen numbers follow `penMap`.
4. **DXF:** goldens match byte for byte. The file parses with `dxf-parser` (MIT, dev-only) and has the expected layers, entity count, closed flags, and vertices ±0.0001 mm.
5. **Origins and axes:** for each of the 4 origins × swapXY, the rectangle fixture's corners map to the expected coordinates (table test).
6. **Marks:** the imposed PDF (003 or the stub) contains marks at the expected positions (pdf.js render sampling: dark pixel at each mark center, light at center ± 1.5 × radius). Cut coordinates relative to the origin mark equal (placement position - mark position) ±0.05 mm, including for a 90°-rotated placement.
7. **Plugin:** `cutter-generic` passes the CutterDriver conformance kit (added by this spec), runs as a separate process, and its artifact sha256 matches the returned value.
8. **Profiles:** `cutter-generic`, `cutter-summa-s2`, and `cutter-summa-f` each pass the CutterDriver/2 conformance kit. Core validation rejects: a job wider than the work area, an unknown tool, an out-of-range force, and an unsupported registration method (table test with roll and flatbed fake profiles).
9. **Panels:** a 5 m roll job with `maxPanelLengthMm: 1500` splits into 4 panels. Every contour appears exactly once. Panel marks are present.
10. **summa-f PDF cut file:** layers named per `toolMap`. `Regmark` layer has 4 circles of 5 mm ±0.01. No content outside cut layers (pdf-lib inspection). Golden file.
11. **summa-s2:** HPGL golden with `SP` per tool. `dmpl` and OPOS options return `unsupported` / `experimental-disabled` unless explicitly enabled.
12. **Vendor-neutral check:** no vendor names in `packages/cut` (CI script from 001).
13. Lint, license check, and the 001 CI matrix pass. No commercial product names.

## References (public)
- ISO 32000-1:2008 (PDF 1.7), §8 Graphics, §8.6.6.4 Separation, §8.11 Optional Content. (Adobe's public PDF 1.7 reference copy.)
- *The HP-GL/2 and HP RTL Reference Guide* (HP, public).
- AutoCAD Release 12 DXF reference (public).

## Out of scope
Live sending beyond file/folder and user-configured raw TCP/serial passthrough, undocumented vendor languages and mark systems (separate private plugins if partner docs are obtained), text-to-outline contours, automatic contour generation from images (alpha or edge tracing; future spec), and true-shape nesting (003 phase 2).
