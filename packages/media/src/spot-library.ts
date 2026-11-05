import { ValidationError, type Lab, normalizeSpotName } from '@bax-print/core';
import { deltaE2000 } from './color/deltae.js';
import { cxfNumber, findAll, findFirst, parseXml, type XmlElement } from './cxf.js';

/** CMYK tint percentages, each 0..100. */
export type CmykPercent = readonly [c: number, m: number, y: number, k: number];

export interface SpotColor {
  readonly name: string;
  /** CIELAB relative to D50. */
  readonly lab: Lab;
  readonly cmykFallback?: CmykPercent;
}

export interface SpotLibrary {
  readonly name: string;
  readonly colors: readonly SpotColor[];
}

export interface SpotMatch {
  readonly color: SpotColor;
  /** CIEDE2000 difference from the query colour. */
  readonly deltaE: number;
}

const L_RANGE = [0, 100] as const;
const AB_RANGE = [-128, 127] as const;
const PERCENT_RANGE = [0, 100] as const;
const CMYK_CHANNELS = ['Cyan', 'Magenta', 'Yellow', 'Black'] as const;

/** Lookup key for a colour name; the shared rule lives in core. */
export { normalizeSpotName };

function inRange(value: number, [min, max]: readonly [number, number], label: string, name: string): number {
  if (value < min || value > max) {
    throw new ValidationError(`CxF: spot color ${name} has ${label} ${value} outside ${min}..${max}`, { object: name });
  }
  return value;
}

function readLab(object: XmlElement, name: string): Lab {
  const lab = findFirst(object, 'ColorCIELab');
  if (!lab) throw new ValidationError(`CxF: spot color ${name} has no ColorCIELab value`, { object: name });
  return {
    L: inRange(cxfNumber(lab, 'L', name), L_RANGE, 'L*', name),
    a: inRange(cxfNumber(lab, 'A', name), AB_RANGE, 'a*', name),
    b: inRange(cxfNumber(lab, 'B', name), AB_RANGE, 'b*', name),
  };
}

function readCmyk(object: XmlElement, name: string): CmykPercent | undefined {
  const cmyk = findFirst(object, 'ColorCMYK');
  if (!cmyk) return undefined;
  const [c, m, y, k] = CMYK_CHANNELS.map((channel) => inRange(cxfNumber(cmyk, channel, name), PERCENT_RANGE, channel, name));
  if (c === undefined || m === undefined || y === undefined || k === undefined) return undefined;
  return [c, m, y, k];
}

/**
 * Reads the named colours of a user-supplied ISO 17972 (CxF3) document into a spot library.
 * Every `Object` must carry a `Name` and a `ColorCIELab` value; a `ColorCMYK` value, when
 * present, becomes the process fallback. Names must be unique after normalisation.
 */
export function parseCxfSpotLibrary(xml: string, libraryName: string): SpotLibrary {
  const name = libraryName.trim();
  if (name === '') throw new ValidationError('Spot library: the library name is empty');
  const document = parseXml(xml).children[0];
  if (!document || document.name !== 'CxF') throw new ValidationError('CxF: the root element must be CxF');
  const seen = new Map<string, string>();
  const colors: SpotColor[] = [];
  for (const object of findAll(document, 'Object')) {
    const colorName = (object.attributes.Name ?? '').trim();
    if (colorName === '') {
      const id = object.attributes.Id ?? '(no Id)';
      throw new ValidationError(`CxF: object ${id} has no Name`, { object: id });
    }
    const key = normalizeSpotName(colorName);
    const previous = seen.get(key);
    if (previous !== undefined) {
      throw new ValidationError(`CxF: duplicate spot color name ${colorName} (also ${previous})`, { object: colorName });
    }
    seen.set(key, colorName);
    const lab = readLab(object, colorName);
    const cmykFallback = readCmyk(object, colorName);
    colors.push(cmykFallback ? { name: colorName, lab, cmykFallback } : { name: colorName, lab });
  }
  if (colors.length === 0) throw new ValidationError('CxF: no named colors');
  return { name, colors };
}

/** The colour whose name matches `name` ignoring case and whitespace differences. */
export function findSpot(library: SpotLibrary, name: string): SpotColor | undefined {
  const key = normalizeSpotName(name);
  return library.colors.find((color) => normalizeSpotName(color.name) === key);
}

/** The `n` colours closest to `lab` by CIEDE2000, nearest first; ties keep library order. */
export function nearestSpots(library: SpotLibrary, lab: Lab, n: number): SpotMatch[] {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`nearestSpots: n must be a non-negative integer, got ${n}`);
  return library.colors
    .map((color) => ({ color, deltaE: deltaE2000(lab, color.lab) }))
    .sort((x, y) => x.deltaE - y.deltaE)
    .slice(0, n);
}
