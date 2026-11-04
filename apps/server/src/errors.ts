/** Service errors with the HTTP status the API maps them to. */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: readonly string[];

  constructor(statusCode: number, code: string, message: string, details?: readonly string[]) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const notFound = (what: string, id: string): HttpError => new HttpError(404, "not_found", `${what} ${id} not found`);

export const invalid = (message: string, details?: readonly string[]): HttpError => new HttpError(400, "invalid_request", message, details);

export const conflict = (message: string): HttpError => new HttpError(409, "conflict", message);
