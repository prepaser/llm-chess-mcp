import * as z from "zod/v4";
import { EXPLORER_ERROR_KINDS } from "./explorer.js";
import { INTENTS } from "./types.js";
import type { ToolName } from "./tool-names.js";

const revision = z.number().int().min(0);
const color = z.enum(["w", "b"]);
const wdl = z.tuple([z.number(), z.number(), z.number()]);

export const ErrorSchema = z.strictObject({
  code: z.string(),
  message: z.string(),
});

export const ErrorOutputSchema = z.strictObject({
  error: ErrorSchema,
});

export const StateSchema = z.strictObject({
  fen: z.string(),
  turn: color,
  revision,
  isCheck: z.boolean(),
  isCheckmate: z.boolean(),
  isStalemate: z.boolean(),
  isDraw: z.boolean(),
  isGameOver: z.boolean(),
  isInsufficientMaterial: z.boolean(),
  isThreefoldRepetition: z.boolean(),
  isDrawByFiftyMoves: z.boolean(),
  moveNumber: z.number().int().min(1),
  history: z.array(z.string()),
  lastMove: z
    .strictObject({
      san: z.string(),
      uci: z.string(),
    })
    .nullable(),
  castling: z.strictObject({
    whiteKingside: z.boolean(),
    whiteQueenside: z.boolean(),
    blackKingside: z.boolean(),
    blackQueenside: z.boolean(),
  }),
});

export const SfLineSchema = z.strictObject({
  multipv: z.number().int().min(1),
  scoreCp: z.number().nullable(),
  scoreMate: z.number().nullable(),
  wdl: wdl.nullable(),
  pv: z.array(z.string()),
});

export const AnalysisLineSchema = z.strictObject({
  ...SfLineSchema.shape,
  pvSan: z.array(z.string()),
});

export const OpeningStatsSchema = z.strictObject({
  status: z.enum(["available", "no_data", "unavailable", "disabled"]),
  reason: z.enum(EXPLORER_ERROR_KINDS).optional(),
  games: z.number().nullable(),
  frequency: z.number().nullable(),
  white: z.number().nullable(),
  draws: z.number().nullable(),
  black: z.number().nullable(),
  averageRating: z.number().nullable(),
});

export const CandidateSchema = z.strictObject({
  uci: z.string(),
  san: z.string(),
  objective: z.strictObject({
    rank: z.number().nullable(),
    moverCp: z.number().nullable(),
    whiteCp: z.number().nullable(),
    cpLoss: z.number().nullable(),
    moverMate: z.number().nullable(),
    whiteMate: z.number().nullable(),
    wdl: wdl.nullable(),
  }),
  human: z.strictObject({
    maia3Prob: z.number().nullable(),
    selfElo: z.number(),
    opponentElo: z.number(),
  }),
  opening: OpeningStatsSchema,
});

export const OpeningSchema = z
  .strictObject({
    eco: z.string(),
    name: z.string(),
  })
  .nullable();

export const CreateGameOutputSchema = z.strictObject({
  game_id: z.string(),
  revision: z.literal(0),
});

export const DeleteGameOutputSchema = z.strictObject({
  game_id: z.string(),
  deleted: z.literal(true),
});

export const GameStateOutputSchema = z.strictObject({
  game_id: z.string(),
  ...StateSchema.shape,
  board: z.string().optional(),
});

export const GamePlayMoveOutputSchema = z.strictObject({
  game_id: z.string(),
  move: z.string(),
  ...StateSchema.shape,
});

const legalMove = z.strictObject({
  san: z.string(),
  uci: z.string(),
  from: z.string().regex(/^[a-h][1-8]$/),
  to: z.string().regex(/^[a-h][1-8]$/),
  piece: z.enum(["p", "n", "b", "r", "q", "k"]),
  captured: z.enum(["p", "n", "b", "r", "q", "k"]).nullable(),
  promotion: z.enum(["n", "b", "r", "q"]).nullable(),
  isCapture: z.boolean(),
  isCheck: z.boolean(),
});

export const GameLegalMovesOutputSchema = z.strictObject({
  game_id: z.string(),
  revision,
  count: z.number().int().min(0),
  moves: z.array(legalMove),
});

export const PositionAnalyzeOutputSchema = z.strictObject({
  game_id: z.string(),
  fen: z.string(),
  turn: color,
  revision,
  analysis_level: z.enum(["fast", "normal", "deep"]),
  lines: z.array(AnalysisLineSchema),
});

export const Maia3MoveSchema = z.strictObject({
  uci: z.string(),
  san: z.string(),
  prob: z.number(),
});

export const HumanMoveDistributionOutputSchema = z.strictObject({
  game_id: z.string(),
  elo: z.number(),
  oppo_elo: z.number(),
  revision,
  moves: z.array(Maia3MoveSchema),
});

const moveEvaluation = z.strictObject({
  move: z.string(),
  uci: z.string(),
  result: z.enum([
    "ongoing",
    "checkmate",
    "stalemate",
    "insufficient_material",
    "threefold_repetition",
    "fifty_move_rule",
    "draw",
  ]),
  scoreCp: z.number().nullable(),
  scoreMate: z.number().nullable(),
  bestCp: z.number().nullable(),
  cpLoss: z.number().nullable(),
  classification: z
    .enum(["best", "excellent", "good", "inaccuracy", "mistake", "blunder"])
    .nullable(),
  pv: z.array(z.string()),
  pvSan: z.array(z.string()),
});

export const MoveEvaluateOutputSchema = z.strictObject({
  game_id: z.string(),
  revision,
  results: z.array(moveEvaluation).min(1).max(10),
});

export const MoveSensitivitySchema = z.strictObject({
  level: z.enum(["low", "medium", "high"]),
  topMoveSpreadCp: z.number().nullable(),
});

const candidatesBase = {
  game_id: z.string(),
  revision,
  fen: z.string(),
  turn: color,
  elo: z.number(),
  analysis_level: z.enum(["fast", "normal", "deep"]),
  moveSensitivity: MoveSensitivitySchema,
  candidates: z.array(CandidateSchema),
};

export const MoveCandidatesOutputSchema = z.strictObject(candidatesBase);

export const MoveCandidatesByIntentOutputSchema = z.strictObject({
  ...candidatesBase,
  intent: z.enum(INTENTS),
});

export const LichessMoveSchema = z.strictObject({
  uci: z.string(),
  san: z.string(),
  white: z.number(),
  draws: z.number(),
  black: z.number(),
  count: z.number(),
  averageRating: z.number().nullable(),
});

export const OpeningExplorerOutputSchema = z.strictObject({
  game_id: z.string(),
  revision,
  db: z.enum(["lichess", "masters"]),
  white: z.number(),
  draws: z.number(),
  black: z.number(),
  moves: z.array(LichessMoveSchema),
  opening: OpeningSchema,
});

export const GamePgnOutputSchema = z.strictObject({
  game_id: z.string(),
  revision,
  pgn: z.string(),
});

export const GameImportPgnOutputSchema = z.strictObject({
  game_id: z.string(),
  ...StateSchema.shape,
  revision: z.literal(0),
});

export const TOOL_OUTPUT_SCHEMAS = {
  create_game: CreateGameOutputSchema,
  delete_game: DeleteGameOutputSchema,
  game_state: GameStateOutputSchema,
  game_play_move: GamePlayMoveOutputSchema,
  game_legal_moves: GameLegalMovesOutputSchema,
  position_analyze: PositionAnalyzeOutputSchema,
  human_move_distribution: HumanMoveDistributionOutputSchema,
  move_evaluate: MoveEvaluateOutputSchema,
  move_candidates: MoveCandidatesOutputSchema,
  move_candidates_by_intent: MoveCandidatesByIntentOutputSchema,
  opening_explorer: OpeningExplorerOutputSchema,
  game_pgn: GamePgnOutputSchema,
  game_import_pgn: GameImportPgnOutputSchema,
} as const satisfies Record<ToolName, z.ZodType>;
