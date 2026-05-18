export class FFHBError extends Error {
  override readonly name: string = "FFHBError";
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
  }
}

export class ScrapeError extends FFHBError {
  override readonly name: string = "ScrapeError";
}

export class ValidationError extends FFHBError {
  override readonly name: string = "ValidationError";
}

export class HttpError extends ScrapeError {
  override readonly name: string = "HttpError";
  constructor(message: string, public readonly status: number, public readonly url: string) {
    super(message);
  }
}
