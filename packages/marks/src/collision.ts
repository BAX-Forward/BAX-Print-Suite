/**
 * Spec 004 Part D owns the registration marks; finishing marks and labels
 * must stay out of their clearance zones. Each mark gets a square zone of
 * radius + clearance; with the `edge-rows` pattern each row of marks also
 * becomes one continuous zone, because a sensor scans the whole row.
 */
import { MarkCollisionError, type Collision } from "./errors.js";
import { boundsOf, intersection, rectsOverlap, type Rect } from "./geometry.js";
import type { RegistrationInput } from "./layout-types.js";
import { elementShapes } from "./parts.js";
import type { PlannedElement } from "./plan-types.js";
import { ptToMm } from "./units.js";

export const DEFAULT_REGISTRATION_CLEARANCE_MM = 3;
/** Marks within this x distance (mm) form one row. */
const ROW_TOLERANCE_MM = 0.01;

export interface ClearanceZone {
  /** `mark:<id>` or `row:<n>`. */
  readonly id: string;
  /** Layout frame, mm. */
  readonly rect: Rect;
}

export function registrationZones(reg: RegistrationInput): ClearanceZone[] {
  const clearance = reg.clearanceMm ?? DEFAULT_REGISTRATION_CLEARANCE_MM;
  const squares = reg.marks.map((m) => {
    const r = ptToMm(m.dPt) / 2 + clearance;
    const x = ptToMm(m.xPt);
    const y = ptToMm(m.yPt);
    return { id: m.id, x, rect: { x: x - r, y: y - r, w: 2 * r, h: 2 * r } };
  });
  const zones: ClearanceZone[] = squares.map((s) => ({ id: `mark:${s.id}`, rect: s.rect }));
  if (reg.pattern !== "edge-rows") return zones;

  const rows: (typeof squares)[] = [];
  for (const s of [...squares].sort((a, b) => a.x - b.x)) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row[0]!.x - s.x) <= ROW_TOLERANCE_MM) row.push(s);
    else rows.push([s]);
  }
  rows
    .filter((row) => row.length >= 2)
    .forEach((row, i) => {
      const corners = row.flatMap((s) => [
        { x: s.rect.x, y: s.rect.y },
        { x: s.rect.x + s.rect.w, y: s.rect.y + s.rect.h },
      ]);
      zones.push({ id: `row:${i + 1}`, rect: boundsOf(corners) });
    });
  return zones;
}

export function findCollisions(elements: readonly PlannedElement[], zones: readonly ClearanceZone[]): Collision[] {
  const out: Collision[] = [];
  for (const el of elements) {
    const shapes = elementShapes(el);
    for (const zone of zones) {
      const hit = shapes.find((s) => rectsOverlap(s, zone.rect));
      if (hit) out.push({ elementId: el.id, zoneId: zone.id, overlap: intersection(hit, zone.rect) });
    }
  }
  return out;
}

/** Throws `MarkCollisionError` when any element enters a registration clearance zone. */
export function assertNoCollisions(elements: readonly PlannedElement[], reg: RegistrationInput | undefined): void {
  if (!reg || reg.marks.length === 0) return;
  const collisions = findCollisions(elements, registrationZones(reg));
  if (collisions.length > 0) throw new MarkCollisionError(collisions);
}
