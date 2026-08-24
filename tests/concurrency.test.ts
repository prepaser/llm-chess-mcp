import assert from "node:assert/strict";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Stockfish } from "../src/engines/stockfish.js";
import type { StockfishEngine, StockfishInit } from "../src/engines/stockfish.js";
import { GameStore } from "../src/games.js";
import { buildServer } from "../src/server.js";
import type { AppServices } from "../src/services.js";

function services(games: GameStore): AppServices {
  return {
    games,
    analyze: async () => [],
    quit: async () => undefined,
    humanMoveDistribution: async () => [],
    explorerEnabled: () => false,
    openingExplorer: async () => {
      throw new Error("unused");
    },
    computeCandidates: async () => ({
      candidates: [],
      moveSensitivity: { level: "low", topMoveSpreadCp: null },
    }),
    rankByIntent: (candidates) => candidates,
  };
}

async function clientFor(games: GameStore, t: test.TestContext): Promise<Client> {
  const server = buildServer(services(games));
  const client = new Client({ name: "concurrency-tests", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

test("simultaneous moves from one revision commit exactly once", async (t) => {
  const games = new GameStore({ createId: () => "concurrent-game" });
  const client = await clientFor(games, t);
  const gameId = games.createGame();

  const results = await Promise.all([
    client.callTool({
      name: "game_play_move",
      arguments: { game_id: gameId, move: "e4", expected_revision: 0 },
    }),
    client.callTool({
      name: "game_play_move",
      arguments: { game_id: gameId, move: "d4", expected_revision: 0 },
    }),
  ]);

  const successes = results.filter((result) => result.isError !== true);
  const failures = results.filter((result) => result.isError === true);
  assert.equal(successes.length, 1);
  assert.equal(failures.length, 1);
  assert.deepEqual(failures[0]?.structuredContent, {
    error: {
      code: "STALE_POSITION",
      message: "position changed: expected revision 0, current 1",
    },
  });
  assert.equal(games.getSnapshot(gameId).revision, 1);
  assert.equal(games.getSnapshot(gameId).chess.history().length, 1);
});

test("Stockfish serializes concurrent FEN requests without listener cross-talk", async () => {
  let position = "";
  let active = 0;
  let maxActive = 0;
  const positions: string[] = [];
  const engine: StockfishEngine = {
    listener: null,
    sendCommand(command) {
      if (command === "uci") {
        queueMicrotask(() => this.listener?.("uciok"));
      } else if (command === "isready") {
        queueMicrotask(() => this.listener?.("readyok"));
      } else if (command.startsWith("position fen ")) {
        position = command.slice("position fen ".length);
      } else if (command.startsWith("go depth ")) {
        positions.push(position);
        active += 1;
        maxActive = Math.max(maxActive, active);
        const current = position;
        queueMicrotask(() => {
          this.listener?.(`info depth 1 multipv 1 score cp 1 pv ${current}`);
          active -= 1;
          this.listener?.("bestmove e2e4");
        });
      }
    },
    terminate() {},
  };
  const init: StockfishInit = (_flavor, callback) => {
    queueMicrotask(() => callback(null, engine));
    return engine;
  };
  const stockfish = new Stockfish({
    init,
    timeouts: { init: 100, handshake: 100, analyze: 100, stopGrace: 20 },
  });

  try {
    const [first, second] = await Promise.all([
      stockfish.analyze("fen-first", 1, 1),
      stockfish.analyze("fen-second", 1, 1),
    ]);

    assert.deepEqual(positions, ["fen-first", "fen-second"]);
    assert.equal(maxActive, 1);
    assert.equal(first[0]?.pv[0], "fen-first");
    assert.equal(second[0]?.pv[0], "fen-second");
  } finally {
    await stockfish.quit();
  }
});
