import assert from "node:assert/strict";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer, type ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { ChessError } from "../src/errors.js";
import { ExplorerError } from "../src/explorer.js";
import { safeHandler, toolError, toolResult } from "../src/tool-result.js";

function context(signal: AbortSignal): ServerContext {
  return { mcpReq: { signal } } as ServerContext;
}

test("toolResult keeps canonical data out of text content", () => {
  const outputSchema = z.object({ game_id: z.string(), revision: z.number() });
  const data = { game_id: "game", revision: 2 };
  const result = toolResult(outputSchema, data, "Game game at revision 2");

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
  const inputSchema = z.object({});
  const outputSchema = z.object({});
  const handler = safeHandler(inputSchema, outputSchema, async (_args, signal) => {
    received = signal;
    return toolResult(outputSchema, {}, "ok");
  });

  await handler({}, context(controller.signal));
  assert.equal(received, controller.signal);
});

test("safeHandler parses direct calls and rejects invalid input", async () => {
  let calls = 0;
  const inputSchema = z.object({ value: z.coerce.number().default(3) });
  const outputSchema = z.object({ value: z.number() });
  const handler = safeHandler(
    inputSchema,
    outputSchema,
    async ({ value }) => {
      calls += 1;
      return toolResult(outputSchema, { value }, "ok");
    },
  );

  assert.deepEqual(await handler({}), toolResult(outputSchema, { value: 3 }, "ok"));
  assert.deepEqual(
    await handler({ value: "4" }),
    toolResult(outputSchema, { value: 4 }, "ok"),
  );
  assert.deepEqual(await handler({ value: "nope" }), toolError("INVALID_INPUT", "invalid tool input"));
  assert.equal(calls, 2);
});

test("safeHandler masks unexpected failures", async () => {
  const outputSchema = z.strictObject({});
  const handler = safeHandler(z.strictObject({}), outputSchema, async () => {
    throw new Error("database password: exposed");
  });

  assert.deepEqual(
    await handler({}),
    toolError("INTERNAL", "internal tool error"),
  );
});

test("safeHandler prevalidates successful output without applying transforms", async () => {
  const outputSchema = z.strictObject({
    value: z.string().transform((value) => value.trim()),
  });
  const handler = safeHandler(z.strictObject({}), outputSchema, async () =>
    toolResult(outputSchema, { value: "  result  " }, "ok"),
  );

  assert.deepEqual(
    await handler({}),
    toolResult(outputSchema, { value: "  result  " }, "ok"),
  );
});

test("wire output applies a non-idempotent transform only once", async (t) => {
  const inputSchema = z.strictObject({});
  const outputSchema = z.strictObject({
    value: z
      .number()
      .transform((value) => value + 1)
      .refine((value) => value <= 2, "too large"),
  });
  const server = new McpServer({ name: "output-transform-test", version: "1" });
  server.registerTool(
    "transformed_output",
    { inputSchema, outputSchema },
    safeHandler(inputSchema, outputSchema, async () =>
      toolResult(outputSchema, { value: 1 }, "ok"),
    ),
  );
  const client = new Client({ name: "output-transform-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({
    name: "transformed_output",
    arguments: {},
  });
  assert.notEqual(result.isError, true);
  assert.deepEqual(result.structuredContent, { value: 1 });
});

test("safeHandler masks invalid successful output", async () => {
  const outputSchema = z.strictObject({ value: z.number() });
  const handler = safeHandler(z.strictObject({}), outputSchema, async () =>
    toolResult(outputSchema, { value: Number.NaN }, "invalid"),
  );

  assert.deepEqual(
    await handler({}),
    toolError("INTERNAL", "internal tool error"),
  );
});

test("safeHandler preserves error results without output validation", async () => {
  const outputSchema = z.strictObject({ value: z.number() });
  const expected = toolError("EXPECTED", "expected failure");
  const handler = safeHandler(
    z.strictObject({}),
    outputSchema,
    async () => expected as never,
  );

  assert.deepEqual(await handler({}), expected);
});

test("safeHandler preserves known domain and explorer errors", async () => {
  const outputSchema = z.strictObject({});
  const cases = [
    [
      new ChessError("GAME_NOT_FOUND", "game not found: missing"),
      "GAME_NOT_FOUND",
      "game not found: missing",
    ],
    [
      new ExplorerError("rate_limited", "Lichess rate limited the request"),
      "LICHESS_RATE_LIMITED",
      "Lichess rate limited the request",
    ],
  ] as const;

  for (const [error, code, message] of cases) {
    const handler = safeHandler(z.strictObject({}), outputSchema, async () => {
      throw error;
    });
    assert.deepEqual(await handler({}), toolError(code, message));
  }
});

test("safeHandler rejects pre-aborted requests without running the handler", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  let called = false;
  const outputSchema = z.object({});
  const handler = safeHandler(z.object({}), outputSchema, async () => {
    called = true;
    return toolResult(outputSchema, {}, "unexpected");
  });

  await assert.rejects(handler({}, context(controller.signal)), /cancelled/);
  assert.equal(called, false);
});

test("safeHandler rethrows cancellation during async output validation", async () => {
  let markValidationStarted!: () => void;
  let finishValidation!: () => void;
  const validationStarted = new Promise<void>((resolve) => {
    markValidationStarted = resolve;
  });
  const validationFinished = new Promise<void>((resolve) => {
    finishValidation = resolve;
  });
  const controller = new AbortController();
  const outputSchema = z.strictObject({
    value: z.string().transform(async (value) => {
      markValidationStarted();
      await validationFinished;
      return value;
    }),
  });
  const handler = safeHandler(z.strictObject({}), outputSchema, async () =>
    toolResult(outputSchema, { value: "ok" }, "ok"),
  );
  const result = handler({}, context(controller.signal));
  await validationStarted;
  const cause = new Error("cancelled during output validation");
  controller.abort(cause);
  finishValidation();

  await assert.rejects(result, (error: unknown) => error === cause);
});

test("safeHandler rethrows when cancellation races a handler error", async () => {
  const controller = new AbortController();
  const handler = safeHandler(z.object({}), z.object({}), async () => {
    controller.abort(new Error("cancelled"));
    throw new Error("application failure");
  });

  await assert.rejects(handler({}, context(controller.signal)), /cancelled/);
});

test("safeHandler does not convert downstream aborts into tool errors", async () => {
  const handler = safeHandler(z.object({}), z.object({}), async () => {
    throw new DOMException("session closed", "AbortError");
  });

  await assert.rejects(handler({}), { name: "AbortError" });
});
