import assert from "node:assert/strict";
import test from "node:test";
import * as z from "zod/v4";
import { EXPLORER_MAX_MOVES, EXPLORER_MAX_STRING_LENGTH } from "../src/explorer-core.js";
import {
  CandidateSchema,
  LichessMoveSchema,
  Maia3MoveSchema,
  OpeningExplorerOutputSchema,
  OpeningStatsSchema,
} from "../src/tool-schemas.js";

type JsonSchema = {
  description?: string;
  items?: JsonSchema;
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
    { ...candidate, objective: { ...candidate.objective, wdl: [500, 300, 199] } },
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

test("wire schemas expose UCI and cross-field constraints", () => {
  const candidateSchema = z.toJSONSchema(CandidateSchema) as JsonSchema;
  const explorerSchema = z.toJSONSchema(OpeningExplorerOutputSchema) as JsonSchema;
  const uciSchema = candidateSchema.properties?.uci;
  const objectiveSchema = candidateSchema.properties?.objective;
  const wdlSchema = objectiveSchema?.properties?.wdl;
  const openingSchema = candidateSchema.properties?.opening;
  const moveSchema = explorerSchema.properties?.moves?.items;

  assert.ok(uciSchema?.pattern);
  const uciPattern = new RegExp(uciSchema.pattern);
  assert.equal(uciPattern.test("e2e2"), false);
  assert.equal(uciPattern.test("e7e8q"), true);
  assert.equal(uciPattern.test("e2e1n"), true);
  assert.equal(uciPattern.test("e2e4q"), false);
  assert.match(wdlSchema?.description ?? "", /sum to 1000/);
  assert.match(openingSchema?.description ?? "", /all null or all present/);
  assert.match(explorerSchema.description ?? "", /must not exceed/);
  assert.match(moveSchema?.description ?? "", /count must equal/);
});
