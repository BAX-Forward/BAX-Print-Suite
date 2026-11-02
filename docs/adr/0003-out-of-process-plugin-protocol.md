# ADR-0003: Out-of-process plugin protocol (BPP)

- Status: Accepted
- Date: 2026-11-02

## Context
Engines and drivers vary in language and license (Apache, AGPL, proprietary SDKs) and in stability. Linking them into the host would create license entanglement and crash coupling.

## Decision
All RenderEngine, ColorEngine, Screener, PrinterDriver, CutterDriver, and third-party Inspector plugins run as **separate processes**, speaking **BPP v1**: JSON-RPC 2.0 over stdio (Content-Length framing) for control, and raster bands passed by handle through spool files or negotiated shared memory. Interfaces are versioned independently. Manifests declare capabilities, permissions, and external dependencies (see ARCHITECTURE.md §3).

Built-in Apache-2.0 Storage and Inspector implementations may run in-process through the same TypeScript interfaces.

## Consequences
+ License isolation at arm's length (ADR-0004, ADR-0005), crash isolation, any language, and a natural path to remote workers.
− IPC overhead. Mitigated by band handles, shared memory, and coarse-grained calls.
− We must keep a conformance kit and compatibility guarantees.

## Alternatives
In-process native addons (license and crash coupling), gRPC (heavier toolchain on Windows. May be added as a transport later), WASM (sandboxing is attractive, but the engines and SDKs we need aren't available as WASM).
