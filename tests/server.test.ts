import assert from "node:assert/strict";
import test from "node:test";
import type { Transport } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildServer } from "../src/server.js";
import { defaultAppServices } from "../src/services.js";
import { createScopedGameRepository, GameStore } from "../src/games.js";

test("the shared stdio/MCP builder cannot expose bearer-owned games anonymously", async (t) => {
  const games = new GameStore();
  const owned = createScopedGameRepository(games, "bearer:owner");
  const gameId = owned.createGame();
  const server = buildServer({ ...defaultAppServices, games });
  const client = new Client({ name: "scope-test", version: "1" });
  t.after(async () => { await client.close(); await server.close(); });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  for (const [name, args] of [
    ["game_state", { game_id: gameId }],
    ["game_play_move", { game_id: gameId, move: "e4", expected_revision: 0 }],
    ["delete_game", { game_id: gameId }],
  ] as const) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as { error: { code: string } }).error.code, "GAME_NOT_FOUND");
  }
  assert.equal(games.getSnapshot(gameId).revision, 0);
  const created = await client.callTool({ name: "create_game", arguments: {} });
  assert.notEqual(created.isError, true);
  const id = (created.structuredContent as { game_id: string }).game_id;
  assert.equal(typeof id, "string");
  assert.equal(games.forScope("anonymous").getSnapshot(id as string).revision, 0);
  assert.throws(() => owned.getSnapshot(id as string), /game not found/);
});

test("MCP does not re-scope a custom factory's explicitly selected view", async (t) => {
  const games = new GameStore();
  const forScope = games.forScope.bind(games);
  games.forScope = (scope) => Object.assign(forScope(scope), {
    forScope: () => { throw new Error("selected view must not be re-scoped"); },
  });
  const selected = createScopedGameRepository(games, "bearer:selected");
  assert.equal(selected.forScope, undefined);
  const server = buildServer({ ...defaultAppServices, games: selected });
  const client = new Client({ name: "custom-scope-test", version: "1" });
  t.after(async () => { await client.close(); await server.close(); });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const created = await client.callTool({ name: "create_game", arguments: {} });
  assert.notEqual(created.isError, true);
  const id = (created.structuredContent as { game_id: string }).game_id;
  assert.equal(forScope("bearer:selected").getSnapshot(id).revision, 0);
  assert.throws(() => forScope("anonymous").getSnapshot(id), /game not found/);
});

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
