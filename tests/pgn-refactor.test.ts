import assert from "node:assert/strict";
import test from "node:test";
import { ChessError } from "../src/errors.js";
import { commentSpan, quotedSpan, wordSpan } from "../src/pgn-lex.js";
import { parseImportedPgn, pgnOf } from "../src/pgn.js";
import { serializePgn } from "../src/pgn-serialize.js";
import {
  MAX_PGN_BYTES,
  MAX_PGN_HEADERS,
  MAX_PGN_TOKEN_BYTES,
  pgnHeaderIndex,
  pgnSetupHeaders,
} from "../src/pgn-shared.js";

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

test("PGN result disagreements precede movetext element limits", () => {
  const excessive = "() ".repeat(20_000);
  assert.throws(
    () => parseImportedPgn(`[Result "1-0"]\n\n* ${excessive}`),
    (error) => error instanceof ChessError && error.code === "INVALID_PGN",
  );
  assert.throws(
    () => parseImportedPgn(`[Result "*"]\n\n* ${excessive}`),
    (error) => error instanceof ChessError && error.code === "PGN_TOO_COMPLEX",
  );
});

test("PGN result pre-pass ignores markers inside mainline and variation comments", () => {
  const chess = parseImportedPgn(
    '[Result "1-0"]\n\n1.e4 {0-1} (1.d4 {1/2-1/2}) 1-0',
  );

  assert.deepEqual(chess.history(), ["e4"]);
  assert.equal(chess.getHeaders().Result, "1-0");
});

test("PGN result pre-pass preserves variation-boundary marker semantics", () => {
  const excessive = "() ".repeat(20_000);
  assert.throws(
    () =>
      parseImportedPgn(
        `[Result "1-0"]\n\n1.e4 (1.d4 *) ${excessive}`,
      ),
    (error) => error instanceof ChessError && error.code === "PGN_TOO_COMPLEX",
  );
});

test("PGN serialization rejects aggregate size before materializing raw text", () => {
  const headers: [string, string][] = Array.from(
    { length: MAX_PGN_HEADERS / 4 - 1 },
    (_, index) => [`X${index}`, "a".repeat(MAX_PGN_TOKEN_BYTES)] as [string, string],
  );
  const comments = ["c".repeat(MAX_PGN_TOKEN_BYTES)];
  const headerBytes = Buffer.byteLength(
    headers
      .map(([name, value]) => `[${name} "${value}"]`)
      .join("\n"),
    "utf8",
  );
  assert.ok(headerBytes < MAX_PGN_BYTES);
  assert.ok(headerBytes + Buffer.byteLength(comments[0]!, "utf8") > MAX_PGN_BYTES);
  let materialized = false;

  assert.throws(
    () =>
      serializePgn(
        () => {
          materialized = true;
          return "";
        },
        headers,
        comments,
      ),
    (error) => error instanceof ChessError && error.code === "PGN_TOO_LARGE",
  );
  assert.equal(materialized, false);
});

test("PGN preflight accounts for unsafe comment newline normalization", () => {
  const comment = "a}" + "\r\n".repeat(7_000);
  const comments = Array<string>(80).fill(comment);
  const raw = comments.map((value) => `{${value}}`).join(" ");
  assert.ok(Buffer.byteLength(raw, "utf8") > MAX_PGN_BYTES);
  const pgn = serializePgn(() => raw, [], comments);
  assert.equal(pgn, comments.map(() => ";a} \n").join(" "));
});
