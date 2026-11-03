/**
 * Space the nester must keep free around each item for marks and labels that
 * sit outside the bleed (Spec 006 FR4: "the layout reserves the space via
 * Spec 003 margins"). Layout edges: `left`/`right` across the roll (x min/max),
 * `bottom` = lead edge (y min), `top` = trail edge (y max).
 */
import { MarkSpecError } from "./errors.js";
import { boundsOf } from "./geometry.js";
import { assignMarkIds, planItemLocal } from "./item-plan.js";
import type { Rotation } from "./layout-types.js";
import { elementShapes } from "./parts.js";
import { itemBox, loadSymbols, parseFinishing } from "./plan.js";
import type { ItemInfo, JobInfo } from "./plan-types.js";
import { EDGES, type Edge, type FinishingSpecInput } from "./schema.js";
import type { SymbolSource } from "./symbols.js";

export type EdgeSpace = Readonly<Record<Edge, number>>;

/** Spec 003 margin reservation API. */
export interface MarginReserver {
  reserve(edge: Edge, mm: number): void;
}

export interface ReservationInput {
  readonly items: readonly ItemInfo[];
  readonly finishing: FinishingSpecInput;
  readonly job: JobInfo;
  readonly symbols?: Readonly<Record<string, SymbolSource>>;
  /** Rotations the nester may use; default [0]. */
  readonly rotations?: readonly Rotation[];
}

const NORMALS: Readonly<Record<Edge, readonly [number, number]>> = {
  left: [-1, 0],
  right: [1, 0],
  bottom: [0, -1],
  top: [0, 1],
};

const ZERO: EdgeSpace = { top: 0, bottom: 0, left: 0, right: 0 };

/** The layout edge an item edge faces after a counter-clockwise rotation. */
export function rotateEdge(edge: Edge, rotation: Rotation): Edge {
  const [x, y] = NORMALS[edge];
  const turns = rotation / 90;
  let v: readonly [number, number] = [x, y];
  for (let i = 0; i < turns; i++) v = [-v[1], v[0]];
  return EDGES.find((e) => NORMALS[e][0] === v[0] && NORMALS[e][1] === v[1])!;
}

/** Per item edge, how far beyond the bleed box its marks and label reach (mm). */
export async function itemReservations(input: ReservationInput): Promise<Map<string, EdgeSpace>> {
  const finishing = parseFinishing(input.finishing);
  const markIds = assignMarkIds(finishing.marks);
  const { table } = await loadSymbols(finishing, input.symbols);
  const out = new Map<string, EdgeSpace>();
  for (const item of input.items) {
    const box = itemBox(item);
    const { elements } = planItemLocal(
      finishing,
      markIds,
      { item: box, copy: 0, copyTotal: item.copies ?? 1, panel: item.panel, job: input.job },
      table,
    );
    const shapes = elements.flatMap(elementShapes);
    if (shapes.length === 0) {
      out.set(item.itemId, ZERO);
      continue;
    }
    const b = boundsOf(shapes.flatMap((r) => [
      { x: r.x, y: r.y },
      { x: r.x + r.w, y: r.y + r.h },
    ]));
    out.set(item.itemId, {
      left: Math.max(0, -box.bleedMm - b.x),
      bottom: Math.max(0, -box.bleedMm - b.y),
      right: Math.max(0, b.x + b.w - (box.widthMm + box.bleedMm)),
      top: Math.max(0, b.y + b.h - (box.heightMm + box.bleedMm)),
    });
  }
  return out;
}

/** The largest space any item needs on each layout edge, over the allowed rotations. */
export async function layoutReservation(input: ReservationInput): Promise<EdgeSpace> {
  const rotations = input.rotations && input.rotations.length > 0 ? input.rotations : [0 as Rotation];
  const out: Record<Edge, number> = { ...ZERO };
  for (const space of (await itemReservations(input)).values()) {
    for (const rotation of rotations) {
      for (const edge of EDGES) {
        const target = rotateEdge(edge, rotation);
        out[target] = Math.max(out[target], space[edge]);
      }
    }
  }
  return out;
}

/** Computes the layout reservation and hands each non-zero edge to `reserver`. */
export async function reserveSpace(input: ReservationInput, reserver: MarginReserver): Promise<EdgeSpace> {
  if (!input.job.id) throw new MarkSpecError("job.id is required");
  const space = await layoutReservation(input);
  for (const edge of EDGES) if (space[edge] > 0) reserver.reserve(edge, space[edge]);
  return space;
}
