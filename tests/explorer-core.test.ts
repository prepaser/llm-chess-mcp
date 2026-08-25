import assert from "node:assert/strict";
import { test } from "node:test";
import { awaitWithAbort } from "../src/explorer-core.js";

test("does not start aborted explorer work", async () => {
  const controller = new AbortController();
  const cause = new Error("caller cancelled before work started");
  let started = false;
  controller.abort(cause);

  await assert.rejects(
    awaitWithAbort(controller.signal, async () => {
      started = true;
    }),
    (error: unknown) => error === cause,
  );
  assert.equal(started, false);
});

test("preserves the caller cancellation reason while work is pending", async () => {
  const controller = new AbortController();
  const cause = new Error("caller cancelled pending work");
  let release: (() => void) | undefined;
  const pending = awaitWithAbort(
    controller.signal,
    async () =>
      await new Promise<void>((resolve) => {
        release = resolve;
      }),
  );

  controller.abort(cause);
  await assert.rejects(pending, (error: unknown) => error === cause);
  release?.();
});
