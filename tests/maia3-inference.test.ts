import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import { Chess } from "chess.js";
import * as ort from "onnxruntime-node";
import { ChessError } from "../src/errors.js";
import {
  assertSessionContract,
  createCheckedSession,
  extractMoveLogits,
  humanMoveDistribution,
  MaiaAdmission,
  MaiaWorkerPool,
  quitMaia,
  softmax,
  withoutNodeInputType,
} from "../src/maia3/inference.js";
import { VOCAB_SIZE } from "../src/maia3/vocab.js";

const execFileAsync = promisify(execFile);
const testChildUrl = new URL("./support/maia-child.ts", import.meta.url);

function poolRequest(modelPath: string) {
  return {
    modelPath,
    input: new Float32Array(64 * 96),
    elo: 1500,
    oppoElo: 1500,
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

test("awaits failed session cleanup without hiding the contract error", async () => {
  let releases = 0;
  const candidate = {
    inputNames: ["tokens"],
    outputNames: ["logits_move"],
    async release() {
      releases += 1;
      throw new Error("release failed");
    },
  } as unknown as ort.InferenceSession;

  await assert.rejects(
    createCheckedSession(async () => candidate),
    /Maia3 model input missing: self_elo/,
  );
  assert.equal(releases, 1);
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

test("bounds Maia inference and removes queued aborts immediately", async () => {
  const admission = new MaiaAdmission(1, 1);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started: string[] = [];
  const first = admission.run(undefined, async () => {
    started.push("first");
    await blocked;
    return 1;
  });
  await Promise.resolve();

  const controller = new AbortController();
  const second = admission.run(controller.signal, async () => {
    started.push("second");
    return 2;
  });
  assert.equal(admission.active, 1);
  assert.equal(admission.pending, 1);
  await assert.rejects(admission.run(undefined, async () => 3), (error) => {
    return (
      error instanceof ChessError &&
      error.code === "SERVER_BUSY" &&
      error.message === "Maia3 inference queue full"
    );
  });

  const cause = new Error("queued inference cancelled");
  controller.abort(cause);
  await assert.rejects(second, (error: unknown) => error === cause);
  assert.equal(admission.pending, 0);

  const third = admission.run(undefined, async () => {
    started.push("third");
    return 3;
  });
  assert.equal(admission.pending, 1);
  release();
  assert.equal(await first, 1);
  assert.equal(await third, 3);
  assert.deepEqual(started, ["first", "third"]);

  assert.throws(() => new MaiaAdmission(0, 0), /maxConcurrency/);
  assert.throws(() => new MaiaAdmission(1, -1), /maxQueue/);
});

test("Maia admission rejects pre-aborted work asynchronously", async () => {
  const admission = new MaiaAdmission();
  const result = admission.run(AbortSignal.abort(), async () => 1);
  assert.ok(result instanceof Promise);
  await assert.rejects(result, { name: "AbortError" });
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

test("active cancellation retires its worker and later inference recovers", async () => {
  await quitMaia();
  await humanMoveDistribution(new Chess(), 1500, 1500, 1);
  const controller = new AbortController();
  const cause = new Error("active inference cancelled");
  const cancelled = humanMoveDistribution(
    new Chess(),
    1500,
    1500,
    1,
    controller.signal,
  );
  setTimeout(() => controller.abort(cause), 0);

  await assert.rejects(cancelled, (error: unknown) => error === cause);
  assert.equal((await humanMoveDistribution(new Chess(), 1500, 1500, 1)).length, 1);
});

test("child pool recovers on the same instance after a timeout", async () => {
  const pool = new MaiaWorkerPool(1, 5_000, testChildUrl);
  try {
    await assert.rejects(pool.run(poolRequest("hang")), /inference timed out/);
    assert.deepEqual(await pool.run(poolRequest("ok")), new Float32Array([7]));
  } finally {
    await pool.close(new Error("closed"));
  }
});

test("child pool rejects failures and malformed responses, and restarts", async () => {
  const pool = new MaiaWorkerPool(1, 5_000, testChildUrl);
  try {
    assert.deepEqual(await pool.run(poolRequest("ok")), new Float32Array([7]));
    await assert.rejects(
      pool.run(poolRequest("null")),
      /invalid Maia3 inference child response/,
    );
    assert.deepEqual(await pool.run(poolRequest("ok")), new Float32Array([7]));
    await assert.rejects(
      pool.run(poolRequest("bad-error")),
      /invalid Maia3 inference child response/,
    );
    await assert.rejects(pool.run(poolRequest("crash")), /disconnected|exited/);
    assert.deepEqual(await pool.run(poolRequest("ok")), new Float32Array([7]));

    const active = pool.run(poolRequest("hang"));
    const cause = new Error("pool closed");
    const closing = pool.close(cause);
    assert.equal(pool.close(new Error("duplicate")), closing);
    await assert.rejects(active, (error: unknown) => error === cause);
    await closing;
    assert.deepEqual(await pool.run(poolRequest("ok")), new Float32Array([7]));
  } finally {
    await pool.close(new Error("closed"));
  }
});

test("child pool rejects every run failure asynchronously", async () => {
  const pool = new MaiaWorkerPool(1, 2_000, testChildUrl);
  const active = pool.run(poolRequest("hang"));
  try {
    const unavailable = pool.run(poolRequest("ok"));
    assert.ok(unavailable instanceof Promise);
    await assert.rejects(unavailable, {
      name: "ChessError",
      message: "Maia3 worker pool unavailable",
    });

    const closing = pool.close(new Error("closed"));
    const closed = pool.run(poolRequest("ok"));
    assert.ok(closed instanceof Promise);
    await assert.rejects(closed, /shutting down/);
    await assert.rejects(active, /closed/);
    await closing;
  } finally {
    await pool.close(new Error("closed"));
  }
});

test("validates child pool configuration", () => {
  for (const size of [0, -1, Number.NaN, Infinity]) {
    assert.throws(
      () => new MaiaWorkerPool(size, 1, testChildUrl),
      /worker pool size/,
    );
  }
  for (const timeout of [0, -1, Number.NaN, Infinity, 2_147_483_648]) {
    assert.throws(
      () => new MaiaWorkerPool(1, timeout, testChildUrl),
      /worker timeout/,
    );
  }
});

test("inference children do not inherit the Lichess credential", async () => {
  const previous = process.env.LICHESS_TOKEN;
  process.env.LICHESS_TOKEN = "secret";
  const pool = new MaiaWorkerPool(1, 2_000, testChildUrl);
  try {
    assert.deepEqual(await pool.run(poolRequest("env")), new Float32Array([1]));
  } finally {
    if (previous === undefined) delete process.env.LICHESS_TOKEN;
    else process.env.LICHESS_TOKEN = previous;
    await pool.close(new Error("closed"));
  }
});

test("child pool preserves falsey active cancellation reasons", async () => {
  const pool = new MaiaWorkerPool(1, 2_000, testChildUrl);
  try {
    for (const reason of [false, null]) {
      const controller = new AbortController();
      const outcome = pool
        .run(poolRequest("hang"), controller.signal)
        .then(
          () => ({ resolved: true, reason: undefined }),
          (error: unknown) => ({ resolved: false, reason: error }),
        );
      controller.abort(reason);
      assert.deepEqual(await outcome, { resolved: false, reason });
    }
  } finally {
    await pool.close(new Error("closed"));
  }
});

test("quit fences work, shares completion, and permits lazy restart", async () => {
  await humanMoveDistribution(new Chess(), 1500, 1500, 1);
  const first = quitMaia();
  assert.equal(quitMaia(), first);
  await assert.rejects(
    humanMoveDistribution(new Chess(), 1500, 1500, 1),
    /cancelled by shutdown/,
  );
  await first;
  assert.equal((await humanMoveDistribution(new Chess(), 1500, 1500, 1)).length, 1);
  await quitMaia();
});

test("child execution yields the main event loop", async () => {
  await quitMaia();
  let ticked = false;
  const timer = setTimeout(() => {
    ticked = true;
  }, 0);
  await humanMoveDistribution(new Chess(), 1500, 1500, 1);
  clearTimeout(timer);
  assert.equal(ticked, true);
});

test("parses quoted and unquoted NODE_OPTIONS without changing other options", () => {
  for (const input of [
    "--input-type=module --no-warnings",
    "\"--input-type=module\" --no-warnings",
    "'--input-type=module' --no-warnings",
    "\"--input-type\" \"module\" --no-warnings",
  ]) {
    assert.equal(withoutNodeInputType(input), "--no-warnings");
  }
  assert.equal(
    withoutNodeInputType('--require "./loader path.cjs" --no-warnings'),
    '--require "./loader path.cjs" --no-warnings',
  );
});

test("child env strips quoted input-type and preserves other options", async () => {
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = '"--input-type=module" --no-warnings';
  const pool = new MaiaWorkerPool(1, 2_000, testChildUrl);
  try {
    assert.deepEqual(
      await pool.run(poolRequest("node-options")),
      new Float32Array([1]),
    );
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
    await pool.close(new Error("closed"));
  }
});

test("source children ignore inherited input-type exec arguments", { timeout: 15_000 }, async () => {
  const moduleUrl = new URL("../src/maia3/inference.ts", import.meta.url).href;
  const source = `
    import { Chess } from "chess.js";
    const { humanMoveDistribution, quitMaia } = await import(${JSON.stringify(moduleUrl)});
    const moves = await humanMoveDistribution(new Chess(), 1500, 1500, 1);
    await quitMaia();
    process.stdout.write(moves[0].uci);
  `;
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", source],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '"--input-type=module"']
          .filter(Boolean)
          .join(" "),
      },
      timeout: 10_000,
    },
  );
  assert.equal(stdout, "e2e4");
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

test("captures one immutable position before asynchronous inference", async () => {
  const expected = await humanMoveDistribution(new Chess(), 1500, 1500, 5);
  const mutable = new Chess();
  const pending = humanMoveDistribution(mutable, 1500, 1500, 5);
  mutable.move("e4");

  assert.deepEqual(await pending, expected);
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
