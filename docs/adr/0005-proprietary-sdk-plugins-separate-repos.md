# ADR-0005: Proprietary SDK plugins live in separate repositories

- Status: Accepted
- Date: 2026-11-02

## Context
Native control of many printers and cutters (status, media sync, accounting, raster submission) is only available through vendor SDKs or partner programs under NDA or restrictive licenses. That material can't be in a public Apache-2.0 repo.

## Decision
- This public repo contains **only** the public interfaces (`packages/plugin-sdk`), the conformance kit, and a **mock PrinterDriver/CutterDriver** for development and tests.
- Each vendor-SDK integration is a **separate repository** (public or private, depending on the vendor's terms), licensed as its authors choose. It depends on the published `@bax-print/plugin-sdk` and speaks BPP. It ships as a separate install.
- No vendor SDK files, headers, binaries, NDA documentation, credentials, or derived protocol notes may be committed here. CI includes secret scanning, and the PR template requires a clean-room attestation.
- The public docs may name vendors and link to their **public** developer-program pages.

## Consequences
+ Clean public repo. Vendors and integrators can build closed plugins legally.
− Fragmented plugin ecosystem. Mitigated by a plugin registry and listing page (future).
