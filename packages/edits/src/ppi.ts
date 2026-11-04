import type { EditedGeometry } from "./geometry.js";
import { IDENTITY, PT_PER_INCH, axisLengths, multiply, type Matrix } from "./transform.js";

/**
 * A raster image as drawn on a page. In PDF an image occupies the unit square of image
 * space, mapped to user space by the CTM in effect at its `Do` (ISO 32000-1 §8.9.4).
 */
export interface ImagePlacement {
  pixelWidth: number;
  pixelHeight: number;
  /** Image space (unit square) → source user space. */
  ctm: Matrix;
}

export interface EffectivePpi {
  x: number;
  y: number;
  /** The lower of the two axes: what a resolution check compares against. */
  min: number;
}

/**
 * Effective resolution of an image after `toOutput` (source user space → output points),
 * e.g. `EditedGeometry.toTrim`. Rotation and mirroring leave it unchanged; scaling divides it.
 */
export function effectivePpi(image: ImagePlacement, toOutput: Matrix = IDENTITY): EffectivePpi {
  if (!(image.pixelWidth > 0 && image.pixelHeight > 0)) throw new RangeError("image needs positive pixel dimensions");
  const lengths = axisLengths(multiply(image.ctm, toOutput));
  if (!(lengths.x > 0 && lengths.y > 0)) throw new RangeError("image is drawn with no area");
  const x = image.pixelWidth / (lengths.x / PT_PER_INCH);
  const y = image.pixelHeight / (lengths.y / PT_PER_INCH);
  return { x, y, min: Math.min(x, y) };
}

/** Effective resolution of an image on a page after the page's edit stack. */
export function editedPpi(image: ImagePlacement, geometry: EditedGeometry): EffectivePpi {
  return effectivePpi(image, geometry.toTrim);
}
