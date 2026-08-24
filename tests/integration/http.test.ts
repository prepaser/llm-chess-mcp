import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { GameStore } from "../../src/games.js";
import { serveHttp } from "../../src/http.js";
import type { AppServices } from "../../src/services.js";

type JsonObject = Record<string, unknown>;

type HttpResult = {
  status: number;
  body: string;
};

function fakeServices(games: GameStore): AppServices {
  return {
    games,
    analyze: async () => [],
    quit: async () => {},
    humanMoveDistribution: async () => [],
    explorerEnabled: () => false,
    openingExplorer: async (_chess, db) => ({
      db,
      white: 0,
      draws: 0,
      black: 0,
      moves: [],
      opening: null,
    }),
    computeCandidates: async () => ({
      candidates: [],
      moveSensitivity: { level: "low", topMoveSpreadCp: null },
    }),
    rankByIntent: (candidates) => candidates,
  };
}

function httpRequest(url: string, headers: Record<string, string>): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() });
      });
    });
    req.once("error", reject);
    req.end();
  });
}

function object(value: unknown): JsonObject {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as JsonObject;
}

function string(value: unknown): string {
  if (typeof value !== "string") assert.fail("expected a string");
  return value;
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting for condition");
}

test("Streamable HTTP serves an isolated game session", async (t) => {
  const games = new GameStore({ createId: () => "http-game" });
  const http = await serveHttp({ port: 0 }, fakeServices(games));
  const client = new Client({ name: "http-integration-tests", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(http.url));
  t.after(async () => {
    await client.close();
    await http.close();
  });

  await client.connect(transport);
  assert.equal(http.sessionCount(), 1);
  assert.ok(transport.sessionId);

  const listed = await client.listTools();
  assert.ok(listed.tools.some((tool) => tool.name === "create_game"));
  assert.ok(listed.tools.some((tool) => tool.name === "game_state"));

  const created = object(
    (await client.callTool({ name: "create_game", arguments: {} })).structuredContent,
  );
  const gameId = string(created.game_id);
  assert.equal(created.revision, 0);
  assert.deepEqual(games.listGames(), [gameId]);

  const state = object(
    (
      await client.callTool({
        name: "game_state",
        arguments: { game_id: gameId, include_ascii: true },
      })
    ).structuredContent,
  );
  assert.equal(state.game_id, gameId);
  assert.equal(state.revision, 0);
  assert.equal(state.turn, "w");
  assert.equal(typeof state.board, "string");

  await transport.terminateSession();
  await waitFor(() => http.sessionCount() === 0);
  assert.equal(transport.sessionId, undefined);
});

test("Streamable HTTP rejects invalid routing, sessions, and browser headers", async (t) => {
  const http = await serveHttp({ port: 0 }, fakeServices(new GameStore()));
  t.after(() => http.close());

  const wrongPath = await fetch(`${http.url}/wrong`);
  assert.equal(wrongPath.status, 404);

  const invalidSession = await httpRequest(http.url, { "mcp-session-id": "missing" });
  assert.equal(invalidSession.status, 404);
  assert.match(invalidSession.body, /MCP session not found/);

  const rejectedHost = await httpRequest(http.url, { host: "attacker.example" });
  assert.equal(rejectedHost.status, 403);

  const rejectedOrigin = await httpRequest(http.url, { origin: "https://attacker.example" });
  assert.equal(rejectedOrigin.status, 403);
});
