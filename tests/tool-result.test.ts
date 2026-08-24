import assert from "node:assert/strict";
import test from "node:test";
import type { ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { safeHandler, toolError, toolResult } from "../src/tool-result.js";

function context(signal: AbortSignal): ServerContext {
  return { mcpReq: { signal } } as ServerContext;
}

test("toolResult keeps canonical data out of text content", () => {
  const data = { game_id: "game", revision: 2 };
  const result = toolResult(data, "Game game at revision 2");

  assert.equal(result.content[0]?.text, "Game game at revision 2");
  assert.equal(result.content[0]?.text.includes(JSON.stringify(data)), false);
  assert.deepEqual(result.structuredContent, data);
  assert.equal(result.isError, undefined);
});

test("toolError returns a structured MCP tool error", () => {
  assert.deepEqual(toolError("GAME_NOT_FOUND", "game not found: missing"), {
    content: [{ type: "text", text: "GAME_NOT_FOUND: game not found: missing" }],
    structuredContent: {
      error: { code: "GAME_NOT_FOUND", message: "game not found: missing" },
    },
    isError: true,
  });
});

test("safeHandler forwards the MCP cancellation signal", async () => {
  const controller = new AbortController();
  let received: AbortSignal | undefined;
  const handler = safeHandler(z.object({}), async (_args, signal) => {
    received = signal;
    return toolResult({}, "ok");
  });

  await handler({}, context(controller.signal));
  assert.equal(received, controller.signal);
});

test("safeHandler parses direct calls and rejects invalid input", async () => {
  let calls = 0;
  const handler = safeHandler(
    z.object({ value: z.coerce.number().default(3) }),
    async ({ value }) => {
      calls += 1;
      return toolResult({ value }, "ok");
    },
  );

  assert.deepEqual(await handler({}), toolResult({ value: 3 }, "ok"));
  assert.deepEqual(await handler({ value: "4" }), toolResult({ value: 4 }, "ok"));
  assert.deepEqual(await handler({ value: "nope" }), toolError("INVALID_INPUT", "invalid tool input"));
  assert.equal(calls, 2);
});

test("safeHandler rejects pre-aborted requests without running the handler", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  let called = false;
  const handler = safeHandler(z.object({}), async () => {
    called = true;
    return toolResult({}, "unexpected");
  });

  await assert.rejects(handler({}, context(controller.signal)), /cancelled/);
  assert.equal(called, false);
});

test("safeHandler rethrows when cancellation races a handler error", async () => {
  const controller = new AbortController();
  const handler = safeHandler(z.object({}), async () => {
    controller.abort(new Error("cancelled"));
    throw new Error("application failure");
  });

  await assert.rejects(handler({}, context(controller.signal)), /cancelled/);
});

test("safeHandler does not convert downstream aborts into tool errors", async () => {
  const handler = safeHandler(z.object({}), async () => {
    throw new DOMException("session closed", "AbortError");
  });

  await assert.rejects(handler({}), { name: "AbortError" });
});
