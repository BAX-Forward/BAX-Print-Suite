/** Base class for every typed error raised by BAX Print Suite packages. */
export class BpsError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** A caller passed a value that fails validation. */
export class InvalidArgumentError extends BpsError {
  constructor(message: string) {
    super('INVALID_ARGUMENT', message);
  }
}
