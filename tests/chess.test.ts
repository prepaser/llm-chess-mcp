import assert from "node:assert/strict";
import test from "node:test";
import { Chess } from "chess.js";
import {
  drawResult,
  parseMove,
  playParsedMove,
  snapshotChess,
  stateOf,
} from "../src/chess.js";
import { ChessError } from "../src/errors.js";

test("snapshotChess preserves history without sharing mutations", () => {
  const chess = new Chess();
  for (const move of ["Nf3", "Nf6", "Ng1", "Ng8", "Nf3", "Nf6", "Ng1", "Ng8"]) {
    chess.move(move);
  }

  const snapshot = snapshotChess(chess);
  chess.move("e4");

  assert.equal(snapshot.isThreefoldRepetition(), true);
  assert.equal(snapshot.history().length, 8);
  assert.notEqual(snapshot.fen(), chess.fen());
});

test("snapshotChess replays promotion moves", () => {
  const chess = new Chess("8/P7/8/8/8/6k1/8/6K1 w - - 0 1");
  chess.move("a8=Q");

  const snapshot = snapshotChess(chess);

  assert.equal(snapshot.fen(), chess.fen());
  assert.deepEqual(snapshot.history(), ["a8=Q"]);
});

test("stateOf reports the typed public state", () => {
  const chess = new Chess();
  chess.move("e4");

  assert.deepEqual(stateOf(chess, 3), {
    fen: chess.fen(),
    turn: "b",
    revision: 3,
    isCheck: false,
    isCheckmate: false,
    isStalemate: false,
    isDraw: false,
    isGameOver: false,
    isInsufficientMaterial: false,
    isThreefoldRepetition: false,
    isDrawByFiftyMoves: false,
    moveNumber: 1,
    history: ["e4"],
    lastMove: { san: "e4", uci: "e2e4" },
    castling: {
      whiteKingside: true,
      whiteQueenside: true,
      blackKingside: true,
      blackQueenside: true,
    },
  });
});

test("parseMove accepts SAN without check suffix and UCI", () => {
  const check = new Chess("7k/8/8/8/8/8/4Q3/4K3 w - - 0 1");
  assert.equal(parseMove(check, "Qe8").san, "Qe8+");

  const chess = new Chess();
  const move = parseMove(chess, "e2e4");
  assert.equal(playParsedMove(chess, move).san, "e4");
  assert.throws(
    () => parseMove(chess, "e2e5"),
    (error) => error instanceof ChessError && error.code === "ILLEGAL_MOVE",
  );
});

test("drawResult returns null for non-draw positions", () => {
  assert.equal(drawResult(new Chess()), null);
});
