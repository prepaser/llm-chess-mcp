import assert from "node:assert/strict";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Chess } from "chess.js";
import { ExplorerError } from "../../src/explorer.js";
import type { ExplorerResult } from "../../src/explorer.js";
import { GameStore } from "../../src/games.js";
import type { LichessOpts } from "../../src/intents.js";
import { buildServer } from "../../src/server.js";
import type { AppServices } from "../../src/services.js";
import { TOOL_META } from "../../src/tool-meta.js";
import { TOOL_OUTPUT_SCHEMAS } from "../../src/tool-schemas.js";
import type { Candidate, Intent } from "../../src/types.js";

const TOOL_NAMES = [
  "create_game",
  "delete_game",
  "game_import_pgn",
  "game_legal_moves",
  "game_pgn",
  "game_play_move",
  "game_state",
  "human_move_distribution",
  "move_candidates",
  "move_candidates_by_intent",
  "move_evaluate",
  "opening_explorer",
  "position_analyze",
] as const;

type JsonObject = Record<string, unknown>;
type ToolName = (typeof TOOL_NAMES)[number];
type ToolCallResult = Awaited<ReturnType<Client["callTool"]>>;

interface AnalysisCall {
  fen: string;
  depth: number;
  multipv: number;
}

interface CandidateCall {
  fen: string;
  elo: number;
  depth: number;
  multipv: number;
  maiaTopN: number;
  lichess: LichessOpts | null | undefined;
}

interface ExplorerCall {
  fen: string;
  db: "lichess" | "masters";
  speeds: string[];
  ratings: number[];
}

interface FakeCalls {
  analysis: AnalysisCall[];
  candidates: CandidateCall[];
  explorer: ExplorerCall[];
  human: Array<{
    fen: string;
    elo: number;
    opponentElo: number;
    topN: number;
  }>;
  intents: Intent[];
  quit: number;
}

interface FakeFaults {
  analysis: boolean;
  explorer: "none" | "rate_limited";
  explorerEnabled: boolean;
}

function object(value: unknown): JsonObject {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as JsonObject;
}

function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value as unknown[];
}

function isToolName(value: string): value is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(value);
}

function text(result: ToolCallResult): string {
  assert.equal(result.content.length, 1);
  const block = result.content[0];
  assert.ok(block);
  assert.equal(block.type, "text");
  if (block.type !== "text") assert.fail("expected text content");
  assert.ok(block.text.length > 0);
  return block.text;
}

async function success(
  client: Client,
  name: ToolName,
  args: JsonObject,
): Promise<JsonObject> {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, text(result));
  const parsed = TOOL_OUTPUT_SCHEMAS[name].safeParse(result.structuredContent);
  if (!parsed.success) {
    assert.fail(`${name} output failed its schema: ${parsed.error.message}`);
  }
  return object(parsed.data);
}

async function errorEnvelope(
  client: Client,
  name: ToolName,
  args: JsonObject,
  code: string,
): Promise<JsonObject> {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, true);
  assert.match(text(result), new RegExp(`^${code}: `));
  const envelope = object(result.structuredContent);
  assert.deepEqual(Object.keys(envelope), ["error"]);
  const error = object(envelope.error);
  assert.equal(error.code, code);
  assert.equal(typeof error.message, "string");
  return error;
}

function candidate(
  uci: string,
  san: string,
  rank: number,
  moverCp: number,
  probability: number,
): Candidate {
  return {
    uci,
    san,
    objective: {
      rank,
      moverCp,
      whiteCp: moverCp,
      cpLoss: rank === 1 ? 0 : 35,
      moverMate: null,
      whiteMate: null,
      wdl: rank === 1 ? [520, 330, 150] : [470, 350, 180],
    },
    human: {
      maia3Prob: probability,
      selfElo: 1800,
      opponentElo: 1800,
    },
    opening: {
      status: "available",
      games: rank === 1 ? 700 : 300,
      frequency: rank === 1 ? 0.7 : 0.3,
      white: rank === 1 ? 350 : 140,
      draws: rank === 1 ? 220 : 100,
      black: rank === 1 ? 130 : 60,
      averageRating: 1810,
    },
  };
}

function fakeServices(): {
  services: AppServices;
  games: GameStore;
  calls: FakeCalls;
  faults: FakeFaults;
} {
  let nextId = 0;
  const games = new GameStore({ createId: () => `game-${(nextId += 1)}` });
  const calls: FakeCalls = {
    analysis: [],
    candidates: [],
    explorer: [],
    human: [],
    intents: [],
    quit: 0,
  };
  const faults: FakeFaults = {
    analysis: false,
    explorer: "none",
    explorerEnabled: true,
  };
  const candidates = [
    candidate("e2e4", "e4", 1, 70, 0.58),
    candidate("d2d4", "d4", 2, 35, 0.42),
  ];
  const explorerResult: ExplorerResult = {
    db: "lichess",
    white: 490,
    draws: 320,
    black: 190,
    moves: [
      {
        uci: "e2e4",
        san: "e4",
        white: 350,
        draws: 220,
        black: 130,
        count: 700,
        averageRating: 1810,
      },
    ],
    opening: { eco: "B00", name: "King's Pawn Game" },
  };

  const services: AppServices = {
    games,
    analyze: async (fen, depth, multipv) => {
      calls.analysis.push({ fen, depth, multipv });
      if (faults.analysis) throw new Error("fake analysis failure");
      const legal = new Chess(fen).moves({ verbose: true });
      return Array.from({ length: multipv }, (_, index) => ({
        multipv: index + 1,
        scoreCp: 70 - index * 35,
        scoreMate: null,
        wdl: [520 - index * 50, 330, 150 + index * 50],
        pv: legal[index] ? [legal[index].lan] : [],
      }));
    },
    quit: async () => {
      calls.quit += 1;
    },
    humanMoveDistribution: async (chess, elo, opponentElo, topN) => {
      calls.human.push({ fen: chess.fen(), elo, opponentElo, topN });
      return [
        { uci: "e2e4", san: "e4", prob: 0.58 },
        { uci: "d2d4", san: "d4", prob: 0.42 },
      ].slice(0, topN);
    },
    explorerEnabled: () => faults.explorerEnabled,
    openingExplorer: async (chess, db, speeds, ratings) => {
      calls.explorer.push({
        fen: chess.fen(),
        db,
        speeds: [...speeds],
        ratings: [...ratings],
      });
      if (faults.explorer === "rate_limited") {
        throw new ExplorerError("rate_limited", "fake explorer limit", 429);
      }
      return { ...explorerResult, db };
    },
    computeCandidates: async (
      chess,
      elo,
      depth,
      multipv,
      maiaTopN,
      lichess,
    ) => {
      calls.candidates.push({
        fen: chess.fen(),
        elo,
        depth,
        multipv,
        maiaTopN,
        lichess,
      });
      return {
        candidates,
        moveSensitivity: { level: "medium", topMoveSpreadCp: 95 },
      };
    },
    rankByIntent: (values, intent) => {
      calls.intents.push(intent);
      return [...values].reverse();
    },
  };
  return { services, games, calls, faults };
}

async function fixture() {
  const fake = fakeServices();
  const server = buildServer(fake.services);
  const client = new Client({ name: "in-memory-tests", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { ...fake, server, client };
}

test("all tools expose contracts and execute with isolated fake services", async (t) => {
  const context = await fixture();
  t.after(async () => {
    await context.client.close();
    await context.server.close();
  });

  const listed = await context.client.listTools();
  assert.equal(listed.tools.length, TOOL_NAMES.length);
  assert.deepEqual(
    listed.tools.map(({ name }) => name).sort(),
    [...TOOL_NAMES].sort(),
  );
  for (const tool of listed.tools) {
    assert.ok(isToolName(tool.name));
    if (!isToolName(tool.name)) assert.fail(`unexpected tool: ${tool.name}`);
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.outputSchema?.type, "object");
    assert.deepEqual(tool.annotations, TOOL_META[tool.name].annotations);
  }

  const created = await success(context.client, "create_game", {});
  assert.deepEqual(created, { game_id: "game-1", revision: 0 });
  const gameId = String(created.game_id);

  const state = await success(context.client, "game_state", {
    game_id: gameId,
    include_ascii: true,
  });
  assert.equal(state.turn, "w");
  assert.equal(state.revision, 0);
  assert.equal(typeof state.board, "string");

  const legal = await success(context.client, "game_legal_moves", {
    game_id: gameId,
  });
  assert.equal(legal.count, 20);
  assert.equal(
    array(legal.moves).some((move) => object(move).uci === "e2e4"),
    true,
  );

  const analyzed = await success(context.client, "position_analyze", {
    game_id: gameId,
    analysis_level: "fast",
    depth: 9,
    multipv: 2,
  });
  assert.equal(analyzed.analysis_level, "fast");
  assert.equal(array(analyzed.lines).length, 2);
  assert.deepEqual(
    array(analyzed.lines).map((line) => object(line).pvSan),
    [["a3"], ["a4"]],
  );
  assert.equal(context.calls.analysis[0]?.depth, 9);

  const human = await success(context.client, "human_move_distribution", {
    game_id: gameId,
    elo: 1700,
    oppo_elo: 1900,
    top_n: 2,
  });
  assert.equal(human.oppo_elo, 1900);
  assert.equal(array(human.moves).length, 2);
  assert.deepEqual(context.calls.human[0], {
    fen: state.fen,
    elo: 1700,
    opponentElo: 1900,
    topN: 2,
  });

  const evaluated = await success(context.client, "move_evaluate", {
    game_id: gameId,
    move: "e4",
    depth: 7,
  });
  const evaluation = object(array(evaluated.results)[0]);
  assert.equal(evaluation.move, "e4");
  assert.equal(evaluation.result, "ongoing");
  assert.equal(evaluation.classification, "inaccuracy");
  assert.deepEqual(evaluation.pvSan, ["Nc6"]);
  assert.equal(context.games.getGame(gameId).revision, 0);

  const candidateArgs = {
    game_id: gameId,
    elo: 1800,
    analysis_level: "fast",
    sf_depth: 10,
    sf_multipv: 2,
    maia_top_n: 2,
    lichess_db: "lichess",
    lichess_speeds: ["rapid"],
    lichess_ratings: [1800],
  };
  const candidates = await success(
    context.client,
    "move_candidates",
    candidateArgs,
  );
  assert.deepEqual(candidates.moveSensitivity, {
    level: "medium",
    topMoveSpreadCp: 95,
  });
  assert.equal(object(array(candidates.candidates)[0]).uci, "e2e4");
  assert.deepEqual(context.calls.candidates[0]?.lichess, {
    db: "lichess",
    speeds: ["rapid"],
    ratings: [1800],
  });

  const byIntent = await success(context.client, "move_candidates_by_intent", {
    ...candidateArgs,
    intent: "natural",
  });
  assert.equal(byIntent.intent, "natural");
  assert.equal(object(array(byIntent.candidates)[0]).uci, "d2d4");
  assert.deepEqual(context.calls.intents, ["natural"]);

  const explorer = await success(context.client, "opening_explorer", {
    game_id: gameId,
    db: "lichess",
    speeds: ["rapid"],
    ratings: [1800],
  });
  assert.equal(explorer.white, 490);
  assert.deepEqual(explorer.opening, {
    eco: "B00",
    name: "King's Pawn Game",
  });
  assert.equal(object(array(explorer.moves)[0]).count, 700);
  assert.deepEqual(context.calls.explorer[0], {
    fen: state.fen,
    db: "lichess",
    speeds: ["rapid"],
    ratings: [1800],
  });

  const played = await success(context.client, "game_play_move", {
    game_id: gameId,
    move: "e2e4",
    expected_revision: 0,
  });
  assert.equal(played.move, "e4");
  assert.equal(played.revision, 1);
  await errorEnvelope(
    context.client,
    "game_play_move",
    { game_id: gameId, move: "e5", expected_revision: 0 },
    "STALE_POSITION",
  );

  const pgn = await success(context.client, "game_pgn", { game_id: gameId });
  assert.match(String(pgn.pgn), /\be4\b/);
  const imported = await success(context.client, "game_import_pgn", {
    pgn: pgn.pgn,
  });
  assert.equal(imported.game_id, "game-2");
  assert.deepEqual(imported.history, ["e4"]);
  const deleted = await success(context.client, "delete_game", {
    game_id: imported.game_id,
  });
  assert.deepEqual(deleted, { game_id: "game-2", deleted: true });

  assert.equal(context.calls.quit, 0);
});

test("handler failures retain structured error envelopes", async (t) => {
  const context = await fixture();
  t.after(async () => {
    await context.client.close();
    await context.server.close();
  });
  const created = await success(context.client, "create_game", {});
  const gameId = String(created.game_id);

  await errorEnvelope(
    context.client,
    "game_state",
    { game_id: "missing" },
    "GAME_NOT_FOUND",
  );
  await errorEnvelope(
    context.client,
    "create_game",
    { fen: "not a fen" },
    "INVALID_FEN",
  );

  context.faults.analysis = true;
  const internal = await errorEnvelope(
    context.client,
    "position_analyze",
    { game_id: gameId },
    "INTERNAL",
  );
  assert.equal(internal.message, "fake analysis failure");
  context.faults.analysis = false;

  context.faults.explorer = "rate_limited";
  await errorEnvelope(
    context.client,
    "opening_explorer",
    { game_id: gameId },
    "LICHESS_RATE_LIMITED",
  );
  context.faults.explorerEnabled = false;
  await errorEnvelope(
    context.client,
    "opening_explorer",
    { game_id: gameId },
    "LICHESS_DISABLED",
  );

  const invalidInput = await context.client.callTool({
    name: "opening_explorer",
    arguments: { game_id: gameId, db: "masters", speeds: ["rapid"] },
  });
  assert.equal(invalidInput.isError, true);
  assert.equal(invalidInput.structuredContent, undefined);
  assert.match(text(invalidInput), /^Input validation error:/);
});

test("move evaluation reports terminal draw reasons without analyzing successors", async (t) => {
  const context = await fixture();
  t.after(async () => {
    await context.client.close();
    await context.server.close();
  });
  const queenId = context.games.createGame(
    "k7/2Q5/2K5/8/8/8/8/8 w - - 0 1",
  );
  const insufficientId = context.games.createGame(
    "8/8/8/8/8/8/Kr6/7k w - - 0 1",
  );
  const fiftyId = context.games.createGame(
    "8/8/8/8/8/6k1/8/R5K1 w - - 99 1",
  );
  const repetition = new Chess();
  for (const move of ["Nf3", "Nf6", "Ng1", "Ng8", "Nf3", "Nf6", "Ng1"]) {
    repetition.move(move);
  }
  const repetitionId = context.games.createGameFromChess(repetition);
  const initialAnalysisCalls = context.calls.analysis.length;

  const queen = await success(context.client, "move_evaluate", {
    game_id: queenId,
    move: ["Qb6", "Qb7#"],
    depth: 5,
  });
  assert.deepEqual(
    array(queen.results).map((result) => object(result).result),
    ["stalemate", "checkmate"],
  );

  const insufficient = await success(context.client, "move_evaluate", {
    game_id: insufficientId,
    move: "Kxb2",
    depth: 5,
  });
  assert.equal(
    object(array(insufficient.results)[0]).result,
    "insufficient_material",
  );

  const fifty = await success(context.client, "move_evaluate", {
    game_id: fiftyId,
    move: "Ra2",
    depth: 5,
  });
  assert.equal(
    object(array(fifty.results)[0]).result,
    "fifty_move_rule",
  );

  const threefold = await success(context.client, "move_evaluate", {
    game_id: repetitionId,
    move: "Ng8",
    depth: 5,
  });
  assert.equal(
    object(array(threefold.results)[0]).result,
    "threefold_repetition",
  );

  assert.equal(context.calls.analysis.length - initialAnalysisCalls, 4);
  for (const id of [queenId, insufficientId, fiftyId, repetitionId]) {
    assert.equal(context.games.getGame(id).revision, 0);
  }
});
