# Cutter integration research (public sources only)

Status: 2026-11-02. Scope: how open software can drive roll and flatbed cutters through **documented** interfaces. The first targets are the Summa S2 (roll) and Summa F-series (flatbed). The design stays vendor-neutral (ARCHITECTURE §3.8, spec 004).

## 1. Vendor-neutral findings
- **Generic job formats** that most cutters or their control software accept: HP-GL / HP-GL/2 (pen-up/down vectors, `SP` tool select), DXF (layers map to tools), and PDF or SVG with named layers or spot colors for cut methods. These are what `cutter-generic` emits.
- **Two delivery models:**
  1. *Direct:* send the command stream to the device over USB, Ethernet, or serial (common on roll cutters).
  2. *Folder import:* write files to a folder watched by the vendor's machine-control software (common on flatbeds, whose motion, tools, and camera are run by the vendor's software).
- **Registration models:**
  - Sensor-read printed marks (squares or circles at corners or in rows along edges), with optional deformation compensation along one or both axes.
  - Camera-read marks or contours (flatbeds and some roll cutters).
  - Optional barcodes identifying the job. Mark *geometry* is often described in user manuals. The *command protocols* that trigger reading usually aren't.
- **Tool parameters** (force, speed, offset, depth, passes) are often stored on the device or in vendor software as "methods" or "materials". Open software can map semantic tools (kiss, thru, crease) to them by name rather than sending raw values.

## 2. Summa S2 (S Class 2, roll), e.g. D-160
| Topic | Public? | Finding | Source |
|---|---|---|---|
| Languages | Yes | User-selectable **DM/PL, HP-GL, HP-GL/2**. The active language must match the sending software. DM/PL is described as recommended for cutting | S Class 2 manual [S2]; SummaCut manual [SC] |
| Tool selection | Yes (behavior) | A "Tool command" setting makes the cutter accept DM/PL `P` and HP-GL `SP` tool selection. Tools: drag knife (tangential on T models), pen, pouncing tool | [S2], [SC] |
| Pressure, speed, offset | Partly | Ranges and defaults are set from the panel or from Summa Cutter Control (e.g. knife pressure in grams). Standard HP-GL `VS` exists. A Summa-specific force command is **not** publicly documented | [SC], [S2] |
| DM/PL command reference | **No** | No public command list found | Needs Summa docs |
| Connections | Yes (physical) | USB (USB-B on the cutter; Summa driver) and Ethernet (DHCP or static). The first port to receive data stays active. Older units have serial. The **raw network protocol/port is not documented** in the manual | [S2], [CT] |
| OPOS sensor | Yes (concept) | A carriage sensor reads printed **squares** around the graphic. Layouts: OPOS X (left and right rows), XY (+ bottom line), XY2 (+ top line), XYXtra (+ lines between mark pairs) | [S2] |
| OPOS commands, mark dimensions, tolerances | **No** | Not publicly documented | Needs Summa docs |
| OPOS barcode | Feature public, format **no** | The barcode must be unlocked with a serial-number-based activation code. Summa Cutter Control's "barcode server" matches job numbers to cut files in a folder. Encoding is not documented | [S2], [CT] |
| OPOS-CAM models | Yes (constraint) | Camera models need Summa Cutter Control over USB (Windows). Third-party RIPs output cut files to a folder Cutter Control reads | [PF] |
| Roll / panel jobs | Partly | Multi-job rolls via barcode, plus segmented OPOS for long jobs. Commands are undocumented | [S2], [CT] |

## 3. Summa F-series (flatbed)
| Topic | Public? | Finding | Source |
|---|---|---|---|
| Job intake | Yes | Controlled by **GoProduce (Flatbed Edition)**, which is proprietary. Basic edition imports **PDF, DXF, SVG** (+ Summa/other native formats). Pro Pack adds **PLT/HPGL/DMPL** (including roll-cutter files with OPOS info, "Twin X"), i-CUT, ZCC, CUT, and a **hot-folder** import mode | [GPF], [GPN] |
| PDF/DXF mapping | Yes | Methods separated by layer name, spot color name, or color. Layers can be excluded. Print data is not imported. Open paths within 0.5 mm are closed. Reg marks are searched for as **5 mm circles on a "Regmark" layer** (older GoProduce manual) | [GPF], [GP] |
| Barcode | Partly | Barcode import (handheld or camera, Pro Pack). The file name must be 8–13 characters. An older doc mentions a POSTNET-type barcode printed with OPOS marks | [GPF], [GP] |
| Tools and modules | Yes (catalog) | Kiss-cut tool (down-position offset), perforating, creasing, router, and others, configured as materials and methods in GoProduce | [GPN] |
| Camera registration | Concept | Camera reads the marks (and barcode). Algorithms and commands are not documented | [GP] |
| Machine command protocol | **No** | Not documented publicly. GoProduce drives the machine | Needs Summa |
| SDK | Exists, terms unknown | A "GoProduce SDK programmer guide" is posted on Summa support. Its license and redistribution terms are unreviewed, so it isn't used | [SDK] |

## 4. Consequences for BAX Print Suite
- **S2:** HP-GL/2 output plus file delivery works today from public info. USB and raw-TCP send are stubs to verify on hardware using our own output only. OPOS and DM/PL are optional or disabled until Summa provides documentation we may implement openly. Meanwhile, the supported path is our HPGL file plus our generic-mark print PDF, read by Summa's own cutter software.
- **F-series:** PDF (layers per method + Regmark circles) or DXF into a GoProduce folder or hot folder. No machine control on our side.
- Everything vendor-specific stays in `plugins/cutter-summa-*`. Anything that needs partner docs goes in a separate private plugin (ADR-0005).

## Sources
- [S2] Summa S Class 2 User Manual: https://download.airmark.com/user-manuals/scl2_en.pdf
- [SC] SummaCut Series User's Manual (Summa): https://www.summa.com/media/z2bbfl2e/oldcut_en.pdf
- [CT] Summa Cutter Tools User's Manual Rev 7: https://inspire.grimco.ca/hubfs/vr_install/pdf/Summa%20Cutter%20Tools%20Manual.pdf
- [PF] PrintFactory KB, "Summa S2 OPOS-Cam": https://support.printfactory.cloud/portal/en/kb/articles/summa-s2-opos-cam
- [GPF] GoProduce Flatbed Edition manual (Rev 002b): https://connect.grimco.com/hubfs/Knowledge%20Base/goproduceflatbededition_rev002b_en.pdf
- [GPN] GoProduce Flatbed Edition V2 release notes: https://www.summa.com/en-int/support/software-release-notes/goproduce-flatbed-edition-v2
- [GP] Summa GoProduce user manual: https://download.airmark.com/user-manuals/GoProduce_en.pdf
- [SDK] GoProduce SDK programmer guide (listing only): https://support.summa.eu/support/solutions/articles/43000543461-goproduce-sdk-programmer-guide
