import * as z from "zod/v4";
import { MAX_EVALUATED_MOVES } from "./chess.js";
import {
  LICHESS_RATINGS,
  LICHESS_SPEEDS,
  lichessRatingSchema,
  lichessSpeedSchema,
} from "./explorer.js";
import {
  ANALYSIS_LEVELS,
  INTENTS,
  MAX_ANALYSIS_DEPTH,
  MAX_HUMAN_MOVES,
  MAX_MULTIPV,
} from "./domain.js";
import type { ToolName } from "./tool-names.js";
import { GameIdSchema } from "./tool-fields.js";

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

const explorerFilterFields = {
  db: z.enum(["lichess", "masters"]),
  speeds: lichessSpeedsSchema.default([]),
  ratings: lichessRatingsSchema.default([]),
};

type ExplorerFilterKeys<Fields extends z.ZodRawShape> = {
  db: Extract<keyof Fields, string>;
  speeds: Extract<keyof Fields, string>;
  ratings: Extract<keyof Fields, string>;
};

function strictExplorerInputSchema<const Fields extends z.ZodRawShape>(
  fields: Fields,
  keys: ExplorerFilterKeys<Fields>,
) {
  const { db, speeds, ratings } = keys;
  return z
    .strictObject(fields)
    .superRefine((input, ctx) => {
      const filters = input as Record<string, unknown>;
      const selectedDb = filters[db];
      const speedValues = filters[speeds];
      const ratingValues = filters[ratings];
      if (
        selectedDb !== "masters" ||
        (!Array.isArray(speedValues) || speedValues.length === 0) &&
          (!Array.isArray(ratingValues) || ratingValues.length === 0)
      ) {
        return;
      }
      ctx.addIssue({
        code: "custom",
        message: "masters does not support speed or rating filters",
        path: [db],
      });
    })
    .meta({
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
    });
}

export const ExplorerFiltersSchema = strictExplorerInputSchema(
  explorerFilterFields,
  { db: "db", speeds: "speeds", ratings: "ratings" },
);

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

export const CreateGameInputSchema = z.strictObject({ fen: z.string().optional() });
export const GameIdInputSchema = z.strictObject({ game_id: GameIdSchema });
export const GameStateInputSchema = z.strictObject({
  game_id: GameIdSchema,
  include_ascii: z.boolean().default(false),
});
export const GamePlayMoveInputSchema = z.strictObject({
  game_id: GameIdSchema,
  move: z.string(),
  expected_revision: z.number().int().min(0),
});
export const PositionAnalyzeInputSchema = z.strictObject({
  game_id: GameIdSchema,
  analysis_level: z.enum(ANALYSIS_LEVELS).default("normal"),
  depth: z.number().int().min(1).max(MAX_ANALYSIS_DEPTH).optional(),
  multipv: z.number().int().min(1).max(MAX_MULTIPV).optional(),
});
export const HumanMoveDistributionInputSchema = z.strictObject({
  game_id: GameIdSchema,
  elo: z.number().int().min(600).max(2600).default(1500),
  oppo_elo: z.number().int().min(600).max(2600).optional(),
  top_n: z.number().int().min(1).max(MAX_HUMAN_MOVES).default(5),
});
export const MoveEvaluateInputSchema = z.strictObject({
  game_id: GameIdSchema,
  move: z.union([
    z.string(),
    z.array(z.string()).min(1).max(MAX_EVALUATED_MOVES),
  ]),
  depth: z.number().int().min(1).max(MAX_ANALYSIS_DEPTH).default(15),
});

const candidateFields = {
  game_id: GameIdSchema,
  elo: z.number().int().min(600).max(2600).default(1500),
  analysis_level: z.enum(ANALYSIS_LEVELS).default("normal"),
  sf_depth: z.number().int().min(1).max(MAX_ANALYSIS_DEPTH).optional(),
  sf_multipv: z.number().int().min(1).max(MAX_MULTIPV).optional(),
  lichess_db: explorerFilterFields.db.default("lichess"),
  lichess_speeds: explorerFilterFields.speeds,
  lichess_ratings: explorerFilterFields.ratings,
};

export const MoveCandidatesInputSchema = strictExplorerInputSchema(
  {
    ...candidateFields,
    maia_top_n: z.number().int().min(1).max(MAX_HUMAN_MOVES).default(5),
  },
  {
    db: "lichess_db",
    speeds: "lichess_speeds",
    ratings: "lichess_ratings",
  },
);

export const MoveCandidatesByIntentInputSchema = strictExplorerInputSchema(
  {
    ...candidateFields,
    intent: z.enum(INTENTS),
    maia_top_n: z.number().int().min(1).max(MAX_HUMAN_MOVES).default(10),
  },
  {
    db: "lichess_db",
    speeds: "lichess_speeds",
    ratings: "lichess_ratings",
  },
);

export const OpeningExplorerInputSchema = strictExplorerInputSchema(
  {
    game_id: GameIdSchema,
    db: explorerFilterFields.db.default("lichess"),
    speeds: explorerFilterFields.speeds,
    ratings: explorerFilterFields.ratings,
  },
  { db: "db", speeds: "speeds", ratings: "ratings" },
);

export const GameImportPgnInputSchema = z.strictObject({ pgn: z.string() });

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
