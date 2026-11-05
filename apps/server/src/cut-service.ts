import type { Job } from "@bax-print/core";
import { buildCutJob, type CutJobInput, type CutJobResult } from "@bax-print/cut-export";
import { resolveCutContour, type PageBoxes } from "@bax-print/edits";

/**
 * What a cut job is planned from besides the job itself (Spec 007g). Everything `buildCutJob`
 * takes except the job id and the resolved contour, which come from the job.
 */
export interface CutPlanDeps extends Omit<CutJobInput, "jobId" | "cutContour"> {
  /** The boxes of the page that is cut, in PDF user space with its `/Rotate` and `/UserUnit`. */
  pageBoxes: PageBoxes;
}

/**
 * Plans the cut job of a job's page. The job's edits pick the cut contour (`resolveCutContour`);
 * without a `cutContour` edit the configured `deps.cut` selection applies. Returns
 * `{ kind: "none" }` when the edits say the job is not cut, and never calls `deps.extract` then.
 * Throws `EditError` when a trim-box contour can't be resolved and `CutterDriverError` when the
 * resolved rectangle has no area.
 */
export async function planCutJob(job: Pick<Job, "id" | "ticket">, deps: CutPlanDeps): Promise<CutJobResult> {
  const { pageBoxes, ...input } = deps;
  const cutContour = resolveCutContour(job.ticket.edits ?? [], pageBoxes);
  return buildCutJob({ ...input, jobId: job.id, ...(cutContour ? { cutContour } : {}) });
}
