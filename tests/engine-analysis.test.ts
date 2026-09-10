import assert from "node:assert/strict";
import test from "node:test";
import { Chess } from "chess.js";
import { createEngineAnalyzer, resolveEngineMode, type EngineAdapter } from "../src/engines/analysis.js";
import type { EngineId, EngineLine } from "../src/engines/types.js";

const line = (scoreCp: number): EngineLine => ({ multipv: 1, scoreCp, scoreMate: null, wdl: [500, 400, 100], pv: ["b7b5"] });

function adapter(id: EngineId, result: EngineLine[] | Error): EngineAdapter {
  return {
    id,
    analyze: async (position) => {
      assert.equal(position.fen, "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1");
      assert.deepEqual(position.moves, ["e2e4"]);
      if (result instanceof Error) throw result;
      return result;
    },
    metadata: () => ({ id, version: "test", weightsSha256: null, backend: "test" }),
    quit: async () => {},
  };
}

function position(): Chess {
  const chess = new Chess();
  chess.move("e4");
  return chess;
}

test("resolveEngineMode validates explicit values", () => {
  assert.equal(resolveEngineMode("both"), "both");
  assert.equal(resolveEngineMode("stockfish"), "stockfish");
  assert.throws(() => resolveEngineMode("invalid"), /must be one of/);
});

test("engine analysis runs both adapters concurrently and reports metadata", async () => {
  const analyzer = createEngineAnalyzer({ stockfish: adapter("stockfish", [line(10)]), lc0: adapter("lc0", [line(20)]) });
  const result = await analyzer.analyzeEngines(position(), { mode: "both", depth: 10, multipv: 1, movetimeMs: 100 });
  assert.equal(result.mode, "both");
  assert.equal(result.partial, false);
  assert.deepEqual(result.enginesUsed, ["stockfish", "lc0"]);
  assert.equal(result.engines.stockfish.status, "ok");
  assert.equal(result.engines.lc0.status, "ok");
  await analyzer.quitEngines();
});

test("single engine failure is returned as a partial result", async () => {
  const analyzer = createEngineAnalyzer({ stockfish: adapter("stockfish", [line(10)]), lc0: adapter("lc0", new Error("offline")) });
  const result = await analyzer.analyzeEngines(position(), { mode: "both", depth: 10, multipv: 1, movetimeMs: 100 });
  assert.equal(result.partial, true);
  assert.deepEqual(result.enginesUsed, ["stockfish"]);
  assert.equal(result.engines.lc0.status, "error");
  await analyzer.quitEngines();
});

test("single-engine mode does not invoke the other adapter", async () => {
  let lc0Called = false;
  const lc0Adapter = adapter("lc0", [line(20)]);
  const analyzer = createEngineAnalyzer({
    stockfish: adapter("stockfish", [line(10)]),
    lc0: { ...lc0Adapter, analyze: async () => { lc0Called = true; return [line(20)]; } },
  });
  const result = await analyzer.analyzeEngines(position(), { mode: "stockfish", depth: 10, multipv: 1, movetimeMs: 100 });
  assert.equal(lc0Called, false);
  assert.deepEqual(result.engines.lc0, { status: "not_requested" });
  await analyzer.quitEngines();
});
