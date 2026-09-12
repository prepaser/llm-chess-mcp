import assert from "node:assert/strict";
import test from "node:test";
import { Chess } from "chess.js";
import {
  assertLegalPosition,
  parseImportedPgn,
  pgnOf,
  snapshotChess,
} from "../src/chess.js";
import { ChessError } from "../src/errors.js";
import { GameStore } from "../src/games.js";

const WHITE_INITIAL =
  "B7/1P6/2k5/8/8/8/8/7K w - - 0 1";
const WHITE_RESULT = "BN6/8/2k5/8/8/8/8/7K b - - 0 1";
const BLACK_INITIAL = "7k/8/8/8/8/2K5/1p6/b7 b - - 0 1";
const BLACK_RESULT = "7k/8/8/8/8/2K5/8/bn6 w - - 0 2";
const WHITE_CAPTURE_INITIAL =
  "B1r5/1P6/2k5/8/8/8/8/7K w - - 0 1";
const WHITE_CAPTURE_RESULT = "B1R5/8/2k5/8/8/8/8/7K b - - 0 1";
const BLACK_CAPTURE_INITIAL =
  "7k/8/8/8/8/2K5/1p6/brR5 b - - 0 1";
const BLACK_CAPTURE_RESULT = "7k/8/8/8/8/2K5/8/brr5 w - - 0 2";

function assertInvalidFen(fen: string): void {
  assert.throws(
    () => assertLegalPosition(new Chess(fen)),
    (error) => error instanceof ChessError && error.code === "INVALID_FEN",
  );
}

test("accepts a non-capturing promotion that creates double check", () => {
  const store = new GameStore({ createId: () => "promotion" });
  const id = store.createGame(WHITE_INITIAL);
  const chess = new Chess(WHITE_INITIAL);
  const move = chess
    .moves({ verbose: true })
    .find(({ from, to, promotion }) =>
      from === "b7" && to === "b8" && promotion === "n",
    );
  assert.ok(move);
  const snapshot = store.applyMove(id, 0, move);

  assert.equal(snapshot.chess.fen(), WHITE_RESULT);
  assert.doesNotThrow(() => store.createGame(WHITE_RESULT));
});

test("snapshot and PGN round trips preserve promotion double check", () => {
  const chess = new Chess(WHITE_INITIAL);
  chess.setHeader("SetUp", "1");
  chess.setHeader("FEN", WHITE_INITIAL);
  chess.move({ from: "b7", to: "b8", promotion: "n" });

  assert.equal(snapshotChess(chess).fen(), WHITE_RESULT);
  assert.equal(parseImportedPgn(pgnOf(chess)).fen(), WHITE_RESULT);
});

test("accepts the corresponding non-capturing black promotion", () => {
  const store = new GameStore();
  const id = store.createGame(BLACK_INITIAL);
  const chess = new Chess(BLACK_INITIAL);
  const move = chess.move({ from: "b2", to: "b1", promotion: "n" });
  assert.equal(store.applyMove(id, 0, move).chess.fen(), BLACK_RESULT);
  assert.doesNotThrow(() => store.createGame(BLACK_RESULT));
  assert.equal(parseImportedPgn(pgnOf(chess)).fen(), BLACK_RESULT);
});

test("preserves promotion capture validation for both colors", () => {
  const white = new Chess(WHITE_CAPTURE_INITIAL);
  white.move({ from: "b7", to: "c8", promotion: "r" });
  assert.equal(white.fen(), WHITE_CAPTURE_RESULT);
  assert.doesNotThrow(() => assertLegalPosition(white));

  const black = new Chess(BLACK_CAPTURE_INITIAL);
  black.move({ from: "b2", to: "c1", promotion: "r" });
  assert.equal(black.fen(), BLACK_CAPTURE_RESULT);
  assert.doesNotThrow(() => assertLegalPosition(black));
});

test("promotions cannot create double check with a nonzero halfmove clock", () => {
  assertInvalidFen(WHITE_RESULT.replace(" 0 1", " 1 1"));
  assertInvalidFen(BLACK_RESULT.replace(" 0 2", " 1 2"));
  assertInvalidFen(WHITE_CAPTURE_RESULT.replace(" 0 1", " 1 1"));
  assertInvalidFen(BLACK_CAPTURE_RESULT.replace(" 0 2", " 1 2"));
});
