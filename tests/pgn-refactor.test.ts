import assert from "node:assert/strict";
import test from "node:test";
import { ChessError } from "../src/errors.js";
import { commentSpan, quotedSpan, wordSpan } from "../src/pgn-lex.js";
import { parseImportedPgn, pgnOf } from "../src/pgn.js";
import { pgnHeaderIndex, pgnSetupHeaders } from "../src/pgn-shared.js";

test("PGN lexical spans preserve exact source boundaries", () => {
  const quoted = '"a\\"b" tail';
  assert.deepEqual(quotedSpan(quoted, 0), {
    start: 0,
    end: 6,
    contentStart: 1,
    contentEnd: 5,
    closed: true,
  });
  assert.deepEqual(commentSpan("{a\nb} tail", 0), {
    start: 0,
    end: 5,
    contentStart: 1,
    contentEnd: 4,
    closed: true,
  });
  assert.deepEqual(commentSpan(";note\r\nnext", 0), {
    start: 0,
    end: 5,
    contentStart: 1,
    contentEnd: 5,
    closed: true,
  });
  assert.deepEqual(wordSpan("e4$1 rest", 0, /\s/), { start: 0, end: 4 });
});

test("PGN header indexing is case-insensitive and validates setup pairing", () => {
  const headers = pgnHeaderIndex([
    ["setup", "1"],
    ["FeN", "4k3/8/8/8/8/8/P7/4K3 w - - 0 1"],
  ]);
  assert.deepEqual(pgnSetupHeaders(headers), {
    setup: "1",
    fen: "4k3/8/8/8/8/8/P7/4K3 w - - 0 1",
  });
  assert.throws(
    () => pgnHeaderIndex([["Result", "*"], ["result", "*"]]),
    (error) => error instanceof ChessError && error.code === "INVALID_PGN",
  );
});

test("PGN import shares indexed headers across setup and result validation", () => {
  const chess = parseImportedPgn(
    '[eVeNt "indexed"]\n[setup "1"]\n[fen "4k3/8/8/8/8/8/P7/4K3 w - - 0 1"]\n[result "*"]\n\n{[Result "1-0"] [FEN "invalid"]} 1.a3 (1.a4) *',
  );

  assert.deepEqual(chess.history(), ["a3"]);
  assert.equal(chess.getHeaders().Event, "indexed");
  assert.equal(chess.getHeaders().SetUp, "1");
  assert.equal(chess.getHeaders().Result, "*");
  assert.doesNotThrow(() => parseImportedPgn(pgnOf(chess)));
});

test("PGN normalization composes variations, en passant, and comment clusters", () => {
  const chess = parseImportedPgn(
    "1.e4 a6 2.e5 d5 3.exd6 e.p. {one}$1;two\n{three} (3.exd6 e.p. cxd6) *",
  );

  assert.deepEqual(chess.history(), ["e4", "a6", "e5", "d5", "exd6"]);
  assert.equal(chess.getComments().at(-1)?.comment, "one two three");
  assert.doesNotThrow(() => parseImportedPgn(pgnOf(chess)));
});
