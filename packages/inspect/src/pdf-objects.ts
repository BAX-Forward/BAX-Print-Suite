import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  decodePDFRawStream,
  type PDFObject,
} from "pdf-lib";
import { normalizeRect, type Rect } from "@bax-print/edits";

/** Small, total helpers over pdf-lib objects. None of them throw on malformed input. */

const MAX_INHERIT_DEPTH = 64;
const utf8 = new TextDecoder("utf-8", { fatal: true });
const latin1 = new TextDecoder("latin1");

/** Decodes a PDF name (without the slash), resolving `#xx` escapes. UTF-8 when valid, else Latin-1. */
export function decodeNameText(encoded: string): string {
  if (!encoded.includes("#")) return encoded;
  const bytes: number[] = [];
  for (let i = 0; i < encoded.length; i++) {
    const hex = encoded[i] === "#" ? encoded.slice(i + 1, i + 3) : "";
    if (/^[0-9a-fA-F]{2}$/.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(encoded.charCodeAt(i) & 0xff);
    }
  }
  const array = Uint8Array.from(bytes);
  try {
    return utf8.decode(array);
  } catch {
    return latin1.decode(array);
  }
}

export function nameText(name: PDFName): string {
  return decodeNameText(name.asString().slice(1));
}

export function lookupIn(dict: PDFDict | undefined, key: string): PDFObject | undefined {
  return dict?.lookup(PDFName.of(key));
}

export function dictIn(dict: PDFDict | undefined, key: string): PDFDict | undefined {
  const value = lookupIn(dict, key);
  if (value instanceof PDFDict) return value;
  if (value instanceof PDFStream) return value.dict;
  return undefined;
}

export function nameIn(dict: PDFDict | undefined, key: string): string | undefined {
  const value = lookupIn(dict, key);
  return value instanceof PDFName ? nameText(value) : undefined;
}

export function numberIn(dict: PDFDict | undefined, key: string): number | undefined {
  const value = lookupIn(dict, key);
  return value instanceof PDFNumber ? value.asNumber() : undefined;
}

export function boolIn(dict: PDFDict | undefined, key: string): boolean | undefined {
  const value = lookupIn(dict, key);
  return value instanceof PDFBool ? value.asBoolean() : undefined;
}

/** Text of a string, hex string or name object. */
export function textOf(value: PDFObject | undefined): string | undefined {
  if (value instanceof PDFString || value instanceof PDFHexString) return value.decodeText();
  if (value instanceof PDFName) return nameText(value);
  return undefined;
}

export function refString(raw: PDFObject | undefined): string | undefined {
  return raw instanceof PDFRef ? raw.toString() : undefined;
}

/** A dictionary entry as stored (possibly a reference) and resolved. */
export function entryIn(dict: PDFDict | undefined, key: string): { raw?: PDFObject; value?: PDFObject } {
  if (!dict) return {};
  const raw = dict.get(PDFName.of(key));
  return { raw, value: raw instanceof PDFRef ? dict.context.lookup(raw) : raw };
}

/** Looks a key up on a page node, then its `/Parent` chain (ISO 32000-1 §7.7.3.4). */
export function inheritedIn(node: PDFDict, key: string): PDFObject | undefined {
  let current: PDFDict | undefined = node;
  for (let depth = 0; current && depth < MAX_INHERIT_DEPTH; depth++) {
    const value = lookupIn(current, key);
    if (value !== undefined) return value;
    const parent = lookupIn(current, "Parent");
    current = parent instanceof PDFDict ? parent : undefined;
  }
  return undefined;
}

export function numbersOf(value: PDFObject | undefined): number[] | undefined {
  if (!(value instanceof PDFArray)) return undefined;
  const numbers: number[] = [];
  for (let i = 0; i < value.size(); i++) {
    const item = value.lookup(i);
    if (!(item instanceof PDFNumber)) return undefined;
    numbers.push(item.asNumber());
  }
  return numbers;
}

/** A rectangle array, normalized. `undefined` when the value is not four finite numbers. */
export function rectOf(value: PDFObject | undefined): Rect | undefined {
  const numbers = numbersOf(value);
  if (!numbers || numbers.length !== 4 || !numbers.every(Number.isFinite)) return undefined;
  const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = numbers;
  return normalizeRect(x0, y0, x1, y1);
}

/** Decoded bytes of a stream. Throws for filters pdf-lib can't decode (e.g. image codecs). */
export function streamBytes(stream: PDFStream): Uint8Array {
  if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode();
  const unencoded = (stream as { getUnencodedContents?: () => Uint8Array }).getUnencodedContents;
  return typeof unencoded === "function" ? unencoded.call(stream) : stream.getContents();
}
