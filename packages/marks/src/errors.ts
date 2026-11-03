import type { Rect } from "./geometry.js";

export interface Collision {
  /** `<itemId>#<copy>/<markId>` of the finishing element. */
  readonly elementId: string;
  /** `mark:<id>` or `row:<n>` of the Spec 004 clearance zone. */
  readonly zoneId: string;
  /** Overlapping area in the layout frame (mm). */
  readonly overlap: Rect;
}

/** A finishing mark or label overlaps a Spec 004 registration clearance zone. */
export class MarkCollisionError extends Error {
  override readonly name = "MarkCollisionError";
  readonly collisions: readonly Collision[];

  constructor(collisions: readonly Collision[]) {
    super(
      `finishing marks overlap the registration clearance zone: ${collisions
        .map((c) => `${c.elementId} vs ${c.zoneId}`)
        .join(", ")}`,
    );
    this.collisions = collisions;
  }
}

/** Invalid mark, label, preset or symbol input. */
export class MarkSpecError extends Error {
  override readonly name = "MarkSpecError";
  readonly issues: readonly string[];

  constructor(message: string, issues: readonly string[] = []) {
    super(issues.length > 0 ? `${message}: ${issues.join("; ")}` : message);
    this.issues = issues;
  }
}
