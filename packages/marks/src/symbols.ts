import { PDFDocument } from "pdf-lib";
import { MarkSpecError } from "./errors.js";
import { parseSvgSymbol, type SvgSymbol } from "./svg-symbol.js";

/** A user-supplied custom mark symbol (Spec 006 FR1 `custom`). */
export type SymbolSource =
  | { readonly type: "pdf"; readonly bytes: Uint8Array }
  | { readonly type: "svg"; readonly svg: string };

/** `aspect` is height / width of the symbol. */
export type PreparedSymbol =
  | { readonly id: string; readonly type: "pdf"; readonly bytes: Uint8Array; readonly aspect: number }
  | { readonly id: string; readonly type: "svg"; readonly symbol: SvgSymbol; readonly aspect: number };

export type SymbolTable = ReadonlyMap<string, PreparedSymbol>;

async function preparePdf(id: string, bytes: Uint8Array): Promise<PreparedSymbol> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    throw new MarkSpecError(`custom symbol "${id}" is not a readable PDF`, [String(err)]);
  }
  if (doc.getPageCount() !== 1) {
    throw new MarkSpecError(`custom symbol "${id}" must be a single-page PDF, got ${doc.getPageCount()} pages`);
  }
  const { width, height } = doc.getPage(0).getSize();
  if (!(width > 0 && height > 0)) throw new MarkSpecError(`custom symbol "${id}" has an empty page`);
  return { id, type: "pdf", bytes, aspect: height / width };
}

export async function prepareSymbols(
  sources: Readonly<Record<string, SymbolSource>> | undefined,
  needed: readonly string[],
): Promise<{ table: SymbolTable; warnings: string[] }> {
  const table = new Map<string, PreparedSymbol>();
  const warnings: string[] = [];
  for (const id of new Set(needed)) {
    const src = sources?.[id];
    if (!src) throw new MarkSpecError(`custom mark refers to unknown symbol "${id}"`);
    if (src.type === "pdf") {
      table.set(id, await preparePdf(id, src.bytes));
    } else {
      const symbol = parseSvgSymbol(src.svg);
      warnings.push(...symbol.warnings.map((w) => `symbol "${id}": ${w}`));
      table.set(id, { id, type: "svg", symbol, aspect: symbol.viewBox.h / symbol.viewBox.w });
    }
  }
  return { table, warnings };
}
