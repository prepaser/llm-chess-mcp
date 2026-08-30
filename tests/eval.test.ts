import assert from "node:assert/strict";
import test from "node:test";
import {
  ANALYSIS_PRESETS,
  CLASSIFICATION,
  classifyCpLoss,
  evalToCp,
  negateEval,
  toEval,
} from "../src/eval.js";
import type { SfLine } from "../src/types.js";

function line(scoreCp: number | null, scoreMate: number | null): SfLine {
  const value = { multipv: 1, scoreCp, scoreMate, wdl: null, pv: ["e2e4"] };
  return value as SfLine;
}

test("converts Stockfish scores and gives mate precedence", () => {
  assert.deepEqual(toEval(line(42, null)), { type: "cp", value: 42 });
  assert.deepEqual(toEval(line(42, -3)), { type: "mate", plies: -3 });
  assert.equal(toEval(line(null, null)), null);
});

test("maps mate scores to sortable centipawn values", () => {
  assert.equal(evalToCp({ type: "cp", value: -125 }), -125);
  assert.equal(evalToCp({ type: "mate", plies: 0 }), 10_000);
  assert.equal(evalToCp({ type: "mate", plies: 1 }), 9_900);
  assert.equal(evalToCp({ type: "mate", plies: 5 }), 9_500);
  assert.equal(evalToCp({ type: "mate", plies: -1 }), -9_900);
  assert.equal(evalToCp({ type: "mate", plies: -5 }), -9_500);
});

test("keeps long mate scores on the correct side of zero", () => {
  assert.equal(evalToCp({ type: "mate", plies: 99 }), 9_000);
  assert.equal(evalToCp({ type: "mate", plies: 100 }), 9_000);
  assert.equal(evalToCp({ type: "mate", plies: 101 }), 9_000);
  assert.equal(evalToCp({ type: "mate", plies: 10_000 }), 9_000);
  assert.equal(evalToCp({ type: "mate", plies: -99 }), -9_000);
  assert.equal(evalToCp({ type: "mate", plies: -100 }), -9_000);
  assert.equal(evalToCp({ type: "mate", plies: -101 }), -9_000);
  assert.equal(evalToCp({ type: "mate", plies: -10_000 }), -9_000);
  assert.ok(
    evalToCp({ type: "mate", plies: 10_000 }) >
      evalToCp({ type: "cp", value: 1_000 }),
  );
  assert.ok(
    evalToCp({ type: "mate", plies: -10_000 }) <
      evalToCp({ type: "cp", value: -1_000 }),
  );
});

test("negates centipawn and mate evaluations without mutating inputs", () => {
  const cp = { type: "cp", value: 30 } as const;
  const mate = { type: "mate", plies: -2 } as const;

  assert.deepEqual(negateEval(cp), { type: "cp", value: -30 });
  assert.deepEqual(negateEval(mate), { type: "mate", plies: 2 });
  assert.deepEqual(cp, { type: "cp", value: 30 });
  assert.deepEqual(mate, { type: "mate", plies: -2 });
});

test("classifies every centipawn-loss boundary", () => {
  assert.deepEqual(CLASSIFICATION, {
    best: 0,
    excellent: 30,
    good: 80,
    inaccuracy: 150,
    mistake: 300,
  });
  assert.deepEqual(
    [-1, 0, 1, 29, 30, 79, 80, 149, 150, 299, 300].map(classifyCpLoss),
    [
      "best",
      "best",
      "excellent",
      "excellent",
      "good",
      "good",
      "inaccuracy",
      "inaccuracy",
      "mistake",
      "mistake",
      "blunder",
    ],
  );
});

test("keeps analysis presets stable", () => {
  assert.deepEqual(ANALYSIS_PRESETS, {
    fast: { depth: 8, multipv: 5 },
    normal: { depth: 15, multipv: 8 },
    deep: { depth: 22, multipv: 10 },
  });
});
