# ADR-0004: Ghostscript is an optional, external, user-installed program

- Status: Accepted (attorney review recommended before any bundling)
- Date: 2026-11-02

## Context
Ghostscript is the most capable open-source PDF RIP core (spot/DeviceN separations, ICC/NCLR, overprint simulation, banded multi-threaded rendering). It's licensed **AGPL-3.0**, or commercially by Artifex.

## Decision
- The `render-ghostscript` plugin is Apache-2.0 code that **invokes Ghostscript as a separate program** (`gs`/`gswin64c`) with command-line arguments and files or pipes. It **never links** libgs or includes Ghostscript source.
- Ghostscript is **not bundled** in this repository or our default installers. Users install it themselves (or the plugin offers to download the official Artifex release, with its license shown and user consent).
- The core works without Ghostscript (other RenderEngines, or handoff to an external RIP).

## If we ever bundle the Ghostscript binary in an installer or container
AGPL-3.0 obligations then apply to the Ghostscript part we convey, including:
- Ship or offer the **Corresponding Source** of that exact Ghostscript build (including any modifications) (§6).
- Include the AGPL license text and keep its notices. Don't add further restrictions (§10).
- If we **modify** Ghostscript and users interact with it over a network, offer them the source of the modified version (§13).
- It's generally understood that separate programs on the same medium ("aggregate", §5) don't make our Apache code AGPL. That's a legal judgment, so get counsel review before bundling.

## Downstream vendors
Companies that want to embed Ghostscript (linking, or redistribution without AGPL terms) can get a **commercial license from Artifex** (https://artifex.com/licensing). Our plugin works either way because it doesn't depend on the license under which the user obtained Ghostscript.

## Consequences
+ The Apache core stays clean. Users get a top-tier engine for free.
− An extra install step. Version drift is handled by a version check at `initialize`.
