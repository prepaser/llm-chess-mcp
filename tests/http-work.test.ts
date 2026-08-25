import assert from "node:assert/strict";
import test from "node:test";
import { ChessError } from "../src/errors.js";
import { HttpWorkAdmission } from "../src/http-work.js";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("HTTP work admission holds capacity until downstream work settles", async () => {
  const admission = new HttpWorkAdmission(1, 1);
  const lifecycle = new AbortController();
  const first = admission.forSession(lifecycle.signal);
  const second = admission.forSession(new AbortController().signal);
  const blocked = deferred();
  const running = first(new AbortController().signal, async () => {
    await blocked.promise;
    return "done";
  });

  await assert.rejects(
    second(new AbortController().signal, async () => "bypassed"),
    (error: unknown) =>
      error instanceof ChessError &&
      error.code === "SERVER_BUSY" &&
      error.message === "server work limit reached",
  );

  blocked.resolve();
  assert.equal(await running, "done");
  assert.equal(
    await second(new AbortController().signal, async () => "admitted"),
    "admitted",
  );
});

test("HTTP work admission enforces session capacity and pre-abort", async () => {
  const admission = new HttpWorkAdmission(2, 1);
  const lifecycle = new AbortController();
  const run = admission.forSession(lifecycle.signal);
  const blocked = deferred();
  const running = run(new AbortController().signal, () => blocked.promise);

  await assert.rejects(
    run(new AbortController().signal, async () => {}),
    (error: unknown) =>
      error instanceof ChessError && error.message === "MCP session work limit reached",
  );

  lifecycle.abort();
  await assert.rejects(
    run(new AbortController().signal, async () => {}),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  blocked.resolve();
  await assert.rejects(
    running,
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
});

test("HTTP work admission keeps its legacy session alias", async () => {
  const admission = new HttpWorkAdmission(1, 1);
  const lifecycle = new AbortController();
  const result = await admission.session(lifecycle.signal)(
    new AbortController().signal,
    async () => 42,
  );
  assert.equal(result, 42);
});
