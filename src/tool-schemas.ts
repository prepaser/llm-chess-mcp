import * as z from "zod/v4";
import {
  ANALYSIS_LEVELS,
  COLORS,
  EXPLORER_ERROR_KINDS,
  HUMAN_PROBABILITY_TOLERANCE,
  INTENTS,
  MAX_HUMAN_MOVES,
  MOVE_EVALUATION_RESULTS,
  MOVE_CLASSIFICATIONS,
  PIECES,
  PROMOTIONS,
  type Candidate,
  type ChessState,
  type LichessMove,
  type Maia3Move,
  type MoveSensitivity,
  type OpeningStats,
  type SfLine,
  type Wdl,
} from "./domain.js";
import {
  EXPLORER_MAX_MOVES,
  EXPLORER_MAX_STRING_LENGTH,
} from "./explorer-core.js";
import type { ToolName } from "./tool-names.js";
import { GameIdSchema } from "./tool-fields.js";

const revision = z.number().int().min(0);
const color = z.enum(COLORS);
const safeCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const probability = z.number().min(0).max(1);
const moveText = z.string().min(1).max(EXPLORER_MAX_STRING_LENGTH);
const uci = moveText.regex(
  /^(?!([a-h][1-8])\1)(?:[a-h][1-8][a-h][1-8]|(?:[a-h]7[a-h]8|[a-h]2[a-h]1)[qrbn])$/,
);
const wdlDescription =
  "[wins, draws, losses]; the three counts must sum to 1000.";
const wdl = z
  .tuple([
    z.number().int().min(0).max(1_000),
    z.number().int().min(0).max(1_000),
    z.number().int().min(0).max(1_000),
  ])
  .meta({ minItems: 3, maxItems: 3 })
  .refine(([wins, draws, losses]) => wins + draws + losses === 1_000, {
    message: "WDL counts must sum to 1000",
  })
  .describe(wdlDescription) satisfies z.ZodType<Wdl>;
const nullableWdl = wdl.nullable().describe(wdlDescription);

function addCountIssue(
  ctx: z.RefinementCtx,
  path: PropertyKey[],
  message: string,
): void {
  ctx.addIssue({ code: "custom", message, path });
}

function safeSum(values: readonly number[]): number | null {
  const sum = values.reduce((total, value) => total + value, 0);
  return Number.isSafeInteger(sum) ? sum : null;
}

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
}) satisfies z.ZodType<ChessState>;

const sfLineShape = {
  multipv: z.number().int().min(1),
  scoreCp: z.number().nullable(),
  scoreMate: z.number().nullable(),
  wdl: nullableWdl,
  pv: z.array(z.string()),
};

function addScoreIssue(
  value: { scoreCp: number | null; scoreMate: number | null },
  ctx: z.RefinementCtx,
): void {
  if (value.scoreCp !== null && value.scoreMate !== null) {
    ctx.addIssue({
      code: "custom",
      message: "scoreCp and scoreMate cannot both be present",
      path: ["scoreMate"],
    });
  }
}

export const SfLineSchema = z
  .strictObject(sfLineShape)
  .superRefine(addScoreIssue) as z.ZodType<SfLine>;

export const AnalysisLineSchema = z
  .strictObject({
    ...sfLineShape,
    pvSan: z.array(z.string()),
  })
  .superRefine((line, ctx) => {
    addScoreIssue(line, ctx);
    if (line.pv.length !== line.pvSan.length) {
      ctx.addIssue({
        code: "custom",
        message: "pv and pvSan must have equal lengths",
        path: ["pvSan"],
      });
    }
  })
  .describe(
    "scoreCp and scoreMate cannot both be present; pv and pvSan contain the same continuation and must have equal lengths.",
  );

const analysisLines = z
  .array(AnalysisLineSchema)
  .max(10)
  .superRefine((lines, ctx) => {
    const ranks = new Set<number>();
    for (const [index, line] of lines.entries()) {
      if (ranks.has(line.multipv)) {
        ctx.addIssue({
          code: "custom",
          message: "analysis multipv ranks must be unique",
          path: [index, "multipv"],
        });
      }
      ranks.add(line.multipv);
    }
  })
  .describe("At most 10 analysis lines with unique multipv ranks.");

const openingStatsValues = {
  games: safeCount.nullable(),
  frequency: probability.nullable(),
  white: safeCount.nullable(),
  draws: safeCount.nullable(),
  black: safeCount.nullable(),
  averageRating: safeCount.nullable(),
};

export const OpeningStatsSchema = z
  .discriminatedUnion("status", [
    z.strictObject({ status: z.literal("available"), ...openingStatsValues }),
    z.strictObject({ status: z.literal("no_data"), ...openingStatsValues }),
    z.strictObject({
      status: z.literal("unavailable"),
      reason: z.enum(EXPLORER_ERROR_KINDS),
      ...openingStatsValues,
    }),
    z.strictObject({ status: z.literal("disabled"), ...openingStatsValues }),
  ])
  .superRefine((stats, ctx) => {
    const { games, frequency, white, draws, black, averageRating } = stats;
    if (stats.status !== "available") {
      if (
        [games, frequency, white, draws, black, averageRating].some(
          (value) => value !== null,
        )
      ) {
        addCountIssue(
          ctx,
          ["games"],
          `${stats.status} opening stats must all be null`,
        );
      }
      return;
    }

    const counts = [games, white, draws, black];
    const present = counts.filter((value) => value !== null);
    if (present.length === 0) {
      if (frequency !== null || averageRating !== null) {
        addCountIssue(
          ctx,
          ["frequency"],
          "available opening stats must be all null or include counts and frequency",
        );
      }
      return;
    }
    if (present.length !== counts.length) {
      addCountIssue(ctx, ["games"], "opening counts must be all null or all present");
      return;
    }
    if (frequency === null) {
      addCountIssue(
        ctx,
        ["frequency"],
        "available opening counts require frequency",
      );
    } else if (frequency === 0) {
      addCountIssue(
        ctx,
        ["frequency"],
        "available opening frequency must be positive",
      );
    }
    if (games === 0) {
      addCountIssue(ctx, ["games"], "available opening games must be positive");
    }
    const total = safeSum([white!, draws!, black!]);
    if (total === null || games !== total) {
      addCountIssue(ctx, ["games"], "games must equal white + draws + black");
    }
  })
  .describe(
    "Non-available stats must all be null. Available stats must be all null or include positive games and frequency plus white, draws, and black; games must equal white + draws + black.",
  ) as z.ZodType<OpeningStats>;

export const CandidateSchema = z.strictObject({
  uci,
  san: moveText,
  objective: z.strictObject({
    rank: safeCount.min(1).nullable(),
    moverCp: z.number().nullable(),
    whiteCp: z.number().nullable(),
    cpLoss: z.number().nullable(),
    moverMate: z.number().nullable(),
    whiteMate: z.number().nullable(),
    wdl: nullableWdl,
  }),
  human: z.strictObject({
    maia3Prob: probability.nullable(),
    selfElo: z.number(),
    opponentElo: z.number(),
  }),
  opening: OpeningStatsSchema,
}) satisfies z.ZodType<Candidate>;

export const OpeningSchema = z
  .strictObject({
    eco: moveText,
    name: moveText,
  })
  .nullable();

export const CreateGameOutputSchema = z.strictObject({
  game_id: GameIdSchema,
  revision: z.literal(0),
});

export const DeleteGameOutputSchema = z.strictObject({
  game_id: GameIdSchema,
  deleted: z.literal(true),
});

export const GameStateOutputSchema = z.strictObject({
  game_id: GameIdSchema,
  ...StateSchema.shape,
  board: z.string().optional(),
});

export const GamePlayMoveOutputSchema = z.strictObject({
  game_id: GameIdSchema,
  move: z.string(),
  ...StateSchema.shape,
});

const legalMove = z.strictObject({
  san: z.string(),
  uci: z.string(),
  from: z.string().regex(/^[a-h][1-8]$/),
  to: z.string().regex(/^[a-h][1-8]$/),
  piece: z.enum(PIECES),
  captured: z.enum(PIECES).nullable(),
  promotion: z.enum(PROMOTIONS).nullable(),
  isCapture: z.boolean(),
  isCheck: z.boolean(),
});

export const GameLegalMovesOutputSchema = z.strictObject({
  game_id: GameIdSchema,
  revision,
  count: z.number().int().min(0),
  moves: z.array(legalMove),
});

export const PositionAnalyzeOutputSchema = z.strictObject({
  game_id: GameIdSchema,
  fen: z.string(),
  turn: color,
  revision,
  analysis_level: z.enum(ANALYSIS_LEVELS),
  lines: analysisLines,
});

export const Maia3MoveSchema = z.strictObject({
  uci,
  san: moveText,
  prob: probability,
}) satisfies z.ZodType<Maia3Move>;

const humanMoves = z
  .array(Maia3MoveSchema)
  .max(MAX_HUMAN_MOVES)
  .superRefine((moves, ctx) => {
    const seen = new Set<string>();
    let probabilityMass = 0;
    for (const [index, move] of moves.entries()) {
      if (seen.has(move.uci)) {
        ctx.addIssue({
          code: "custom",
          message: "human move UCIs must be unique",
          path: [index, "uci"],
        });
      }
      seen.add(move.uci);
      probabilityMass += move.prob;
    }
    if (probabilityMass > 1 + HUMAN_PROBABILITY_TOLERANCE) {
      ctx.addIssue({
        code: "custom",
        message: "human move probability mass must not exceed 1",
        path: [],
      });
    }
  })
  .describe(
    `At most ${MAX_HUMAN_MOVES} moves with unique UCIs; probability mass must not exceed 1, allowing float32 rounding tolerance.`,
  );

export const HumanMoveDistributionOutputSchema = z.strictObject({
  game_id: GameIdSchema,
  elo: z.number(),
  oppo_elo: z.number(),
  revision,
  moves: humanMoves,
});

const moveEvaluation = z.strictObject({
  move: z.string(),
  uci: z.string(),
  result: z.enum(MOVE_EVALUATION_RESULTS),
  scoreCp: z.number().nullable(),
  scoreMate: z.number().nullable(),
  bestCp: z.number().nullable(),
  cpLoss: z.number().nullable(),
  classification: z
    .enum(MOVE_CLASSIFICATIONS)
    .nullable(),
  pv: z.array(z.string()),
  pvSan: z.array(z.string()),
}).superRefine(({ pv, pvSan }, ctx) => {
  if (pv.length !== pvSan.length) {
    ctx.addIssue({
      code: "custom",
      message: "pv and pvSan must have equal lengths",
      path: ["pvSan"],
    });
  }
}).describe("pv and pvSan contain the same continuation and must have equal lengths.");

export const MoveEvaluateOutputSchema = z.strictObject({
  game_id: GameIdSchema,
  revision,
  results: z.array(moveEvaluation).min(1).max(10),
});

export const MoveSensitivitySchema = z.strictObject({
  level: z.enum(["low", "medium", "high"]),
  topMoveSpreadCp: z.number().nullable(),
}) satisfies z.ZodType<MoveSensitivity>;

const candidatesBase = {
  game_id: GameIdSchema,
  revision,
  fen: z.string(),
  turn: color,
  elo: z.number(),
  analysis_level: z.enum(ANALYSIS_LEVELS),
  moveSensitivity: MoveSensitivitySchema,
  candidates: z.array(CandidateSchema),
};

export const MoveCandidatesOutputSchema = z.strictObject(candidatesBase);

export const MoveCandidatesByIntentOutputSchema = z.strictObject({
  ...candidatesBase,
  intent: z.enum(INTENTS),
});

export const LichessMoveSchema = z
  .strictObject({
    uci,
    san: moveText,
    white: safeCount,
    draws: safeCount,
    black: safeCount,
    count: safeCount.min(1),
    averageRating: safeCount.nullable(),
  })
  .superRefine(({ white, draws, black, count }, ctx) => {
    const total = safeSum([white, draws, black]);
    if (total === null || count !== total) {
      addCountIssue(ctx, ["count"], "count must equal white + draws + black");
    }
  })
  .describe(
    "count must equal white + draws + black",
  ) satisfies z.ZodType<LichessMove>;

export const OpeningExplorerOutputSchema = z
  .strictObject({
    game_id: GameIdSchema,
    revision,
    db: z.enum(["lichess", "masters"]),
    white: safeCount,
    draws: safeCount,
    black: safeCount,
    moves: z.array(LichessMoveSchema).max(EXPLORER_MAX_MOVES),
    opening: OpeningSchema,
  })
  .superRefine((result, ctx) => {
    if (safeSum([result.white, result.draws, result.black]) === null) {
      addCountIssue(ctx, ["white"], "total game count must be a safe integer");
    }
    for (const [field, total] of [
      ["white", result.white],
      ["draws", result.draws],
      ["black", result.black],
    ] as const) {
      const sum = safeSum(result.moves.map((move) => move[field]));
      if (sum === null || sum > total) {
        addCountIssue(
          ctx,
          ["moves"],
          `move ${field} counts must not exceed the top-level count`,
        );
      }
    }
  })
  .describe(
    "The top-level counts must sum to a safe integer; summed move white, draws, and black counts must not exceed their corresponding top-level counts",
  );

export const GamePgnOutputSchema = z.strictObject({
  game_id: GameIdSchema,
  revision,
  pgn: z.string(),
});

export const GameImportPgnOutputSchema = z.strictObject({
  game_id: GameIdSchema,
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
