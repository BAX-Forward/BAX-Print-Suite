#!/usr/bin/env node
import { serveInspector } from "@bax-print/plugin-sdk";
import { DEFAULT_TIMEOUT_MS, GhostscriptInspector } from "./index.js";

/**
 * Plugin entry point: serves `Inspector/1` over BPP on stdio. The host already scrubs the
 * environment (ARCHITECTURE §3.7), so Ghostscript gets this process's environment as-is.
 *
 * Settings: `BPS_GHOSTSCRIPT` (executable), `BPS_GHOSTSCRIPT_TIMEOUT_MS`.
 */

function timeoutFromEnv(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1000 && parsed <= 3_600_000 ? parsed : DEFAULT_TIMEOUT_MS;
}

const inspector = new GhostscriptInspector({ timeoutMs: timeoutFromEnv(process.env.BPS_GHOSTSCRIPT_TIMEOUT_MS), env: process.env });

// stdout carries the protocol; logs go to stderr.
serveInspector(inspector, { capabilities: () => inspector.capabilities() });
process.stderr.write(JSON.stringify({ level: "info", msg: "inspector-ghostscript ready" }) + "\n");
