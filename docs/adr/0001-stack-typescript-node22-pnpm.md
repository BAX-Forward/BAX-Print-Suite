# ADR-0001: Stack: TypeScript on Node 22, pnpm monorepo

- Status: Accepted
- Date: 2026-11-02

## Context
We need a control plane (API, queue, hot folders, nesting, dashboard) that runs well on Windows shop PCs, is approachable for contributors, and scales to server deployments. Performance-critical raster work is isolated behind the plugin protocol (ADR-0003).

## Decision
- TypeScript (strict) on **Node.js 22 LTS**, ESM.
- **pnpm workspaces** monorepo. Vitest, ESLint, Prettier. Fastify for HTTP. Built-in `node:sqlite` for single-PC storage.
- Rust (or other languages) is allowed for plugins via BPP.

## Consequences
+ One language for the API, UI, and SDK. A large contributor pool. No native build step for the core on Windows.
+ Hot paths can still be native through plugins.
− `node:sqlite` is newer (it was experimental in Node 22). Wrapped behind `Storage` so it can be swapped.
− Node is single-threaded, so CPU-heavy work must stay in plugins or worker threads.

## Alternatives considered
Go (good for single binaries, smaller UI ecosystem), Rust everywhere (slower to iterate on UI and API), .NET (strong on Windows, weaker cross-platform contributor pool).
