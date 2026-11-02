# Instructions for AI coding agents

These rules bind every AI coding agent (Claude, Cursor, and others) working in the BAX Print Suite repository.

## Public specs only

Implement only from the public specs in `docs/specs/` and from public standards. Never implement from proprietary binaries, decompiled output, vendor SDKs, or NDA material.

A behavior belongs in code only after it is written in `docs/specs/` or cited from a public standard. Observation notes, screenshots, and third-party files are not a source of implementation.

## Third-party software

No disassembly, decompiling, or debugging of third-party software. Do not unpack, patch, or step through a program this project does not maintain in order to learn how it works.

## Repository contents

Never commit vendor binaries, profiles, credentials, or proprietary documents. Do not add SDK headers or libraries, licensed ICC profiles, API keys, manuals received under an NDA, screenshots of another product, or output files from a workflow this project does not own.

## Developer Certificate of Origin

Every commit is signed off (DCO) as its author. Use `git commit -s`. The `Signed-off-by:` line must name the author of that commit. Review the diff before you sign.

## Dependencies and copyleft tools

Dependencies must be on the license allowlist in `docs/LICENSING.md`. AGPL tools like Ghostscript are only invoked as optional external programs, never linked. Do not vendor them, load them into the host process, or add them as a package dependency.

## Tests

Tests must accompany behavior changes. Prefer behavior tests and differential tests against recorded fixtures. Commit the fixtures this project owns, the tolerances, and the metrics. Compare structure (geometry, page boxes, separations, color difference, yield), not a byte copy of another workflow's output.

## Package layout

Keep vendor and device names out of core packages. They belong in plugins. Core packages must not name a manufacturer, model, or device command language.

## Required reading

- [CONTRIBUTING.md](CONTRIBUTING.md) — how to contribute, including DCO sign-off and clean-room ground rules.
- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — pipeline stages, the out-of-process plugin boundary, and the vendor-neutral core.
- [Clean-room method](docs/research/clean-room-method.md) — observer and implementer roles, the sanitize step, and differential testing.
