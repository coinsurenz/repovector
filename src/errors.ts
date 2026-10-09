/** Error carrying an HTTP-like status, so the retry policy and the HTTP server can classify it. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (msg: string): HttpError => new HttpError(400, msg);
export const notFound = (msg: string): HttpError => new HttpError(404, msg);
export const unavailable = (msg: string): HttpError => new HttpError(503, msg);

/** A problem with the user's settings: reported as one clear message, never retried. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
