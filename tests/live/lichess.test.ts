import assert from "node:assert/strict";
import test from "node:test";
import { Chess } from "chess.js";
import { loadEnv } from "../../src/env.js";
import { explorerEnabled, openingExplorer } from "../../src/explorer.js";

loadEnv();
const enabled = Boolean(process.env.LICHESS_TOKEN?.trim());

test(
  "live Lichess explorer accepts the configured credential without exposing it",
  { skip: enabled ? false : "LICHESS_TOKEN is not set", timeout: 30_000 },
  async () => {
    assert.equal(explorerEnabled(), true);
    const chess = new Chess();
    const legalMoves = new Set(
      chess.moves({ verbose: true }).map((move) => move.lan),
    );

    const result = await openingExplorer(
      chess,
      "lichess",
      ["blitz"],
      [1_600],
    );

    assert.equal(result.db, "lichess");
    assert.ok(result.white >= 0);
    assert.ok(result.draws >= 0);
    assert.ok(result.black >= 0);
    assert.ok(
      result.moves.every(
        (move) =>
          legalMoves.has(move.uci) &&
          move.count === move.white + move.draws + move.black &&
          (move.averageRating === null || typeof move.averageRating === "number"),
      ),
    );
  },
);
