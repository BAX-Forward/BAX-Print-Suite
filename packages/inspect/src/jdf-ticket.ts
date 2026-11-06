/**
 * Header-level facts of a JDF job ticket (Spec 037a), read from a bounded prefix of the file.
 * Nothing past `JDF_TICKET_MAX_BYTES` is looked at. The ticket is scanned by hand, not parsed as
 * XML: a DTD or entity declaration is only detected, never processed or expanded, and FileSpec
 * URLs are only recorded and counted, never fetched, resolved or opened. Only CIP4 JDF 1.x
 * elements are read: elements in any other namespace, and everything inside them, are skipped.
 * The reader does no file system or network access.
 */

export type JdfTicketErrorCode = "UNKNOWN_FORMAT" | "TRUNCATED" | "INVALID_TICKET";

/** A JDF `XYPair` media size, in points. */
export interface JdfDimension {
  readonly width: number;
  readonly height: number;
}

export interface JdfMedia {
  /** `Media/@DescriptiveName`. */
  readonly name?: string;
  /** `Media/@Dimension`, when it is two positive numbers. */
  readonly dimension?: JdfDimension;
}

export interface JdfFileRefs {
  /** Every `RunList/LayoutElement/FileSpec/@URL` in the prefix. */
  readonly count: number;
  /** The first `JDF_MAX_FILE_URLS` of them, as written. */
  readonly urls: readonly string[];
}

export interface JdfTicket {
  readonly kind: "jdf";
  /** Root `JDF` node attributes. */
  readonly id?: string;
  readonly jobId?: string;
  readonly jobPartId?: string;
  readonly type?: string;
  readonly types?: readonly string[];
  readonly status?: string;
  readonly version?: string;
  /** `Amount` of the first `ResourcePool/Component` that has a positive one. */
  readonly quantity?: number;
  /** The first `ResourcePool/Media` with a name or a dimension. */
  readonly media?: JdfMedia;
  readonly fileRefs: JdfFileRefs;
  readonly hasDoctype: boolean;
  readonly hasEntityDecl: boolean;
  /** The scan stopped at an element or attribute cap, or the prefix ended inside the root element. */
  readonly truncated: boolean;
}

export interface JdfTicketError {
  readonly kind: "error";
  readonly code: JdfTicketErrorCode;
  readonly message: string;
}

export type JdfTicketResult = JdfTicket | JdfTicketError;

/** The reader never looks past this many leading bytes. */
export const JDF_TICKET_MAX_BYTES = 256 * 1024;
/** The scan stops, truncated, at the element after this many. */
export const JDF_MAX_ELEMENTS = 5000;
/** The scan stops, truncated, at an element with more attributes than this. */
export const JDF_MAX_ATTRIBUTES = 64;
/** At most this many FileSpec URLs are recorded; all of them are counted. */
export const JDF_MAX_FILE_URLS = 32;

/** The namespace shared by every JDF 1.x version, as published by CIP4. */
const JDF_NAMESPACE = "http://www.CIP4.org/JDFSchema_1_1";

function failure(code: JdfTicketErrorCode, message: string): JdfTicketError {
  return Object.freeze({ kind: "error", code, message });
}

// ---- Markup scanning (XML 1.0), linear and without a parser ------------------------------

// Markup openers are built from the code point so that no literal bang character appears here.
const BANG = String.fromCharCode(0x21);
const PI_OPEN = "<?";
const COMMENT_OPEN = `<${BANG}--`;
const CDATA_OPEN = `<${BANG}[CDATA[`;
const DOCTYPE_OPEN = `<${BANG}DOCTYPE`;
const ENTITY_OPEN = `<${BANG}ENTITY`;
const DECLARATION_OPEN = `<${BANG}`;

const ELEMENT_NAME = /[^\s/>]+/y;
const ATTRIBUTE = /([^\s=/>"']+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const REFERENCE = /&(?:#x([0-9A-Fa-f]{1,6})|#([0-9]{1,7})|([A-Za-z]{2,4}));/y;
const PREDEFINED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
]);
/** Element names quoted in messages are cut to this length. */
const MAX_NAME_IN_MESSAGE = 64;

/** XML white space: space, tab, carriage return and line feed. */
function isXmlSpace(text: string, at: number): boolean {
  const code = text.charCodeAt(at);
  return code === 0x20 || code === 0x09 || code === 0x0d || code === 0x0a;
}

function skipWhitespace(text: string, from: number): number {
  let at = from;
  while (at < text.length && isXmlSpace(text, at)) at += 1;
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

/** Skips a comment, CDATA section, declaration or processing instruction; `undefined` at a tag. */
function skipMarkup(text: string, at: number): number | undefined {
  if (text.startsWith(COMMENT_OPEN, at)) return after(text, "-->", at + COMMENT_OPEN.length);
  if (text.startsWith(CDATA_OPEN, at)) return after(text, "]]>", at + CDATA_OPEN.length);
  if (text.startsWith(DOCTYPE_OPEN, at)) return skipDoctype(text, at);
  if (text.startsWith(DECLARATION_OPEN, at)) return after(text, ">", at + DECLARATION_OPEN.length);
  if (text.startsWith(PI_OPEN, at)) return after(text, "?>", at + PI_OPEN.length);
  return undefined;
}

type RootScan = { readonly found: true; readonly at: number } | { readonly found: false; readonly ended: boolean };

/** Walks the XML prolog (declaration, comments, processing instructions, DOCTYPE) to the first element. */
function findRootElement(text: string): RootScan {
  let at = skipWhitespace(text, 0);
  while (at < text.length) {
    if (text.startsWith("<", at) === false || text.startsWith(CDATA_OPEN, at)) return { found: false, ended: false };
    const skipped = skipMarkup(text, at);
    if (skipped === undefined) return { found: true, at };
    if (skipped < 0) return { found: false, ended: true };
    at = skipWhitespace(text, skipped);
  }
  return { found: false, ended: true };
}

function elementName(text: string, lt: number): string {
  ELEMENT_NAME.lastIndex = lt + 1;
  return ELEMENT_NAME.exec(text)?.[0] ?? "";
}

type Tag =
  | {
      readonly kind: "tag";
      readonly attributes: ReadonlyMap<string, string>;
      readonly selfClosing: boolean;
      readonly end: number;
    }
  | { readonly kind: "too-many"; readonly attributes: ReadonlyMap<string, string> }
  | { readonly kind: "unclosed" }
  | { readonly kind: "malformed"; readonly at: number };

/** Start-tag attributes, first occurrence wins. Values are kept as written: no reference is expanded. */
function readTag(text: string, from: number): Tag {
  const attributes = new Map<string, string>();
  let at = from;
  for (let n = 0; ; n += 1) {
    const next = skipWhitespace(text, at);
    if (next >= text.length) return { kind: "unclosed" };
    if (text.startsWith(">", next)) return { kind: "tag", attributes, selfClosing: false, end: next + 1 };
    if (text.startsWith("/>", next)) return { kind: "tag", attributes, selfClosing: true, end: next + 2 };
    if (next === at) return { kind: "malformed", at };
    if (n >= JDF_MAX_ATTRIBUTES) return { kind: "too-many", attributes };
    ATTRIBUTE.lastIndex = next;
    const match = ATTRIBUTE.exec(text);
    if (match === null) return text.includes(">", next) ? { kind: "malformed", at: next } : { kind: "unclosed" };
    const attribute = match[1] ?? "";
    if (attributes.has(attribute) === false) attributes.set(attribute, match[2] ?? match[3] ?? "");
    at = ATTRIBUTE.lastIndex;
  }
}

function isXmlChar(code: number): boolean {
  return (
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0d ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff)
  );
}

function referencedText(match: RegExpExecArray): string | undefined {
  const [, hex, decimal, name] = match;
  if (name === undefined) {
    const code = hex === undefined ? Number(decimal) : Number.parseInt(hex, 16);
    return isXmlChar(code) ? String.fromCodePoint(code) : undefined;
  }
  return PREDEFINED_ENTITIES.get(name);
}

/**
 * An attribute value with character references and the five predefined entities replaced (XML 1.0
 * sections 4.1 and 4.6). Any other reference, such as one to a DTD-declared entity, is never looked up: the
 * whole value is unusable and `undefined` is returned.
 */
function decodeValue(raw: string): string | undefined {
  let decoded = "";
  let at = 0;
  for (;;) {
    const amp = raw.indexOf("&", at);
    if (amp < 0) return decoded + raw.slice(at);
    REFERENCE.lastIndex = amp;
    const match = REFERENCE.exec(raw);
    const replacement = match === null ? undefined : referencedText(match);
    if (replacement === undefined) return undefined;
    decoded += raw.slice(at, amp) + replacement;
    at = REFERENCE.lastIndex;
  }
}

/** A decoded, trimmed, non-empty attribute value. */
function attribute(attributes: ReadonlyMap<string, string>, name: string): string | undefined {
  const raw = attributes.get(name);
  const value = raw === undefined ? undefined : decodeValue(raw)?.trim();
  return value === "" ? undefined : value;
}

function parsePositive(raw: string | undefined): number | undefined {
  if (raw === undefined || NUMBER.test(raw) === false) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function parseDimension(raw: string | undefined): JdfDimension | undefined {
  const parts = raw === undefined ? [] : raw.split(/\s+/);
  if (parts.length === 2) {
    const [width, height] = parts.map(parsePositive);
    if (width === undefined || height === undefined) return undefined;
    return Object.freeze({ width, height });
  }
  return undefined;
}

// ---- JDF structure (CIP4 JDF Specification 1.x) ------------------------------------------

interface Frame {
  readonly local: string;
  /** In the JDF namespace, inside JDF-namespace ancestors only. */
  readonly jdf: boolean;
  /** Namespace prefixes this element declares; their bindings end with it. */
  readonly declared: readonly string[];
}

/** Mutable state of one scan; nothing outside `readJdfTicket` sees it. */
interface Scan {
  readonly stack: Frame[];
  /** The in-scope namespace URIs of each prefix (`""` is the default namespace), innermost last. */
  readonly bindings: Map<string, string[]>;
  readonly urls: string[];
  elements: number;
  urlCount: number;
  root: ReadonlyMap<string, string> | undefined;
  quantity: number | undefined;
  media: JdfMedia | undefined;
}

function splitName(qname: string): { readonly prefix: string; readonly local: string } {
  const colon = qname.indexOf(":");
  return colon < 0 ? { prefix: "", local: qname } : { prefix: qname.slice(0, colon), local: qname.slice(colon + 1) };
}

function declarationPrefix(attributeName: string): string | undefined {
  if (attributeName === "xmlns") return "";
  return attributeName.startsWith("xmlns:") ? attributeName.slice("xmlns:".length) : undefined;
}

function namespaceOf(scan: Scan, prefix: string, attributes: ReadonlyMap<string, string>): string | undefined {
  const own = attributes.get(prefix === "" ? "xmlns" : `xmlns:${prefix}`);
  if (own === undefined) return scan.bindings.get(prefix)?.at(-1);
  return own;
}

/** Unprefixed names in no namespace are taken as JDF, since many tickets omit the declaration. */
function isJdfNamespace(prefix: string, uri: string | undefined): boolean {
  if (prefix === "") return uri === undefined || uri === "" || uri === JDF_NAMESPACE;
  return uri === JDF_NAMESPACE;
}

function readFileSpec(scan: Scan, attributes: ReadonlyMap<string, string>): void {
  const url = attribute(attributes, "URL");
  if (url === undefined) return;
  scan.urlCount += 1;
  if (scan.urls.length < JDF_MAX_FILE_URLS) scan.urls.push(url);
}

function readMedia(scan: Scan, attributes: ReadonlyMap<string, string>): void {
  const name = attribute(attributes, "DescriptiveName");
  const dimension = parseDimension(attribute(attributes, "Dimension"));
  if (name === undefined && dimension === undefined) return;
  scan.media = Object.freeze({ ...(name === undefined ? {} : { name }), ...(dimension === undefined ? {} : { dimension }) });
}

/** Reads the facts of a JDF-namespace element below the root from its parent and grandparent. */
function readElement(scan: Scan, local: string, attributes: ReadonlyMap<string, string>): void {
  const parent = scan.stack.at(-1)?.local;
  if (parent === "ResourcePool") {
    if (local === "Component" && scan.quantity === undefined) scan.quantity = parsePositive(attribute(attributes, "Amount"));
    else if (local === "Media" && scan.media === undefined) readMedia(scan, attributes);
  } else if (local === "FileSpec" && parent === "LayoutElement" && scan.stack.at(-2)?.local === "RunList") {
    readFileSpec(scan, attributes);
  }
  // NodeInfo carries scheduling and status details that this reader does not report.
}

function enter(scan: Scan, qname: string, tag: Extract<Tag, { kind: "tag" }>): void {
  const { prefix, local } = splitName(qname);
  const parentJdf = scan.stack.at(-1)?.jdf ?? true;
  const jdf = parentJdf && isJdfNamespace(prefix, namespaceOf(scan, prefix, tag.attributes));
  if (jdf) readElement(scan, local, tag.attributes);
  if (tag.selfClosing) return;
  const declared: string[] = [];
  for (const [name, uri] of tag.attributes) {
    const declaredPrefix = declarationPrefix(name);
    if (declaredPrefix === undefined) continue;
    declared.push(declaredPrefix);
    const uris = scan.bindings.get(declaredPrefix);
    if (uris === undefined) scan.bindings.set(declaredPrefix, [uri]);
    else uris.push(uri);
  }
  scan.stack.push({ local, jdf, declared });
}

function leave(scan: Scan): void {
  const frame = scan.stack.pop();
  for (const prefix of frame?.declared ?? []) scan.bindings.get(prefix)?.pop();
}

/** Where the scan goes next: an index, or why it stops. */
type Next = number | "end" | "capped" | JdfTicketError;

function startTag(text: string, lt: number, scan: Scan): Next {
  if (scan.elements >= JDF_MAX_ELEMENTS) return "capped";
  const name = elementName(text, lt);
  if (name === "") return failure("INVALID_TICKET", `JDF: missing element name at character ${lt}`);
  const tag = readTag(text, lt + 1 + name.length);
  if (tag.kind === "unclosed") return "end";
  if (tag.kind === "too-many") return "capped";
  if (tag.kind === "malformed") return failure("INVALID_TICKET", `JDF: malformed attribute at character ${tag.at}`);
  scan.elements += 1;
  enter(scan, name, tag);
  return tag.end;
}

function endTag(text: string, lt: number, scan: Scan): Next {
  const end = after(text, ">", lt + 2);
  if (end < 0) return "end";
  leave(scan);
  return end;
}

function step(text: string, lt: number, scan: Scan): Next {
  const skipped = skipMarkup(text, lt);
  if (skipped === undefined) return text.startsWith("</", lt) ? endTag(text, lt, scan) : startTag(text, lt, scan);
  return skipped < 0 ? "end" : skipped;
}

/** Scans the elements inside the root until it closes, the prefix ends or a cap is reached. */
function scanElements(text: string, from: number, scan: Scan): "closed" | "end" | "capped" | JdfTicketError {
  let at = from;
  while (scan.stack.length > 0) {
    const lt = text.indexOf("<", at);
    if (lt < 0) return "end";
    const next = step(text, lt, scan);
    if (typeof next === "number") at = next;
    else return next;
  }
  return "closed";
}

function ticket(text: string, scan: Scan, truncated: boolean): JdfTicket {
  const root = scan.root ?? new Map<string, string>();
  const id = attribute(root, "ID");
  const jobId = attribute(root, "JobID");
  const jobPartId = attribute(root, "JobPartID");
  const type = attribute(root, "Type");
  const types = attribute(root, "Types")?.split(/\s+/);
  const status = attribute(root, "Status");
  const version = attribute(root, "Version");
  return Object.freeze({
    kind: "jdf",
    ...(id === undefined ? {} : { id }),
    ...(jobId === undefined ? {} : { jobId }),
    ...(jobPartId === undefined ? {} : { jobPartId }),
    ...(type === undefined ? {} : { type }),
    ...(types === undefined ? {} : { types: Object.freeze(types) }),
    ...(status === undefined ? {} : { status }),
    ...(version === undefined ? {} : { version }),
    ...(scan.quantity === undefined ? {} : { quantity: scan.quantity }),
    ...(scan.media === undefined ? {} : { media: scan.media }),
    fileRefs: Object.freeze({ count: scan.urlCount, urls: Object.freeze([...scan.urls]) }),
    hasDoctype: text.includes(DOCTYPE_OPEN),
    hasEntityDecl: text.includes(ENTITY_OPEN),
    truncated,
  });
}

function quoted(name: string): string {
  return name.length > MAX_NAME_IN_MESSAGE ? `${name.slice(0, MAX_NAME_IN_MESSAGE)}...` : name;
}

/** Reads the header facts of a JDF job ticket from its first `JDF_TICKET_MAX_BYTES` bytes. */
export function readJdfTicket(bytes: Uint8Array): JdfTicketResult {
  const cut = bytes.byteLength > JDF_TICKET_MAX_BYTES;
  const text = new TextDecoder("utf-8").decode(bytes.subarray(0, JDF_TICKET_MAX_BYTES));
  const found = findRootElement(text);
  if (found.found === false) {
    if (found.ended && cut) return failure("TRUNCATED", `No root element within the first ${JDF_TICKET_MAX_BYTES} bytes`);
    return failure("UNKNOWN_FORMAT", "Input is not a JDF job ticket");
  }
  const name = elementName(text, found.at);
  const { prefix, local } = splitName(name);
  if ((local === "JDF") === false) return failure("UNKNOWN_FORMAT", `Root element <${quoted(name)}> is not <JDF>`);
  const tag = readTag(text, found.at + 1 + name.length);
  if (tag.kind === "unclosed") return failure("TRUNCATED", "JDF: the root <JDF> start tag is not closed within the prefix");
  if (tag.kind === "malformed") return failure("INVALID_TICKET", `JDF: malformed attribute at character ${tag.at}`);
  const scan: Scan = {
    stack: [],
    bindings: new Map(),
    urls: [],
    elements: 1,
    urlCount: 0,
    root: undefined,
    quantity: undefined,
    media: undefined,
  };
  if (isJdfNamespace(prefix, namespaceOf(scan, prefix, tag.attributes)) === false) {
    return failure("UNKNOWN_FORMAT", `Root element <${quoted(name)}> is not in the JDF namespace`);
  }
  if (tag.kind === "too-many") return ticket(text, scan, true);
  scan.root = tag.attributes;
  enter(scan, name, { ...tag, selfClosing: false });
  if (tag.selfClosing) leave(scan);
  const outcome = scanElements(text, tag.end, scan);
  if (typeof outcome === "object") return outcome;
  return ticket(text, scan, outcome === "capped" || (outcome === "end" && cut));
}
