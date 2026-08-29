import * as z from "zod/v4";
import { MAX_EVALUATED_MOVES } from "./chess.js";
import {
  LICHESS_RATINGS,
  LICHESS_SPEEDS,
  lichessRatingSchema,
  lichessSpeedSchema,
} from "./explorer.js";
import { ANALYSIS_LEVELS, INTENTS } from "./domain.js";
import type { ToolName } from "./tool-names.js";

const lichessSpeedsSchema = z
  .array(lichessSpeedSchema)
  .max(LICHESS_SPEEDS.length)
  .refine((values) => new Set(values).size === values.length, "duplicate speeds")
  .meta({
    uniqueItems: true,
    description: "Speed filters must be unique; duplicates are not allowed.",
  });
const lichessRatingsSchema = z
  .array(lichessRatingSchema)
  .max(LICHESS_RATINGS.length)
  .refine((values) => new Set(values).size === values.length, "duplicate ratings")
  .meta({
    uniqueItems: true,
    description: "Rating filters must be unique; duplicates are not allowed.",
  });

function mastersFilterContract(
  db: "db" | "lichess_db",
  speeds: "speeds" | "lichess_speeds",
  ratings: "ratings" | "lichess_ratings",
) {
  return {
    description: `When ${db} is masters, ${speeds} and ${ratings} must both be empty.`,
    allOf: [
      {
        if: { properties: { [db]: { const: "masters" } }, required: [db] },
        then: {
          properties: {
            [speeds]: { maxItems: 0 },
            [ratings]: { maxItems: 0 },
          },
        },
      },
    ],
  };
}

const explorerFilterContract = mastersFilterContract("db", "speeds", "ratings");
const candidateExplorerFilterContract = mastersFilterContract(
  "lichess_db",
  "lichess_speeds",
  "lichess_ratings",
);

const explorerFilterFields = {
  db: z.enum(["lichess", "masters"]),
  speeds: lichessSpeedsSchema.default([]),
  ratings: lichessRatingsSchema.default([]),
};

type ExplorerFilterValues = {
  db: "lichess" | "masters";
  speeds: string[];
  ratings: number[];
};

function addExplorerFilterIssue(
  filters: ExplorerFilterValues,
  ctx: z.RefinementCtx,
  path: "db" | "lichess_db",
): void {
  if (filters.db !== "masters" || (!filters.speeds.length && !filters.ratings.length)) {
    return;
  }
  ctx.addIssue({
    code: "custom",
    message: "masters does not support speed or rating filters",
    path: [path],
  });
}

export const ExplorerFiltersSchema = z
  .object(explorerFilterFields)
  .superRefine((filters, ctx) => addExplorerFilterIssue(filters, ctx, "db"))
  .meta(explorerFilterContract);

export type ExplorerFilters = z.output<typeof ExplorerFiltersSchema>;

export function explorerFilters(
  filters: ExplorerFilters,
): ExplorerFilters {
  return filters;
}

export function candidateExplorerFilters(input: {
  lichess_db: ExplorerFilters["db"];
  lichess_speeds: ExplorerFilters["speeds"];
  lichess_ratings: ExplorerFilters["ratings"];
}): ExplorerFilters {
  return explorerFilters({
    db: input.lichess_db,
    speeds: input.lichess_speeds,
    ratings: input.lichess_ratings,
  });
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
  analysis_level: z.enum(ANALYSIS_LEVELS).default("normal"),
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
  analysis_level: z.enum(ANALYSIS_LEVELS).default("normal"),
  sf_depth: z.number().int().min(1).max(30).optional(),
  sf_multipv: z.number().int().min(1).max(10).optional(),
  lichess_db: explorerFilterFields.db.default("lichess"),
  lichess_speeds: explorerFilterFields.speeds,
  lichess_ratings: explorerFilterFields.ratings,
};

export const MoveCandidatesInputSchema = z
  .object({
    ...candidateFields,
    maia_top_n: z.number().int().min(1).max(20).default(5),
  })
  .superRefine((value, ctx) => {
    addExplorerFilterIssue(candidateExplorerFilters(value), ctx, "lichess_db");
  })
  .meta(candidateExplorerFilterContract);

export const MoveCandidatesByIntentInputSchema = z
  .object({
    ...candidateFields,
    intent: z.enum(INTENTS),
    maia_top_n: z.number().int().min(1).max(20).default(10),
  })
  .superRefine((value, ctx) => {
    addExplorerFilterIssue(candidateExplorerFilters(value), ctx, "lichess_db");
  })
  .meta(candidateExplorerFilterContract);

export const OpeningExplorerInputSchema = z
  .object({
    game_id: z.string(),
    db: explorerFilterFields.db.default("lichess"),
    speeds: explorerFilterFields.speeds,
    ratings: explorerFilterFields.ratings,
  })
  .superRefine((value, ctx) => {
    addExplorerFilterIssue(explorerFilters(value), ctx, "db");
  })
  .meta(explorerFilterContract);

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
} as const satisfies Record<ToolName, z.ZodType>;
