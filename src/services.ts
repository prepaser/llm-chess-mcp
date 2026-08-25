import type { Chess } from "chess.js";
import { stockfish } from "./engines/stockfish.js";
import {
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

const analyze: AppServices["analyze"] = (fen, depth, multipv, signal) =>
  stockfish.analyze(fen, depth, multipv, signal);
const humanMoveDistribution: AppServices["humanMoveDistribution"] = async (
  chess,
  elo,
  opponentElo,
  topN,
  signal,
) =>
  (await import("./maia3/inference.js")).humanMoveDistribution(
    chess,
    elo,
    opponentElo,
    topN,
    signal,
  );
const openExplorer: AppServices["openingExplorer"] = (
  chess,
  db,
  speeds,
  ratings,
  signal,
) =>
  openingExplorer(
    chess,
    db,
    speeds,
    ratings,
    signal === undefined ? {} : { signal },
  );
const computeCandidates = createCandidateComputation({
  analyze,
  humanMoveDistribution,
  explorerEnabled,
  openingExplorer: openExplorer,
  explorerFailureReason: (error) =>
    error instanceof ExplorerError ? error.reason : "upstream",
});

export const defaultAppServices: AppServices = {
  games: defaultGameStore,
  analyze,
  quit: () => stockfish.quit(),
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

  return {
    acquire(): DefaultAppServicesLease {
      leaseCount += 1;
      let released = false;
      return {
        services,
        async release(): Promise<void> {
          if (released) return;
          released = true;
          leaseCount -= 1;
          if (leaseCount === 0) await services.quit();
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
