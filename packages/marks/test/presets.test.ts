import { describe, expect, it } from "vitest";
import {
  MarkSpecError,
  exportPresets,
  importPresets,
  parsePreset,
  planFinishing,
  resolveFinishing,
  selectPreset,
  type MarkPresetInput,
} from "../src/index.js";
import { placeMm } from "./helpers.js";

const BANNER_PRESET: MarkPresetInput = {
  id: "banner-standard",
  name: "Banner standard",
  appliesTo: { hotFolders: ["hf-banners"] },
  finishing: {
    marks: [{ kind: "crop" }, { kind: "grommet", spacingMm: 500 }],
    label: { edge: "bottom", code: { symbology: "datamatrix" } },
  },
};

const QUEUE_PRESET: MarkPresetInput = {
  id: "queue-default",
  name: "Queue default",
  appliesTo: { queues: ["q-roll"] },
  finishing: { marks: [{ kind: "trim-line" }] },
};

const PRESETS = [parsePreset(BANNER_PRESET), parsePreset(QUEUE_PRESET)];

describe("mark presets (FR6)", () => {
  it("parses a preset and fills every default", () => {
    const p = PRESETS[0]!;
    expect(p.version).toBe(1);
    expect(p.appliesTo).toEqual({ hotFolders: ["hf-banners"], queues: [] });
    expect(p.finishing.colorant).toBe("separation");
    expect(p.finishing.marks[1]).toMatchObject({ kind: "grommet", insetMm: 25, spacingMm: 500, diameterMm: 5 });
    expect(p.finishing.label?.code).toMatchObject({ symbology: "datamatrix", moduleMm: 0.5, payload: "uri" });
  });

  it("rejects invalid presets with MarkSpecError", () => {
    expect(() => parsePreset({ ...BANNER_PRESET, id: "bad id!" })).toThrow(MarkSpecError);
    expect(() => parsePreset({ ...QUEUE_PRESET, finishing: { marks: [{ kind: "grommet", spacingMm: -1 }] } })).toThrow(
      /spacingMm/,
    );
  });

  it("exports to self-describing JSON and imports back unchanged", () => {
    const json = exportPresets(PRESETS);
    expect(JSON.parse(json)[1].finishing.marks[0]).toMatchObject({ kind: "trim-line", lineWidthPt: 0.1 });
    expect(importPresets(json)).toEqual(PRESETS);
    const single = exportPresets(PRESETS[0]!);
    expect(Array.isArray(JSON.parse(single))).toBe(false);
    expect(importPresets(single)).toEqual([PRESETS[0]]);
  });

  it("rejects malformed JSON and duplicate ids on import", () => {
    expect(() => importPresets("{not json")).toThrow(MarkSpecError);
    expect(() => importPresets(JSON.stringify([BANNER_PRESET, BANNER_PRESET]))).toThrow(/duplicate/);
  });

  it("selects the job's explicit preset, else the hot folder's, else the queue's", () => {
    expect(selectPreset({ presets: PRESETS, hotFolderId: "hf-banners", queueId: "q-roll" })?.id).toBe("banner-standard");
    expect(selectPreset({ presets: PRESETS, hotFolderId: "hf-other", queueId: "q-roll" })?.id).toBe("queue-default");
    expect(selectPreset({ presets: PRESETS })).toBeUndefined();
    expect(
      selectPreset({ presets: PRESETS, hotFolderId: "hf-banners", override: { presetId: "queue-default" } })?.id,
    ).toBe("queue-default");
    expect(() => selectPreset({ presets: PRESETS, override: { presetId: "missing" } })).toThrow(/missing/);
  });

  it("applies a per-job override: merge by kind, remove, append, colorant and partial label", () => {
    const spec = resolveFinishing({
      presets: PRESETS,
      hotFolderId: "hf-banners",
      override: {
        colorant: "process-k",
        marks: [{ kind: "grommet", spacingMm: 400 }, { kind: "hem-line", edges: ["top"] }],
        removeMarks: ["crop"],
        label: { edge: "top", code: { moduleMm: 0.8 } },
      },
    });
    expect(spec.colorant).toBe("process-k");
    expect(spec.marks.map((m) => m.kind)).toEqual(["grommet", "hem-line"]);
    expect(spec.marks[0]).toMatchObject({ spacingMm: 400, insetMm: 25 });
    expect(spec.marks[1]).toMatchObject({ edges: ["top"], offsetMm: 30 });
    expect(spec.label).toMatchObject({ edge: "top", code: { symbology: "datamatrix", moduleMm: 0.8 } });
  });

  it("merges an override mark by id when the preset names its marks", () => {
    const preset = parsePreset({
      id: "two-hems",
      name: "Two hems",
      finishing: {
        marks: [
          { kind: "hem-line", id: "hem-outer", offsetMm: 40 },
          { kind: "hem-line", id: "hem-inner", offsetMm: 20 },
        ],
      },
    });
    const spec = resolveFinishing({
      presets: [preset],
      override: { presetId: "two-hems", marks: [{ kind: "hem-line", id: "hem-inner", offsetMm: 25 }], removeMarks: ["hem-outer"] },
    });
    expect(spec.marks).toHaveLength(1);
    expect(spec.marks[0]).toMatchObject({ id: "hem-inner", offsetMm: 25 });
  });

  it("removes the label with label: null, and falls back to an empty spec without a preset", () => {
    expect(resolveFinishing({ presets: PRESETS, hotFolderId: "hf-banners", override: { label: null } }).label).toBeUndefined();
    expect(resolveFinishing({ presets: [] })).toEqual({ colorant: "separation", marks: [] });
  });

  it("rejects an override that makes the spec invalid", () => {
    expect(() =>
      resolveFinishing({ presets: PRESETS, hotFolderId: "hf-banners", override: { marks: [{ kind: "grommet", spacingMm: 0 }] } }),
    ).toThrow(MarkSpecError);
  });

  it("the resolved spec drives planning", async () => {
    const item = { itemId: "a", widthMm: 1000, heightMm: 500, bleedMm: 0 };
    const plan = await planFinishing({
      layout: { placements: [placeMm(item, 0, 40)] },
      items: [item],
      job: { id: "J-P", date: "2026-01-01" },
      finishing: resolveFinishing({ presets: PRESETS, queueId: "q-roll" }),
    });
    expect(plan.elements.map((e) => e.markId)).toEqual(["trim-line"]);
  });
});
