import assert from "node:assert/strict";
import test from "node:test";
import { toolError, toolResult } from "../src/tool-result.js";

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
