import assert from "node:assert/strict";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { GameStore } from "../src/games.js";
import { buildServer } from "../src/server.js";
import type { AppServices } from "../src/services.js";
import { toolError } from "../src/tool-result.js";
import { MoveEvaluateOutputSchema } from "../src/tool-schemas.js";
import { registerAnalysisTools } from "../src/tools/analysis.js";

type Handler = (
  args: Record<string, unknown>,
  context: ServerContext,
) => Promise<unknown>;

function analysisServices(
  games: GameStore,
  humanMoveDistribution: AppServices["humanMoveDistribution"],
): AppServices {
  return {
    games,
    analyze: async () => [],
    quit: async () => undefined,
    humanMoveDistribution,
    explorerEnabled: () => false,
    openingExplorer: async () => {
      throw new Error("unused");
    },
    computeCandidates: async () => ({
      candidates: [],
      moveSensitivity: { level: "low", topMoveSpreadCp: null },
    }),
    rankByIntent: (candidates) => candidates,
  };
}

function captureHandlers(): {
  server: McpServer;
  handlers: Map<string, Handler>;
} {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool(name: string, _config: unknown, handler: Handler) {
      handlers.set(name, handler);
      return {};
    },
  } as unknown as McpServer;
  return { server, handlers };
}

test("move_evaluate rejects terminal games before engine analysis", async (t) => {
  const games = new GameStore({ createId: () => "terminal-game" });
  const gameId = games.createGame("7k/6Q1/7K/8/8/8/8/8 b - - 0 1");
  let analysisCalls = 0;
  const services: AppServices = {
    games,
    analyze: async () => {
      analysisCalls += 1;
      throw new Error("engine must not be called");
    },
    quit: async () => undefined,
    humanMoveDistribution: async () => [],
    explorerEnabled: () => false,
    openingExplorer: async () => {
      throw new Error("unused");
    },
    computeCandidates: async () => ({
      candidates: [],
      moveSensitivity: { level: "low", topMoveSpreadCp: null },
    }),
    rankByIntent: (candidates) => candidates,
  };
  const server = buildServer(services);
  const client = new Client({ name: "analysis-tests", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const response = await client.callTool({
    name: "move_evaluate",
    arguments: { game_id: gameId, move: "Kh7", depth: 5 },
  });

  assert.equal(response.isError, true);
  assert.deepEqual(response.structuredContent, {
    error: { code: "GAME_OVER", message: "game is already over" },
  });
  assert.equal(analysisCalls, 0);
});

test("move_evaluate classifies terminal draws from the mover's prior score", async (t) => {
  const games = new GameStore({ createId: () => "draw-game" });
  const gameId = games.createGame("k7/2Q5/2K5/8/8/8/8/8 w - - 0 1");
  let scoreCp: number | null = 500;
  let analysisCalls = 0;
  const services: AppServices = {
    games,
    analyze: async () => {
      analysisCalls += 1;
      return [
        {
          multipv: 1,
          scoreCp,
          scoreMate: null,
          wdl: null,
          pv: ["c7b7"],
        },
      ];
    },
    quit: async () => undefined,
    humanMoveDistribution: async () => [],
    explorerEnabled: () => false,
    openingExplorer: async () => {
      throw new Error("unused");
    },
    computeCandidates: async () => ({
      candidates: [],
      moveSensitivity: { level: "low", topMoveSpreadCp: null },
    }),
    rankByIntent: (candidates) => candidates,
  };
  const server = buildServer(services);
  const client = new Client({ name: "analysis-tests", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  for (const expected of [
    { beforeCp: 500, cpLoss: 500, classification: "blunder" },
    { beforeCp: -200, cpLoss: -200, classification: "best" },
    { beforeCp: null, cpLoss: null, classification: null },
  ] as const) {
    scoreCp = expected.beforeCp;
    const response = await client.callTool({
      name: "move_evaluate",
      arguments: { game_id: gameId, move: "Qb6", depth: 5 },
    });
    assert.notEqual(response.isError, true);
    const parsed = MoveEvaluateOutputSchema.parse(response.structuredContent);
    const result = parsed.results[0];
    assert.ok(result);
    assert.deepEqual(result, {
      move: "Qb6",
      uci: "c7b6",
      result: "stalemate",
      scoreCp: 0,
      scoreMate: null,
      bestCp: expected.beforeCp,
      cpLoss: expected.cpLoss,
      classification: expected.classification,
      pv: [],
      pvSan: [],
    });
  }

  assert.equal(analysisCalls, 3);
  assert.equal(games.getSnapshot(gameId).revision, 0);
});

test("human_move_distribution rejects invalid injected results directly", async () => {
  const games = new GameStore({ createId: () => "human-direct" });
  const gameId = games.createGame();
  let moves = [{ uci: "e2e4", san: "e4", prob: 0.5 }];
  const { server, handlers } = captureHandlers();
  registerAnalysisTools(
    server,
    analysisServices(games, async () => moves),
  );
  const handler = handlers.get("human_move_distribution");
  assert.ok(handler);
  const context = {
    mcpReq: { signal: new AbortController().signal },
  } as ServerContext;

  for (const invalid of [
    {
      topN: 1,
      moves: [
        { uci: "e2e4", san: "e4", prob: 0.5 },
        { uci: "d2d4", san: "d4", prob: 0.5 },
      ],
    },
    {
      topN: 2,
      moves: [
        { uci: "e2e4", san: "e4", prob: 0.4 },
        { uci: "e2e4", san: "e4", prob: 0.4 },
      ],
    },
    { topN: 1, moves: [{ uci: "a1a2", san: "Ra2", prob: 0.5 }] },
    { topN: 1, moves: [{ uci: "e2e4", san: "d4", prob: 0.5 }] },
    {
      topN: 2,
      moves: [
        { uci: "e2e4", san: "e4", prob: 0.6 },
        { uci: "d2d4", san: "d4", prob: 0.6 },
      ],
    },
  ]) {
    moves = invalid.moves;
    assert.deepEqual(
      await handler(
        { game_id: gameId, elo: 1500, top_n: invalid.topN },
        context,
      ),
      toolError("INTERNAL", "internal tool error"),
    );
  }
});

test("human_move_distribution masks invalid injected results on wire", async (t) => {
  const games = new GameStore({ createId: () => "human-wire" });
  const gameId = games.createGame();
  const server = buildServer(
    analysisServices(games, async () => [
      { uci: "a1a2", san: "Ra2", prob: 0.9 },
    ]),
  );
  const client = new Client({ name: "analysis-tests", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const response = await client.callTool({
    name: "human_move_distribution",
    arguments: { game_id: gameId, top_n: 1 },
  });
  assert.equal(response.isError, true);
  assert.deepEqual(response.structuredContent, {
    error: { code: "INTERNAL", message: "internal tool error" },
  });
});
