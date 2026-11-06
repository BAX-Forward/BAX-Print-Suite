import { PDFDocument } from "pdf-lib";
import { clipBoxProblem } from "./clip-box.js";
import { impose, type ImposeOptions, type ImposeSource, type ImposeWarning, type SourceBox } from "./impose.js";
import { nest } from "./nesters.js";
import type { Layout, NestItem, NestOptions, RollMedia } from "./types.js";

export type NestItemIssueCode =
  | "unreadable-source"
  | "duplicate-item-id"
  | "page-out-of-range"
  | "invalid-clip-box"
  | "clip-outside-source"
  | "impose-failed";

export interface NestItemIssue {
  readonly code: NestItemIssueCode;
  readonly message: string;
  readonly itemId?: string;
}

export interface NestItemsSource {
  /** The PDF every item draws from; `item.pageIndex` (default 0) picks the page. */
  readonly sourcePdf: Uint8Array;
  /** Page box that matches the item size; clip boxes must lie inside it. */
  readonly sourceBox: SourceBox;
  readonly marks?: ImposeOptions["marks"];
}

export type NestItemsResult =
  | {
      readonly ok: true;
      readonly layout: Layout;
      readonly imposedPdf: Uint8Array;
      /** Warnings from the impose step. */
      readonly warnings: readonly ImposeWarning[];
    }
  | { readonly ok: false; readonly issues: readonly NestItemIssue[] };

interface PageBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadSource(bytes: Uint8Array): Promise<PDFDocument | NestItemIssue> {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (error) {
    return { code: "unreadable-source", message: `cannot read source PDF (${errorMessage(error)})` };
  }
}

function itemIssues(doc: PDFDocument, items: readonly NestItem[], kind: SourceBox): NestItemIssue[] {
  const issues: NestItemIssue[] = [];
  const seen = new Set<string>();
  const count = doc.getPageCount();
  const boxes = new Map<number, PageBox>();
  const boxOf = (index: number): PageBox => {
    const cached = boxes.get(index);
    if (cached) return cached;
    const page = doc.getPage(index);
    const box = kind === "bleed" ? page.getBleedBox() : page.getTrimBox();
    boxes.set(index, box);
    return box;
  };
  for (const item of items) {
    const itemId = String(item.id);
    if (seen.has(itemId)) {
      issues.push({ code: "duplicate-item-id", itemId, message: `item ${itemId}: id is used by more than one item` });
    }
    seen.add(itemId);
    const index = item.pageIndex ?? 0;
    if (!Number.isInteger(index) || index < 0 || index >= count) {
      issues.push({
        code: "page-out-of-range",
        itemId,
        message: `item ${itemId}: source PDF has no page index ${index} (${count} pages)`,
      });
      continue;
    }
    if (!item.clipBox) continue;
    const problem = clipBoxProblem(item.clipBox, boxOf(index));
    if (problem) issues.push({ code: problem.code, itemId, message: `item ${itemId}: ${problem.message}` });
  }
  return issues;
}

function sourceFor(item: NestItem, source: NestItemsSource): ImposeSource {
  return {
    pdfBytes: source.sourcePdf,
    pageIndex: item.pageIndex ?? 0,
    box: source.sourceBox,
    ...(item.clipBox ? { clipBox: item.clipBox } : {}),
  };
}

/**
 * Nests prepared items (Spec 009 FR7 panels among them) with `nest()` and
 * imposes them with `impose()`. Items with a `clipBox` draw only that part of
 * their source page; items without one render exactly as `impose()` does.
 * Never throws: invalid items, an unreadable source or a failed render come
 * back as issues, and nothing is imposed.
 */
export async function imposeNestItems(
  media: RollMedia,
  items: readonly NestItem[],
  opts: NestOptions,
  source: NestItemsSource,
): Promise<NestItemsResult> {
  const doc = await loadSource(source.sourcePdf);
  if (!(doc instanceof PDFDocument)) return { ok: false, issues: [doc] };
  const issues = itemIssues(doc, items, source.sourceBox);
  if (issues.length > 0) return { ok: false, issues };
  try {
    const layout = nest(media, items, opts);
    const sources = new Map(items.map((item) => [String(item.id), sourceFor(item, source)]));
    const warnings: ImposeWarning[] = [];
    const imposedPdf = await impose(layout, sources, {
      ...(source.marks ? { marks: source.marks } : {}),
      onWarning: (warning) => {
        warnings.push(warning);
      },
    });
    return { ok: true, layout, imposedPdf, warnings };
  } catch (error) {
    return { ok: false, issues: [{ code: "impose-failed", message: `cannot impose items (${errorMessage(error)})` }] };
  }
}
