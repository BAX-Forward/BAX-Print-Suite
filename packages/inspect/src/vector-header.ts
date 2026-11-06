/**
 * Header-level facts for vector intake (Spec 035a): the declared size of an SVG and the drawing
 * header of an ASCII DXF, read from a bounded prefix of the file. Nothing past
 * `VECTOR_HEADER_MAX_BYTES` is looked at. SVG is scanned by hand, not parsed as XML: a DTD or
 * entity declaration is only detected, never processed or expanded, and external references are
 * only counted, never fetched or resolved. The reader does no file system or network access.
 */

export type VectorType = "svg" | "dxf";
export type VectorHeaderErrorCode = "UNKNOWN_FORMAT" | "UNSUPPORTED" | "TRUNCATED" | "INVALID_HEADER";

const SVG_UNITS = ["px", "pt", "pc", "mm", "cm", "in", "em", "ex", "%"] as const;
export type SvgLengthUnit = (typeof SVG_UNITS)[number];

export interface SvgViewBox {
  readonly minX: number;
  readonly minY: number;
  readonly width: number;
  readonly height: number;
}

export interface SvgHeader {
  readonly kind: "svg";
  /** Root `width` and `height`, positive; absent when missing or not a plain length. */
  readonly width?: number;
  readonly height?: number;
  /** The unit of `width` and `height`; absent when unitless (user units) or mixed beyond conversion. */
  readonly unit?: SvgLengthUnit;
  readonly viewBox?: SvgViewBox;
  readonly hasDoctype: boolean;
  readonly hasEntityDecl: boolean;
  /** `href` / `xlink:href` values in the prefix that are neither `#fragment` nor `data:` URIs. */
  readonly externalRefs: number;
}

export interface DxfPoint {
  readonly x: number;
  readonly y: number;
  readonly z?: number;
}

export interface DxfHeader {
  readonly kind: "dxf";
  /** `$ACADVER`, e.g. `AC1027`. */
  readonly acadVer?: string;
  /** `$INSUNITS` drawing units code; 0 means unitless. */
  readonly insUnits?: number;
  readonly extMin?: DxfPoint;
  readonly extMax?: DxfPoint;
}

export interface VectorHeaderError {
  readonly kind: "error";
  readonly code: VectorHeaderErrorCode;
  readonly message: string;
  /** The format, when the bytes were recognised before the read failed. */
  readonly format?: VectorType;
}

export type VectorHeader = SvgHeader | DxfHeader;
export type VectorHeaderResult = VectorHeader | VectorHeaderError;

/** The reader never looks past this many leading bytes. */
export const VECTOR_HEADER_MAX_BYTES = 64 * 1024;

/** Upper bound on root attributes, so hostile input can't make the tag scan unbounded. */
const MAX_SVG_ATTRIBUTES = 1024;

function failure(code: VectorHeaderErrorCode, message: string, format?: VectorType): VectorHeaderError {
  return Object.freeze({ kind: "error", code, message, ...(format === undefined ? {} : { format }) });
}

/** Reads the header facts of an SVG or ASCII DXF file from its first `VECTOR_HEADER_MAX_BYTES` bytes. */
export function readVectorHeader(bytes: Uint8Array): VectorHeaderResult {
  const prefix = bytes.subarray(0, VECTOR_HEADER_MAX_BYTES);
  const cut = bytes.byteLength > VECTOR_HEADER_MAX_BYTES;
  if (isBinaryDxf(prefix)) return failure("UNSUPPORTED", "DXF: binary DXF is not supported; save the drawing as ASCII DXF", "dxf");
  const text = new TextDecoder("utf-8").decode(prefix);
  const start = skipWhitespace(text, 0);
  if (text.startsWith("<", start)) return readSvg(text, start, cut);
  return readDxf(text, cut) ?? failure("UNKNOWN_FORMAT", "Input is not an SVG or ASCII DXF file");
}

// ---- SVG (W3C SVG 1.1 / SVG 2, XML 1.0) --------------------------------------------------

// Markup openers are built from the code point so that no literal bang character appears here.
const BANG = String.fromCharCode(0x21);
const PI_OPEN = "<?";
const COMMENT_OPEN = `<${BANG}--`;
const DOCTYPE_OPEN = `<${BANG}DOCTYPE`;
const ENTITY_OPEN = `<${BANG}ENTITY`;
const DECLARATION_OPEN = `<${BANG}`;

const WHITESPACE = /\s/;
const ELEMENT_NAME = /[^\s/>]+/y;
const ATTRIBUTE = /([^\s=/>"']+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
const HREF = /\s(?:[A-Za-z_][\w.-]*:)?href\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const LENGTH = /^(\+?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)([a-z]{2}|%)?$/i;

const UNIT_BY_NAME: ReadonlyMap<string, SvgLengthUnit> = new Map(SVG_UNITS.map((unit) => [unit, unit]));
/** CSS px per absolute unit (CSS Values 3 §6.2); relative units have no entry. */
const PX_PER_UNIT: ReadonlyMap<SvgLengthUnit, number> = new Map([
  ["px", 1],
  ["pt", 96 / 72],
  ["pc", 16],
  ["mm", 96 / 25.4],
  ["cm", 96 / 2.54],
  ["in", 96],
]);

function skipWhitespace(text: string, from: number): number {
  let at = from;
  while (at < text.length && WHITESPACE.test(text.charAt(at))) at += 1;
  return at;
}

/** The index just past `terminator`, searching from `from`; -1 when it is not in the text. */
function after(text: string, terminator: string, from: number): number {
  const at = text.indexOf(terminator, from);
  return at < 0 ? -1 : at + terminator.length;
}

/** Skips a DOCTYPE declaration, internal subset included, without interpreting it; -1 if unclosed. */
function skipDoctype(text: string, from: number): number {
  let quote = "";
  let depth = 0;
  for (let at = from + DOCTYPE_OPEN.length; at < text.length; at += 1) {
    const char = text.charAt(at);
    if (quote === "") {
      if (char === '"' || char === "'") quote = char;
      else if (char === "[") depth += 1;
      else if (char === "]") depth = Math.max(0, depth - 1);
      else if (char === ">" && depth === 0) return at + 1;
    } else if (char === quote) {
      quote = "";
    }
  }
  return -1;
}

type RootScan = { readonly found: true; readonly at: number } | { readonly found: false; readonly ended: boolean };

/** Walks the XML prolog (declaration, comments, processing instructions, DOCTYPE) to the first element. */
function findRootElement(text: string, from: number): RootScan {
  let at = from;
  while (at < text.length) {
    if (text.startsWith(PI_OPEN, at)) at = after(text, "?>", at + PI_OPEN.length);
    else if (text.startsWith(COMMENT_OPEN, at)) at = after(text, "-->", at + COMMENT_OPEN.length);
    else if (text.startsWith(DOCTYPE_OPEN, at)) at = skipDoctype(text, at);
    else if (text.startsWith("<", at) && text.startsWith(DECLARATION_OPEN, at) === false) return { found: true, at };
    else return { found: false, ended: false };
    if (at < 0) return { found: false, ended: true };
    at = skipWhitespace(text, at);
  }
  return { found: false, ended: true };
}

function readSvg(text: string, start: number, cut: boolean): VectorHeaderResult {
  const root = findRootElement(text, start);
  if (root.found === false) {
    if (root.ended && cut) return failure("TRUNCATED", `No root element within the first ${VECTOR_HEADER_MAX_BYTES} bytes`);
    return failure("UNKNOWN_FORMAT", "Input is not an SVG or ASCII DXF file");
  }
  ELEMENT_NAME.lastIndex = root.at + 1;
  const name = ELEMENT_NAME.exec(text)?.[0] ?? "";
  if (name.split(":").pop() === "svg") {
    const attributes = readAttributes(text, root.at + 1 + name.length);
    if (attributes instanceof Map) return svgHeader(text, attributes);
    return attributes;
  }
  return failure("UNKNOWN_FORMAT", `Root element <${name}> is not <svg>`);
}

/** Root start-tag attributes, first occurrence wins. Values are kept literally: no entity is expanded. */
function readAttributes(text: string, from: number): Map<string, string> | VectorHeaderError {
  const attributes = new Map<string, string>();
  let at = from;
  for (let n = 0; n <= MAX_SVG_ATTRIBUTES; n += 1) {
    const next = skipWhitespace(text, at);
    if (next >= text.length) return failure("TRUNCATED", "SVG: the root <svg> start tag is not closed within the prefix", "svg");
    if (text.startsWith(">", next) || text.startsWith("/>", next)) return attributes;
    if (next === at) return failure("INVALID_HEADER", `SVG: expected whitespace before the attribute at character ${at}`, "svg");
    ATTRIBUTE.lastIndex = next;
    const match = ATTRIBUTE.exec(text);
    if (match === null) {
      if (text.includes(">", next)) return failure("INVALID_HEADER", `SVG: malformed attribute at character ${next}`, "svg");
      return failure("TRUNCATED", "SVG: the root <svg> start tag is not closed within the prefix", "svg");
    }
    const attribute = match[1] ?? "";
    if (attributes.has(attribute) === false) attributes.set(attribute, match[2] ?? match[3] ?? "");
    at = ATTRIBUTE.lastIndex;
  }
  return failure("INVALID_HEADER", `SVG: the root <svg> start tag has more than ${MAX_SVG_ATTRIBUTES} attributes`, "svg");
}

interface SvgLength {
  value: number;
  unit: SvgLengthUnit | undefined;
}

/** A positive `<length>`; `undefined` for anything else, including unexpanded entity references. */
function parseLength(raw: string | undefined): SvgLength | undefined {
  const match = LENGTH.exec(raw?.trim() ?? "");
  if (match === null) return undefined;
  const value = Number(match[1]);
  const unitName = match[2]?.toLowerCase();
  if (Number.isFinite(value) === false || value <= 0) return undefined;
  if (unitName === undefined) return { value, unit: undefined };
  const unit = UNIT_BY_NAME.get(unitName);
  return unit === undefined ? undefined : { value, unit };
}

function parseViewBox(raw: string | undefined): SvgViewBox | undefined {
  const parts = (raw?.trim() ?? "").split(/[\s,]+/);
  if (parts.length === 4 && parts.every((part) => NUMBER.test(part))) {
    const [minX = 0, minY = 0, width = 0, height = 0] = parts.map(Number);
    if (width > 0 && height > 0) return { minX, minY, width, height };
  }
  return undefined;
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** Width, height and their shared unit. Mixed absolute units are converted to the width's unit. */
function svgSize(width: SvgLength | undefined, height: SvgLength | undefined): Pick<SvgHeader, "width" | "height" | "unit"> {
  const unit = (length: SvgLength): Pick<SvgHeader, "unit"> => (length.unit === undefined ? {} : { unit: length.unit });
  if (width === undefined) return height === undefined ? {} : { height: height.value, ...unit(height) };
  if (height === undefined) return { width: width.value, ...unit(width) };
  if (width.unit === height.unit) return { width: width.value, height: height.value, ...unit(width) };
  const widthPx = width.unit === undefined ? undefined : PX_PER_UNIT.get(width.unit);
  const heightPx = height.unit === undefined ? undefined : PX_PER_UNIT.get(height.unit);
  if (widthPx === undefined || heightPx === undefined) return { width: width.value, height: height.value };
  return { width: width.value, height: round((height.value * heightPx) / widthPx), ...unit(width) };
}

function isExternalReference(value: string): boolean {
  return value.length > 0 && value.startsWith("#") === false && /^data:/i.test(value) === false;
}

function countExternalReferences(text: string): number {
  let count = 0;
  for (const match of text.matchAll(HREF)) {
    if (isExternalReference((match[1] ?? match[2] ?? "").trim())) count += 1;
  }
  return count;
}

function svgHeader(text: string, attributes: ReadonlyMap<string, string>): SvgHeader {
  const viewBox = parseViewBox(attributes.get("viewBox"));
  return Object.freeze({
    kind: "svg",
    ...svgSize(parseLength(attributes.get("width")), parseLength(attributes.get("height"))),
    ...(viewBox === undefined ? {} : { viewBox: Object.freeze(viewBox) }),
    hasDoctype: text.includes(DOCTYPE_OPEN),
    hasEntityDecl: text.includes(ENTITY_OPEN),
    externalRefs: countExternalReferences(text),
  });
}

// ---- DXF (AutoCAD DXF reference, ASCII form) ---------------------------------------------

const BINARY_DXF_SENTINEL = "AutoCAD Binary DXF";
const GROUP_CODE = /^\s*[+-]?\d+\s*$/;
const INTEGER = /^[+-]?\d+$/;
const DXF_COMMENT = 999;

function isBinaryDxf(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= BINARY_DXF_SENTINEL.length &&
    [...BINARY_DXF_SENTINEL].every((char, index) => bytes[index] === char.charCodeAt(0))
  );
}

interface DxfPair {
  code: number;
  value: string;
}

/** Group-code/value line pairs; `undefined` at the end of the text, `null` for a malformed code. */
function pairReader(lines: readonly string[]): () => DxfPair | null | undefined {
  let index = 0;
  return () => {
    const codeLine = lines[index];
    const valueLine = lines[index + 1];
    if (codeLine === undefined || valueLine === undefined) return undefined;
    index += 2;
    return GROUP_CODE.test(codeLine) ? { code: Number(codeLine), value: valueLine.trim() } : null;
  };
}

function isPair(pair: DxfPair | null | undefined, code: number, value: string): boolean {
  return pair?.code === code && pair.value === value;
}

/**
 * Reads the HEADER section of an ASCII DXF: `undefined` when the text is not a DXF. The scan stops
 * at the HEADER's ENDSEC or the end of the prefix; HEADER is the first section when present.
 */
function readDxf(text: string, cut: boolean): VectorHeaderResult | undefined {
  const lines = text.split(/\r?\n/);
  // A prefix cut at the bound may end mid-line.
  if (cut) lines.pop();
  const next = pairReader(lines);
  let first = next();
  while (first?.code === DXF_COMMENT) first = next();
  if (isPair(first, 0, "SECTION") === false) return undefined;
  const section = next();
  if (section === null) return failure("INVALID_HEADER", "DXF: malformed group code after SECTION", "dxf");
  if (isPair(section, 2, "HEADER") === false) return dxfHeader(new Map());
  const variables = new Map<string, Map<number, string>>();
  let current: Map<number, string> | undefined;
  let pair = next();
  // Group code 0 ends the section: ENDSEC, or a malformed file that starts the next object early.
  while (pair && (pair.code === 0) === false) {
    if (pair.code === 9) {
      current = variables.has(pair.value) ? undefined : new Map();
      if (current) variables.set(pair.value, current);
    } else if (current && current.has(pair.code) === false) {
      current.set(pair.code, pair.value);
    }
    pair = next();
  }
  if (pair === null) return failure("INVALID_HEADER", "DXF: malformed group code in the HEADER section", "dxf");
  return dxfHeader(variables);
}

function parseNumber(raw: string | undefined): number | undefined {
  if (raw === undefined || NUMBER.test(raw) === false) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function parseInteger(raw: string | undefined): number | undefined {
  return raw === undefined || INTEGER.test(raw) === false ? undefined : Number(raw);
}

/** A point variable: X, Y and optional Z in group codes 10, 20 and 30. */
function readPoint(values: ReadonlyMap<number, string> | undefined): DxfPoint | undefined {
  const x = parseNumber(values?.get(10));
  const y = parseNumber(values?.get(20));
  const z = parseNumber(values?.get(30));
  if (x === undefined || y === undefined) return undefined;
  return Object.freeze({ x, y, ...(z === undefined ? {} : { z }) });
}

function dxfHeader(variables: ReadonlyMap<string, ReadonlyMap<number, string>>): DxfHeader {
  const acadVer = variables.get("$ACADVER")?.get(1);
  const insUnits = parseInteger(variables.get("$INSUNITS")?.get(70));
  const extMin = readPoint(variables.get("$EXTMIN"));
  const extMax = readPoint(variables.get("$EXTMAX"));
  return Object.freeze({
    kind: "dxf",
    ...(acadVer === undefined || acadVer === "" ? {} : { acadVer }),
    ...(insUnits === undefined ? {} : { insUnits }),
    ...(extMin === undefined ? {} : { extMin }),
    ...(extMax === undefined ? {} : { extMax }),
  });
}
