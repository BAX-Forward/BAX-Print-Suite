# Feature matrix

Status of every planned BAX Print Suite capability across the wide-format print-production workflow. Updated as work lands. Nothing is merged as code yet; "In development" means a spec is being built on a feature branch.

**163 capabilities:** Implemented 0, In development 29, Planned 115, Blocked 19

Specs: 001 queue and hot folders, 002 dashboard and RIP handoff, 003 nesting, 004 cut export, 005 media library and profiling, 006 finishing marks and labels, 007 preflight and job editor, 008 archive and reprint, 009 tiling and panels. Milestones are from [ROADMAP.md](ROADMAP.md); "—" means not yet scheduled.

## Intake

| Capability | Status | Spec | Milestone | Priority | Hardware | Notes |
|---|---|---|---|---|---|---|
| Per-printer hot folders | In development | 001 | M1 | P0 | All printers; Latex 630/730 first |  |
| Hot-folder settings presets (per-folder job defaults) | In development | 001 | M1 | P0 | All |  |
| Hot-folder file-stability detection and partial-write handling | In development | 001 | M1 | P0 | All |  |
| Duplicate and resubmission detection | In development | 001 | M1 | P1 | All |  |
| Job submission REST API with OpenAPI 3.1 | In development | 001 | M1 | P0 | All |  |
| Command-line job submission | In development | 001 | M1 | P0 | All |  |
| PDF intake (PDF 1.3–2.0, PDF/X) | In development | 001 | M1 | P0 | All |  |
| PostScript and EPS intake | Planned | unassigned | M5 | P1 | All | Needs external Ghostscript (AGPL, user-installed) |
| TIFF, JPEG and PNG raster intake | Planned | unassigned | M5 | P1 | All |  |
| SVG and DXF vector intake | Planned | unassigned | M4 | P2 | Summa F-Series workflows |  |
| JDF/JMF job ticket intake | Planned | unassigned | — | P2 | All | Proposed spec 012 |
| Network print driver (print from desktop apps) | Planned | unassigned | — | P2 | All | Proposed spec 013 |
| Web upload portal for customers and staff | Planned | unassigned | — | P2 | All | Proposed spec 013 |
| Email-to-job intake | Planned | unassigned | — | P2 | All | Proposed spec 013 |
| Job metadata fields (job number, customer, company) | In development | 001 | M1 | P0 | All |  |

## Preflight and normalization

| Capability | Status | Spec | Milestone | Priority | Hardware | Notes |
|---|---|---|---|---|---|---|
| Preflight inspection (fonts, images, resolution, boxes) | Planned | 007 | M5 | P0 | All | Spec 007 draft in progress |
| PDF/X and PDF/A conformance checks | Planned | 007 | M5 | P1 | All | Spec 007 draft in progress |
| Normalization presets (PDF/X-1a, X-3, X-4) | Planned | 007 | M5 | P1 | All | Spec 007 draft in progress |
| Automatic fixups (missing bleed, RGB to CMYK, flatten) | Planned | 007 | M5 | P1 | All | Spec 007 draft in progress |
| Low-resolution image warnings at output size | Planned | 007 | M5 | P1 | All | Spec 007 draft in progress |
| Spot color and cut-spot detection report | Planned | 007 | M4 | P0 | Summa S2 / F-Series | Spec 007 draft in progress |
| Font embedding check and outlining | Planned | 007 | M5 | P2 | All | Spec 007 draft in progress |
| Preflight report (JSON plus human-readable) | Planned | 007 | M5 | P1 | All | Spec 007 draft in progress |

## Job editing

| Capability | Status | Spec | Milestone | Priority | Hardware | Notes |
|---|---|---|---|---|---|---|
| Per-job scale, rotate, mirror | Planned | 007 | M3 | P0 | All | Spec 007 draft in progress |
| Crop and page-box selection | Planned | 007 | M3 | P1 | All | Spec 007 draft in progress |
| Bleed generation (mirror/stretch edge) | Planned | 007 | M3 | P1 | All | Spec 007 draft in progress |
| Add or edit cut contour on a job | Planned | 007 | M4 | P0 | Summa S2 / F-Series | Spec 007 draft in progress |
| Per-job color adjustments (curves, brightness) | Planned | 007 | M6 | P2 | All | Spec 007 draft in progress |
| Spot color replacement and remapping per job | Planned | 007 | M6 | P1 | All | Spec 007 draft in progress |
| Multi-page job handling and page selection | Planned | 007 | M3 | P1 | All | Spec 007 draft in progress |
| Job editor with live preview | Planned | 007 | M5 | P1 | All | Spec 007 draft in progress |

## Layout

| Capability | Status | Spec | Milestone | Priority | Hardware | Notes |
|---|---|---|---|---|---|---|
| Rectangular nesting on roll width | In development | 003 | M3 | P0 | Latex 630/730 rolls |  |
| True-shape nesting | In development | 003 | M3 | P1 | Latex 630/730; Summa S2 |  |
| Nesting spacing, rotation and margin controls | In development | 003 | M3 | P0 | All |  |
| Auto-nest across jobs sharing media | In development | 003 | M3 | P1 | All |  |
| Nest yield and media-use report | In development | 003 | M3 | P1 | All |  |
| Imposed PDF output for nests | In development | 003 | M3 | P0 | All |  |
| Saved and reusable layouts | Planned | 003 | M3 | P1 | All |  |
| Interactive layout editor (drag, lock, reorder) | Planned (queued) | 002 | M3 | P1 | All | Depends on dashboard (Spec 002, queued) |
| Step and repeat | Planned | 003 | M3 | P1 | All |  |
| Tiling into panels | Planned | 009 | M3 | P0 | Latex 630/730 | Spec 009 draft in progress |
| Tile overlap and white-space overlap | Planned | 009 | M3 | P0 | Latex 630/730 | Spec 009 draft in progress |
| Custom tile maps (unequal panels) | Planned | 009 | M3 | P2 | All | Spec 009 draft in progress |
| Panel numbering and assembly labels | Planned | 009 | M3 | P1 | All | Spec 009 draft in progress |
| Booklet and sheet imposition (n-up, signatures) | Planned | unassigned | — | P2 | Sheet-fed devices | Proposed spec 014 |
| Proof watermark option | Planned | unassigned | M2 | P2 | All |  |

## Color

| Capability | Status | Spec | Milestone | Priority | Hardware | Notes |
|---|---|---|---|---|---|---|
| ICC color conversion (LittleCMS) | Planned | unassigned | M6 | P0 | All |  |
| Rendering intents and black-point compensation | Planned | unassigned | M6 | P0 | All |  |
| Device link profiles | Planned | unassigned | M6 | P1 | All |  |
| Color workflow levels (ICC only to full custom) | Planned | 005 | M6 | P1 | All | Spec 005 draft in progress |
| Named spot color libraries (user-supplied CxF/ASE) | Planned | unassigned | M6 | P1 | All | Proposed spec 010; no licensed Pantone data |
| Proprietary spot library emulation (Pantone) | Blocked | unassigned | — | P2 | All | Blocked: Pantone licensing; legal review |
| Spot color to N-channel (DeviceN) mapping | Planned | unassigned | M6 | P1 | All |  |
| Ink limits (total and per channel) | Planned | 005 | M6 | P0 | Latex 630/730 | Spec 005 draft in progress |
| Ink restriction per channel | Planned | 005 | M6 | P1 | All | Spec 005 draft in progress |
| Linearization and calibration curves | Blocked | 005 | M6 | P0 | Latex 630/730 | Blocked: needs the target shop's spectrophotometer model and access |
| Printer-side color calibration via vendor SDK | Blocked | unassigned | M8 | P1 | Latex 560/630/730 | Blocked: HP LFP partner SDK |
| ICC profile creation with a spectrophotometer | Blocked | 005 | M6 | P1 | All | Blocked: spectro access; ArgyllCMS (AGPL) as separate program |
| Spectrophotometer driver plugins | Blocked | unassigned | — | P1 | All | Blocked: spectro model and SDK licence; proposed spec 011 |
| G7 calibration and gray balance | Blocked | unassigned | — | P2 | All | Blocked: spectro access; proposed spec 011 |
| Print verification and standards simulation | Blocked | unassigned | — | P2 | All | Blocked: spectro access; proposed spec 011 |
| Swatch book and color chart printing | Planned | unassigned | — | P2 | All | Proposed spec 010 |
| White ink generation (spot, flood, choke) | Planned | unassigned | M6 | P1 | Latex W models | Proposed spec 015 |
| Varnish/overcoat channel handling | Planned | unassigned | M6 | P2 | Latex 700/800 | Proposed spec 015 |
| Color-white-color sandwich jobs | Planned | unassigned | — | P2 | Latex W models | Proposed spec 015 |
| Backlit day/night multi-layer jobs | Planned | unassigned | — | P2 | All | Proposed spec 015 |
| Overprint simulation | Planned | unassigned | M5 | P1 | All |  |
| 16-bit color processing | Planned | unassigned | M6 | P1 | All |  |
| Soft proofing on screen | Planned | unassigned | M6 | P2 | All |  |

## RIP and rendering

| Capability | Status | Spec | Milestone | Priority | Hardware | Notes |
|---|---|---|---|---|---|---|
| PDF render engine plugin (Ghostscript, external) | Planned | unassigned | M5 | P0 | All | Ghostscript AGPL: optional, user-installed, never linked |
| PostScript render path | Planned | unassigned | M5 | P1 | All | Same Ghostscript constraint |
| Commercial PDF engine plugin slot | Blocked | unassigned | — | P2 | All | Blocked: vendor licence; legal review |
| Banded streaming render (planar bands by file) | Planned | unassigned | M5 | P0 | All |  |
| Transparency and blend-mode rendering | Planned | unassigned | M5 | P0 | All |  |
| Preview thumbnails and screen previews | Planned (queued) | 002 | M2 | P0 | All | Spec 002 queued |
| Error diffusion screening | Planned | unassigned | M7 | P0 | All |  |
| Blue-noise and threshold-array screening | Planned | unassigned | M7 | P1 | All |  |
| Multi-level (variable dot) screening | Planned | unassigned | M7 | P1 | Latex 630/730 |  |
| Custom halftone/screening sets per mode | Planned | unassigned | M7 | P2 | All |  |
| Print-while-RIP | Planned | unassigned | M5 | P1 | All |  |
| Multi-RIP parallel processing on one host | Planned | unassigned | M5 | P1 | All |  |
| Distributed RIP workers (server plus workers) | Planned | unassigned | — | P2 | All | Proposed spec 016 |
| GWG test-suite conformance harness | Planned | unassigned | M5 | P1 | All |  |

## Print

| Capability | Status | Spec | Milestone | Priority | Hardware | Notes |
|---|---|---|---|---|---|---|
| Hot-folder handoff to an existing RIP | Planned (queued) | 002 | M2 | P0 | Latex 630/730 | Spec 002 queued |
| Mock printer driver for tests | In development | 001 | M1 | P0 | None |  |
| Printer driver plugin interface | In development | 001 | M1 | P0 | All |  |
| Native HP Latex 630/730 driver | Blocked | unassigned | M8 | P0 | Latex 630/730 | Blocked: HP LFP partner SDK application |
| Native HP Latex 560 driver | Blocked | unassigned | M8 | P1 | Latex 560 | Blocked: HP LFP partner SDK application |
| Other vendor printer drivers (Epson, Canon, Mimaki, Roland) | Blocked | unassigned | — | P2 | Other printers | Blocked: vendor developer programs |
| Per-printer queues | In development | 001 | M1 | P0 | All |  |
| Printer status and ink levels | Blocked | unassigned | M8 | P1 | Latex 560/630/730 | Blocked: HP SDK; PrintOS API as interim |
| Media library (media types, categories) | Planned | 005 | M6 | P0 | Latex 630/730 | Spec 005 draft in progress |
| Print-mode library (passes, dpi, uni/bidi) | Planned | 005 | M6 | P0 | Latex 630/730 | Spec 005 draft in progress |
| Media and profile download registry | Planned | 005 | — | P2 | All | Spec 005 draft in progress |
| Media sync from printer | Blocked | 005 | M8 | P1 | Latex 560/630/730 | Blocked: HP LFP partner SDK |
| Roll width auto-detect | Blocked | unassigned | M8 | P1 | Latex 630/730 | Blocked: HP LFP partner SDK |
| Borderless (no-margin) printing | Blocked | unassigned | M8 | P1 | Latex 630/730 | Blocked: HP LFP partner SDK |
| Double-sided and blockout printing | Planned | unassigned | M8 | P2 | Latex 630/730 | Proposed spec 015 |
| Optimize for lamination (overcoat off) | Blocked | unassigned | M8 | P2 | Latex 700/800 | Blocked: HP LFP partner SDK |
| Print accounting ID per job | Planned | unassigned | — | P2 | Latex 630/730 | Proposed spec 017 |

## Finishing

| Capability | Status | Spec | Milestone | Priority | Hardware | Notes |
|---|---|---|---|---|---|---|
| Cut contour extraction from named spot | Planned (queued) | 004 | M4 | P0 | Summa S2 / F-Series | Spec 004 queued |
| Cut path generation (offset, outline from alpha) | Planned (queued) | 004 | M4 | P1 | Summa S2 / F-Series | Spec 004 queued |
| Registration marks for roll cutters | Planned (queued) | 004 | M4 | P0 | Summa S2 | Spec 004 queued; public layouts only |
| Summa OPOS barcode job recall | Blocked | 004 | M4 | P1 | Summa S2 | Blocked: barcode format not public; Summa partner docs |
| Flatbed registration marks (5 mm circles) | Planned (queued) | 004 | M4 | P0 | Summa F-Series | Spec 004 queued |
| HP-GL/2 cut export | Planned (queued) | 004 | M4 | P0 | Summa S2 | Spec 004 queued |
| DXF cut export | Planned (queued) | 004 | M4 | P0 | Summa F-Series | Spec 004 queued |
| PDF/SVG cut export for flatbed software | Planned (queued) | 004 | M4 | P0 | Summa F-Series | Spec 004 queued |
| Cutter driver plugin interface | Planned (queued) | 004 | M4 | P0 | Summa S2 / F-Series | Spec 004 queued |
| Direct cutter connection (USB/Ethernet) | Planned (queued) | 004 | M4 | P1 | Summa S2 | Spec 004 queued |
| Flatbed hot-folder delivery | Blocked | 004 | M4 | P1 | Summa F-Series | Blocked: confirm the flatbed Pro Pack license |
| Tool, speed and pressure per cut layer | Planned (queued) | 004 | M4 | P1 | Summa S2 / F-Series | Spec 004 queued |
| Kiss cut versus through cut layers | Planned (queued) | 004 | M4 | P1 | Summa S2 / F-Series | Spec 004 queued |
| Cut order optimization | Planned (queued) | 004 | M4 | P2 | Summa S2 / F-Series | Spec 004 queued |
| Weeding lines and boxes | Planned | 006 | M4 | P2 | Summa S2 | Spec 006 draft in progress |
| Router and milling output | Planned | unassigned | — | P2 | Other cutters | Proposed spec 018 |
| Other cutter families (Zund, Graphtec, Mimaki, others) | Planned | unassigned | — | P2 | Other cutters | Proposed spec 018 |
| Grommet marks | Planned | 006 | M4 | P1 | All | Spec 006 draft in progress |
| Stitch and zero-line marks | Planned | 006 | M4 | P2 | All | Spec 006 draft in progress |
| Crop and trim marks | Planned | 006 | M4 | P1 | All | Spec 006 draft in progress |
| Job info bar and print labels | Planned | 006 | M4 | P1 | All | Spec 006 draft in progress |
| QR code job labels | Planned | 006 | M4 | P1 | All | Spec 006 draft in progress |
| User-defined custom marks | Planned | 006 | M4 | P2 | All | Spec 006 draft in progress |
| Lamination/finishing step tracking | Planned | unassigned | — | P2 | All | Proposed spec 017 |

## Production management

| Capability | Status | Spec | Milestone | Priority | Hardware | Notes |
|---|---|---|---|---|---|---|
| Web dashboard (jobs, devices, log) | Planned (queued) | 002 | M2 | P0 | All | Spec 002 queued |
| Live updates over server-sent events | Planned (queued) | 002 | M2 | P0 | All | Spec 002 queued |
| Job state machine (received to done) | In development | 001 | M1 | P0 | All |  |
| Queue control (pause, resume, cancel) | In development | 001 | M1 | P0 | All |  |
| Holds and priorities | In development | 001 | M1 | P0 | All |  |
| Move jobs between printers | Planned (queued) | 002 | M2 | P1 | All | Spec 002 queued |
| Job status notifications and webhooks | Planned | unassigned | M2 | P1 | All | Proposed spec 019 |
| Ink and media cost estimation | Planned | unassigned | — | P1 | Latex 630/730 | Proposed spec 017 |
| Job accounting and cost reports | Planned | unassigned | — | P1 | All | Proposed spec 017 |
| Production reporting and analytics | Planned | unassigned | — | P2 | All | Proposed spec 017 |
| Printer usage data via cloud API (interim) | Blocked | unassigned | — | P2 | Latex 560/630/730 | Blocked: shop PrintOS account unknown |
| Logging and log viewer | Planned (queued) | 002 | M2 | P1 | All | Spec 002 queued |

## Archive, reprint and history

| Capability | Status | Spec | Milestone | Priority | Hardware | Notes |
|---|---|---|---|---|---|---|
| Job archive | Planned | 008 | M2 | P1 | All | Spec 008 draft in progress |
| Archive restore | Planned | 008 | M2 | P1 | All | Spec 008 draft in progress |
| Reprint with original settings | Planned | 008 | M2 | P0 | All | Spec 008 draft in progress |
| Job history and audit trail | Planned | 008 | M2 | P1 | All | Spec 008 draft in progress |
| Archive retention and cleanup policy | Planned | 008 | M2 | P2 | All | Spec 008 draft in progress |
| Search jobs by customer, date, media | Planned | 008 | M2 | P1 | All | Spec 008 draft in progress |

## Automation and integrations

| Capability | Status | Spec | Milestone | Priority | Hardware | Notes |
|---|---|---|---|---|---|---|
| CloudEvents with a stored outbox | In development | 001 | M1 | P1 | All |  |
| Outbound webhooks | Planned | unassigned | M2 | P1 | All | Proposed spec 019 |
| MIS and web-to-print connectors | Planned | unassigned | — | P2 | All | Proposed spec 019 |
| JDF/JMF status output to MIS | Planned | unassigned | — | P2 | All | Proposed spec 012 |
| Scripting and rule-based automation | Planned | unassigned | — | P2 | All | Proposed spec 019 |

## Multi-user, server and security

| Capability | Status | Spec | Milestone | Priority | Hardware | Notes |
|---|---|---|---|---|---|---|
| Single-PC deployment on SQLite | In development | 001 | M1 | P0 | All |  |
| Server plus workers on Postgres | Planned | unassigned | — | P1 | All | Proposed spec 016 |
| User accounts and authentication | Planned | unassigned | — | P1 | All | Proposed spec 020 |
| Role-based permissions | Planned | unassigned | — | P2 | All | Proposed spec 020 |
| API tokens and TLS | Planned | unassigned | — | P1 | All | Proposed spec 020 |
| Multi-site and remote clients | Planned | unassigned | — | P2 | All | Proposed spec 016 |

## Platform

| Capability | Status | Spec | Milestone | Priority | Hardware | Notes |
|---|---|---|---|---|---|---|
| Plugin SDK (JSON-RPC over stdio) | In development | 001 | M1 | P0 | All |  |
| Plugin manifest and trust levels | In development | 001 | M1 | P0 | All |  |
| Plugin conformance kit | In development | 001 | M1 | P0 | All |  |
| Device capability profiles | In development | 001 | M1 | P0 | All |  |
| Windows support | In development | 001 | M1 | P0 | All |  |
| Linux support | In development | 001 | M1 | P0 | All |  |
| macOS support | Planned | unassigned | — | P2 | All |  |
| Localization (i18n) | Planned | unassigned | — | P2 | All | Proposed spec 021 |
| Proxy and network configuration | Planned | unassigned | — | P2 | All |  |
| Licence, SBOM and secret scanning in CI | In development | 001 | M1 | P0 | None |  |
