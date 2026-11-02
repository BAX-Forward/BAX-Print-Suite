# ADR-0006: Dashboard is a React + Vite single-page app on the public API

- Status: Accepted
- Date: 2026-11-02

## Context
The dashboard (ARCHITECTURE.md §10) must use only the public REST and SSE API, run from the single-PC control plane without an extra server process, and be easy for contributors to work on.

## Decision
- **React 18 + TypeScript + Vite**, built to static assets that `apps/server` serves under `/ui` (`@fastify/static`).
- Data: **TanStack Query** for REST caching, with SSE events invalidating queries. Routing: **React Router**. Table: **TanStack Table**. Styling: plain CSS modules (no UI-kit lock-in). All MIT.
- API client types are **generated from `/openapi.json`** (`openapi-typescript`, MIT), so the UI can't drift from the API.
- Previews: **pdf.js (`pdfjs-dist`, Apache-2.0) in the browser**, loading `GET /jobs/:id/file`. Server-side previews arrive later through the RenderEngine (M5) behind the same `GET /jobs/:id/preview` contract.
- E2E tests: **Playwright** (Apache-2.0).

## Rationale
- An SPA served as static files means no Node SSR runtime. Fits the single-PC deployment and keeps the "public API only" rule obvious.
- React has the largest contributor pool and mature table and PDF integrations.
- Browser pdf.js means no copyleft engine and no server CPU for thumbnails in M2.

## Alternatives
Next.js (SSR is unnecessary, and it tempts private server routes), SvelteKit/Vue (fine, smaller pool), server-side thumbnails via Ghostscript (AGPL, optional, and not available until M5).

## Consequences
+ Static, cacheable UI and typed API usage.
− pdf.js preview fidelity is screen-grade (overprint and spot simulation are limited). The preview is labeled "screen preview", and RIP-accurate preview comes in M5.
