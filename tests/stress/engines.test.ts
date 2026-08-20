import assert from "node:assert/strict";
import test from "node:test";
import { Chess } from "chess.js";
import { Stockfish } from "../../src/engines/stockfish.js";
import { humanMoveDistribution } from "../../src/maia3/inference.js";

const positions = [
  new Chess(),
  new Chess("rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2"),
];

test(
  "actual Stockfish and Maia3 handle a short concurrent burst and Stockfish shuts down",
  { timeout: 60_000 },
  async (t) => {
    const stockfish = new Stockfish({
      timeouts: { init: 15_000, handshake: 15_000, analyze: 20_000 },
    });
    t.after(async () => {
      await stockfish.quit();
    });

    const [stockfishLines, maiaMoves] = await Promise.all([
      Promise.all(positions.map((chess) => stockfish.analyze(chess.fen(), 1, 1))),
      Promise.all(
        positions.map((chess) => humanMoveDistribution(chess, 1_500, 1_500, 3)),
      ),
    ]);

    assert.equal(stockfishLines.length, positions.length);
    assert.ok(
      stockfishLines.every((lines, index) => {
        const root = lines[0]?.pv[0];
        return (
          root !== undefined &&
          positions[index]?.moves({ verbose: true }).some((move) => move.lan === root)
        );
      }),
    );
    assert.equal(maiaMoves.length, positions.length);
    assert.ok(
      maiaMoves.every(
        (moves, index) => {
          const legalMoves = new Set(
            positions[index]?.moves({ verbose: true }).map((move) => move.lan),
          );
          return (
            moves.length > 0 &&
            moves.length <= 3 &&
            moves.every(
              (move) =>
                move.prob > 0 && move.prob <= 1 && legalMoves.has(move.uci),
            )
          );
        },
      ),
    );

    await stockfish.quit();
  },
);
