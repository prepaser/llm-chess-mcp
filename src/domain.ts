import type { Chess } from "chess.js";

export const EXPLORER_ERROR_KINDS = [
  "disabled",
  "invalid_input",
  "timeout",
  "network",
  "auth",
  "rate_limited",
  "upstream",
  "http",
  "invalid_response",
] as const;
export type ExplorerErrorKind = (typeof EXPLORER_ERROR_KINDS)[number];

export const COLORS = ["w", "b"] as const;
export type Color = (typeof COLORS)[number];

export const PIECES = ["p", "n", "b", "r", "q", "k"] as const;
export type Piece = (typeof PIECES)[number];

export const PROMOTIONS = ["n", "b", "r", "q"] as const;
export type Promotion = (typeof PROMOTIONS)[number];

export const DRAW_RESULTS = [
  "stalemate",
  "insufficient_material",
  "threefold_repetition",
  "fifty_move_rule",
  "draw",
] as const;
export type DrawResult = (typeof DRAW_RESULTS)[number];

export const MOVE_EVALUATION_RESULTS = [
  "ongoing",
  "checkmate",
  ...DRAW_RESULTS,
] as const;
export type MoveEvaluationResult = (typeof MOVE_EVALUATION_RESULTS)[number];

export const ANALYSIS_LEVELS = ["fast", "normal", "deep"] as const;
export type AnalysisLevel = (typeof ANALYSIS_LEVELS)[number];

export const MAX_ANALYSIS_DEPTH = 30;
export const MAX_MULTIPV = 10;
export const MAX_HUMAN_MOVES = 20;
export const HUMAN_PROBABILITY_TOLERANCE = 1e-5;
export const GAME_ID_MAX_LENGTH = 256;
export const WDL_TOTAL = 1_000;

export const MOVE_CLASSIFICATIONS = [
  "best",
  "excellent",
  "good",
  "inaccuracy",
  "mistake",
  "blunder",
] as const;
export type MoveClassification = (typeof MOVE_CLASSIFICATIONS)[number];

export const INTENTS = [
  "best",
  "strong",
  "natural",
  "balanced",
  "ease_off",
  "give_chance",
] as const;
export type Intent = (typeof INTENTS)[number];

export interface GameRecord {
  chess: Chess;
  createdAt: number;
  lastAccessedAt: number;
  revision: number;
}

export interface ChessState {
  fen: string;
  turn: Color;
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

export type Wdl = [number, number, number];

type SfScore =
  | { scoreCp: number; scoreMate: null }
  | { scoreCp: null; scoreMate: number }
  | { scoreCp: null; scoreMate: null };

export type SfLine = {
  multipv: number;
  wdl: Wdl | null;
  pv: string[];
} & SfScore;

export interface Maia3Move {
  uci: string;
  san: string;
  prob: number;
}

export interface LichessMove {
  uci: string;
  san: string;
  white: number;
  draws: number;
  black: number;
  count: number;
  averageRating: number | null;
}

export interface Objective {
  rank: number | null;
  moverCp: number | null;
  whiteCp: number | null;
  cpLoss: number | null;
  moverMate: number | null;
  whiteMate: number | null;
  wdl: Wdl | null;
}

export interface HumanModel {
  maia3Prob: number | null;
  selfElo: number;
  opponentElo: number;
}

type EmptyOpeningStats = {
  games: null;
  frequency: null;
  white: null;
  draws: null;
  black: null;
  averageRating: null;
};

type AvailableOpeningStats = {
  games: number;
  frequency: number;
  white: number;
  draws: number;
  black: number;
  averageRating: number | null;
};

export type OpeningStats =
  | ({ status: "available" } & (EmptyOpeningStats | AvailableOpeningStats))
  | ({ status: "no_data" | "disabled" } & EmptyOpeningStats)
  | ({ status: "unavailable"; reason: ExplorerErrorKind } & EmptyOpeningStats);

export interface Candidate {
  uci: string;
  san: string;
  objective: Objective;
  human: HumanModel;
  opening: OpeningStats;
}

export interface MoveSensitivity {
  level: "low" | "medium" | "high";
  topMoveSpreadCp: number | null;
}
