import { ChessError } from "./errors.js";
import type { AppServices } from "./services.js";

export type WorkRunner = <T>(
  signal: AbortSignal,
  work: (signal: AbortSignal) => Promise<T>,
) => Promise<T>;

type WorkAdmittedServices = Pick<
  AppServices,
  "analyze" | "humanMoveDistribution" | "openingExplorer" | "computeCandidates"
>;

const NO_REQUEST_SIGNAL = new AbortController().signal;

export class HttpWorkAdmission {
  #activeGlobal = 0;

  constructor(
    private readonly maxGlobal: number,
    private readonly maxPerSession: number,
  ) {}

  forSession(lifecycle: AbortSignal): WorkRunner {
    let activeSession = 0;
    return async <T>(
      request: AbortSignal,
      work: (signal: AbortSignal) => Promise<T>,
    ): Promise<T> => {
      const signal = AbortSignal.any([request, lifecycle]);
      signal.throwIfAborted();
      if (activeSession >= this.maxPerSession) {
        throw new ChessError("SERVER_BUSY", "MCP session work limit reached");
      }
      if (this.#activeGlobal >= this.maxGlobal) {
        throw new ChessError("SERVER_BUSY", "server work limit reached");
      }
      activeSession += 1;
      this.#activeGlobal += 1;
      try {
        const result = await work(signal);
        signal.throwIfAborted();
        return result;
      } finally {
        activeSession -= 1;
        this.#activeGlobal -= 1;
      }
    };
  }

  session(lifecycle: AbortSignal): WorkRunner {
    return this.forSession(lifecycle);
  }
}

export function withSessionWorkAdmission(
  services: AppServices,
  run: WorkRunner,
): AppServices {
  const admitted: WorkAdmittedServices = {
    analyze: (fen, depth, multipv, request) =>
      run(request ?? NO_REQUEST_SIGNAL, (signal) =>
        services.analyze(fen, depth, multipv, signal),
      ),
    humanMoveDistribution: (chess, elo, opponentElo, topN, request) =>
      run(request ?? NO_REQUEST_SIGNAL, (signal) =>
        services.humanMoveDistribution(chess, elo, opponentElo, topN, signal),
      ),
    openingExplorer: (chess, db, speeds, ratings, request) =>
      run(request ?? NO_REQUEST_SIGNAL, (signal) =>
        services.openingExplorer(chess, db, speeds, ratings, signal),
      ),
    computeCandidates: (
      chess,
      elo,
      sfDepth,
      sfMultipv,
      maiaTopN,
      lichess,
      request,
    ) =>
      run(request ?? NO_REQUEST_SIGNAL, (signal) =>
        services.computeCandidates(
          chess,
          elo,
          sfDepth,
          sfMultipv,
          maiaTopN,
          lichess,
          signal,
        ),
      ),
  };
  return { ...services, ...admitted };
}
