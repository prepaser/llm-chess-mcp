import assert from "node:assert/strict";
import test from "node:test";
import { Chess } from "chess.js";
import * as ort from "onnxruntime-node";
import {
  assertSessionContract,
  extractMoveLogits,
  humanMoveDistribution,
  softmax,
} from "../src/maia3/inference.js";
import { VOCAB_SIZE } from "../src/maia3/vocab.js";

function abortOnCheck(checkAt: number): { signal: AbortSignal; checks(): number } {
  let checks = 0;
  return {
    signal: {
      throwIfAborted() {
        checks += 1;
        if (checks === checkAt) {
          const error = new Error("The operation was aborted");
          error.name = "AbortError";
          throw error;
        }
      },
    } as AbortSignal,
    checks: () => checks,
  };
}

test("computes a stable softmax and preserves masked moves", () => {
  const probabilities = softmax(Float32Array.from([1, 2, -Infinity]));
  const low = probabilities[0];
  const high = probabilities[1];
  assert.ok(low !== undefined && Math.abs(low - 0.26894143) < 1e-7);
  assert.ok(high !== undefined && Math.abs(high - 0.7310586) < 1e-7);
  assert.equal(probabilities[2], 0);
});

test("rejects invalid softmax inputs", () => {
  assert.throws(() => softmax(new Float32Array()), /empty logits/);
  assert.throws(() => softmax(Float32Array.from([-Infinity, -Infinity])), /no legal moves/);
  assert.throws(() => softmax(Float32Array.from([0, NaN])), /invalid Maia3 logits/);
  assert.throws(() => softmax(Float32Array.from([0, Infinity])), /invalid Maia3 logits/);
});

test("validates the Maia3 session contract", () => {
  assert.doesNotThrow(() =>
    assertSessionContract({
      inputNames: ["tokens", "self_elo", "oppo_elo"],
      outputNames: ["logits_move"],
    }),
  );
  assert.throws(
    () => assertSessionContract({ inputNames: ["tokens"], outputNames: ["logits_move"] }),
    /model input missing: self_elo/,
  );
  assert.throws(
    () =>
      assertSessionContract({
        inputNames: ["tokens", "self_elo", "oppo_elo"],
        outputNames: [],
      }),
    /model output missing: logits_move/,
  );
});

test("validates move logits type and shape", () => {
  const logits = new Float32Array(VOCAB_SIZE);
  assert.equal(
    extractMoveLogits({ logits_move: new ort.Tensor("float32", logits, [1, VOCAB_SIZE]) }),
    logits,
  );
  assert.throws(() => extractMoveLogits({}), /inference output missing/);
  assert.throws(
    () => extractMoveLogits({ logits_move: new ort.Tensor("int32", new Int32Array(VOCAB_SIZE), [1, VOCAB_SIZE]) }),
    /invalid Maia3 logits type/,
  );
  assert.throws(
    () => extractMoveLogits({ logits_move: new ort.Tensor("float32", new Float32Array(2), [1, 2]) }),
    /invalid Maia3 logits shape/,
  );
});

test("aborts before loading the model", async () => {
  const previous = process.env.MAIA3_MODEL;
  process.env.MAIA3_MODEL = "invalid";
  try {
    await assert.rejects(
      humanMoveDistribution(new Chess(), 1500, 1500, 1, AbortSignal.abort()),
      { name: "AbortError" },
    );
  } finally {
    if (previous === undefined) delete process.env.MAIA3_MODEL;
    else process.env.MAIA3_MODEL = previous;
  }
});

test("checks cancellation after native inference and around formatting", async () => {
  for (const checkAt of [3, 4, 5]) {
    const cancellation = abortOnCheck(checkAt);
    await assert.rejects(
      humanMoveDistribution(new Chess(), 1500, 1500, 1, cancellation.signal),
      { name: "AbortError" },
    );
    assert.equal(cancellation.checks(), checkAt);
  }

  assert.equal((await humanMoveDistribution(new Chess(), 1500, 1500, 1)).length, 1);
});

test("preserves bundled model inference parity", async () => {
  const previous = process.env.MAIA3_MODEL;
  process.env.MAIA3_MODEL = "5m";
  try {
    const moves = await humanMoveDistribution(new Chess(), 1500, 1500, 20);
    assert.deepEqual(moves.slice(0, 4).map(({ uci }) => uci), ["e2e4", "d2d4", "c2c4", "g1f3"]);
    assert.ok(Math.abs((moves[0]?.prob ?? 0) - 0.6428275) < 1e-6);
    assert.ok(Math.abs(moves.reduce((sum, move) => sum + move.prob, 0) - 1) < 1e-6);
  } finally {
    if (previous === undefined) delete process.env.MAIA3_MODEL;
    else process.env.MAIA3_MODEL = previous;
  }
});

test("skips model loading for terminal positions with legal moves", async () => {
  const previous = process.env.MAIA3_MODEL;
  process.env.MAIA3_MODEL = "invalid";
  try {
    const insufficient = new Chess("8/8/8/8/8/8/K7/7k w - - 0 1");
    assert.equal(insufficient.isGameOver(), true);
    assert.ok(insufficient.moves().length > 0);
    assert.deepEqual(await humanMoveDistribution(insufficient, 1500, 1500, 1), []);
  } finally {
    if (previous === undefined) delete process.env.MAIA3_MODEL;
    else process.env.MAIA3_MODEL = previous;
  }
});
