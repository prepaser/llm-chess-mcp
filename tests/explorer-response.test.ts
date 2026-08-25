import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeExplorerResponse } from "../src/explorer-response.js";

test("preserves caller cancellation while consuming a successful body", async () => {
  const controller = new AbortController();
  const cause = new Error("caller cancelled while reading explorer body");
  let resolveStarted: (() => void) | undefined;
  const bodyStarted = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  let releaseCancellation: (() => void) | undefined;
  let resolveCancellationStarted: (() => void) | undefined;
  const cancellationStarted = new Promise<void>((resolve) => {
    resolveCancellationStarted = resolve;
  });
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull() {
        resolveStarted?.();
        return new Promise<void>(() => {});
      },
      cancel(reason) {
        assert.equal(reason, cause);
        resolveCancellationStarted?.();
        return new Promise<void>((resolve) => {
          releaseCancellation = resolve;
        });
      },
    }),
  );
  const pending = normalizeExplorerResponse(
    response,
    AbortSignal.any([controller.signal]),
    { callerSignal: controller.signal, db: "lichess", legalMoves: new Map() },
  );

  await bodyStarted;
  controller.abort(cause);

  await cancellationStarted;
  let settled = false;
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  releaseCancellation?.();
  await assert.rejects(pending, (error: unknown) => error === cause);
});
