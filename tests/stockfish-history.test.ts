import assert from "node:assert/strict";
import test from "node:test";
import { Chess } from "chess.js";
import { Stockfish, type StockfishEngine } from "../src/engines/stockfish.js";

test("Stockfish sends validated, snapshotted move history", async () => {
  const commands: string[] = [];
  const engine: StockfishEngine = {
    listener: null,
    sendCommand(command) {
      commands.push(command);
      queueMicrotask(() => {
        if (command === "uci") engine.listener?.("uciok");
        else if (command === "isready") engine.listener?.("readyok");
        else if (command.startsWith("go ")) {
          engine.listener?.("info depth 1 multipv 1 score cp 0 pv e7e5");
          engine.listener?.("bestmove e7e5");
        }
      });
    },
    terminate() {},
  };
  const sf = new Stockfish({ init: (_flavor, callback) => { queueMicrotask(() => callback(null, engine)); return engine; } });
  const chess = new Chess();
  const initialFen = chess.fen();
  chess.move("e4");
  const moves = ["e2e4"];
  try {
    const pending = sf.analyze(chess.fen(), 1, 1, undefined, { initialFen, moves });
    moves[0] = "d2d4";
    await pending;
    assert.ok(commands.includes(`position fen ${initialFen} moves e2e4`));
    await assert.rejects(sf.analyze(chess.fen(), 1, 1, undefined, { initialFen, moves }), /does not match/);
    await assert.rejects(sf.analyze(chess.fen(), 1, 1, undefined, { initialFen, moves: ["e2e4\nquit"] }), /invalid UCI/);
  } finally {
    await sf.quit();
  }
});
