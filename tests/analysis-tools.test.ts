import assert from "node:assert/strict";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { GameStore } from "../src/games.js";
import { buildServer } from "../src/server.js";
import type { AppServices } from "../src/services.js";
import { MoveEvaluateOutputSchema } from "../src/tool-schemas.js";

test("move_evaluate classifies terminal draws from the mover's prior score", async (t) => {
  const games = new GameStore({ createId: () => "draw-game" });
  const gameId = games.createGame("k7/2Q5/2K5/8/8/8/8/8 w - - 0 1");
  let scoreCp: number | null = 500;
  let analysisCalls = 0;
  const services: AppServices = {
    games,
    analyze: async () => {
      analysisCalls += 1;
      return [
        {
          multipv: 1,
          scoreCp,
          scoreMate: null,
          wdl: null,
          pv: ["c7b7"],
        },
      ];
    },
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
  const server = buildServer(services);
  const client = new Client({ name: "analysis-tests", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  for (const expected of [
    { beforeCp: 500, cpLoss: 500, classification: "blunder" },
    { beforeCp: -200, cpLoss: -200, classification: "best" },
    { beforeCp: null, cpLoss: null, classification: null },
  ] as const) {
    scoreCp = expected.beforeCp;
    const response = await client.callTool({
      name: "move_evaluate",
      arguments: { game_id: gameId, move: "Qb6", depth: 5 },
    });
    assert.notEqual(response.isError, true);
    const parsed = MoveEvaluateOutputSchema.parse(response.structuredContent);
    const result = parsed.results[0];
    assert.ok(result);
    assert.deepEqual(result, {
      move: "Qb6",
      uci: "c7b6",
      result: "stalemate",
      scoreCp: 0,
      scoreMate: null,
      bestCp: expected.beforeCp,
      cpLoss: expected.cpLoss,
      classification: expected.classification,
      pv: [],
    });
  }

  assert.equal(analysisCalls, 3);
  assert.equal(games.getGame(gameId).revision, 0);
});
