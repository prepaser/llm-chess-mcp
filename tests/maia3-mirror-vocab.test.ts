import assert from "node:assert/strict";
import test from "node:test";
import { mirrorMove, mirrorSquare, squareName } from "../src/maia3/mirror.js";
import { MOVE_VOCAB, VOCAB_SIZE, vocabIndex } from "../src/maia3/vocab.js";

test("mirrors squares and UCI moves vertically", () => {
  assert.equal(mirrorSquare("a1"), "a8");
  assert.equal(mirrorSquare("h8"), "h1");
  assert.equal(mirrorMove("e2e4"), "e7e5");
  assert.equal(mirrorMove("a7a8q"), "a2a1q");
  assert.equal(mirrorMove(mirrorMove("b7c8n")), "b7c8n");
});

test("rejects malformed squares, moves, and coordinates", () => {
  assert.throws(() => mirrorSquare("a0"), /invalid square/);
  assert.throws(() => mirrorSquare("A1"), /invalid square/);
  assert.throws(() => mirrorMove("e2e9"), /invalid UCI move/);
  assert.throws(() => mirrorMove("e7e8k"), /invalid UCI move/);
  assert.throws(() => squareName(-1, 0), /invalid rank/);
  assert.throws(() => squareName(0, 8), /invalid file/);
});

test("builds the canonical Maia3 move vocabulary", () => {
  assert.equal(MOVE_VOCAB.length, VOCAB_SIZE);
  assert.equal(new Set(MOVE_VOCAB).size, VOCAB_SIZE);
  assert.equal(MOVE_VOCAB[vocabIndex("a1a1")], "a1a1");
  assert.equal(MOVE_VOCAB[vocabIndex("h8h8")], "h8h8");
  assert.equal(MOVE_VOCAB[vocabIndex("a7h8q")], "a7h8q");
  assert.equal(MOVE_VOCAB[vocabIndex("h7a8n")], "h7a8n");
  assert.throws(() => vocabIndex("e7e8k"), /move not in vocab/);
});
