import assert from "node:assert/strict";
import test from "node:test";
import type { Transport } from "@modelcontextprotocol/server";
import { buildServer } from "../src/server.js";
import { defaultAppServices } from "../src/services.js";

function transport(close: () => Promise<void>): Transport {
  return {
    start: async () => {},
    send: async () => {},
    close,
  };
}

test("default server close preserves transport and lease failures", async (t) => {
  const quit = defaultAppServices.quit;
  t.after(() => {
    defaultAppServices.quit = quit;
  });

  const closeError = new Error("transport close failed");
  const releaseError = new Error("release failed");
  defaultAppServices.quit = () => Promise.reject(releaseError);
  const dual = buildServer();
  await dual.connect(transport(() => Promise.reject(closeError)));
  const first = dual.close();
  assert.equal(dual.close(), first);
  await assert.rejects(first, (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.message, "MCP server close and service release failed");
    assert.deepEqual(error.errors, [closeError, releaseError]);
    return true;
  });

  defaultAppServices.quit = async () => {};
  const closeOnly = buildServer();
  await closeOnly.connect(transport(() => Promise.reject(closeError)));
  await assert.rejects(closeOnly.close(), (error: unknown) => error === closeError);

  defaultAppServices.quit = () => Promise.reject(releaseError);
  const releaseOnly = buildServer();
  await releaseOnly.connect(transport(async () => {}));
  await assert.rejects(
    releaseOnly.close(),
    (error: unknown) => error === releaseError,
  );
});
