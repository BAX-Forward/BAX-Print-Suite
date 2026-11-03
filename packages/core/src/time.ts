/** Injectable clock so schedulers and policies can be tested with a fake time. */
export type Clock = () => Date;

export const systemClock: Clock = () => new Date();

export const DAY_MS = 86_400_000;
