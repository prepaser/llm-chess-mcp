import assert from "node:assert/strict";
import test from "node:test";
import { Chess } from "chess.js";
import type { Candidate } from "../src/types.js";
import { ChessError } from "../src/errors.js";
import {
  buildServer,
  drawResult,
  MAX_EVALUATED_MOVES,
  MAX_PGN_BYTES,
  MAX_PGN_PLIES,
  parseImportedPgn,
  snapshotChess,
} from "../src/index.js";
import { rankByIntent } from "../src/intents.js";

function candidate(uci: string, moverCp: number, maia3Prob: number): Candidate {
  return {
    uci,
    san: uci,
    objective: {
      rank: 1,
      moverCp,
      whiteCp: moverCp,
      cpLoss: 0,
      moverMate: null,
      whiteMate: null,
      wdl: [500, 400, 100],
    },
    human: { maia3Prob, selfElo: 1500, opponentElo: 1500 },
    opening: {
      status: "disabled",
      games: null,
      frequency: null,
      white: null,
      draws: null,
      black: null,
      averageRating: null,
    },
  };
}

test("position snapshots preserve move and repetition history", () => {
  const chess = new Chess();
  for (const move of ["Nf3", "Nf6", "Ng1", "Ng8", "Nf3", "Nf6", "Ng1", "Ng8"]) {
    chess.move(move);
  }

  const snapshot = snapshotChess(chess);
  chess.move("e4");

  assert.equal(snapshot.isThreefoldRepetition(), true);
  assert.equal(snapshot.history().length, 8);
  assert.notEqual(snapshot.fen(), chess.fen());
});

test("all chess.js terminal draw reasons are reported", () => {
  const stalemate = new Chess("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1");
  const insufficient = new Chess("8/8/8/8/8/8/K7/7k w - - 0 1");
  const fiftyMoves = new Chess("8/8/8/8/8/6k1/8/R5K1 w - - 100 1");
  const repetition = new Chess();
  for (const move of ["Nf3", "Nf6", "Ng1", "Ng8", "Nf3", "Nf6", "Ng1", "Ng8"]) {
    repetition.move(move);
  }

  assert.equal(drawResult(stalemate), "stalemate");
  assert.equal(drawResult(insufficient), "insufficient_material");
  assert.equal(drawResult(fiftyMoves), "fifty_move_rule");
  assert.equal(drawResult(repetition), "threefold_repetition");
  assert.equal(drawResult(new Chess()), null);
});

test("PGN import enforces UTF-8 byte and ply caps", () => {
  assert.throws(
    () => parseImportedPgn("é".repeat(MAX_PGN_BYTES / 2 + 1)),
    (error) => error instanceof ChessError && error.code === "PGN_TOO_LARGE",
  );

  const cycles = Math.floor(MAX_PGN_PLIES / 4) + 1;
  const pgn = Array.from(
    { length: cycles },
    (_, i) => `${i + 1}. Nf3 Nf6 ${i + 1}... Ng1 Ng8`,
  ).join(" ");
  assert.throws(
    () => parseImportedPgn(pgn),
    (error) => error instanceof ChessError && error.code === "PGN_TOO_MANY_MOVES",
  );
});

test("move arrays are bounded and tool failures are marked as errors", async () => {
  type Tool = {
    inputSchema: { safeParse(value: unknown): { success: boolean } };
    outputSchema: { safeParse(value: unknown): { success: boolean } };
    handler(args: unknown): Promise<{
      content: Array<{ type: string; text: string }>;
      structuredContent: Record<string, unknown>;
      isError?: boolean;
    }>;
  };
  const server = buildServer() as unknown as {
    _registeredTools: Record<string, Tool>;
  };
  const tools = server._registeredTools;
  const moveEvaluate = tools.move_evaluate;
  const gameState = tools.game_state;
  assert.ok(moveEvaluate);
  assert.ok(gameState);
  const tooMany = Array.from({ length: MAX_EVALUATED_MOVES + 1 }, () => "e4");

  assert.equal(
    moveEvaluate.inputSchema.safeParse({
      game_id: "game",
      move: tooMany,
    }).success,
    false,
  );
  const failure = await gameState.handler({ game_id: "missing" });
  assert.equal(failure.isError, true);
  assert.deepEqual(failure.structuredContent, {
    error: {
      code: "GAME_NOT_FOUND",
      message: "game not found: missing",
    },
  });
  assert.equal(failure.content[0]?.text.startsWith("GAME_NOT_FOUND:"), true);
});

test("all tools advertise output schemas and Lichess filters are strict", () => {
  type Tool = {
    inputSchema: { safeParse(value: unknown): { success: boolean } };
    outputSchema?: unknown;
  };
  const server = buildServer() as unknown as {
    _registeredTools: Record<string, Tool>;
  };
  const tools = server._registeredTools;
  const openingExplorer = tools.opening_explorer;
  const moveCandidates = tools.move_candidates;
  assert.ok(openingExplorer);
  assert.ok(moveCandidates);

  assert.equal(Object.keys(tools).length, 13);
  assert.equal(Object.values(tools).every((tool) => tool.outputSchema), true);
  assert.equal(
    openingExplorer.inputSchema.safeParse({
      game_id: "game",
      db: "lichess",
      speeds: ["ultraBullet", "rapid"],
      ratings: [0, 2500],
    }).success,
    true,
  );
  assert.equal(
    openingExplorer.inputSchema.safeParse({
      game_id: "game",
      db: "masters",
      speeds: ["rapid"],
    }).success,
    false,
  );
  assert.equal(
    moveCandidates.inputSchema.safeParse({
      game_id: "game",
      lichess_speeds: ["blitz", "blitz"],
    }).success,
    false,
  );
});

test("constrained intents return no candidates when none satisfy the intent", () => {
  const candidates = [candidate("a2a3", 100, 0.8), candidate("h2h3", 90, 0.2)];

  assert.deepEqual(rankByIntent(candidates, "ease_off"), []);
  assert.deepEqual(rankByIntent(candidates, "give_chance"), []);
});
