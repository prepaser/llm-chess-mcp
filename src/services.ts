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
import type { Candidate, Intent, Maia3Move, SfLine } from "./types.js";

export interface AppServices {
  games: GameStore;
  analyze(
    fen: string,
    depth: number,
    multipv: number,
    signal?: AbortSignal,
  ): Promise<SfLine[]>;
  quit(): Promise<void>;
  humanMoveDistribution(
    chess: Chess,
    elo: number,
    opponentElo: number,
    topN: number,
    signal?: AbortSignal,
  ): Promise<Maia3Move[]>;
  explorerEnabled(): boolean;
  openingExplorer(
    chess: Chess,
    db: "lichess" | "masters",
    speeds: readonly string[],
    ratings: readonly number[],
    signal?: AbortSignal,
  ): Promise<ExplorerResult>;
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

let defaultAppServicesLeaseCount = 0;

export function acquireDefaultAppServices(): DefaultAppServicesLease {
  defaultAppServicesLeaseCount += 1;
  let released = false;
  return {
    services: defaultAppServices,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      defaultAppServicesLeaseCount -= 1;
      if (defaultAppServicesLeaseCount === 0) await defaultAppServices.quit();
    },
  };
}
