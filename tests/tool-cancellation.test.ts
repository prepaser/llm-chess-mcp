import assert from "node:assert/strict";
import test from "node:test";
import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import { GameStore } from "../src/games.js";
import type { AppServices } from "../src/services.js";
import { registerAnalysisTools } from "../src/tools/analysis.js";
import { registerGameTools } from "../src/tools/game.js";

type Handler = (args: Record<string, unknown>, context: ServerContext) => Promise<unknown>;

function registry(): { server: McpServer; handlers: Map<string, Handler> } {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool(name: string, _config: unknown, handler: Handler) {
      handlers.set(name, handler);
      return {};
    },
  } as unknown as McpServer;
  return { server, handlers };
}

function context(signal: AbortSignal): ServerContext {
  return { mcpReq: { signal } } as ServerContext;
}

function services(games: GameStore, analyze: AppServices["analyze"]): AppServices {
  return {
    games,
    analyze,
    quit: async () => {},
    humanMoveDistribution: async () => [],
    explorerEnabled: () => false,
    openingExplorer: async (_chess, db) => ({
      db,
      white: 0,
      draws: 0,
      black: 0,
      moves: [],
      opening: null,
    }),
    computeCandidates: async () => ({
      candidates: [],
      moveSensitivity: { level: "low", topMoveSpreadCp: null },
    }),
    rankByIntent: (candidates) => candidates,
  };
}

test("analysis tools forward the MCP signal to AppServices", async () => {
  const games = new GameStore({ createId: () => "game" });
  const gameId = games.createGame();
  let received: AbortSignal | undefined;
  const { server, handlers } = registry();
  registerAnalysisTools(
    server,
    services(games, async (_fen, _depth, _multipv, signal) => {
      received = signal;
      return [];
    }),
  );
  const handler = handlers.get("position_analyze");
  assert.ok(handler);
  const controller = new AbortController();

  await handler(
    { game_id: gameId, analysis_level: "normal" },
    context(controller.signal),
  );

  assert.equal(received, controller.signal);
});

test("pre-aborted mutation does not create a game", async () => {
  const games = new GameStore();
  const { server, handlers } = registry();
  registerGameTools(server, services(games, async () => []));
  const handler = handlers.get("create_game");
  assert.ok(handler);
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));

  await assert.rejects(handler({}, context(controller.signal)), /cancelled/);
  assert.deepEqual(games.listGames(), []);
});
