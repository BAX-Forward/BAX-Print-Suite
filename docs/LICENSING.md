# Licensing and Dependency Policy

BAX Print Suite is licensed under **Apache-2.0** (ADR-0002). This policy keeps everything we ship compatible with that license. It is not legal advice. Edge cases go to maintainers, and to counsel where needed.

## 1. Allowlist for linked / bundled dependencies
Allowed in any package in this repo (CI-enforced):
- MIT, MIT-0, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, Zlib, 0BSD, Unlicense, CC0-1.0 (data), BlueOak-1.0.0, Python-2.0 (case by case)
- **MPL-2.0:** allowed (file-level copyleft). Don't modify the MPL files, or publish any modifications to them.
- MPL-2.0 is allowed only as an unmodified third-party dependency (it is file-level copyleft, so changes to those files must be shared).

Not allowed in linked/bundled code: GPL-*, LGPL-* (case-by-case exception by ADR only), AGPL-*, SSPL, BUSL, Commons Clause, "non-commercial" licenses, and anything with no license.

## 2. Copyleft engines
Copyleft programs (e.g. Ghostscript, MuPDF tools, ArgyllCMS) may be used **only** as:
- **optional**, **separate-process** plugins (ADR-0003) that invoke an **externally installed** program,
- never linked, vendored, or bundled in default artifacts (ADR-0004).

## 3. Proprietary SDKs
Never in this repo. Separate plugin repos only (ADR-0005).

## 4. Candidate components

| Component | License | Our use | Compatibility |
|---|---|---|---|
| Ghostscript | AGPL-3.0 or Artifex commercial | RenderEngine via external `gs` program | ✅ as an external optional plugin. ❌ to link/bundle by default |
| MuPDF | AGPL-3.0 or Artifex commercial | Possible preview engine via the `mutool` program | Same treatment as Ghostscript |
| LittleCMS (lcms2) | MIT | Default ColorEngine (native plugin) | ✅ |
| ArgyllCMS | AGPL-3.0 (most of it; verify per component) | Optional profiling/measurement tools invoked externally | External optional plugin only |
| pdf-lib | MIT | Inspector, imposition PDF writing | ✅ |
| pdf.js (pdfjs-dist) | Apache-2.0 | Dashboard previews | ✅ (keep NOTICE) |
| PDFium | BSD-3-Clause (plus Apache-2.0 / other third-party parts) | Possible fast preview plugin | ✅ (audit its bundled third-party code) |
| chokidar | MIT | Hot-folder watching | ✅ |
| Fastify | MIT | HTTP API | ✅ |
| `node:sqlite` | Part of Node.js (MIT); SQLite is public domain | Single-PC storage | ✅ |

Unknown or changed licenses get rechecked at every dependency bump. CI produces an SBOM.

## 5. ICC profiles and media libraries
- Don't commit ICC profiles, media presets, or characterization data unless the license explicitly allows redistribution. Record each one in `profiles/PROVENANCE.md` (source, license, hash).
- Printer- and media-vendor profiles are usually downloadable by end users but **not redistributable**. Our software should **import** them from the user's machine.
- Prefer profiles we generate ourselves from our own measurements (contributed under CC0 or Apache-2.0), or standard data whose license allows redistribution (check each: e.g. ECI, FOGRA, IDEAlliance characterization data).
- Never export media libraries from commercial RIPs into this project.

## 6. Pantone and other color libraries
Pantone color data and libraries need a license from Pantone LLC. We **don't ship** Pantone data or use Pantone names in UI presets. Users may import their own licensed spot-color libraries (e.g. from a CxF file they own). Spot names in incoming PDFs are just names we honor.

## 7. Trademarks
Third-party names appear only to describe compatibility. "BAX Print Suite" naming is governed by BAX Forward.
