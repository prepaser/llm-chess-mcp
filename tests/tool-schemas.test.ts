import assert from "node:assert/strict";
import test from "node:test";
import * as z from "zod/v4";
import { MAX_EVALUATED_MOVES } from "../src/chess.js";
import { MAX_MULTIPV } from "../src/domain.js";
import { EXPLORER_MAX_MOVES, EXPLORER_MAX_STRING_LENGTH } from "../src/explorer-core.js";
import { GAME_ID_MAX_LENGTH, GameIdSchema } from "../src/tool-fields.js";
import {
  AnalysisLineSchema,
  CandidateSchema,
  HumanMoveDistributionOutputSchema,
  LichessMoveSchema,
  Maia3MoveSchema,
  MoveEvaluateOutputSchema,
  OpeningExplorerOutputSchema,
  OpeningStatsSchema,
  PositionAnalyzeOutputSchema,
  TOOL_OUTPUT_SCHEMAS,
} from "../src/tool-schemas.js";

type JsonSchema = {
  anyOf?: JsonSchema[];
  description?: string;
  items?: JsonSchema;
  maxItems?: number;
  minItems?: number;
  pattern?: string;
  properties?: Record<string, JsonSchema>;
};

const values = {
  games: null,
  frequency: null,
  white: null,
  draws: null,
  black: null,
  averageRating: null,
};

test("opening stats enforce status-specific failure reasons", () => {
  assert.equal(
    OpeningStatsSchema.safeParse({ status: "unavailable", ...values }).success,
    false,
  );
  assert.equal(
    OpeningStatsSchema.safeParse({
      status: "available",
      reason: "network",
      ...values,
    }).success,
    false,
  );
  assert.equal(
    OpeningStatsSchema.safeParse({
      status: "unavailable",
      reason: "network",
      ...values,
    }).success,
    true,
  );
  for (const status of ["available", "no_data", "disabled"] as const) {
    assert.equal(OpeningStatsSchema.safeParse({ status, ...values }).success, true);
  }

  for (const [status, extra] of [
    ["no_data", {}],
    ["disabled", {}],
    ["unavailable", { reason: "network" }],
  ] as const) {
    for (const field of Object.keys(values) as Array<keyof typeof values>) {
      assert.equal(
        OpeningStatsSchema.safeParse({
          status,
          ...extra,
          ...values,
          [field]: field === "frequency" ? 0.5 : 1,
        }).success,
        false,
        `${status}.${field}`,
      );
    }
  }

  assert.equal(
    OpeningStatsSchema.safeParse({
      status: "available",
      ...values,
      frequency: 0.5,
    }).success,
    false,
  );
  assert.equal(
    OpeningStatsSchema.safeParse({
      status: "available",
      ...values,
      averageRating: 1_800,
    }).success,
    false,
  );
  assert.equal(
    OpeningStatsSchema.safeParse({
      status: "available",
      ...values,
      games: 9,
      white: 4,
      draws: 3,
      black: 2,
    }).success,
    false,
  );
  assert.equal(
    OpeningStatsSchema.safeParse({
      status: "available",
      ...values,
      games: 0,
      frequency: 0,
      white: 0,
      draws: 0,
      black: 0,
    }).success,
    false,
  );
});

const lichessMove = {
  uci: "e2e4",
  san: "e4",
  white: 4,
  draws: 3,
  black: 2,
  count: 9,
  averageRating: 1_800,
};

const explorer = {
  game_id: "game",
  revision: 0,
  db: "lichess" as const,
  white: 10,
  draws: 8,
  black: 6,
  moves: [lichessMove],
  opening: { eco: "B00", name: "King's Pawn Game" },
};

const candidate = {
  uci: "e2e4",
  san: "e4",
  objective: {
    rank: 1,
    moverCp: 30,
    whiteCp: 30,
    cpLoss: 0,
    moverMate: null,
    whiteMate: null,
    wdl: [500, 300, 200] as [number, number, number],
  },
  human: { maia3Prob: 0.5, selfElo: 1_800, opponentElo: 1_800 },
  opening: {
    status: "available" as const,
    games: 9,
    frequency: 0.375,
    white: 4,
    draws: 3,
    black: 2,
    averageRating: 1_800,
  },
};

test("explorer output enforces bounded strings and consistent safe counts", () => {
  assert.equal(OpeningExplorerOutputSchema.safeParse(explorer).success, true);
  assert.equal(LichessMoveSchema.safeParse(lichessMove).success, true);

  for (const move of [
    { ...lichessMove, count: 8 },
    { ...lichessMove, white: 0, draws: 0, black: 0, count: 0 },
    { ...lichessMove, white: -1 },
    { ...lichessMove, draws: 0.5 },
    { ...lichessMove, averageRating: -1 },
    { ...lichessMove, averageRating: 1.5 },
    { ...lichessMove, averageRating: Number.MAX_SAFE_INTEGER + 1 },
    {
      ...lichessMove,
      white: Number.MAX_SAFE_INTEGER,
      draws: 1,
      black: 0,
      count: Number.MAX_SAFE_INTEGER,
    },
    { ...lichessMove, uci: "e2e9" },
    { ...lichessMove, uci: "e2e2" },
    { ...lichessMove, uci: "e2e4q" },
    { ...lichessMove, san: "" },
    { ...lichessMove, san: "x".repeat(EXPLORER_MAX_STRING_LENGTH + 1) },
  ]) {
    assert.equal(LichessMoveSchema.safeParse(move).success, false);
  }

  assert.equal(
    OpeningExplorerOutputSchema.safeParse({
      ...explorer,
      moves: [{ ...lichessMove, white: explorer.white + 1, count: 16 }],
    }).success,
    false,
  );
  assert.equal(
    OpeningExplorerOutputSchema.safeParse({
      ...explorer,
      moves: Array.from({ length: EXPLORER_MAX_MOVES + 1 }, () => lichessMove),
    }).success,
    false,
  );
  assert.equal(
    OpeningExplorerOutputSchema.safeParse({
      ...explorer,
      opening: { eco: "", name: "opening" },
    }).success,
    false,
  );
  assert.equal(
    OpeningExplorerOutputSchema.safeParse({
      ...explorer,
      white: Number.MAX_SAFE_INTEGER,
      draws: 1,
    }).success,
    false,
  );
});

test("candidate output enforces move, probability, evaluation, and opening bounds", () => {
  assert.equal(CandidateSchema.safeParse(candidate).success, true);
  assert.equal(
    OpeningStatsSchema.safeParse(candidate.opening).success,
    true,
  );

  for (const value of [
    { ...candidate, uci: "e2e4qz" },
    { ...candidate, san: "" },
    { ...candidate, human: { ...candidate.human, maia3Prob: 1.01 } },
    { ...candidate, objective: { ...candidate.objective, rank: 0 } },
    { ...candidate, objective: { ...candidate.objective, wdl: [500, 500] } },
    { ...candidate, objective: { ...candidate.objective, wdl: [500, 300, 199] } },
    {
      ...candidate,
      objective: { ...candidate.objective, wdl: [500, 300, 200, 0] },
    },
    { ...candidate, opening: { ...candidate.opening, frequency: 1.01 } },
    { ...candidate, opening: { ...candidate.opening, games: 8 } },
    { ...candidate, opening: { ...candidate.opening, black: null } },
  ]) {
    assert.equal(CandidateSchema.safeParse(value).success, false);
  }

  assert.equal(
    Maia3MoveSchema.safeParse({ uci: "g1f3", san: "Nf3", prob: 1 }).success,
    true,
  );
  assert.equal(
    Maia3MoveSchema.safeParse({ uci: "g1f3", san: "Nf3", prob: -0.01 }).success,
    false,
  );
});

test("human distribution bounds moves, UCIs, and probability mass", () => {
  const base = {
    game_id: "game",
    elo: 1_500,
    oppo_elo: 1_500,
    revision: 0,
  };
  const move = { uci: "e2e4", san: "e4", prob: 0.5 };
  assert.equal(
    HumanMoveDistributionOutputSchema.safeParse({ ...base, moves: [move] })
      .success,
    true,
  );
  assert.equal(
    HumanMoveDistributionOutputSchema.safeParse({
      ...base,
      moves: [move, move],
    }).success,
    false,
  );
  assert.equal(
    HumanMoveDistributionOutputSchema.safeParse({
      ...base,
      moves: [
        { ...move, prob: 0.6 },
        { uci: "d2d4", san: "d4", prob: 0.6 },
      ],
    }).success,
    false,
  );
  assert.equal(
    HumanMoveDistributionOutputSchema.safeParse({
      ...base,
      moves: Array.from({ length: 21 }, (_, index) => ({
        ...move,
        uci: index % 2 ? "e2e4" : "d2d4",
      })),
    }).success,
    false,
  );
});

test("analysis outputs require matching UCI and SAN PV lengths", () => {
  const line = {
    multipv: 1,
    scoreCp: 10,
    scoreMate: null,
    wdl: null,
    pv: ["e2e4"],
    pvSan: [],
  };
  assert.equal(AnalysisLineSchema.safeParse(line).success, false);
  assert.equal(
    AnalysisLineSchema.safeParse({
      ...line,
      scoreMate: 3,
      pvSan: ["e4"],
    }).success,
    false,
  );
  const validLine = { ...line, pvSan: ["e4"] };
  assert.equal(
    PositionAnalyzeOutputSchema.safeParse({
      game_id: "game",
      fen: "fen",
      turn: "w",
      revision: 0,
      analysis_level: "normal",
      lines: [validLine, validLine],
    }).success,
    false,
  );
  assert.equal(
    PositionAnalyzeOutputSchema.safeParse({
      game_id: "game",
      fen: "fen",
      turn: "w",
      revision: 0,
      analysis_level: "normal",
      lines: Array.from({ length: 11 }, (_, index) => ({
        ...validLine,
        multipv: index + 1,
      })),
    }).success,
    false,
  );
  assert.equal(
    MoveEvaluateOutputSchema.safeParse({
      game_id: "game",
      revision: 0,
      results: [
        {
          move: "e4",
          uci: "e2e4",
          result: "ongoing",
          scoreCp: 10,
          scoreMate: null,
          bestCp: 10,
          cpLoss: 0,
          classification: "best",
          pv: line.pv,
          pvSan: line.pvSan,
        },
      ],
    }).success,
    false,
  );
});

test("wire schemas expose UCI and cross-field constraints", () => {
  const candidateSchema = z.toJSONSchema(CandidateSchema) as JsonSchema;
  const explorerSchema = z.toJSONSchema(OpeningExplorerOutputSchema) as JsonSchema;
  const uciSchema = candidateSchema.properties?.uci;
  const objectiveSchema = candidateSchema.properties?.objective;
  const wdlSchema = objectiveSchema?.properties?.wdl;
  const wdlArraySchema = wdlSchema?.anyOf?.[0];
  const openingSchema = candidateSchema.properties?.opening;
  const moveSchema = explorerSchema.properties?.moves?.items;

  assert.ok(uciSchema?.pattern);
  const uciPattern = new RegExp(uciSchema.pattern);
  assert.equal(uciPattern.test("e2e2"), false);
  assert.equal(uciPattern.test("e7e8q"), true);
  assert.equal(uciPattern.test("e2e1n"), true);
  assert.equal(uciPattern.test("e2e4q"), false);
  assert.match(wdlSchema?.description ?? "", /sum to 1000/);
  assert.equal(wdlArraySchema?.minItems, 3);
  assert.equal(wdlArraySchema?.maxItems, 3);
  assert.match(openingSchema?.description ?? "", /Non-available stats must all be null/);
  assert.match(explorerSchema.description ?? "", /must not exceed/);
  assert.match(moveSchema?.description ?? "", /count must equal/);
});

test("every game-id output exposes the shared length bounds", () => {
  assert.equal(GameIdSchema.safeParse("g").success, true);
  assert.equal(GameIdSchema.safeParse("g".repeat(GAME_ID_MAX_LENGTH)).success, true);
  assert.equal(GameIdSchema.safeParse("😀".repeat(GAME_ID_MAX_LENGTH)).success, true);
  assert.equal(GameIdSchema.safeParse("").success, false);
  assert.equal(
    GameIdSchema.safeParse("g".repeat(GAME_ID_MAX_LENGTH + 1)).success,
    false,
  );
  assert.equal(
    GameIdSchema.safeParse("😀".repeat(GAME_ID_MAX_LENGTH + 1)).success,
    false,
  );

  for (const [name, schema] of Object.entries(TOOL_OUTPUT_SCHEMAS)) {
    const wire = z.toJSONSchema(schema) as {
      properties?: Record<string, { maxLength?: number; minLength?: number }>;
    };
    const gameId = wire.properties?.game_id;
    assert.ok(gameId, name);
    assert.equal(gameId.minLength, 1, name);
    assert.equal(gameId.maxLength, GAME_ID_MAX_LENGTH, name);
  }
});

test("analysis outputs expose the shared cardinality limits", () => {
  const position = z.toJSONSchema(PositionAnalyzeOutputSchema) as {
    properties?: { lines?: { maxItems?: number } };
  };
  const evaluation = z.toJSONSchema(MoveEvaluateOutputSchema) as {
    properties?: { results?: { maxItems?: number } };
  };
  assert.equal(position.properties?.lines?.maxItems, MAX_MULTIPV);
  assert.equal(
    evaluation.properties?.results?.maxItems,
    MAX_EVALUATED_MOVES,
  );
});
