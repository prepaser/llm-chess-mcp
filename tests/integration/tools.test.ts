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
import { TOOL_NAMES } from "../../src/tool-names.js";
import type { ToolName } from "../../src/tool-names.js";
import { TOOL_OUTPUT_SCHEMAS } from "../../src/tool-schemas.js";
import type { Candidate, Intent } from "../../src/types.js";

type JsonObject = Record<string, unknown>;
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

  const explorerTool = listed.tools.find(
    ({ name }) => name === "opening_explorer",
  );
  const candidateTool = listed.tools.find(
    ({ name }) => name === "move_candidates",
  );
  assert.ok(explorerTool);
  assert.ok(candidateTool);
  const explorerInput = object(explorerTool.inputSchema);
  const explorerProperties = object(explorerInput.properties);
  assert.equal(object(explorerProperties.speeds).uniqueItems, true);
  assert.equal(object(explorerProperties.ratings).uniqueItems, true);
  assert.match(String(explorerInput.description), /masters/);
  assert.equal(array(explorerInput.allOf).length, 1);

  const candidateInput = object(candidateTool.inputSchema);
  const candidateInputProperties = object(candidateInput.properties);
  assert.equal(
    object(candidateInputProperties.lichess_speeds).uniqueItems,
    true,
  );
  assert.equal(
    object(candidateInputProperties.lichess_ratings).uniqueItems,
    true,
  );
  assert.match(String(candidateInput.description), /masters/);
  assert.equal(array(candidateInput.allOf).length, 1);

  const candidateOutput = object(candidateTool.outputSchema);
  const candidateOutputProperties = object(candidateOutput.properties);
  const candidateItems = object(
    object(candidateOutputProperties.candidates).items,
  );
  const candidateProperties = object(candidateItems.properties);
  const objectiveProperties = object(
    object(candidateProperties.objective).properties,
  );
  const wdlAlternatives = array(object(objectiveProperties.wdl).anyOf);
  assert.equal(object(wdlAlternatives[0]).minItems, 3);
  assert.equal(object(wdlAlternatives[0]).maxItems, 3);

  const created = await success(context.client, "create_game", {});
  assert.deepEqual(created, { game_id: "0:game-1", revision: 0 });
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
  assert.equal(context.games.getSnapshot(gameId).revision, 0);

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
    pgn: String(pgn.pgn).replace("e4", "e4 {king pawn}"),
  });
  assert.equal(imported.game_id, "1:game-2");
  assert.deepEqual(imported.history, ["e4"]);
  const roundTrip = await success(context.client, "game_pgn", {
    game_id: imported.game_id,
  });
  assert.match(String(roundTrip.pgn), /e4 \{king pawn\}/);
  const deleted = await success(context.client, "delete_game", {
    game_id: imported.game_id,
  });
  assert.deepEqual(deleted, { game_id: "1:game-2", deleted: true });

  assert.equal(context.calls.quit, 0);
});

test("game_legal_moves marks en passant as a capture", async (t) => {
  const context = await fixture();
  t.after(async () => {
    await context.client.close();
    await context.server.close();
  });

  const created = await success(context.client, "create_game", {});
  const gameId = String(created.game_id);
  for (const [revision, move] of ["e4", "a6", "e5", "d5"].entries()) {
    await success(context.client, "game_play_move", {
      game_id: gameId,
      move,
      expected_revision: revision,
    });
  }

  const legal = await success(context.client, "game_legal_moves", {
    game_id: gameId,
  });
  const enPassant = array(legal.moves)
    .map(object)
    .find((move) => move.uci === "e5d6");
  assert.deepEqual(enPassant, {
    san: "exd6",
    uci: "e5d6",
    from: "e5",
    to: "d6",
    piece: "p",
    captured: "p",
    promotion: null,
    isCapture: true,
    isCheck: false,
  });
});

test("game_legal_moves returns no executable moves after game over", async (t) => {
  const context = await fixture();
  t.after(async () => {
    await context.client.close();
    await context.server.close();
  });

  const created = await success(context.client, "create_game", {
    fen: "8/8/8/8/8/8/K7/7k w - - 0 1",
  });
  const legal = await success(context.client, "game_legal_moves", {
    game_id: created.game_id,
  });

  assert.equal(legal.count, 0);
  assert.deepEqual(legal.moves, []);
});

test("game_pgn exports a checkmate result that round-trips through import", async (t) => {
  const context = await fixture();
  t.after(async () => {
    await context.client.close();
    await context.server.close();
  });

  const created = await success(context.client, "create_game", {});
  const gameId = String(created.game_id);
  for (const [revision, move] of ["f3", "e5", "g4", "Qh4#"].entries()) {
    await success(context.client, "game_play_move", {
      game_id: gameId,
      move,
      expected_revision: revision,
    });
  }

  const exported = await success(context.client, "game_pgn", { game_id: gameId });
  assert.match(String(exported.pgn), /\[Result "0-1"\]/);
  assert.match(String(exported.pgn), /Qh4# 0-1/);

  const imported = await success(context.client, "game_import_pgn", {
    pgn: String(exported.pgn),
  });
  assert.equal(imported.isCheckmate, true);
  const roundTrip = await success(context.client, "game_pgn", {
    game_id: imported.game_id,
  });
  assert.match(String(roundTrip.pgn), /\[Result "0-1"\]/);
  assert.match(String(roundTrip.pgn), /Qh4# 0-1/);
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
  assert.equal(internal.message, "internal tool error");
  context.faults.analysis = false;

  context.services.analyze = async () => [
    {
      multipv: 1,
      scoreCp: Number.NaN,
      scoreMate: null,
      wdl: null,
      pv: [],
    },
  ];
  const invalidOutput = await errorEnvelope(
    context.client,
    "position_analyze",
    { game_id: gameId },
    "INTERNAL",
  );
  assert.equal(invalidOutput.message, "internal tool error");

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

test("create_game does not misclassify operational failures as invalid FEN", async (t) => {
  const context = await fixture();
  t.after(async () => {
    await context.client.close();
    await context.server.close();
  });
  context.services.games = new GameStore({ clock: () => Number.NaN });

  const error = await errorEnvelope(
    context.client,
    "create_game",
    {},
    "INTERNAL",
  );
  assert.equal(error.message, "internal tool error");
});

test("candidate tools reject moves from a mutated injected position", async (t) => {
  const context = await fixture();
  t.after(async () => {
    await context.client.close();
    await context.server.close();
  });
  const created = await success(context.client, "create_game", {});
  const gameId = String(created.game_id);
  const before = context.games.getSnapshot(gameId);

  context.services.computeCandidates = async (chess) => {
    chess.move("e4");
    await Promise.resolve();
    return {
      candidates: [candidate("e7e5", "e5", 1, 70, 1)],
      moveSensitivity: { level: "low", topMoveSpreadCp: null },
    };
  };

  await errorEnvelope(
    context.client,
    "move_candidates",
    { game_id: gameId },
    "INTERNAL",
  );
  assert.equal(context.games.getSnapshot(gameId).chess.fen(), before.chess.fen());
});

test("intent and explorer tools revalidate injected moves against the original position", async (t) => {
  const context = await fixture();
  t.after(async () => {
    await context.client.close();
    await context.server.close();
  });
  const created = await success(context.client, "create_game", {});
  const gameId = String(created.game_id);
  const before = context.games.getSnapshot(gameId).chess.fen();

  context.services.rankByIntent = (candidates) => [
    { ...candidates[0]!, uci: "e7e5", san: "e5" },
  ];
  await errorEnvelope(
    context.client,
    "move_candidates_by_intent",
    { game_id: gameId, intent: "natural" },
    "INTERNAL",
  );

  context.services.openingExplorer = async (chess, db) => {
    chess.move("e4");
    return {
      db,
      white: 1,
      draws: 0,
      black: 0,
      moves: [
        {
          uci: "e7e5",
          san: "e5",
          white: 1,
          draws: 0,
          black: 0,
          count: 1,
          averageRating: 1_500,
        },
      ],
      opening: null,
    };
  };
  await errorEnvelope(
    context.client,
    "opening_explorer",
    { game_id: gameId },
    "INTERNAL",
  );
  assert.equal(context.games.getSnapshot(gameId).chess.fen(), before);
});

test("candidate tools return no moves for terminal games", async (t) => {
  const context = await fixture();
  t.after(async () => {
    await context.client.close();
    await context.server.close();
  });
  const gameId = context.games.createGame("8/8/8/8/8/8/K7/7k w - - 0 1");

  const args = { game_id: gameId, analysis_level: "fast" as const };
  const candidates = await success(context.client, "move_candidates", args);
  assert.deepEqual(candidates.candidates, []);
  assert.deepEqual(candidates.moveSensitivity, {
    level: "low",
    topMoveSpreadCp: null,
  });

  const byIntent = await success(context.client, "move_candidates_by_intent", {
    ...args,
    intent: "natural",
  });
  assert.deepEqual(byIntent.candidates, []);
  assert.deepEqual(context.calls.candidates, []);
  assert.deepEqual(context.calls.intents, []);
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
    assert.equal(context.games.getSnapshot(id).revision, 0);
  }
});
