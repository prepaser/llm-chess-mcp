import assert from "node:assert/strict";
import test from "node:test";
import { Chess } from "chess.js";
import {
  drawResult,
  parseMove,
  playParsedMove,
  pvToSan,
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

test("parseMove accepts omitted SAN check suffixes and UCI", () => {
  const check = new Chess("7k/8/8/8/8/8/4Q3/4K3 w - - 0 1");
  assert.equal(parseMove(check, "Qe8").san, "Qe8+");
  assert.equal(parseMove(check, "Qe8+").san, "Qe8+");
  assert.throws(
    () => parseMove(check, "Qe8#"),
    (error) => error instanceof ChessError && error.code === "ILLEGAL_MOVE",
  );

  const chess = new Chess();
  assert.throws(
    () => parseMove(chess, "e4+"),
    (error) => error instanceof ChessError && error.code === "ILLEGAL_MOVE",
  );
  assert.throws(
    () => parseMove(chess, "e4#"),
    (error) => error instanceof ChessError && error.code === "ILLEGAL_MOVE",
  );
  const move = parseMove(chess, "e2e4");
  assert.equal(playParsedMove(chess, move).san, "e4");
  assert.throws(
    () => parseMove(chess, "e2e5"),
    (error) => error instanceof ChessError && error.code === "ILLEGAL_MOVE",
  );

  const mate = new Chess();
  mate.move("f3");
  mate.move("e5");
  mate.move("g4");
  assert.equal(parseMove(mate, "Qh4#").san, "Qh4#");
});

test("pvToSan converts legal UCI prefixes without mutating the position", () => {
  const chess = new Chess();
  const fen = chess.fen();

  assert.deepEqual(
    pvToSan(chess, ["e2e4", "e7e5", "g1f3", "b8c6", "e2e5"]),
    ["e4", "e5", "Nf3", "Nc6"],
  );
  assert.equal(chess.fen(), fen);
  assert.deepEqual(
    pvToSan(
      new Chess("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1"),
      ["e1g1", "e8c8"],
    ),
    ["O-O", "O-O-O"],
  );
  assert.deepEqual(
    pvToSan(new Chess("7k/P7/8/8/8/8/8/K7 w - - 0 1"), ["a7a8q"]),
    ["a8=Q+"],
  );
  assert.deepEqual(
    pvToSan(new Chess(), ["f2f3", "e7e5", "g2g4", "d8h4"]),
    ["f3", "e5", "g4", "Qh4#"],
  );
});

test("drawResult returns null for non-draw positions", () => {
  assert.equal(drawResult(new Chess()), null);
});
