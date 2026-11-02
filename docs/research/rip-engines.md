# PDF RIP engine options for BAX Print Suite

Status: research notes, 2026-11-02. Scope: candidate engines for the `RenderEngine` plugin interface (see ../ARCHITECTURE.md). Vendor information comes from public sources only and may be out of date. Corrections are welcome via PR.

> Conventions: **Verified** means a cited public source states it. **Unverified** means it's general knowledge or vendor positioning not confirmed by a primary source in this pass. **Unknown** means we couldn't find it publicly; ask the vendor. Prices are almost never public for OEM SDKs.

## 1. Summary table

| Engine | License | PDF/X-4 transparency + overprint | Spot / DeviceN | ICC hooks | N-channel / bit depth out | Banding / tiling | Multi-thread | Windows | Public license terms? |
|---|---|---|---|---|---|---|---|---|---|
| **Ghostscript** (Artifex) | AGPL-3.0, or Artifex commercial | Yes, incl. overprint simulation (verified [GS-CM]) | Yes, up to 64 colorants, `tiffsep`/`psdcmyk` (verified [GS-DEV]) | Full ICC pipeline, LittleCMS-based (lcms2mt), NCLR output profiles (verified [GS-CM]) | 8/16-bit, CMYK+spots planar; 1-bit with error diffusion (verified [GS-DEV]) | Yes, c-list banding, `BandHeight`/`BufferSpace` (verified [GS-DEV]) | Yes, `-dNumRenderingThreads` (bands in parallel) (verified [GS-CM]) | Yes | AGPL public; commercial terms on request |
| **MuPDF** (Artifex) | AGPL-3.0, or Artifex commercial | Yes, transparency groups/blend modes; overprint simulation is supported but less tested for print than GS (unverified) | Separations/spot support exists (`fz_separations`) (unverified details) | LittleCMS (lcms2mt) (unverified version) | 8-bit; N-channel pixmaps with spots (unverified) | Band rendering via API (unverified) | Thread-safe contexts, app does the threading | Yes | AGPL public; commercial on request |
| **pdf.js** (Mozilla) | Apache-2.0 | Screen-grade; not a print RIP | Converts to RGB | No real output-ICC pipeline | RGB canvas only | No | Limited (worker) | Browser | Yes |
| **PDFium** (Google) | BSD-3 / Apache-2.0 (Chromium) | Screen/office-grade; overprint simulation limited (unverified) | Renders to RGB/BGRA | Minimal | 8-bit RGB(A) or gray | Can render sub-rects | App-level | Yes | Yes |
| **Poppler** | GPL-2.0/3.0 | Splash backend handles transparency; overprint preview exists (unverified) | Splash can do separations (`pdftoppm` limited) | Optional LittleCMS | 8-bit, CMYK via Splash (unverified) | Sub-rect render | Limited | Yes (builds) | Yes (but GPL, no commercial option) |
| **Skia** | BSD-3 | Skia *writes* PDF; it is **not** a general PDF reader (verified by project scope; any reader module is experimental/unknown) | n/a | n/a | n/a | n/a | n/a | Yes | Yes |
| **Cairo** | LGPL-2.1 / MPL-1.1 | Writes PDF; does **not** parse PDF (pair with Poppler) | n/a | No | n/a | n/a | n/a | Yes | Yes |
| **Harlequin Core / Direct** (Global Graphics / Hybrid) | Commercial OEM | Yes, print-grade (vendor claims, [GG-MIMAKI]) | Yes, extended gamut and special colors (vendor, [GG-DFE]) | Yes | Yes, N-channel; "widest, highest-res" devices (vendor) | Yes | Yes; SDR/HDR/UHDR tiers (vendor, [GG-DFE]) | Yes | **No.** Direct is licensed per printing device via the OEM's own licensing (verified [GG-DS]) |
| **Mako Core** (Global Graphics) | Commercial | PDF DOM + renderer; transparency handled (vendor) | DeviceN create/retain/merge/drop (verified [MAKO-CVT]) | ICC-based render targets (verified [MAKO-CM]) | Render at chosen DPI/bit depth/color space (verified [MAKO-CM]) | Unknown | Unknown | Yes (C++/.NET) | No |
| **APPE** (Adobe) | Commercial OEM; also via Datalogics | Reference implementation for PDF/X-4 | Yes | Yes | Yes | Yes | Yes | Yes | No. Royalty/fixed/subscription "flexible" (verified [APPE-FAQ]) |
| **callas pdfToolbox SDK** | Commercial OEM | Preflight/fixup, **not** a RIP renderer | Inspect/convert spots | Yes (conversions) | n/a (has image export, unverified quality for RIP use) | n/a | Server/CLI | Yes | No; OEM licensing on request [CALLAS-OEM] |
| **Apryse (PDFTron) / Foxit SDKs** | Commercial | General PDF SDKs; overprint preview exists (unverified); not marketed as production RIPs | Limited for output separations (unverified) | Some | Mostly RGB/CMYK 8-bit (unverified) | Tile render | Yes | Yes | Pricing not public |
| **PDFlib TET / PLOP** | Commercial | TET = text/image extraction; PLOP = linearize/protect/repair. Neither renders | n/a | n/a | n/a | n/a | n/a | Yes | Price lists published on pdflib.com (unverified current) |

## 2. Notes per engine

### Open source
- **Ghostscript.** The strongest open-source fit by far. `tiffsep` writes a composite CMYK plus one gray TIFF per separation, handles up to 64 process+spot colorants with accurate overprint, and supports 8 or 1 bpc (1 bpc uses error diffusion); `psdcmyk16` gives 16-bit with spots [GS-DEV]. Its color architecture defines every space in ICC terms, accepts NCLR (N-color) output profiles for separation devices, DeviceN source profiles via `-sDeviceNProfile`, and simulates spot overprint [GS-CM]. Multi-threaded band rendering via `-dNumRenderingThreads`, with color conversion done during the threaded phase [GS-CM]. **License catch:** AGPL. We use it only as an optional external program (ADR-0004). Downstream vendors who want to embed it can get an Artifex commercial license (terms not public).
- **MuPDF.** Faster, smaller, a clean C API, same Artifex dual license. Good for previews, thumbnails, and nesting-time geometry. Print-grade separations/overprint are less proven than Ghostscript; test before relying on it (unknown).
- **pdf.js, PDFium.** Screen previews only (dashboard thumbnails, web proof). Not suitable as the production renderer: no N-channel output, limited overprint.
- **Poppler.** GPL with no commercial option. Avoid in anything we might sell.
- **Skia / Cairo.** PDF *writers* and 2D rasterizers. Not PDF interpreters. Usable for generating marks, labels, and preview compositing, not for RIPing customer PDFs.

### Commercial
- **Harlequin.** Used by Mimaki RasterLink, and GG lists HP, Canon, Durst, Roland among customers [GG-MIMAKI]. Sold to OEMs. "Direct"/SmartDFE is licensed per printing device through the OEM's licensing [GG-DS]; "Core" is the SDK variant formerly called Harlequin Host Renderer (HHR) [GG-HHR]. Availability to non-OEM projects is **unknown**. Their BreakThrough engineering-services model is aimed at OEMs [GG-DFE].
- **Mako Core.** A PDF DOM, transform, and render SDK. The DeviceN merge/retain/drop transform [MAKO-CVT] and ICC render targets [MAKO-CM] are exactly what pre-RIP color work needs. Could act as a full renderer or as a front end to Ghostscript. Price unknown.
- **APPE.** Adobe licenses it to OEMs with "unit-based royalties, fixed fees, subscriptions" [APPE-FAQ]. Datalogics resells APPE as a RIP SDK [DATALOGICS], which may be a more reachable route for a small ISV. Price unknown.
- **callas pdfToolbox SDK.** Best-in-class preflight and PDF/X fixups (for example a "Convert to PDF/X-4" profile ships with the SDK [CALLAS-SDK]). Use upstream of any renderer. Not a renderer replacement.
- **Apryse / Foxit.** Viewer and edit SDKs. Possible for the operator UI, but they don't solve RIP output.
- **PDFlib TET / PLOP.** Useful only for parts (text extraction for job metadata, PDF repair). Optional.

## 3. Recommendation

1. **Renderer-agnostic interface (build now).** Define a `Renderer` port in our code:
   ```
   probe(pdf) -> {pages, boxes, colorants[], outputIntent, hasTransparency, hasOverprint}
   render(job: {pdf, page, dpi_x, dpi_y, region|tile, outputProfile(ICC, CMYK or NCLR), colorantMap, renderingIntent, bpc: 8|16, simulateOverprint}) -> planar band stream (one plane per colorant)
   ```
   Halftoning, white/varnish layer generation, and the printer encoder live *after* this interface, so engines can be swapped. Run the renderer **out of process** (a CLI or worker). That keeps an AGPL engine's code separate from ours and isolates crashes.
2. **Reference open-source engine: Ghostscript** via `tiffsep`/`psdcmyk16`-style planar output, ICC/NCLR profiles, banded and multi-threaded. User-installed and invoked as a separate program (ADR-0004).
3. **Commercial engines** (Harlequin/Mako, APPE, Artifex-licensed builds) can be offered as separately distributed plugins (ADR-0005). The interface must not assume any single engine.
4. **Preflight:** start with Ghostscript plus our own checks. Evaluate callas pdfToolbox SDK if preflight becomes a selling point.
5. **Validation:** use the Ghent Workgroup output suite (GWG) and Altona test suite PDFs as acceptance tests for transparency, overprint, and spot handling.

## 4. Screening / halftoning

Inkjet RIPs normally hand the printer either contone planes (the printer screens internally) or multi-level (1 to 2 bit) dot data. **Which one a given printer expects** depends on the vendor interface (vendor developer programs). So build screening as a separate, optional stage.

| Method | Notes | Open implementations |
|---|---|---|
| Ordered / threshold-array | Fast and parallel. Blue-noise masks give stochastic look | Ghostscript (threshold halftones in PostScript/PDF), our own code |
| Error diffusion (Floyd–Steinberg, Jarvis, Stucki) | Serial per row. Serpentine scan reduces artifacts | Ghostscript (`tiffscaled`/1-bpc paths) [GS-DEV]; trivial to implement |
| Variable-coefficient ED (Ostromoukhov 2001) | Better midtones | Published paper; implement ourselves |
| Blue-noise / void-and-cluster (Ulichney 1993) | Precomputed mask, fully parallel, good for tiles | Public-domain algorithm descriptions; generate masks ourselves |
| Multi-level (drop sizes) | Needed for multi-drop heads | Gutenprint's EvenTone/"Adaptive Hybrid" dithers (GPL, verify) |
| Commercial | ScreenPro / PrintFlat (Global Graphics) [GG-MIMAKI] | Commercial |

Patent note: some stochastic and multi-level screening methods have been patented. Maintainers review patent status before merging screens beyond textbook FS/ordered/void-and-cluster.

## 5. Wide-format specifics
- A 64 in × 50 ft job at 1200×1200 dpi in 6 colorants at 8 bpc is about 76,800 × 720,000 px × 6 ≈ **330 GB** uncompressed. So the pipeline must **stream bands** end to end (render, color, screen, encode, send) and never hold the full page. Ghostscript's c-list banding fits this.
- Tiling for nesting: render each nested PDF placement into its band, or (simpler) pre-impose the nest into one PDF first and RIP that.
- White ink (630W/730W): generate the white plane as a named spot (from the PDF or synthesized from alpha/a mask) through the NCLR/colorant map. The Latex 560 is a secondary compatibility target for the same white-ink path.

## 6. Unknowns to resolve
- Artifex, Global Graphics, and Adobe/Datalogics pricing, and whether they license to open-source plugin authors.
- MuPDF's overprint/separation fidelity vs. Ghostscript on GWG suites (test it).
- Raster formats and bit depths expected by specific printers (vendor developer programs).
- Skia's experimental PDF-reading status (not needed if we use GS).

## Sources
- [GS-DEV] Ghostscript output devices: https://ghostscript.readthedocs.io/en/latest/Devices.html
- [GS-CM] Ghostscript color management: https://ghostscript.readthedocs.io/en/latest/GhostscriptColorManagement.html
- Ghostscript licensing: https://artifex.com/licensing (AGPL/commercial)
- MuPDF: https://mupdf.com/ and https://artifex.com/licensing
- pdf.js: https://github.com/mozilla/pdf.js (Apache-2.0)
- PDFium: https://pdfium.googlesource.com/pdfium/
- Poppler: https://poppler.freedesktop.org/
- Skia: https://skia.org/ · Cairo: https://www.cairographics.org/
- [GG-DFE] SmartDFE: https://hybridhelix.com/products/smartdfe/industrial/
- [GG-DS] SmartDFE datasheet (licensing): https://hybridhelix.com/assets/documents/datasheets/datasheet-smartdfe-workflow.pdf
- [GG-HHR] Harlequin Core naming bulletin: https://documentation.hybridhelix.com/hqnc/harlequin-core-bulletin-july-2021
- [GG-MIMAKI] Mimaki renews Harlequin Core: https://www.globalgraphics.com/news/2024/12/18/mimaki-engineering-and-global-graphics-software-renew-strategic-partnership-to-license-harlequin-core/
- [MAKO-CM] Mako color management: https://documentation.hybridhelix.com/mako/color-management
- [MAKO-CVT] Mako IColorConverterTransform: https://api.hybridhelix.com/mako/class_jaws_mako_1_1_i_color_converter_transform.html
- [APPE-FAQ] Adobe Embedded Print Engine FAQ: https://www.adobe.com/products/pdfprintengine/faq.html · Partner list: https://www.adobe.com/products/pdfprintengine/partner-list.html
- [DATALOGICS] https://www.datalogics.com/adobe-print-engine
- [CALLAS-OEM] https://oem.callassoftware.com/integration/ · [CALLAS-SDK] https://help.callassoftware.com/a/826781-callas-pdfengine-sdk-first-steps
- Apryse: https://apryse.com/ · Foxit: https://developers.foxit.com/ · PDFlib: https://www.pdflib.com/
- LittleCMS (MIT): https://www.littlecms.com/
- Ghent Workgroup test suites: https://www.gwg.org/
