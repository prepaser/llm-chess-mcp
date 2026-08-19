export interface GameRecord {
  chess: import("chess.js").Chess;
  createdAt: number;
  lastAccessedAt: number;
  revision: number;
}

export type DrawResult =
  | "stalemate"
  | "insufficient_material"
  | "threefold_repetition"
  | "fifty_move_rule"
  | "draw";

export interface ChessState {
  fen: string;
  turn: "w" | "b";
  revision: number;
  isCheck: boolean;
  isCheckmate: boolean;
  isStalemate: boolean;
  isDraw: boolean;
  isGameOver: boolean;
  isInsufficientMaterial: boolean;
  isThreefoldRepetition: boolean;
  isDrawByFiftyMoves: boolean;
  moveNumber: number;
  history: string[];
  lastMove: { san: string; uci: string } | null;
  castling: {
    whiteKingside: boolean;
    whiteQueenside: boolean;
    blackKingside: boolean;
    blackQueenside: boolean;
  };
}

export type SfLine = z.output<typeof SfLineSchema>;
export type Maia3Move = z.output<typeof Maia3MoveSchema>;
export type LichessMove = z.output<typeof LichessMoveSchema>;
export type Candidate = z.output<typeof CandidateSchema>;
export type Objective = Candidate["objective"];
export type HumanModel = Candidate["human"];
export type OpeningStats = z.output<typeof OpeningStatsSchema>;

export const INTENTS = [
  "best",
  "strong",
  "natural",
  "balanced",
  "ease_off",
  "give_chance",
] as const;

export type Intent = (typeof INTENTS)[number];

export type MoveSensitivity = z.output<typeof MoveSensitivitySchema>;
import type * as z from "zod/v4";
import type {
  CandidateSchema,
  LichessMoveSchema,
  Maia3MoveSchema,
  MoveSensitivitySchema,
  OpeningStatsSchema,
  SfLineSchema,
} from "./tool-schemas.js";
