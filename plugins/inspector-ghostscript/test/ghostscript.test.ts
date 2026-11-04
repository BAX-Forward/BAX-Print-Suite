import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FIXUP_TARGETS,
  GhostscriptInspector,
  GhostscriptNotFoundError,
  buildFixupArgs,
  defaultCommand,
  detectVersion,
} from "../src/index.js";

/** A command that is not installed anywhere, standing in for a machine without Ghostscript. */
const MISSING = { command: "bps-test-ghostscript-not-installed" };

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("without Ghostscript installed", () => {
  it("detects no version instead of failing", async () => {
    await expect(detectVersion(MISSING)).resolves.toBeUndefined();
  });

  it("reports the capability as unavailable", async () => {
    const inspector = new GhostscriptInspector({ ghostscript: MISSING });
    await expect(inspector.capabilities()).resolves.toEqual({ ghostscript: { available: false } });
  });

  it("fails fixup with a typed error and writes no file", async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), "bps-gs-"));
    dirs.push(outputDir);
    const inspector = new GhostscriptInspector({ ghostscript: MISSING });
    const attempt = inspector.fixup({ document: { kind: "file", path: path.join(outputDir, "in.pdf") }, target: "PDF/A-2b", outputDir });
    await expect(attempt).rejects.toBeInstanceOf(GhostscriptNotFoundError);
    expect(await readdir(outputDir)).toEqual([]);
  });

  it("rejects an unsupported target before running anything", async () => {
    const inspector = new GhostscriptInspector({ ghostscript: MISSING });
    await expect(inspector.fixup({ document: { kind: "file", path: "in.pdf" }, target: "PDF/X-9", outputDir: tmpdir() })).rejects.toBeInstanceOf(
      TypeError,
    );
  });
});

describe("command line", () => {
  it("honours the configured executable", () => {
    expect(defaultCommand({ BPS_GHOSTSCRIPT: " /opt/gs/bin/gs " }, "linux")).toEqual({ command: "/opt/gs/bin/gs" });
    expect(defaultCommand({}, "linux")).toEqual({ command: "gs" });
  });

  it("passes paths as separate arguments with the input last", () => {
    const args = buildFixupArgs(FIXUP_TARGETS[0], "/in/a b.pdf", "/out/x.pdf", { outputIntentProfile: "/icc/press.icc" });
    expect(args).toContain("-dSAFER");
    expect(args).toContain("-dPDFX");
    expect(args).toContain("--permit-file-read=/icc/press.icc");
    expect(args).toContain("-sOutputFile=/out/x.pdf");
    expect(args.at(-1)).toBe("/in/a b.pdf");
  });
});
