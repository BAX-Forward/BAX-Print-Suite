import { normalizeSpotName } from "@bax-print/core";
import { describe, expect, it } from "vitest";
import { spotNameKey } from "../src/index.js";

describe("spot name parity", () => {
  it("uses the shared core rule", () => {
    expect(spotNameKey).toBe(normalizeSpotName);
  });

  it.each(["Brand Red", "  brand\tRED ", "Cafe\u0301 Blue", "CutContour"])("matches core for %j", (name) => {
    expect(spotNameKey(name)).toBe(normalizeSpotName(name));
  });
});
