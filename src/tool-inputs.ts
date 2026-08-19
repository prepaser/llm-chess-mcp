import * as z from "zod/v4";
import { MAX_EVALUATED_MOVES } from "./chess.js";
import {
  LICHESS_RATINGS,
  LICHESS_SPEEDS,
  lichessRatingSchema,
  lichessSpeedSchema,
} from "./explorer.js";
import { INTENTS } from "./types.js";

const lichessSpeedsSchema = z
  .array(lichessSpeedSchema)
  .max(LICHESS_SPEEDS.length)
  .refine((values) => new Set(values).size === values.length, "duplicate speeds");
const lichessRatingsSchema = z
  .array(lichessRatingSchema)
  .max(LICHESS_RATINGS.length)
  .refine((values) => new Set(values).size === values.length, "duplicate ratings");

function mastersFilterIssue(
  db: "lichess" | "masters",
  speeds: readonly string[],
  ratings: readonly number[],
): boolean {
  return db === "masters" && (speeds.length > 0 || ratings.length > 0);
}

export const CreateGameInputSchema = z.object({ fen: z.string().optional() });
export const GameIdInputSchema = z.object({ game_id: z.string() });
export const GameStateInputSchema = z.object({
  game_id: z.string(),
  include_ascii: z.boolean().default(false),
});
export const GamePlayMoveInputSchema = z.object({
  game_id: z.string(),
  move: z.string(),
  expected_revision: z.number().int().min(0),
});
export const PositionAnalyzeInputSchema = z.object({
  game_id: z.string(),
  analysis_level: z.enum(["fast", "normal", "deep"]).default("normal"),
  depth: z.number().int().min(1).max(30).optional(),
  multipv: z.number().int().min(1).max(10).optional(),
});
export const HumanMoveDistributionInputSchema = z.object({
  game_id: z.string(),
  elo: z.number().int().min(600).max(2600).default(1500),
  oppo_elo: z.number().int().min(600).max(2600).optional(),
  top_n: z.number().int().min(1).max(20).default(5),
});
export const MoveEvaluateInputSchema = z.object({
  game_id: z.string(),
  move: z.union([
    z.string(),
    z.array(z.string()).min(1).max(MAX_EVALUATED_MOVES),
  ]),
  depth: z.number().int().min(1).max(30).default(15),
});

const candidateFields = {
  game_id: z.string(),
  elo: z.number().int().min(600).max(2600).default(1500),
  analysis_level: z.enum(["fast", "normal", "deep"]).default("normal"),
  sf_depth: z.number().int().min(1).max(30).optional(),
  sf_multipv: z.number().int().min(1).max(10).optional(),
  lichess_db: z.enum(["lichess", "masters"]).default("lichess"),
  lichess_speeds: lichessSpeedsSchema.default([]),
  lichess_ratings: lichessRatingsSchema.default([]),
};

export const MoveCandidatesInputSchema = z
  .object({
    ...candidateFields,
    maia_top_n: z.number().int().min(1).max(20).default(5),
  })
  .superRefine((value, ctx) => {
    if (
      mastersFilterIssue(
        value.lichess_db,
        value.lichess_speeds,
        value.lichess_ratings,
      )
    ) {
      ctx.addIssue({
        code: "custom",
        message: "masters does not support speed or rating filters",
        path: ["lichess_db"],
      });
    }
  });

export const MoveCandidatesByIntentInputSchema = z
  .object({
    ...candidateFields,
    intent: z.enum(INTENTS),
    maia_top_n: z.number().int().min(1).max(20).default(10),
  })
  .superRefine((value, ctx) => {
    if (
      mastersFilterIssue(
        value.lichess_db,
        value.lichess_speeds,
        value.lichess_ratings,
      )
    ) {
      ctx.addIssue({
        code: "custom",
        message: "masters does not support speed or rating filters",
        path: ["lichess_db"],
      });
    }
  });

export const OpeningExplorerInputSchema = z
  .object({
    game_id: z.string(),
    db: z.enum(["lichess", "masters"]).default("lichess"),
    speeds: lichessSpeedsSchema.default([]),
    ratings: lichessRatingsSchema.default([]),
  })
  .superRefine((value, ctx) => {
    if (mastersFilterIssue(value.db, value.speeds, value.ratings)) {
      ctx.addIssue({
        code: "custom",
        message: "masters does not support speed or rating filters",
        path: ["db"],
      });
    }
  });

export const GameImportPgnInputSchema = z.object({ pgn: z.string() });

export const TOOL_INPUT_SCHEMAS = {
  create_game: CreateGameInputSchema,
  delete_game: GameIdInputSchema,
  game_state: GameStateInputSchema,
  game_play_move: GamePlayMoveInputSchema,
  game_legal_moves: GameIdInputSchema,
  position_analyze: PositionAnalyzeInputSchema,
  human_move_distribution: HumanMoveDistributionInputSchema,
  move_evaluate: MoveEvaluateInputSchema,
  move_candidates: MoveCandidatesInputSchema,
  move_candidates_by_intent: MoveCandidatesByIntentInputSchema,
  opening_explorer: OpeningExplorerInputSchema,
  game_pgn: GameIdInputSchema,
  game_import_pgn: GameImportPgnInputSchema,
} as const;
