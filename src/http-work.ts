import { ChessError } from "./errors.js";

export type WorkRunner = <T>(
  signal: AbortSignal,
  work: (signal: AbortSignal) => Promise<T>,
) => Promise<T>;

export class HttpWorkAdmission {
  #active = 0;

  constructor(
    private readonly max: number,
    private readonly maxPerSession: number,
  ) {}

  session(lifecycle: AbortSignal): WorkRunner {
    let active = 0;
    return async <T>(
      request: AbortSignal,
      work: (signal: AbortSignal) => Promise<T>,
    ): Promise<T> => {
      const signal = AbortSignal.any([request, lifecycle]);
      signal.throwIfAborted();
      if (active >= this.maxPerSession) {
        throw new ChessError("SERVER_BUSY", "MCP session work limit reached");
      }
      if (this.#active >= this.max) {
        throw new ChessError("SERVER_BUSY", "server work limit reached");
      }
      active += 1;
      this.#active += 1;
      try {
        const result = await work(signal);
        signal.throwIfAborted();
        return result;
      } finally {
        active -= 1;
        this.#active -= 1;
      }
    };
  }
}
