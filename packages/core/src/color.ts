/** Reference to a stored profile (ARCHITECTURE §4 `Profile`), including provenance. */
export interface ProfileRef {
  readonly id: string;
  readonly fileName: string;
  readonly sha256: string;
  readonly redistributable: boolean;
  readonly license?: string;
  readonly source?: string;
}

/** Immutable snapshot of a color setup for one (device, medium) pair (Spec 005). */
export interface ColorSetupRevision {
  readonly id: string;
  readonly colorSetupId: string;
  readonly deviceId: string;
  readonly mediumId: string;
  readonly modeKey?: string;
  readonly createdAt: string;
  readonly profiles: readonly ProfileRef[];
}
