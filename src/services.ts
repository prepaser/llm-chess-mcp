import type { Chess } from "chess.js";
import { snapshotChess } from "./chess.js";
import { stockfish } from "./engines/stockfish.js";
import {
  createExplorerLimiter,
  ExplorerError,
  explorerEnabled,
  openingExplorer,
} from "./explorer.js";
import type { ExplorerResult } from "./explorer.js";
import { defaultGameStore } from "./games.js";
import type { GameStore } from "./games.js";
import { createCandidateComputation, rankByIntent } from "./intents.js";
import type { CandidateSet, LichessOpts } from "./intents.js";
import type { Candidate, Intent, Maia3Move, SfLine } from "./domain.js";

export interface GameServices {
  games: GameStore;
}

export interface AnalysisServices {
  analyze(
    fen: string,
    depth: number,
    multipv: number,
    signal?: AbortSignal,
  ): Promise<SfLine[]>;
  humanMoveDistribution(
    chess: Chess,
    elo: number,
    opponentElo: number,
    topN: number,
    signal?: AbortSignal,
  ): Promise<Maia3Move[]>;
}

export interface ExplorerServices {
  explorerEnabled(): boolean;
  openingExplorer(
    chess: Chess,
    db: "lichess" | "masters",
    speeds: readonly string[],
    ratings: readonly number[],
    signal?: AbortSignal,
  ): Promise<ExplorerResult>;
}

export interface CandidateServices {
  computeCandidates(
    chess: Chess,
    elo: number,
    sfDepth: number,
    sfMultipv: number,
    maiaTopN: number,
    lichess?: LichessOpts | null,
    signal?: AbortSignal,
  ): Promise<CandidateSet>;
  rankByIntent(candidates: Candidate[], intent: Intent): Candidate[];
}

export interface LifecycleServices {
  quit(): Promise<void>;
}

export interface AppServices
  extends
    GameServices,
    AnalysisServices,
    ExplorerServices,
    CandidateServices,
    LifecycleServices {}

let maiaModule: Promise<typeof import("./maia3/inference.js")> | undefined;
let defaultShutdown: Promise<void> | null = null;
type DefaultGeneration = {
  active: Set<Promise<void>>;
  controller: AbortController;
  limiter: ReturnType<typeof createExplorerLimiter>;
};
const createDefaultGeneration = (): DefaultGeneration => ({
  active: new Set(),
  controller: new AbortController(),
  limiter: createExplorerLimiter(),
});
let defaultGeneration = createDefaultGeneration();
function trackGeneration<T>(
  generation: DefaultGeneration,
  operation: Promise<T>,
): Promise<T> {
  const settled = operation.then(
    () => {},
    () => {},
  );
  generation.active.add(settled);
  void settled.then(() => generation.active.delete(settled));
  return operation;
}
const shutdownError = (): Error | null =>
  defaultShutdown ? new Error("application services are shutting down") : null;
function runInGeneration<T>(
  signal: AbortSignal | undefined,
  start: (generation: DefaultGeneration, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const error = shutdownError();
  if (error) return Promise.reject(error);
  const generation = defaultGeneration;
  const workSignal = signal
    ? AbortSignal.any([signal, generation.controller.signal])
    : generation.controller.signal;
  return trackGeneration(generation, start(generation, workSignal));
}
const analyze: AppServices["analyze"] = (fen, depth, multipv, signal) => {
  const error = shutdownError();
  return error
    ? Promise.reject(error)
    : stockfish.analyze(fen, depth, multipv, signal);
};
const loadMaia = (): Promise<typeof import("./maia3/inference.js")> =>
  (maiaModule ??= import("./maia3/inference.js"));
const humanMoveDistribution: AppServices["humanMoveDistribution"] = async (
  chess,
  elo,
  opponentElo,
  topN,
  signal,
) => {
  const beforeLoad = shutdownError();
  if (beforeLoad) throw beforeLoad;
  const position = snapshotChess(chess);
  const maia = await loadMaia();
  const afterLoad = shutdownError();
  if (afterLoad) throw afterLoad;
  return maia.humanMoveDistribution(
    position,
    elo,
    opponentElo,
    topN,
    signal,
  );
};
const openExplorer: AppServices["openingExplorer"] = (
  chess,
  db,
  speeds,
  ratings,
  signal,
) =>
  runInGeneration(signal, (generation, workSignal) =>
    openingExplorer(chess, db, speeds, ratings, {
      limiter: generation.limiter,
      signal: workSignal,
    }),
  );
const computeCandidateSet = createCandidateComputation({
  analyze,
  humanMoveDistribution,
  explorerEnabled,
  openingExplorer: openExplorer,
  explorerFailureReason: (error) =>
    error instanceof ExplorerError ? error.reason : "upstream",
});
const computeCandidates: AppServices["computeCandidates"] = (
  chess,
  elo,
  sfDepth,
  sfMultipv,
  maiaTopN,
  lichess,
  signal,
) =>
  runInGeneration(signal, (_generation, workSignal) =>
    computeCandidateSet(
      chess,
      elo,
      sfDepth,
      sfMultipv,
      maiaTopN,
      lichess,
      workSignal,
    ),
  );

function quitDefaultServices(): Promise<void> {
  if (defaultShutdown) return defaultShutdown;
  const maia = maiaModule;
  const generation = defaultGeneration;
  let operation!: Promise<void>;
  operation = Promise.resolve()
    .then(async () => {
      const generationDrain = Promise.all([...generation.active]).then(
        () => {},
      );
      const results = await Promise.allSettled([
        stockfish.quit(),
        generationDrain,
        ...(maia ? [maia.then((module) => module.quitMaia())] : []),
      ]);
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        throw new AggregateError(errors, "application services shutdown failed");
      }
    })
    .finally(() => {
      if (defaultShutdown === operation) defaultShutdown = null;
    });
  defaultShutdown = operation;
  defaultGeneration = createDefaultGeneration();
  generation.controller.abort(
    new Error("application services are shutting down"),
  );
  return operation;
}

export const defaultAppServices: AppServices = {
  games: defaultGameStore,
  analyze,
  quit: quitDefaultServices,
  humanMoveDistribution,
  explorerEnabled,
  openingExplorer: openExplorer,
  computeCandidates,
  rankByIntent,
};

export type DefaultAppServicesLease = {
  services: AppServices;
  release(): Promise<void>;
};

export type AppServicesLeaseManager = {
  acquire(): DefaultAppServicesLease;
};

export function createAppServicesLeaseManager(
  services: AppServices,
): AppServicesLeaseManager {
  let leaseCount = 0;
  let quitting = false;

  return {
    acquire(): DefaultAppServicesLease {
      if (quitting) throw new Error("application services are shutting down");
      leaseCount += 1;
      let releasePromise: Promise<void> | undefined;
      return {
        services,
        release(): Promise<void> {
          if (releasePromise) return releasePromise;
          leaseCount -= 1;
          if (leaseCount !== 0) {
            releasePromise = Promise.resolve();
            return releasePromise;
          }
          quitting = true;
          releasePromise = Promise.resolve()
            .then(() => services.quit())
            .finally(() => {
              quitting = false;
            });
          return releasePromise;
        },
      };
    },
  };
}

const defaultAppServicesLeaseManager = createAppServicesLeaseManager(
  defaultAppServices,
);

export function acquireDefaultAppServices(): DefaultAppServicesLease {
  return defaultAppServicesLeaseManager.acquire();
}
