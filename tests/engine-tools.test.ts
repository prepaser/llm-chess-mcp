import assert from "node:assert/strict";
import test from "node:test";
import type { ServerContext } from "@modelcontextprotocol/server";
import { GameStore } from "../src/games.js";
import type { EngineAnalysis } from "../src/engines/types.js";
import { registerAnalysisTools } from "../src/tools/analysis.js";
import { registerCandidateTools } from "../src/tools/candidates.js";
import { candidateSetFromEngineAnalysis } from "../src/engine-consensus.js";
import type { AppServices } from "../src/services.js";
import { MoveEvaluateOutputSchema, PositionAnalyzeOutputSchema } from "../src/tool-schemas.js";

function services(games: GameStore, analysis: AppServices["analyzeEngines"]): AppServices {
  return {
    games,
    analyze: async () => [],
    ...(analysis ? { analyzeEngines: analysis } : {}),
    humanMoveDistribution: async () => [],
    quit: async () => undefined,
    explorerEnabled: () => false,
    openingExplorer: async () => { throw new Error("unused"); },
    computeCandidates: async () => ({ candidates: [], moveSensitivity: { level: "low", topMoveSpreadCp: null } }),
    rankByIntent: (candidates) => candidates,
  };
}

function context(): ServerContext {
  return { mcpReq: { signal: new AbortController().signal } } as ServerContext;
}

function analysis(): EngineAnalysis {
  const line = (uci: string, scoreCp: number) => ({
    multipv: 1,
    scoreCp,
    scoreMate: null,
    wdl: [500, 300, 200] as [number, number, number],
    pv: [uci],
  });
  const ok = (id: "stockfish" | "lc0", scoreCp: number, uci = "e2e4") => ({
    status: "ok" as const,
    meta: { id, version: "test", weightsSha256: null, backend: "test" },
    result: [line(uci, scoreCp)],
    elapsedMs: 1,
    limits: { depth: id === "stockfish" ? 15 : null, movetimeMs: id === "lc0" ? 3000 : null, multipv: 1 },
  });
  return {
    mode: "both",
    partial: false,
    enginesUsed: ["stockfish", "lc0"],
    engines: { stockfish: ok("stockfish", 30), lc0: ok("lc0", 20) },
  };
}

test("position_analyze returns per-engine lines and consensus", async () => {
  const games = new GameStore({ createId: () => "engine-position" });
  const gameId = games.createGame();
  const handlers = new Map<string, (args: Record<string, unknown>, context: ServerContext) => Promise<unknown>>();
  const server = { registerTool(name: string, _config: unknown, handler: (args: Record<string, unknown>, context: ServerContext) => Promise<unknown>) { handlers.set(name, handler); } } as never;
  registerAnalysisTools(server, services(games, async () => analysis()));
  const response = await handlers.get("position_analyze")!({ game_id: gameId, engine_mode: "both", multipv: 1 }, context()) as { structuredContent: unknown };
  const output = PositionAnalyzeOutputSchema.parse(response.structuredContent);
  assert.equal(output.mode, "both");
  assert.equal(output.engines.stockfish.status, "ok");
  if (output.engines.stockfish.status === "ok") assert.deepEqual(output.engines.stockfish.result[0]?.pvSan, ["e4"]);
  assert.deepEqual(output.consensus[0]?.uci, "e2e4");
});

test("move_evaluate reports independent engine evaluations", async () => {
  const games = new GameStore({ createId: () => "engine-evaluate" });
  const gameId = games.createGame();
  let calls = 0;
  const handlers = new Map<string, (args: Record<string, unknown>, context: ServerContext) => Promise<unknown>>();
  const server = { registerTool(name: string, _config: unknown, handler: (args: Record<string, unknown>, context: ServerContext) => Promise<unknown>) { handlers.set(name, handler); } } as never;
  registerAnalysisTools(server, services(games, async () => {
    calls += 1;
    const value = analysis();
    if (calls > 1) {
      for (const id of ["stockfish", "lc0"] as const) {
        const outcome = value.engines[id];
        if (outcome.status === "ok") outcome.result[0]!.pv = ["e7e5"];
      }
    }
    return value;
  }));
  const response = await handlers.get("move_evaluate")!({ game_id: gameId, move: "e4", engine_mode: "both", depth: 15 }, context()) as { structuredContent: unknown };
  const output = MoveEvaluateOutputSchema.parse(response.structuredContent);
  assert.equal(output.results[0]?.result, "ongoing");
  assert.equal(output.results[0]?.classificationBasis, "engine_cp_heuristic");
  assert.equal(calls, 2);
});

test("candidate tools keep server-owned snapshot fields despite injected extra properties", async () => {
  const games = new GameStore({ createId: () => "candidate-snapshot" });
  const gameId = games.createGame();
  const snapshot = games.getSnapshot(gameId);
  const handlers = new Map<string, (args: Record<string, unknown>, context: ServerContext) => Promise<unknown>>();
  const server = { registerTool(name: string, _config: unknown, handler: (args: Record<string, unknown>, context: ServerContext) => Promise<unknown>) { handlers.set(name, handler); } } as never;
  const injected = services(games, undefined);
  injected.computeEngineCandidates = async (chess, elo, request) => ({
    ...candidateSetFromEngineAnalysis(chess, elo, analysis(), [],
      { status: "disabled", totalGames: null, moves: [] }, request.multipv),
    game_id: "wrong-game", revision: 999, fen: "wrong-fen", turn: "b",
    elo: 999, analysis_level: "fast",
  });
  registerCandidateTools(server, injected);
  for (const name of ["move_candidates", "move_candidates_by_intent"]) {
    const response = await handlers.get(name)!({
      game_id: gameId, engine_mode: "both", sf_multipv: 1,
      ...(name === "move_candidates_by_intent" ? { intent: "best" } : {}),
    }, context()) as { isError?: boolean; structuredContent: Record<string, unknown> };
    assert.notEqual(response.isError, true);
    const result = response.structuredContent;
    assert.equal(result.game_id, gameId);
    assert.equal(result.revision, snapshot.revision);
    assert.equal(result.fen, snapshot.chess.fen());
    assert.equal(result.turn, snapshot.chess.turn());
    assert.equal(result.elo, 1500);
    assert.equal(result.analysis_level, "normal");
    assert.equal((result.candidates as unknown[]).length, 1);
  }
});
