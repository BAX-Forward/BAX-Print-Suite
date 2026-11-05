import { describe, expect, it } from "vitest";
import { normalizeSpotName } from "../src/index.js";

describe("normalizeSpotName", () => {
  it.each([
    ["Brand Red", "brand red"],
    ["  Brand   Red  ", "brand red"],
    ["BRAND\tRED", "brand red"],
    ["Cut\nContour", "cut contour"],
    ["Cafe\u0301 Blue", "caf\u00e9 blue"],
    ["", ""],
  ])("normalises %j", (input, expected) => {
    expect(normalizeSpotName(input)).toBe(expected);
  });
});
