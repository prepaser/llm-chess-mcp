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
  const data = { game_id: "game", revision: 2 };
  const result = toolResult(data, "Game game at revision 2");

  assert.equal(result.content[0]?.text, "Game game at revision 2");
  assert.equal(result.content[0]?.text.includes(JSON.stringify(data)), false);
  assert.deepEqual(result.structuredContent, data);
  assert.equal(result.isError, undefined);
});

test("toolResult preserves the legacy schema signature", () => {
  const schema = z.strictObject({ value: z.number() });
  assert.deepEqual(
    toolResult(schema, { value: 1 }, "legacy"),
    toolResult({ value: 1 }, "legacy"),
  );

  // @ts-expect-error Legacy structured content must match its schema.
  toolResult(schema, { value: "wrong" }, "invalid");
});

test("safeHandler contextually checks toolResult payloads", () => {
  const inputSchema = z.strictObject({});
  const outputSchema = z.strictObject({ value: z.number() });
  const invalid = safeHandler(
    inputSchema,
    outputSchema,
    // @ts-expect-error The result payload must match the output schema.
    async () => toolResult({ value: "wrong" }, "invalid"),
  );

  assert.equal(typeof invalid, "function");
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
    return toolResult({}, "ok");
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
      return toolResult({ value }, "ok");
    },
  );

  assert.deepEqual(await handler({}), toolResult({ value: 3 }, "ok"));
  assert.deepEqual(
    await handler({ value: "4" }),
    toolResult({ value: 4 }, "ok"),
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

test("safeHandler prevalidates successful output", async () => {
  const outputSchema = z.strictObject({
    value: z.string().refine((value) => value.length > 0),
  });
  const handler = safeHandler(z.strictObject({}), outputSchema, async () =>
    toolResult({ value: "result" }, "ok"),
  );

  assert.deepEqual(
    await handler({}),
    toolResult({ value: "result" }, "ok"),
  );
});

test("safeHandler rejects non-wire schemas before tool registration", async (t) => {
  const inputSchema = z.strictObject({});
  const outputSchema = z.strictObject({ value: z.number() });
  const server = new McpServer({ name: "wire-schema-test", version: "1" });
  server.registerTool(
    "valid_tool",
    { inputSchema, outputSchema },
    safeHandler(inputSchema, outputSchema, async () =>
      toolResult({ value: 1 }, "ok"),
    ),
  );
  assert.throws(
    () =>
      safeHandler(
        z.strictObject({ value: z.string().transform(Number) }),
        outputSchema,
        async () => toolResult({ value: 1 }, "unreachable"),
      ),
    /MCP input schema must be representable as JSON Schema/,
  );
  const transformedOutput = z.strictObject({
    value: z.string().transform(Number),
  });
  assert.throws(
    () =>
      safeHandler(inputSchema, transformedOutput, async () =>
        toolResult({ value: 1 }, "unreachable"),
      ),
    /MCP output schema must be representable as JSON Schema/,
  );

  const client = new Client({ name: "wire-schema-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(({ name }) => name), ["valid_tool"]);
});

test("safeHandler masks invalid successful output", async () => {
  const outputSchema = z.strictObject({ value: z.number() });
  const handler = safeHandler(z.strictObject({}), outputSchema, async () =>
    toolResult({ value: Number.NaN }, "invalid"),
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
    return toolResult({}, "unexpected");
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
    value: z.string().refine(async () => {
      markValidationStarted();
      await validationFinished;
      return true;
    }),
  });
  const handler = safeHandler(z.strictObject({}), outputSchema, async () =>
    toolResult({ value: "ok" }, "ok"),
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

test("safeHandler masks uncorrelated AbortError failures", async () => {
  const handler = safeHandler(z.object({}), z.object({}), async () => {
    throw new DOMException("secret upstream URL timed out", "AbortError");
  });

  assert.deepEqual(
    await handler({}),
    toolError("INTERNAL", "internal tool error"),
  );
});

test("wire masks uncorrelated AbortError failures", async (t) => {
  const inputSchema = z.strictObject({});
  const outputSchema = z.strictObject({});
  const server = new McpServer({ name: "abort-error-test", version: "1" });
  server.registerTool(
    "abort_error",
    { inputSchema, outputSchema },
    safeHandler(inputSchema, outputSchema, async () => {
      throw new DOMException("secret upstream URL timed out", "AbortError");
    }),
  );
  const client = new Client({ name: "abort-error-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const result = await client.callTool({ name: "abort_error", arguments: {} });
  assert.equal(result.isError, true);
  assert.deepEqual(result.structuredContent, {
    error: { code: "INTERNAL", message: "internal tool error" },
  });
  assert.equal(JSON.stringify(result).includes("secret upstream URL"), false);
});
