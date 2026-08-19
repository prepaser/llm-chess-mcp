import assert from "node:assert/strict";
import test from "node:test";
import { Chess } from "chess.js";
import { humanMoveDistribution } from "../src/maia3/inference.js";

test("Maia3 model selection is validated and failed initialization can retry", async () => {
  const previous = process.env.MAIA3_MODEL;
  process.env.MAIA3_MODEL = "../../payload";
  try {
    await assert.rejects(
      humanMoveDistribution(new Chess(), 1500, 1500, 1),
      /unsupported Maia3 model/,
    );
    process.env.MAIA3_MODEL = "5m";
    assert.equal((await humanMoveDistribution(new Chess(), 1500, 1500, 1)).length, 1);
  } finally {
    if (previous === undefined) delete process.env.MAIA3_MODEL;
    else process.env.MAIA3_MODEL = previous;
  }
});
