# Implementation notes — Spec 007b (FR4 job edits)

## Built
- `packages/core/src/edits.ts`: `JobEdit` typed union (scale, rotate, mirror, crop, addBleed,
  pageSize, copies, spotMap, metadata) as TypeBox schemas, plus `parseEdits()` shape/semantic
  validation. Exported from `packages/core/src/index.ts`. Limits are prefixed (`MAX_EDIT_*`) and
  the result type is `EditParseResult` so `export *` cannot collide with other core modules.
- `packages/edits` (`@bax-print/edits`):
  - `transform.ts`: PDF-convention affine matrices.
  - `geometry.ts`: `computeGeometry(page, edits)` folds the edit stack in order (trim and
    footprint frames, bleed, pageSize, copies, spot maps, metadata); `geometryErrors`, `mapColorant`.
  - `apply-edits.ts`: `applyEdits(item, edits)` for nest items.
  - `ppi.ts`: `effectivePpi(image, toOutput)` / `editedPpi(image, geometry)`, the effective-ppi
    recompute after edits (per-axis and min).
  - `impose.ts` (`@bax-print/edits/impose`): pdf-lib single-page output with edge/mirror bleed.

## Acceptance (Spec 007 test 3)
- rotate 90 ×4 = identity, scale then inverse = identity within 1e-9, mirror ×2 = identity:
  property tests in `packages/edits/test/geometry.test.ts`.
- ppi correct after scale: `packages/edits/test/ppi.test.ts`.

## Deferred
- `JobTicket.edits` field on the ticket schema (`ticket.ts` was outside this sub-spec's file set);
  wire it with `JobEditListSchema` and `parseEdits`.
- Consumers: preflight resolution check and the layout stage calling `editedPpi` / `imposeEdited`.
- `impose.ts` has no test yet (it needs a recorded PDF fixture).
- Not run here: no shell was available, so typecheck and tests are unverified.

## Test commands
```
pnpm install
pnpm --filter @bax-print/core test
pnpm --filter @bax-print/edits exec vitest run
pnpm -r typecheck
```
