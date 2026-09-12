export class ChessError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ChessError";
  }
}

export function fail(code: string, message: string): never {
  throw new ChessError(code, message);
}
