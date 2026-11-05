# Feature matrix

Status of every planned BAX Print Suite capability across the wide-format print-production workflow. Updated as work lands. "Implemented" means merged on main with tests. Hardware is described by capability profile, not by vendor or model; vendor-specific drivers live in plugins/.

**163 capabilities:** Implemented 81, Planned 63, Blocked 19

Specs: 001 queue and hot folders, 002 dashboard and RIP handoff, 003 nesting, 004 cut export, 005 media library and profiling, 006 finishing marks and labels, 007 preflight and job editor, 008 archive and reprint, 009 tiling and panels, 010 named spot libraries, 017 cost estimation and accounting, 022 profiler accuracy report (report-only). Milestones are from [ROADMAP.md](ROADMAP.md); "—" means not yet scheduled.

## Intake

| Capability | Status | Spec | Milestone | Priority | Capability profile | Notes |
|---|---|---|---|---|---|---|
| Per-printer hot folders | Implemented | 001 | M1 | P0 | All printers; roll printer profile first |  |
| Hot-folder settings presets (per-folder job defaults) | Implemented | 001 | M1 | P0 | All |  |
| Hot-folder file-stability detection and partial-write handling | Implemented | 001 | M1 | P0 | All |  |
| Duplicate and resubmission detection | Implemented | 001 | M1 | P1 | All |  |
| Job submission REST API with OpenAPI 3.1 | Implemented | 001 | M1 | P0 | All |  |
| Command-line job submission | Implemented | 001 | M1 | P0 | All |  |
| PDF intake (PDF 1.3–2.0, PDF/X) | Implemented | 001 | M1 | P0 | All |  |
| PostScript and EPS intake | Planned | unassigned | M5 | P1 | All | Needs external Ghostscript (AGPL, user-installed) |
| TIFF, JPEG and PNG raster intake | Planned | unassigned | M5 | P1 | All |  |
| SVG and DXF vector intake | Planned | unassigned | M4 | P2 | Flatbed cutter workflows |  |
| JDF/JMF job ticket intake | Planned | unassigned | — | P2 | All | Proposed spec 012 |
| Network print driver (print from desktop apps) | Planned | unassigned | — | P2 | All | Proposed spec 013 |
| Web upload portal for customers and staff | Planned | unassigned | — | P2 | All | Proposed spec 013 |
| Email-to-job intake | Planned | unassigned | — | P2 | All | Proposed spec 013 |
| Job metadata fields (job number, customer, company) | Implemented | 001 | M1 | P0 | All |  |

## Preflight and normalization

| Capability | Status | Spec | Milestone | Priority | Capability profile | Notes |
|---|---|---|---|---|---|---|
| Preflight inspection (fonts, images, resolution, boxes) | Implemented | 007 | M5 | P0 | All | Implemented (007a1, 007a2, 007c, 007d) |
| PDF/X and PDF/A conformance checks | Implemented | 007 | M5 | P1 | All | Implemented (007a1) |
| Normalization presets (PDF/X-1a, X-3, X-4) | Planned | 007 | M5 | P1 | All |  |
| Automatic fixups (missing bleed, RGB to CMYK, flatten) | Planned | 007 | M5 | P1 | All |  |
| Low-resolution image warnings at output size | Implemented | 007 | M5 | P1 | All | Implemented (007a1) |
| Spot color and cut-spot detection report | Implemented | 007 | M4 | P0 | Roll and flatbed cutters | Implemented (007a1); spot-library check 010b (#32) |
| Font embedding check and outlining | Planned | 007 | M5 | P2 | All | Embedding check implemented (007a1); outlining not built |
| Preflight report (JSON plus human-readable) | Implemented | 007 | M5 | P1 | All | Implemented (007a1, 007d server routes, #22) |

## Job editing

| Capability | Status | Spec | Milestone | Priority | Capability profile | Notes |
|---|---|---|---|---|---|---|
| Per-job scale, rotate, mirror | Implemented | 007 | M3 | P0 | All | Implemented (007b edits) |
| Crop and page-box selection | Implemented | 007 | M3 | P1 | All | Implemented (007b edits) |
| Bleed generation (mirror/stretch edge) | Implemented | 007 | M3 | P1 | All | Implemented (007b edits) |
| Add or edit cut contour on a job | Planned | 007 | M4 | P0 | Roll and flatbed cutters |  |
| Per-job color adjustments (curves, brightness) | Planned | 007 | M6 | P2 | All |  |
| Spot color replacement and remapping per job | Implemented | 007 | M6 | P1 | All | Implemented (007b spotMap edit) |
| Multi-page job handling and page selection | Planned | 007 | M3 | P1 | All |  |
| Job editor with live preview | Planned | 007 | M5 | P1 | All |  |

## Layout

| Capability | Status | Spec | Milestone | Priority | Capability profile | Notes |
|---|---|---|---|---|---|---|
| Rectangular nesting on roll width | Implemented | 003 | M3 | P0 | Roll printer (rolls) |  |
| True-shape nesting | Implemented | 003 | M3 | P1 | Roll printer; roll cutter |  |
| Nesting spacing, rotation and margin controls | Implemented | 003 | M3 | P0 | All |  |
| Auto-nest across jobs sharing media | Implemented | 003 | M3 | P1 | All |  |
| Nest yield and media-use report | Implemented | 003 | M3 | P1 | All |  |
| Imposed PDF output for nests | Implemented | 003 | M3 | P0 | All |  |
| Saved and reusable layouts | Planned | 003 | M3 | P1 | All |  |
| Interactive layout editor (drag, lock, reorder) | Implemented | 002 | M3 | P1 | All |  |
| Step and repeat | Planned | 003 | M3 | P1 | All |  |
| Tiling into panels | Implemented | 009 | M3 | P0 | Roll printer |  |
| Tile overlap and white-space overlap | Implemented | 009 | M3 | P0 | Roll printer |  |
| Custom tile maps (unequal panels) | Implemented | 009 | M3 | P2 | All |  |
| Panel numbering and assembly labels | Implemented | 009 | M3 | P1 | All |  |
| Booklet and sheet imposition (n-up, signatures) | Planned | unassigned | — | P2 | Sheet-fed devices | Proposed spec 014 |
| Proof watermark option | Planned | unassigned | M2 | P2 | All |  |

## Color

| Capability | Status | Spec | Milestone | Priority | Capability profile | Notes |
|---|---|---|---|---|---|---|
| ICC color conversion (LittleCMS) | Planned | unassigned | M6 | P0 | All |  |
| Rendering intents and black-point compensation | Planned | unassigned | M6 | P0 | All |  |
| Device link profiles | Planned | unassigned | M6 | P1 | All |  |
| Color workflow levels (ICC only to full custom) | Implemented | 005 | M6 | P1 | All | Implemented (005b characterization levels) |
| Named spot color libraries (user-supplied CxF/ASE) | Implemented | 010 | M6 | P1 | All | Implemented for CxF (010a #31, 010b #32); ASE not supported |
| Proprietary spot library emulation (commercial libraries) | Blocked | unassigned | — | P2 | All | Blocked: commercial library licensing; legal review |
| Spot color to N-channel (DeviceN) mapping | Planned | unassigned | M6 | P1 | All |  |
| Ink limits (total and per channel) | Implemented | 005 | M6 | P0 | Roll printer | Implemented (005b) |
| Ink restriction per channel | Implemented | 005 | M6 | P1 | All | Implemented (005b channel limits) |
| Linearization and calibration curves | Blocked | 005 | M6 | P0 | Roll printer | Blocked: needs the shop's spectrophotometer model and access |
| Printer-side color calibration via vendor SDK | Blocked | unassigned | M8 | P1 | Roll printers (all profiles) | Blocked: printer vendor partner SDK |
| ICC profile creation with a spectrophotometer | Blocked | 005 | M6 | P1 | All | Blocked: spectro access; ArgyllCMS (AGPL) as separate program |
| Spectrophotometer driver plugins | Blocked | unassigned | — | P1 | All | Blocked: spectro model and SDK licence; proposed spec 011 |
| G7 calibration and gray balance | Blocked | unassigned | — | P2 | All | Blocked: spectro access; proposed spec 011 |
| Print verification and standards simulation | Blocked | unassigned | — | P2 | All | Blocked: spectro access; proposed spec 011 |
| Swatch book and color chart printing | Planned | unassigned | — | P2 | All | Proposed spec 010 |
| White ink generation (spot, flood, choke) | Planned | unassigned | M6 | P1 | Roll printer, white-ink profile | Proposed spec 015 |
| Varnish/overcoat channel handling | Planned | unassigned | M6 | P2 | Roll printer, overcoat profile | Proposed spec 015 |
| Color-white-color sandwich jobs | Planned | unassigned | — | P2 | Roll printer, white-ink profile | Proposed spec 015 |
| Backlit day/night multi-layer jobs | Planned | unassigned | — | P2 | All | Proposed spec 015 |
| Overprint simulation | Planned | unassigned | M5 | P1 | All |  |
| 16-bit color processing | Planned | unassigned | M6 | P1 | All |  |
| Soft proofing on screen | Planned | unassigned | M6 | P2 | All |  |

## RIP and rendering

| Capability | Status | Spec | Milestone | Priority | Capability profile | Notes |
|---|---|---|---|---|---|---|
| PDF render engine plugin (Ghostscript, external) | Planned | unassigned | M5 | P0 | All | Ghostscript AGPL: optional, user-installed, never linked |
| PostScript render path | Planned | unassigned | M5 | P1 | All | Same Ghostscript constraint |
| Commercial PDF engine plugin slot | Blocked | unassigned | — | P2 | All | Blocked: vendor licence; legal review |
| Banded streaming render (planar bands by file) | Planned | unassigned | M5 | P0 | All |  |
| Transparency and blend-mode rendering | Planned | unassigned | M5 | P0 | All |  |
| Preview thumbnails and screen previews | Implemented | 002 | M2 | P0 | All |  |
| Error diffusion screening | Planned | unassigned | M7 | P0 | All |  |
| Blue-noise and threshold-array screening | Planned | unassigned | M7 | P1 | All |  |
| Multi-level (variable dot) screening | Planned | unassigned | M7 | P1 | Roll printer |  |
| Custom halftone/screening sets per mode | Planned | unassigned | M7 | P2 | All |  |
| Print-while-RIP | Planned | unassigned | M5 | P1 | All |  |
| Multi-RIP parallel processing on one host | Planned | unassigned | M5 | P1 | All |  |
| Distributed RIP workers (server plus workers) | Planned | unassigned | — | P2 | All | Proposed spec 016 |
| GWG test-suite conformance harness | Planned | unassigned | M5 | P1 | All |  |

## Print

| Capability | Status | Spec | Milestone | Priority | Capability profile | Notes |
|---|---|---|---|---|---|---|
| Hot-folder handoff to an existing RIP | Implemented | 002 | M2 | P0 | Roll printer |  |
| Mock printer driver for tests | Implemented | 001 | M1 | P0 | None |  |
| Printer driver plugin interface | Implemented | 001 | M1 | P0 | All |  |
| Native roll printer driver | Blocked | unassigned | M8 | P0 | Roll printer | Blocked: printer vendor partner SDK application |
| Native roll printer driver, CMYK profile | Blocked | unassigned | M8 | P1 | Roll printer, CMYK profile | Blocked: printer vendor partner SDK application |
| Other printer driver families | Blocked | unassigned | — | P2 | Other printers | Blocked: vendor developer programs |
| Per-printer queues | Implemented | 001 | M1 | P0 | All |  |
| Printer status and ink levels | Blocked | unassigned | M8 | P1 | Roll printers (all profiles) | Blocked: printer vendor SDK; vendor cloud API as interim |
| Media library (media types, categories) | Implemented | 005 | M6 | P0 | Roll printer | Implemented (005b, 005c, 005d API #21) |
| Print-mode library (passes, dpi, uni/bidi) | Implemented | 005 | M6 | P0 | Roll printer | Implemented (005b, 005d API #21) |
| Media and profile download registry | Planned | 005 | — | P2 | All | Not in the 005 slices |
| Media sync from printer | Blocked | 005 | M8 | P1 | Roll printers (all profiles) | Blocked: printer vendor partner SDK |
| Roll width auto-detect | Blocked | unassigned | M8 | P1 | Roll printer | Blocked: printer vendor partner SDK |
| Borderless (no-margin) printing | Blocked | unassigned | M8 | P1 | Roll printer | Blocked: printer vendor partner SDK |
| Double-sided and blockout printing | Planned | unassigned | M8 | P2 | Roll printer | Proposed spec 015 |
| Optimize for lamination (overcoat off) | Blocked | unassigned | M8 | P2 | Roll printer, overcoat profile | Blocked: printer vendor partner SDK |
| Print accounting ID per job | Planned | unassigned | — | P2 | Roll printer | Proposed spec 017 |

## Finishing

| Capability | Status | Spec | Milestone | Priority | Capability profile | Notes |
|---|---|---|---|---|---|---|
| Cut contour extraction from named spot | Implemented | 004 | M4 | P0 | Roll and flatbed cutters |  |
| Cut path generation (offset, outline from alpha) | Implemented | 004 | M4 | P1 | Roll and flatbed cutters |  |
| Registration marks for roll cutters | Implemented | 004 | M4 | P0 | Roll cutter |  |
| Cutter barcode job recall | Blocked | 004 | M4 | P1 | Roll cutter | Blocked: barcode format not public; cutter vendor partner docs |
| Flatbed registration marks (5 mm circles) | Implemented | 004 | M4 | P0 | Flatbed cutter |  |
| HP-GL/2 cut export | Implemented | 004 | M4 | P0 | Roll cutter |  |
| DXF cut export | Implemented | 004 | M4 | P0 | Flatbed cutter |  |
| PDF/SVG cut export for flatbed software | Implemented | 004 | M4 | P0 | Flatbed cutter |  |
| Cutter driver plugin interface | Implemented | 004 | M4 | P0 | Roll and flatbed cutters |  |
| Direct cutter connection (USB/Ethernet) | Implemented | 004 | M4 | P1 | Roll cutter |  |
| Flatbed hot-folder delivery | Blocked | 004 | M4 | P1 | Flatbed cutter | Blocked: confirm the flatbed Pro Pack license |
| Tool, speed and pressure per cut layer | Implemented | 004 | M4 | P1 | Roll and flatbed cutters |  |
| Kiss cut versus through cut layers | Implemented | 004 | M4 | P1 | Roll and flatbed cutters |  |
| Cut order optimization | Implemented | 004 | M4 | P2 | Roll and flatbed cutters |  |
| Weeding lines and boxes | Implemented | 006 | M4 | P2 | Roll cutter |  |
| Router and milling output | Planned | unassigned | — | P2 | Other cutters | Proposed spec 018 |
| Other cutter families | Planned | unassigned | — | P2 | Other cutters | Proposed spec 018 |
| Grommet marks | Implemented | 006 | M4 | P1 | All |  |
| Stitch and zero-line marks | Implemented | 006 | M4 | P2 | All |  |
| Crop and trim marks | Implemented | 006 | M4 | P1 | All |  |
| Job info bar and print labels | Implemented | 006 | M4 | P1 | All |  |
| QR code job labels | Implemented | 006 | M4 | P1 | All |  |
| User-defined custom marks | Implemented | 006 | M4 | P2 | All |  |
| Lamination/finishing step tracking | Planned | unassigned | — | P2 | All | Proposed spec 017 |

## Production management

| Capability | Status | Spec | Milestone | Priority | Capability profile | Notes |
|---|---|---|---|---|---|---|
| Web dashboard (jobs, devices, log) | Implemented | 002 | M2 | P0 | All |  |
| Live updates over server-sent events | Implemented | 002 | M2 | P0 | All |  |
| Job state machine (received to done) | Implemented | 001 | M1 | P0 | All |  |
| Queue control (pause, resume, cancel) | Implemented | 001 | M1 | P0 | All |  |
| Holds and priorities | Implemented | 001 | M1 | P0 | All |  |
| Move jobs between printers | Implemented | 002 | M2 | P1 | All |  |
| Job status notifications and webhooks | Planned | unassigned | M2 | P1 | All | Proposed spec 019 |
| Ink and media cost estimation | Implemented | 017 | — | P1 | Roll printer | Implemented (017a #30); reports in 017b |
| Job accounting and cost reports | Planned | unassigned | — | P1 | All | Proposed spec 017 |
| Production reporting and analytics | Planned | unassigned | — | P2 | All | Proposed spec 017 |
| Printer usage data via cloud API (interim) | Blocked | unassigned | — | P2 | Roll printers (all profiles) | Blocked: shop vendor cloud account unknown |
| Logging and log viewer | Implemented | 002 | M2 | P1 | All |  |

## Archive, reprint and history

| Capability | Status | Spec | Milestone | Priority | Capability profile | Notes |
|---|---|---|---|---|---|---|
| Job archive | Implemented | 008 | M2 | P1 | All |  |
| Archive restore | Implemented | 008 | M2 | P1 | All |  |
| Reprint with original settings | Implemented | 008 | M2 | P0 | All |  |
| Job history and audit trail | Implemented | 008 | M2 | P1 | All |  |
| Archive retention and cleanup policy | Implemented | 008 | M2 | P2 | All |  |
| Search jobs by customer, date, media | Implemented | 008 | M2 | P1 | All |  |

## Automation and integrations

| Capability | Status | Spec | Milestone | Priority | Capability profile | Notes |
|---|---|---|---|---|---|---|
| CloudEvents with a stored outbox | Implemented | 001 | M1 | P1 | All |  |
| Outbound webhooks | Planned | unassigned | M2 | P1 | All | Proposed spec 019 |
| MIS and web-to-print connectors | Planned | unassigned | — | P2 | All | Proposed spec 019 |
| JDF/JMF status output to MIS | Planned | unassigned | — | P2 | All | Proposed spec 012 |
| Scripting and rule-based automation | Planned | unassigned | — | P2 | All | Proposed spec 019 |

## Multi-user, server and security

| Capability | Status | Spec | Milestone | Priority | Capability profile | Notes |
|---|---|---|---|---|---|---|
| Single-PC deployment on SQLite | Implemented | 001 | M1 | P0 | All |  |
| Server plus workers on Postgres | Planned | unassigned | — | P1 | All | Proposed spec 016 |
| User accounts and authentication | Planned | unassigned | — | P1 | All | Proposed spec 020 |
| Role-based permissions | Planned | unassigned | — | P2 | All | Proposed spec 020 |
| API tokens and TLS | Planned | unassigned | — | P1 | All | Proposed spec 020 |
| Multi-site and remote clients | Planned | unassigned | — | P2 | All | Proposed spec 016 |

## Platform

| Capability | Status | Spec | Milestone | Priority | Capability profile | Notes |
|---|---|---|---|---|---|---|
| Plugin SDK (JSON-RPC over stdio) | Implemented | 001 | M1 | P0 | All |  |
| Plugin manifest and trust levels | Implemented | 001 | M1 | P0 | All |  |
| Plugin conformance kit | Implemented | 001 | M1 | P0 | All |  |
| Device capability profiles | Implemented | 001 | M1 | P0 | All |  |
| Windows support | Implemented | 001 | M1 | P0 | All |  |
| Linux support | Implemented | 001 | M1 | P0 | All |  |
| macOS support | Planned | unassigned | — | P2 | All |  |
| Localization (i18n) | Planned | unassigned | — | P2 | All | Proposed spec 021 |
| Proxy and network configuration | Planned | unassigned | — | P2 | All |  |
| Licence, SBOM and secret scanning in CI | Implemented | 001 | M1 | P0 | None |  |

## Recent merges

PRs #21 to #33 on main:

| PR | Change |
|---|---|
| #21 | 005d media API routes, events, OpenAPI and render pinning |
| #22 | 007d unified error envelope; preflight and media routes in the server |
| #23 | 005d2a simulated color measurement device plugin |
| #24 | Strict index checks (noUncheckedIndexedAccess) for eight packages |
| #25 | color-sim plugin emits ./dist |
| #26 | printer-mock plugin emits ./dist |
| #27 | 005d2b color-sim harness and differential color-difference test |
| #28 | Strict index checks for plugin-sdk and the remaining plugins |
| #29 | plugin-sdk and edits emit ./dist (source condition for CI) |
| #30 | 017a job cost estimate |
| #31 | 010a CxF spot color library parse and lookup |
| #32 | 010b preflight spot-library check |
| #33 | 022 profiler accuracy report (report-only) |
