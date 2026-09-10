import assert from "node:assert/strict";
import test from "node:test";
import { Chess } from "chess.js";
import { analyzeWithEngines, computeWithEngines, validateEngineAnalysis } from "../src/engine-services.js";
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
    assert.throws(() => validateEngineAnalysis(invalid, request, new Chess()), /engine analysis/);
  }
});

test("analysis cancellation is not returned as partial success", async () => {
  const controller = new AbortController();
  await assert.rejects(analyzeWithEngines({ async analyze() { controller.abort(new Error("cancelled")); return [line]; } }, new Chess(), request, controller.signal), /cancelled/);
});

test("injected analysis and candidates reject unusable ongoing PVs", async () => {
  const multi = { ...request, multipv: 2 };
  const valid = await analyzeWithEngines({ analyze: async () => [line] }, new Chess(), multi);
  for (const lines of [
    [],
    [{ ...line, pv: [] }],
    [{ ...line, pv: ["a1a2"] }],
    [{ ...line, pv: ["e2e4", "e2e3"] }],
    [line, { ...line, multipv: 2 }],
  ]) {
    const value = structuredClone(valid);
    if (value.engines.stockfish.status === "ok") value.engines.stockfish.result = lines;
    await assert.rejects(analyzeWithEngines({ analyze: async () => [], analyzeEngines: async () => value }, new Chess(), multi));
    await assert.rejects(computeWithEngines({
      computeCandidates: async () => { throw new Error("unexpected legacy call"); },
      computeEngineCandidates: async () => ({ ...value, candidates: [], moveSensitivity: { stockfish: null, lc0: null } }),
    }, new Chess(), 1500, multi, 5));
  }
});

test("terminal injected analysis accepts empty results including history draws", async () => {
  const mate = new Chess();
  for (const move of ["f3", "e5", "g4", "Qh4#"]) mate.move(move);
  const repetition = new Chess();
  for (const move of ["Nf3", "Nf6", "Ng1", "Ng8", "Nf3", "Nf6", "Ng1", "Ng8"]) repetition.move(move);
  for (const position of [mate, repetition]) {
    assert.equal(position.isGameOver(), true);
    const result = await analyzeWithEngines({ analyze: async () => [] }, position, request);
    assert.equal(result.engines.stockfish.status, "ok");
  }
});

test("injected providers cannot change the position used to validate their results", async () => {
  const value = await analyzeWithEngines({ analyze: async () => [line] }, new Chess(), request);
  await assert.rejects(analyzeWithEngines({
    analyze: async () => [],
    analyzeEngines: async (position) => {
      for (const move of ["f3", "e5", "g4", "Qh4#"]) position.move(move);
      if (value.engines.stockfish.status === "ok") value.engines.stockfish.result = [];
      return value;
    },
  }, new Chess(), request), /no analysis lines/);
});
