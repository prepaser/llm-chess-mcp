import assert from "node:assert/strict";
import test from "node:test";
import { Chess } from "chess.js";
import { analyzeWithEngines, validateEngineAnalysis } from "../src/engine-services.js";
import type { EngineAnalysis, EngineRequest } from "../src/engines/types.js";

const request: EngineRequest = { mode: "both", depth: 1, multipv: 1, movetimeMs: 100 };
const line = { multipv: 1, scoreCp: 5, scoreMate: null, wdl: null, pv: ["e2e4"] };

test("legacy injected analysis is explicitly Stockfish-only", async () => {
  let calls = 0;
  const services = { async analyze() { calls++; return [line]; } };
  const result = await analyzeWithEngines(services, new Chess(), request);
  assert.equal(result.partial, true);
  assert.deepEqual(result.enginesUsed, ["stockfish"]);
  assert.equal(result.engines.lc0.status, "error");
  await assert.rejects(analyzeWithEngines(services, new Chess(), { ...request, mode: "lc0" }), /do not provide Lc0/);
  assert.equal(calls, 1);
});

test("analysis adapter snapshots request and rejects inconsistent engine envelopes", async () => {
  const mutable = { ...request };
  const result = await analyzeWithEngines({ async analyze() { mutable.depth = 30; return [line]; } }, new Chess(), mutable);
  assert.equal(result.engines.stockfish.status, "ok");
  if (result.engines.stockfish.status === "ok") assert.equal(result.engines.stockfish.limits.depth, 1);
  for (const alter of [
    (value: EngineAnalysis) => { value.partial = false; },
    (value: EngineAnalysis) => { value.enginesUsed = ["lc0"]; },
    (value: EngineAnalysis) => { value.engines.stockfish = { status: "not_requested" }; },
    (value: EngineAnalysis) => {
      if (value.engines.stockfish.status === "ok") value.engines.stockfish.meta.id = "lc0";
    },
  ]) {
    const invalid = structuredClone(result);
    alter(invalid);
    assert.throws(() => validateEngineAnalysis(invalid, request), /engine analysis/);
  }
});

test("analysis cancellation is not returned as partial success", async () => {
  const controller = new AbortController();
  await assert.rejects(analyzeWithEngines({ async analyze() { controller.abort(new Error("cancelled")); return [line]; } }, new Chess(), request, controller.signal), /cancelled/);
});
