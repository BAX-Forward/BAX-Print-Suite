# Roadmap

Pre-alpha. Dates are targets, not commitments. Each milestone ends with a tagged release and something you can run.

| ID | Milestone | Exit criteria | Depends on | Parallel track |
|---|---|---|---|---|
| **M1** | Intake and queue | Monorepo, plugin-sdk (BPP v1 types and conformance kit), job model and state machine, sqlite store, hot folders, REST API with OpenAPI, CLI, mock PrinterDriver, CI (Win and Linux, DCO, license check) | — | Foundation |
| **M2** | Dashboard plus RIP handoff | Web dashboard on the public API and SSE. "Hot-folder handoff" output driver that delivers print-ready PDFs to an existing RIP's watched folder | M1 | A |
| **M3** | Nesting | Rectangular, then true-shape nesting on roll width. Spacing, rotation, marks. Imposed-PDF output | M1 | B (parallel with M2, M4) |
| **M4** | Cut export | Contour extraction (named cut spot), registration marks, HPGL/HP-GL/2 and DXF export via CutterDriver | M1 (M3 for nested cuts) | C (parallel with M2, M3) |
| **M5** | Ghostscript render plugin plus preview | External-gs RenderEngine: banded planar output, spots/DeviceN, overprint sim. Preview thumbnails. GWG test-suite harness | M1 | D (parallel from M1) |
| **M6** | Color pipeline | LittleCMS ColorEngine: ICC/device links, N-color mapping, ink limits, linearization, white/varnish generation | M5 (interface only; can start on fixtures) | D′ |
| **M7** | Screening | Rust Screener: error diffusion (FS, serpentine), blue-noise threshold arrays, multi-level | BPP band contract (M1) | E (parallel from M1) |
| **M8** | First native printer driver | A PrinterDriver built through the vendor's developer program, in a separate repo (ADR-0005). The public repo gains only conformance improvements | M5–M7, vendor access | F (vendor application starts now) |

**Can run in parallel right after M1:** M2, M3, M4, M5, and M7. M6 trails M5. M8 needs vendor access, so start that application immediately.
