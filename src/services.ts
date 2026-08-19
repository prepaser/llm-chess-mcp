import type { Chess } from "chess.js";
import { stockfish } from "./engines/stockfish.js";
import {
  explorerEnabled,
  openingExplorer,
} from "./explorer.js";
import type { ExplorerResult } from "./explorer.js";
import { defaultGameStore } from "./games.js";
import type { GameStore } from "./games.js";
import { computeCandidates, rankByIntent } from "./intents.js";
import type { CandidateSet, LichessOpts } from "./intents.js";
import { humanMoveDistribution } from "./maia3/inference.js";
import type { Candidate, Intent, Maia3Move, SfLine } from "./types.js";

export interface AppServices {
  games: GameStore;
  analyze(fen: string, depth: number, multipv: number): Promise<SfLine[]>;
  quit(): Promise<void>;
  humanMoveDistribution(
    chess: Chess,
    elo: number,
    opponentElo: number,
    topN: number,
  ): Promise<Maia3Move[]>;
  explorerEnabled(): boolean;
  openingExplorer(
    chess: Chess,
    db: "lichess" | "masters",
    speeds: readonly string[],
    ratings: readonly number[],
  ): Promise<ExplorerResult>;
  computeCandidates(
    chess: Chess,
    elo: number,
    sfDepth: number,
    sfMultipv: number,
    maiaTopN: number,
    lichess?: LichessOpts | null,
  ): Promise<CandidateSet>;
  rankByIntent(candidates: Candidate[], intent: Intent): Candidate[];
}

export const defaultAppServices: AppServices = {
  games: defaultGameStore,
  analyze: (fen, depth, multipv) => stockfish.analyze(fen, depth, multipv),
  quit: () => stockfish.quit(),
  humanMoveDistribution,
  explorerEnabled,
  openingExplorer,
  computeCandidates,
  rankByIntent,
};
