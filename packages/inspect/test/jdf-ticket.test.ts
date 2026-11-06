import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  JDF_MAX_ATTRIBUTES,
  JDF_MAX_ELEMENTS,
  JDF_MAX_FILE_URLS,
  JDF_TICKET_MAX_BYTES,
  readJdfTicket,
  type JdfTicketResult,
} from "../src/index.js";

/** Spec 037a: header-level facts of a JDF job ticket, from tiny CIP4-style fixtures built here. */

// Markup openers are built from the code point so that no literal bang character appears here.
const BANG = String.fromCharCode(0x21);
const DOCTYPE = `<${BANG}DOCTYPE`;
const ENTITY = `<${BANG}ENTITY`;
const COMMENT = `<${BANG}--`;
const JDF_NS = 'xmlns="http://www.CIP4.org/JDFSchema_1_1"';
const EXT_NS = 'xmlns:ex="http://example.com/jdf-extension"';

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function read(text: string): JdfTicketResult {
  return readJdfTicket(utf8(text));
}

function pseudoRandomBytes(seed: number, length: number): number[] {
  let state = seed;
  return Array.from({ length }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state >>> 24;
  });
}

/** Spies on every way the reader could reach the network or the file system. */
function spyOnIo(): ReadonlyArray<{ readonly mock: { readonly calls: readonly unknown[] } }> {
  return [
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network disabled in tests")),
    vi.spyOn(fs, "readFileSync"),
    vi.spyOn(fs, "openSync"),
    vi.spyOn(fs.promises, "readFile"),
  ];
}

function expectNoIo(spies: ReadonlyArray<{ readonly mock: { readonly calls: readonly unknown[] } }>): void {
  for (const spy of spies) expect(spy.mock.calls).toHaveLength(0);
}

const TICKET = [
  `<?xml version="1.0" encoding="UTF-8"?>`,
  `<JDF ${JDF_NS} ID="n0001" JobID="J-1001" JobPartID="P1" Type="Combined" Types="Imposition RIPing" Status="Waiting" Version="1.4">`,
  `  <NodeInfo JobPriority="50" Status="Ready"/>`,
  `  <ResourcePool>`,
  `    <Component ID="r1" Class="Quantity" ComponentType="FinalProduct" Amount="500" Status="Unavailable"/>`,
  `    <Media ID="r2" Class="Consumable" Status="Available" DescriptiveName="Gloss 170 gsm" Dimension="595.276 841.89"/>`,
  `    <RunList ID="r3" Class="Parameter" Status="Available">`,
  `      <LayoutElement><FileSpec URL="file:///jobs/J-1001/cover.pdf"/></LayoutElement>`,
  `    </RunList>`,
  `  </ResourcePool>`,
  `  <ResourceLinkPool><ComponentLink rRef="r1" Usage="Output" Amount="999"/></ResourceLinkPool>`,
  `</JDF>`,
].join("\n");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readJdfTicket: fields", () => {
  it("reads the root node, the first Component, Media and the FileSpec URLs", () => {
    const result = read(TICKET);
    expect(result).toEqual({
      kind: "jdf",
      id: "n0001",
      jobId: "J-1001",
      jobPartId: "P1",
      type: "Combined",
      types: ["Imposition", "RIPing"],
      status: "Waiting",
      version: "1.4",
      quantity: 500,
      media: { name: "Gloss 170 gsm", dimension: { width: 595.276, height: 841.89 } },
      fileRefs: { count: 1, urls: ["file:///jobs/J-1001/cover.pdf"] },
      hasDoctype: false,
      hasEntityDecl: false,
      truncated: false,
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("reads a ticket without a namespace declaration and with a jdf: prefix", () => {
    expect(read(`<JDF JobID="plain"><ResourcePool><Component Amount="2.5"/></ResourcePool></JDF>`)).toMatchObject({
      kind: "jdf",
      jobId: "plain",
      quantity: 2.5,
    });
    const prefixed = `<jdf:JDF xmlns:jdf="http://www.CIP4.org/JDFSchema_1_1" JobID="pre"><jdf:ResourcePool><jdf:Media DescriptiveName="M"/></jdf:ResourcePool></jdf:JDF>`;
    expect(read(prefixed)).toMatchObject({ kind: "jdf", jobId: "pre", media: { name: "M" } });
  });

  it("decodes predefined entities and character references in values", () => {
    const result = read(`<JDF ${JDF_NS} JobID="A&amp;B &#x41;&#66;" JobPartID="  &lt;p&gt;  "/>`);
    expect(result).toMatchObject({ jobId: "A&B AB", jobPartId: "<p>" });
  });

  it("skips values that are empty, not numbers, or not a two-number XYPair", () => {
    const text = `<JDF ${JDF_NS} JobID=""><ResourcePool><Component Amount="many"/><Component Amount="-3"/><Media Dimension="A4"/><Media DescriptiveName="Second" Dimension="10 20 30"/></ResourcePool></JDF>`;
    const result = read(text);
    expect(result).toMatchObject({ kind: "jdf", media: { name: "Second" } });
    expect(result).not.toHaveProperty("jobId");
    expect(result).not.toHaveProperty("quantity");
    expect(result).not.toHaveProperty("media.dimension");
  });

  it("takes Component and Media only as ResourcePool children", () => {
    const text = `<JDF ${JDF_NS}><ResourceLinkPool><Component Amount="7"/><Media DescriptiveName="Link"/></ResourceLinkPool><ResourcePool><Component Amount="8"/></ResourcePool></JDF>`;
    const result = read(text);
    expect(result).toMatchObject({ quantity: 8 });
    expect(result).not.toHaveProperty("media");
  });

  it("skips comments, CDATA and processing instructions inside the ticket", () => {
    const text = `<JDF ${JDF_NS}>${COMMENT} <ResourcePool><Component Amount="1"/></ResourcePool> --><${BANG}[CDATA[<Component Amount="2"/>]]><?pi <x>?><ResourcePool><Component Amount="3"/></ResourcePool></JDF>`;
    expect(read(text)).toMatchObject({ quantity: 3 });
  });
});

describe("readJdfTicket: DTDs and entities", () => {
  it("flags an entity declaration but never expands it into JobID", () => {
    const text = [
      `<?xml version="1.0"?>`,
      `${DOCTYPE} JDF [`,
      `  ${ENTITY} job "EVIL-42">`,
      `  ${ENTITY} tricky "a > b ] c">`,
      `]>`,
      `<JDF ${JDF_NS} JobID="&job;" JobPartID="kept" Version="1.4"/>`,
    ].join("\n");
    const result = read(text);
    expect(result).toEqual({
      kind: "jdf",
      jobPartId: "kept",
      version: "1.4",
      fileRefs: { count: 0, urls: [] },
      hasDoctype: true,
      hasEntityDecl: true,
      truncated: false,
    });
    expect(JSON.stringify(result)).not.toContain("EVIL");
  });

  it("flags a DOCTYPE with an external DTD without fetching or opening it", () => {
    const spies = spyOnIo();
    const result = read(`${DOCTYPE} JDF SYSTEM "http://example.com/jdf.dtd">\n<JDF ${JDF_NS} JobID="J"/>`);
    expect(result).toMatchObject({ kind: "jdf", jobId: "J", hasDoctype: true, hasEntityDecl: false });
    expectNoIo(spies);
  });
});

describe("readJdfTicket: FileSpec URLs", () => {
  it("counts http, file and relative URLs without fetching or opening them", () => {
    const spies = spyOnIo();
    const text = [
      `<JDF ${JDF_NS}><ResourcePool>`,
      `<FileSpec URL="http://example.com/not-in-a-runlist.icc"/>`,
      `<RunList>`,
      `<LayoutElement><FileSpec URL="http://example.com/a.pdf?x=1&amp;y=2"/></LayoutElement>`,
      `<LayoutElement><FileSpec URL="file:///etc/passwd"/></LayoutElement>`,
      `<RunList><LayoutElement><FileSpec URL='../shared/b.pdf'/></LayoutElement></RunList>`,
      `<LayoutElement><FileSpec MimeType="application/pdf"/></LayoutElement>`,
      `</RunList></ResourcePool></JDF>`,
    ].join("\n");
    expect(read(text)).toMatchObject({
      fileRefs: { count: 3, urls: ["http://example.com/a.pdf?x=1&y=2", "file:///etc/passwd", "../shared/b.pdf"] },
    });
    expectNoIo(spies);
  });

  it(`records the first ${JDF_MAX_FILE_URLS} URLs and counts all of them`, () => {
    const total = JDF_MAX_FILE_URLS + 8;
    const elements = Array.from({ length: total }, (_, index) => `<LayoutElement><FileSpec URL="p${index}.pdf"/></LayoutElement>`);
    const result = read(`<JDF ${JDF_NS}><ResourcePool><RunList>${elements.join("")}</RunList></ResourcePool></JDF>`);
    expect(result).toMatchObject({ kind: "jdf", fileRefs: { count: total } });
    const urls = result.kind === "jdf" ? result.fileRefs.urls : [];
    expect(urls).toHaveLength(JDF_MAX_FILE_URLS);
    expect(urls.at(-1)).toBe(`p${JDF_MAX_FILE_URLS - 1}.pdf`);
  });
});

describe("readJdfTicket: other namespaces", () => {
  it("ignores extension elements and attributes and everything inside them", () => {
    const text = [
      `<JDF ${JDF_NS} ${EXT_NS} ex:JobID="EXT" JobID="J-2">`,
      `<ex:Wrapper><ResourcePool><Media DescriptiveName="Hidden"/><Component Amount="1"/></ResourcePool></ex:Wrapper>`,
      `<ResourcePool>`,
      `<ex:Media DescriptiveName="Extension"/>`,
      `<Media xmlns="http://example.com/other" DescriptiveName="Redeclared"/>`,
      `<ex:Component Amount="2"/>`,
      `<Component Amount="10"/>`,
      `<Media DescriptiveName="Plain" Dimension="100 200"/>`,
      `<RunList>`,
      `<ex:LayoutElement><FileSpec URL="inside-extension.pdf"/></ex:LayoutElement>`,
      `<LayoutElement><ex:FileSpec URL="extension.pdf"/></LayoutElement>`,
      `<LayoutElement><FileSpec URL="ok.pdf" ex:URL="ext.pdf"/></LayoutElement>`,
      `</RunList></ResourcePool></JDF>`,
    ].join("\n");
    const result = read(text);
    expect(result).toMatchObject({
      kind: "jdf",
      jobId: "J-2",
      quantity: 10,
      media: { name: "Plain", dimension: { width: 100, height: 200 } },
      fileRefs: { count: 1, urls: ["ok.pdf"] },
    });
    for (const word of ["EXT", "Hidden", "Extension", "Redeclared", "extension"]) {
      expect(JSON.stringify(result)).not.toContain(word);
    }
  });

  it("ends a namespace declaration with the element that made it", () => {
    const text = `<JDF ${JDF_NS}><ResourcePool><Wrapper xmlns="http://example.com/other"><Media DescriptiveName="Inner"/></Wrapper><Media DescriptiveName="Outer"/></ResourcePool></JDF>`;
    expect(read(text)).toMatchObject({ media: { name: "Outer" } });
  });
});

describe("readJdfTicket: prefix bound and caps", () => {
  const late = `<ResourcePool><Media DescriptiveName="Late"/><RunList><LayoutElement><FileSpec URL="late.pdf"/></LayoutElement></RunList></ResourcePool>${DOCTYPE} x>${ENTITY} e "v">`;

  it("ignores data past the bound and reports the open root as truncated", () => {
    const head = `<JDF ${JDF_NS} JobID="J">`;
    const result = read(`${head}${" ".repeat(JDF_TICKET_MAX_BYTES)}${late}</JDF>`);
    expect(result).toEqual({
      kind: "jdf",
      jobId: "J",
      fileRefs: { count: 0, urls: [] },
      hasDoctype: false,
      hasEntityDecl: false,
      truncated: true,
    });
    expect(read(`${head}${" ".repeat(1024)}${late}</JDF>`)).toMatchObject({
      media: { name: "Late" },
      fileRefs: { count: 1 },
      hasDoctype: true,
      hasEntityDecl: true,
      truncated: false,
    });
  });

  it("is not truncated when the root closes inside the bound", () => {
    const result = read(`${TICKET}${" ".repeat(JDF_TICKET_MAX_BYTES)}<Trailing/>`);
    expect(result).toMatchObject({ kind: "jdf", jobId: "J-1001", truncated: false });
  });

  it("reports a root element past the bound as truncated", () => {
    const comment = `${COMMENT} ${"x".repeat(JDF_TICKET_MAX_BYTES)} -->`;
    expect(read(`${comment}<JDF ${JDF_NS}/>`)).toMatchObject({ kind: "error", code: "TRUNCATED" });
    expect(read(`<JDF${" ".repeat(JDF_TICKET_MAX_BYTES)} JobID="J">`)).toMatchObject({ kind: "error", code: "TRUNCATED" });
  });

  it(`stops after ${JDF_MAX_ELEMENTS} elements`, () => {
    const media = `<Media DescriptiveName="Last"/></ResourcePool></JDF>`;
    // The root and the ResourcePool are elements too.
    const fits = `<JDF ${JDF_NS}><ResourcePool>${"<NodeInfo/>".repeat(JDF_MAX_ELEMENTS - 3)}${media}`;
    expect(read(fits)).toMatchObject({ media: { name: "Last" }, truncated: false });
    const over = `<JDF ${JDF_NS}><ResourcePool>${"<NodeInfo/>".repeat(JDF_MAX_ELEMENTS - 2)}${media}`;
    const result = read(over);
    expect(result).toMatchObject({ kind: "jdf", truncated: true });
    expect(result).not.toHaveProperty("media");
  });

  it(`stops at an element with more than ${JDF_MAX_ATTRIBUTES} attributes`, () => {
    const extra = (count: number): string => Array.from({ length: count }, (_, index) => ` a${index}="${index}"`).join("");
    const component = (count: number): string =>
      `<JDF ${JDF_NS}><ResourcePool><Component${extra(count)} Amount="5"/><Media DescriptiveName="After"/></ResourcePool></JDF>`;
    expect(read(component(JDF_MAX_ATTRIBUTES - 1))).toMatchObject({ quantity: 5, media: { name: "After" }, truncated: false });
    const result = read(component(JDF_MAX_ATTRIBUTES));
    expect(result).toMatchObject({ kind: "jdf", truncated: true });
    expect(result).not.toHaveProperty("quantity");
    expect(result).not.toHaveProperty("media");
    const root = read(`<JDF JobID="J"${extra(JDF_MAX_ATTRIBUTES)}/>`);
    expect(root).toMatchObject({ kind: "jdf", truncated: true });
    expect(root).not.toHaveProperty("jobId");
  });

  it("finishes pathological input quickly", () => {
    const size = 200 * 1024;
    const inputs = [
      "<a ".repeat(size / 3),
      `<JDF>${"<a ".repeat(size / 3)}`,
      `<JDF><x ${'a="1" '.repeat(size / 6)}>`,
      `<JDF><x a${" ".repeat(size)}b>`,
      `<JDF><x a="${"x".repeat(size)}`,
      `<JDF>${"<a>".repeat(size / 3)}`,
      `<JDF>${'<p:a xmlns:p="u">'.repeat(size / 17)}`,
      `<JDF>${"</a".repeat(size / 3)}`,
      `<JDF>${COMMENT.repeat(size / 4)}`,
      `<JDF JobID="${"&amp;".repeat(size / 5)}"/>`,
      `<JDF JobID="${"&".repeat(size)}"/>`,
    ];
    for (const input of inputs) {
      const bytes = utf8(input);
      const started = performance.now();
      const result = readJdfTicket(bytes);
      expect(performance.now() - started).toBeLessThan(200);
      expect(["jdf", "error"]).toContain(result.kind);
    }
  });
});

describe("readJdfTicket: malformed, unknown and non-JDF input", () => {
  it("rejects malformed and unclosed root start tags", () => {
    expect(read(`<JDF JobID=J1>`)).toMatchObject({ kind: "error", code: "INVALID_TICKET" });
    expect(read(`<JDF JobID="1"Type="x">`)).toMatchObject({ kind: "error", code: "INVALID_TICKET" });
    expect(read(`<JDF JobID="1"`)).toMatchObject({ kind: "error", code: "TRUNCATED" });
  });

  it("rejects a malformed element inside the ticket", () => {
    expect(read(`<JDF><ResourcePool Class=x></ResourcePool></JDF>`)).toMatchObject({ kind: "error", code: "INVALID_TICKET" });
  });

  it("does not take other XML roots for JDF", () => {
    expect(read(`<JMF ${JDF_NS} Version="1.4"/>`)).toMatchObject({ kind: "error", code: "UNKNOWN_FORMAT" });
    expect(read(`<svg xmlns="http://www.w3.org/2000/svg"/>`)).toMatchObject({ kind: "error", code: "UNKNOWN_FORMAT" });
    expect(read(`<JDFX JobID="J"/>`)).toMatchObject({ kind: "error", code: "UNKNOWN_FORMAT" });
    expect(read(`<JDF xmlns="http://example.com/other" JobID="J"/>`)).toMatchObject({ kind: "error", code: "UNKNOWN_FORMAT" });
    expect(read(`<ex:JDF ${EXT_NS} JobID="J"/>`)).toMatchObject({ kind: "error", code: "UNKNOWN_FORMAT" });
    expect(read(`<${BANG}[CDATA[x]]><JDF/>`)).toMatchObject({ kind: "error", code: "UNKNOWN_FORMAT" });
  });

  it("reports empty, text and binary input as unknown, never throwing", () => {
    expect(readJdfTicket(new Uint8Array(0))).toMatchObject({ kind: "error", code: "UNKNOWN_FORMAT" });
    expect(read("%PDF-1.7\n")).toMatchObject({ kind: "error", code: "UNKNOWN_FORMAT" });
    expect(read("JobID=J-1001")).toMatchObject({ kind: "error", code: "UNKNOWN_FORMAT" });
    for (const seed of [1, 2, 3, 42, 1234]) {
      const bytes = Uint8Array.from([0xff, ...pseudoRandomBytes(seed, 4096)]);
      expect(readJdfTicket(bytes)).toMatchObject({ kind: "error", code: "UNKNOWN_FORMAT" });
    }
    expect(readJdfTicket(new Uint8Array(JDF_TICKET_MAX_BYTES * 2).fill(0x41))).toMatchObject({ kind: "error" });
  });

  it("reads every prefix of a ticket to a result", () => {
    const bytes = utf8(TICKET);
    for (let length = 0; length <= bytes.length; length += 1) {
      expect(["jdf", "error"]).toContain(readJdfTicket(bytes.slice(0, length)).kind);
    }
  });
});
