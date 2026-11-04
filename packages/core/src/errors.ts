/** Base class for every typed error raised by BAX Print Suite packages. */
export class BpsError extends Error {
  readonly code: string;
  /** Structured context that is safe to expose over the API. */
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, options?: ErrorOptions & { details?: Record<string, unknown> }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
    if (options?.details !== undefined) this.details = options.details;
  }
}

/** A caller passed a value that fails validation. */
export class InvalidArgumentError extends BpsError {
  constructor(message: string) {
    super('INVALID_ARGUMENT', message);
  }
}
