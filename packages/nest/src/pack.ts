/**
 * Low-level packer contract. Packers work in the gutter-inflated frame and know
 * nothing about items, rotations or margins.
 */
export interface PackOption {
  readonly w: number;
  readonly h: number;
  /** Opaque orientation index, echoed back in the spot. */
  readonly o: number;
}

export interface PackInput {
  readonly binW: number;
  readonly binH: number;
  /** One entry per piece, in packing order. */
  readonly pieces: readonly (readonly PackOption[])[];
}

export interface PackSpot {
  readonly x: number;
  readonly y: number;
  readonly o: number;
}

/** Same length and order as `PackInput.pieces`; undefined = did not fit. */
export type PackOutput = (PackSpot | undefined)[];

export type Packer = (input: PackInput) => PackOutput;
