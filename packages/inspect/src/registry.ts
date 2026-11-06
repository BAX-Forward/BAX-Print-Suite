import type { AnyCheck } from "./check.js";
import { colorSpacesCheck } from "./checks/color-spaces.js";
import { conformanceCheck } from "./checks/conformance.js";
import { documentCheck } from "./checks/document.js";
import { fontsCheck } from "./checks/fonts.js";
import { imageResolutionCheck } from "./checks/image-resolution.js";
import { outputIntentCheck } from "./checks/output-intent.js";
import { pageBoxesCheck } from "./checks/page-boxes.js";
import { printableWidthCheck } from "./checks/printable-width.js";
import { transparencyOverprintCheck } from "./checks/transparency-overprint.js";
import { rasterColorModeCheck, rasterResolutionCheck } from "./raster-checks.js";

const CHECK_ID = /^[a-z][a-z0-9-]{0,63}$/;

export class CheckRegistry {
  private readonly checks = new Map<string, AnyCheck>();

  constructor(checks: readonly AnyCheck[] = []) {
    checks.forEach((check) => this.register(check));
  }

  register(check: AnyCheck): void {
    if (!CHECK_ID.test(check.id)) throw new TypeError(`Invalid check id ${JSON.stringify(check.id)}`);
    if (this.checks.has(check.id)) throw new Error(`Check ${check.id} is already registered`);
    this.checks.set(check.id, check);
  }

  get(id: string): AnyCheck | undefined {
    return this.checks.get(id);
  }

  has(id: string): boolean {
    return this.checks.has(id);
  }

  list(): AnyCheck[] {
    return [...this.checks.values()];
  }
}

/**
 * Built-in checks, in report order. `document` comes first: the others depend on a readable file.
 * The raster checks (Spec 031b) find nothing in a PDF; they run on raster headers only.
 */
export const BUILTIN_CHECKS: readonly AnyCheck[] = [
  documentCheck,
  pageBoxesCheck,
  printableWidthCheck,
  imageResolutionCheck,
  fontsCheck,
  colorSpacesCheck,
  transparencyOverprintCheck,
  outputIntentCheck,
  conformanceCheck,
  rasterResolutionCheck.check,
  rasterColorModeCheck.check,
];

export function builtinRegistry(): CheckRegistry {
  return new CheckRegistry(BUILTIN_CHECKS);
}
