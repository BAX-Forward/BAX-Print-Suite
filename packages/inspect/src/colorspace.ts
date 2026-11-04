import { PDFArray, PDFDict, PDFName, PDFRef, PDFStream, type PDFObject } from "pdf-lib";
import { isName, type Operand } from "./content-lexer.js";
import { dictIn, nameText, numberIn } from "./pdf-objects.js";

/** A resolved colour space (ISO 32000-1 §8.6). */
export interface ColorSpaceInfo {
  family: string;
  /** Named colorants of Separation/DeviceN spaces, including those under Indexed or Pattern. */
  colorants: readonly string[];
  components?: number;
}

/** Colorant names that refer to process colorants or have special meaning (ISO 32000-1 §8.6.6.4). */
export const PROCESS_COLORANTS: ReadonlySet<string> = new Set(["Cyan", "Magenta", "Yellow", "Black"]);
export const SPECIAL_COLORANTS: ReadonlySet<string> = new Set(["All", "None"]);

export const DEVICE_SPACES: ReadonlySet<string> = new Set(["DeviceGray", "DeviceRGB", "DeviceCMYK"]);

const DIRECT_FAMILIES = new Set([...DEVICE_SPACES, "Pattern"]);
const MAX_DEPTH = 8;

/** Inline-image abbreviations (ISO 32000-1 Table 94). */
const INLINE_ABBREVIATIONS: Readonly<Record<string, string>> = {
  G: "DeviceGray",
  RGB: "DeviceRGB",
  CMYK: "DeviceCMYK",
  I: "Indexed",
};

export function colorSpaceKey(space: ColorSpaceInfo): string {
  return [space.family, ...space.colorants].join("\u0000");
}

function namesOf(value: PDFObject | undefined): string[] {
  if (!(value instanceof PDFArray)) return [];
  return value
    .asArray()
    .map((_, index) => value.lookup(index))
    .filter((item): item is PDFName => item instanceof PDFName)
    .map(nameText);
}

/** Resolves a colour space object or resource name. `undefined` when it can't be resolved. */
export function resolveColorSpace(
  value: PDFObject | undefined,
  resources: PDFDict | undefined,
  depth = 0,
): ColorSpaceInfo | undefined {
  if (depth > MAX_DEPTH || value === undefined) return undefined;
  if (value instanceof PDFRef) return resolveColorSpace(resources?.context.lookup(value), resources, depth + 1);
  if (value instanceof PDFName) {
    const name = nameText(value);
    if (DIRECT_FAMILIES.has(name)) return { family: name, colorants: [] };
    const named = dictIn(resources, "ColorSpace")?.lookup(value);
    return named === undefined ? undefined : resolveColorSpace(named, resources, depth + 1);
  }
  if (!(value instanceof PDFArray) || value.size() === 0) return undefined;
  const head = value.lookup(0);
  if (!(head instanceof PDFName)) return undefined;
  const family = nameText(head);
  switch (family) {
    case "Separation": {
      const colorant = value.lookup(1);
      return { family, colorants: colorant instanceof PDFName ? [nameText(colorant)] : [], components: 1 };
    }
    case "DeviceN": {
      const colorants = namesOf(value.lookup(1));
      return { family, colorants, components: colorants.length };
    }
    case "ICCBased": {
      const stream = value.lookup(1);
      return { family, colorants: [], components: stream instanceof PDFStream ? numberIn(stream.dict, "N") : undefined };
    }
    case "Indexed":
    case "Pattern": {
      const base = value.size() > 1 ? resolveColorSpace(value.get(1), resources, depth + 1) : undefined;
      return { family, colorants: base?.colorants ?? [], components: family === "Indexed" ? 1 : base?.components };
    }
    default:
      return { family, colorants: [] };
  }
}

/** Resolves an inline image `/CS` operand, which may use abbreviations. */
export function resolveInlineColorSpace(operand: Operand | undefined, resources: PDFDict | undefined): ColorSpaceInfo | undefined {
  if (isName(operand)) {
    const name = INLINE_ABBREVIATIONS[operand.raw] ?? operand.raw;
    return resolveColorSpace(PDFName.of(name), resources);
  }
  if (!Array.isArray(operand) || operand.length < 2) return undefined;
  const [head, baseOperand] = operand as readonly Operand[];
  if (isName(head)) {
    const family = INLINE_ABBREVIATIONS[head.raw] ?? head.raw;
    const base = family === "Indexed" ? resolveInlineColorSpace(baseOperand, resources) : undefined;
    return { family, colorants: base?.colorants ?? [], components: family === "Indexed" ? 1 : undefined };
  }
  return undefined;
}

/** True when the colorant names a spot ink, not a process colorant or `All`/`None`. */
export function isSpotColorant(name: string): boolean {
  return !PROCESS_COLORANTS.has(name) && !SPECIAL_COLORANTS.has(name);
}
