import assert from "node:assert/strict";
import test from "node:test";
import { Chess } from "chess.js";
import {
  assertLegalPosition,
  assertSafeFenCounters,
  drawResult,
  MAX_PGN_BYTES,
  MAX_PGN_HEADERS,
  MAX_PGN_PLIES,
  parseImportedPgn,
  parseMove,
  pgnOf,
  playParsedMove,
  pvToSan,
  snapshotChess,
  stateOf,
} from "../src/chess.js";
import { ChessError } from "../src/errors.js";
import { GameStore } from "../src/games.js";
import { MAX_PGN_TOKEN_BYTES } from "../src/pgn.js";

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

test("snapshotChess preserves safe FEN counters exactly", () => {
  const fen = "8/8/8/8/8/8/K7/7k w - - 9007199254740991 9007199254740991";
  const chess = new Chess(fen);

  const snapshot = snapshotChess(chess);

  assert.equal(chess.fen(), fen);
  assert.equal(snapshot.fen(), fen);
});

test("GameStore snapshots preserve delimiter-bearing comments exactly", () => {
  const imported = parseImportedPgn(";same } comment\n1.e4 *");
  assert.doesNotThrow(() => snapshotChess(imported));
  const store = new GameStore({ createId: () => "comment-game" });
  const id = store.createGameFromChess(imported);
  const stored = store.getSnapshot(id).chess;
  const roundTrip = parseImportedPgn(pgnOf(stored));

  assert.deepEqual(roundTrip.history(), ["e4"]);
  assert.deepEqual(roundTrip.getComments(), imported.getComments());

  const multiline = new Chess();
  multiline.setComment("line\nbreak");
  assert.equal(
    snapshotChess(multiline).getComments()[0]?.comment,
    "line\nbreak",
  );

  class MultilineBraceCommentChess extends Chess {
    override getComments() {
      return [{ fen: this.fen(), comment: "brace } with\nline break" }];
    }
  }
  assert.equal(
    snapshotChess(new MultilineBraceCommentChess()).getComments()[0]?.comment,
    "brace } with line break",
  );
});

test("snapshotChess rejects malformed en passant without mutating its source", () => {
  const chess = new Chess(
    "4k3/8/8/3P4/8/8/P7/4K3 w - e6 0 1",
  );
  assert.equal(chess.get("e5"), undefined);

  assert.throws(
    () => snapshotChess(chess),
    (error) => error instanceof ChessError && error.code === "INVALID_FEN",
  );
  assert.equal(chess.get("e5"), undefined);
  assert.equal(
    chess.fen({ forceEnpassantSquare: true }),
    "4k3/8/8/3P4/8/8/P7/4K3 w - e6 0 1",
  );
});

test("snapshotChess rejects an illegal initial position hidden by later history", () => {
  const chess = new Chess(
    "4k3/8/8/8/8/8/P7/4K3 w K - 0 1",
  );
  chess.move("O-O");
  const fen = chess.fen();
  const history = chess.history();

  assert.throws(
    () => snapshotChess(chess),
    (error) => error instanceof ChessError && error.code === "INVALID_FEN",
  );
  assert.equal(chess.fen(), fen);
  assert.deepEqual(chess.history(), history);
});

test("FEN counters must be safe decimal integers", () => {
  const base = "8/8/8/8/8/8/K7/7k w - -";
  for (const fen of [
    `${base} 1e2 1`,
    `${base} 0 1e2`,
    `${base} -1 1`,
    `${base} 0 0`,
    `${base} 9007199254740992 1`,
    `${base} 0 9007199254740992`,
  ]) {
    assert.throws(
      () => assertSafeFenCounters(fen),
      (error) => error instanceof ChessError && error.code === "INVALID_FEN",
    );
  }
  assert.doesNotThrow(() => assertSafeFenCounters(`${base} 0 1`));
});

test("custom positions reject capturable kings without rejecting a checked mover", () => {
  for (const fen of [
    "8/8/8/8/8/8/4k3/R3K3 w - - 0 1",
    "4k3/8/8/8/8/8/4R3/4K3 w - - 0 1",
  ]) {
    assert.throws(
      () => assertLegalPosition(new Chess(fen)),
      (error) => error instanceof ChessError && error.code === "INVALID_FEN",
    );
  }

  assert.doesNotThrow(() =>
    assertLegalPosition(
      new Chess("7k/8/8/8/8/8/4r3/4K3 w - - 0 1"),
    ),
  );

  const missingKing = new Chess();
  missingKing.remove("e8");
  assert.throws(
    () => assertLegalPosition(missingKing),
    (error) => error instanceof ChessError && error.code === "INVALID_FEN",
  );

  const edgePawn = new Chess();
  edgePawn.put({ type: "p", color: "w" }, "a1");
  assert.throws(
    () => assertLegalPosition(edgePawn),
    (error) => error instanceof ChessError && error.code === "INVALID_FEN",
  );
});

test("custom positions validate castling and en passant metadata", () => {
  for (const fen of [
    "4k3/8/8/8/8/8/P7/4K3 w KQkq - 0 1",
    "4k3/8/8/8/8/8/P7/R3K3 w K - 0 1",
    "4k3/8/8/8/8/8/P7/4K2R w Q - 0 1",
    "4k3/8/8/3P4/8/8/P7/4K3 w - e6 0 1",
    "4k3/4p3/8/3Pp3/8/8/P7/4K3 w - e6 0 1",
    "4k3/8/8/3Pp3/8/8/P7/4K3 w - e6 1 1",
    "4k3/8/8/3Pp3/8/8/P7/4K3 w - e6 0 1",
  ]) {
    assert.throws(
      () => assertLegalPosition(new Chess(fen)),
      (error) => error instanceof ChessError && error.code === "INVALID_FEN",
    );
  }

  assert.doesNotThrow(() =>
    assertLegalPosition(
      new Chess("r3k2r/8/8/8/8/8/P7/R3K2R w KQkq - 0 1"),
    ),
  );
  assert.doesNotThrow(() =>
    assertLegalPosition(
      new Chess("4k3/8/8/3Pp3/8/8/P7/4K3 w - e6 0 2"),
    ),
  );
});

test("custom positions reject impossible pawn and promotion material", () => {
  for (const fen of [
    "4k3/pppppppp/p7/8/8/8/PPPPPPPP/4K3 w - - 0 1",
    "4k3/8/8/8/8/8/PPPPPPPP/3QKQ2 w - - 0 1",
    "4k3/8/8/8/8/4B3/PPPPPPPP/2B1K3 w - - 0 1",
    "rnbqkbnr/pppppppp/8/8/8/P7/P1PPPPPP/RNBQKBNR w KQkq - 0 1",
  ]) {
    assert.throws(
      () => assertLegalPosition(new Chess(fen)),
      (error) => error instanceof ChessError && error.code === "INVALID_FEN",
    );
  }
  assert.doesNotThrow(() =>
    assertLegalPosition(
      new Chess("4k3/8/8/8/8/8/PPPPPPP1/3QKQ2 w - - 0 1"),
    ),
  );

  const captured = new Chess();
  for (const move of ["e4", "d5", "exd5"]) captured.move(move);
  assert.doesNotThrow(() => assertLegalPosition(captured));
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

test("checkmate takes precedence over fifty-move draw flags", () => {
  const chess = new Chess(
    "rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 100 3",
  );
  const state = stateOf(chess, 0);

  assert.equal(state.isCheckmate, true);
  assert.equal(state.isGameOver, true);
  assert.equal(state.isDraw, false);
  assert.equal(state.isDrawByFiftyMoves, false);
  assert.equal(drawResult(chess), null);
});

test("parseImportedPgn rejects checkmate results that contradict the winner", () => {
  const moves = "1. f3 e5 2. g4 Qh4#";

  for (const pgn of [
    `${moves} 1-0`,
    `[Result "1-0"]\n\n${moves} 0-1`,
    `${moves} 1-0 {trailing comment}`,
    `${moves} *`,
  ]) {
    assert.throws(
      () => parseImportedPgn(pgn),
      (error) => error instanceof ChessError && error.code === "INVALID_PGN",
    );
  }

  assert.doesNotThrow(() => parseImportedPgn(`${moves} 0-1`));
  assert.doesNotThrow(() => parseImportedPgn(moves));
});

test("parseImportedPgn permits declared results before board termination", () => {
  assert.doesNotThrow(() =>
    parseImportedPgn(
      '[Termination "White resigned"]\n[Result "0-1"]\n\n1. e4 e5 0-1',
    ),
  );
  assert.doesNotThrow(() =>
    parseImportedPgn(
      '[Termination "Black lost on time"]\n[Result "1-0"]\n\n1. e4 e5 1-0',
    ),
  );
  assert.doesNotThrow(() => parseImportedPgn("1. e4 e5"));
  assert.doesNotThrow(() =>
    parseImportedPgn(
      '[Termination "Black resigned"]\n[Result "1-0"]\n\n1. Nf3 Nf6 2. Ng1 Ng8 1-0',
    ),
  );
});

test("parseImportedPgn validates results outside comments for every game", () => {
  assert.doesNotThrow(() =>
    parseImportedPgn("1. f3 e5 2. g4 Qh4# {1-0}"),
  );
  assert.doesNotThrow(() =>
    parseImportedPgn("1. f3 e5 2. g4 Qh4# ; 1-0"),
  );
  assert.doesNotThrow(() =>
    parseImportedPgn('1. f3 e5 2. g4 Qh4# {\n[Result "1-0"]\n}'),
  );
  assert.equal(
    parseImportedPgn('1. e4 {\n[Event "not a header"]\n} *').getHeaders()
      .Event,
    "?",
  );
  for (const pgn of [
    '[Result "invalid"]\n\n1. e4 e5',
    '[Result "1-0"]\n\n1. e4 e5 0-1',
    '[Result "1-0"]\n\n1. e4 e5 1/2-1/2',
    '[Event "{"]\n[Result "1-0"]\n\n1. f3 e5 2. g4 Qh4# 1-0',
  ]) {
    assert.throws(
      () => parseImportedPgn(pgn),
      (error) => error instanceof ChessError && error.code === "INVALID_PGN",
    );
  }
});

test("parseImportedPgn ignores standard column-one escape lines", () => {
  const chess = parseImportedPgn(
    '[Result "1-0"]\n% ignored 0-1 and [FEN "bad"]\n\n1. e4 1-0',
  );

  assert.deepEqual(chess.history(), ["e4"]);
  assert.equal(chess.getHeaders().Result, "1-0");
  assert.doesNotThrow(() => parseImportedPgn(pgnOf(chess)));
});

test("parseImportedPgn keeps tag sections contiguous across escape lines", () => {
  for (const newline of ["\n", "\r", "\r\n"]) {
    const pgn = [
      '[Event "x"]',
      "% ignored",
      String.raw`[white "A \"B\""]`,
      "",
      "1. e4 *",
    ].join(newline);
    const chess = parseImportedPgn(pgn);
    assert.equal(chess.getHeaders().Event, "x");
    assert.equal(chess.getHeaders().White, 'A "B"');
    assert.doesNotThrow(() => parseImportedPgn(pgnOf(chess)));
  }
});

test("parseImportedPgn accepts one UTF-8 BOM before PGN content", () => {
  const chess = parseImportedPgn('\uFEFF[Result "*"]\r\n\r\n1. e4 *');
  assert.deepEqual(chess.history(), ["e4"]);
  assert.doesNotThrow(() => parseImportedPgn(pgnOf(chess)));
});

test("parseImportedPgn decodes and re-encodes header escapes", () => {
  const pgn = String.raw`[Event "A \"quote\" and \\ path"]

1. e4 *`;
  const chess = parseImportedPgn(pgn);
  assert.equal(chess.getHeaders().Event, 'A "quote" and \\ path');

  const exported = pgnOf(chess);
  assert.match(exported, /\[Event "A \\"quote\\" and \\\\ path"\]/);
  assert.equal(parseImportedPgn(exported).getHeaders().Event, 'A "quote" and \\ path');
});

test("parseImportedPgn canonicalizes standard header names without duplicates", () => {
  const chess = parseImportedPgn(
    String.raw`[event "lower"]
[white "A \"player\""]

1. e4 *`,
  );
  const exported = pgnOf(chess);

  assert.equal(chess.getHeaders().Event, "lower");
  assert.equal(chess.getHeaders().White, 'A "player"');
  assert.doesNotMatch(exported, /\[(?:event|white) /);
  const roundTrip = parseImportedPgn(exported);
  assert.equal(roundTrip.getHeaders().Event, "lower");
  assert.equal(roundTrip.getHeaders().White, 'A "player"');
});

test("parseImportedPgn rejects duplicate custom header names case-insensitively", () => {
  assert.throws(
    () => parseImportedPgn('[Event "one"]\n[event "two"]\n\n1. e4 *'),
    (error) => error instanceof ChessError && error.code === "INVALID_PGN",
  );
});

test("parseImportedPgn bounds the complete header section", () => {
  const headers = [
    '[Event "?"]',
    '[Site "?"]',
    '[Date "????.??.??"]',
    '[Round "?"]',
    '[White "?"]',
    '[Black "?"]',
    '[Result "*"]',
    ...Array.from(
      { length: MAX_PGN_HEADERS - 7 },
      (_, index) => `[X${index} "${index}"]`,
    ),
  ];
  const chess = parseImportedPgn(`${headers.join("\n")}\n\n*`);
  assert.equal(
    chess.getHeaders()[`X${MAX_PGN_HEADERS - 8}`],
    String(MAX_PGN_HEADERS - 8),
  );
  assert.doesNotThrow(() => parseImportedPgn(pgnOf(chess)));

  for (const count of [MAX_PGN_HEADERS, MAX_PGN_HEADERS + 1, 1_000]) {
    const excessive = Array.from(
      { length: count },
      (_, index) => `[X${index} "${index}"]`,
    ).join("\n");
    assert.throws(
      () => parseImportedPgn(`${excessive}\n\n*`),
      (error) => error instanceof ChessError && error.code === "PGN_TOO_COMPLEX",
    );
  }
});

test("parseImportedPgn validates legal moves in recursive variations", () => {
  const valid = parseImportedPgn(
    "1. e4 $1 ({one}{two} 1. d4!?$1$2 $3 $4 {before nag} $5 (1. c4) {after one}{after two} d5 (1... Nf6) (1... e6)) {between} (1. c4 e5) e5 * {done}",
  );
  assert.deepEqual(valid.history(), ["e4", "e5"]);

  for (const pgn of [
    "1. e4 (1. e5) *",
    "1. e4 (1. Qh5) *",
    "1. e4 (1. d4$bogus) *",
    "1. e4 (1. d4$) *",
    "1. e4 (1. d4$1junk) *",
    "1. e4 (1. d4!!!) *",
    "1. e4 (1. d4 !) *",
    "1. e4 ($1 1. d4) *",
    "1. e4 (1. 2. d4) *",
    "1. e4 (1. d4 2.) *",
    "1. e4 (1. d4 (1. c4) $1) *",
    "1. e4 (1. d4 (1. c4) {comment} $1) *",
    "1. e4 (e.p. 1. d4) *",
    "1. e4 (1. d4 e.p.) *",
    "1. e4 (1. --) *",
    "1. e4 (1. --+) *",
    "1. e4 (1. --#) *",
    "1. e4 (1. --+!) *",
    "1. e4 (1. --=) *",
    "1. e4 (1. --=+) *",
    "1. e4 (1. --=#) *",
    "1. e4 (1. --=?!) *",
  ]) {
    assert.throws(
      () => parseImportedPgn(pgn),
      (error) => error instanceof ChessError && error.code === "INVALID_PGN",
    );
  }
  assert.doesNotThrow(
    () =>
      parseImportedPgn(
        "1. e4 a6 2. e5 d5 3. exd6 (3. exd6 e.p. $1 {ep} 3... cxd6) *",
      ),
  );
  for (const misplaced of [
    "$1 e.p.",
    "(3. d4) e.p.",
    "e.p. e.p.",
  ]) {
    assert.throws(
      () =>
        parseImportedPgn(
          `1. e4 a6 2. e5 d5 3. exd6 (3. exd6 ${misplaced}) *`,
        ),
      (error) => error instanceof ChessError && error.code === "INVALID_PGN",
    );
  }
});

test("parseImportedPgn validates deeply nested variations without recursion", () => {
  const depth = 2_500;
  const pgn = `1.e4 ${"(1.d4 ".repeat(depth)}${")".repeat(depth)} *`;
  const chess = parseImportedPgn(pgn);
  assert.deepEqual(chess.history(), ["e4"]);
});

test("parseImportedPgn rejects empty and structurally excessive variations", () => {
  for (const variation of ["()", "($1)"]) {
    assert.throws(
      () => parseImportedPgn(`1.e4 ${variation} *`),
      (error) => error instanceof ChessError && error.code === "INVALID_PGN",
    );
  }
  assert.throws(
    () => parseImportedPgn(`1.e4 ${"() ".repeat(200_000)}*`),
    (error) => error instanceof ChessError && error.code === "PGN_TOO_COMPLEX",
  );
  for (const pgn of [
    `1.e4${"$1".repeat(MAX_PGN_PLIES * 8)}*`,
    `1.${".".repeat(MAX_PGN_PLIES * 8)}e4*`,
    `1.e4$${"1".repeat(MAX_PGN_PLIES * 8 + 1)}*`,
    `${"1".repeat(MAX_PGN_PLIES * 8 + 1)}.e4*`,
  ]) {
    assert.throws(
      () => parseImportedPgn(pgn),
      (error) => error instanceof ChessError && error.code === "PGN_TOO_COMPLEX",
    );
  }
});

test("parseImportedPgn bounds individual lexical tokens", () => {
  const maximum = "a".repeat(MAX_PGN_TOKEN_BYTES);
  assert.doesNotThrow(() =>
    parseImportedPgn(`[Note "${maximum}"]\n\n1.e4 {${maximum}} *`),
  );

  const excessive = `${maximum}a`;
  for (const pgn of [
    `[Note "${excessive}"]\n\n1.e4 *`,
    `1.e4 {${excessive}} *`,
    `1.e4 ;${excessive}\n*`,
    `1.e4 ${excessive} *`,
  ]) {
    assert.throws(
      () => parseImportedPgn(pgn),
      (error) => error instanceof ChessError && error.code === "PGN_TOO_COMPLEX",
    );
  }
});

test("parseImportedPgn preserves mainline comments around removed variations", () => {
  const chess = parseImportedPgn(
    '[Event "keep (header)"]\n\n1.e4 {keep (parentheses)} (1.d4 {drop}) e5 ; keep (line)\n*',
  );
  assert.deepEqual(chess.history(), ["e4", "e5"]);
  assert.equal(chess.getHeaders().Event, "keep (header)");
  assert.deepEqual(
    chess.getComments().map(({ comment }) => comment),
    ["keep (parentheses)", "keep (line)"],
  );
  assert.match(pgnOf(chess), /\{keep \(parentheses\)\} e5 \{keep \(line\)\}/);
});

test("parseImportedPgn coalesces consecutive mainline comments", () => {
  const chess = parseImportedPgn(
    "{root one};root two\r\n1.e4 {mid one};mid two\n(1.d4) {after rav one};after } rav two\r\n1...e5 * {result one};result two",
  );
  assert.deepEqual(chess.history(), ["e4", "e5"]);
  assert.deepEqual(
    chess.getComments().map(({ comment }) => comment),
    [
      "root one root two",
      "mid one mid two after rav one after } rav two",
      "result one result two",
    ],
  );
  const roundTrip = parseImportedPgn(pgnOf(chess));
  assert.deepEqual(roundTrip.history(), ["e4", "e5"]);
  assert.deepEqual(
    roundTrip.getComments().map(({ comment }) => comment),
    chess.getComments().map(({ comment }) => comment),
  );
});

test("pgnOf safely exports repeated delimiter-bearing comments", () => {
  const chess = parseImportedPgn(
    '[Event "header {same } comment}"]\n\n;same } comment\n1.e4 ;same } comment\n1...e5 ;x}\n2.Nf3 ;x}}\n2...Nc6 *',
  );
  chess.setComment("line\nbreak comment");

  const roundTrip = parseImportedPgn(pgnOf(chess));
  assert.equal(roundTrip.getHeaders().Event, "header {same } comment}");
  assert.deepEqual(roundTrip.history(), ["e4", "e5", "Nf3", "Nc6"]);
  assert.deepEqual(
    roundTrip.getComments().map(({ comment }) => comment),
    ["same } comment", "same } comment", "x}", "x}}", "line break comment"],
  );

  const headerless = new Chess();
  headerless.setComment("line\n\nbreak comment");
  headerless.move("e4");
  const headerlessRoundTrip = parseImportedPgn(pgnOf(headerless));
  assert.deepEqual(headerlessRoundTrip.history(), ["e4"]);
  assert.equal(
    headerlessRoundTrip.getComments()[0]?.comment,
    "line break comment",
  );
});

test("pgnOf preserves replacement patterns in unsafe comments", () => {
  const comments = ["literal $& }", "literal $` }", "literal $' }", "literal $$ }"];
  const chess = parseImportedPgn(
    [
      `;${comments[0]}`,
      `1.e4 ;${comments[1]}`,
      `1...e5 ;${comments[2]}`,
      `2.Nf3 ;${comments[3]}`,
      "2...Nc6 *",
    ].join("\n"),
  );

  const roundTrip = parseImportedPgn(pgnOf(chess));
  assert.deepEqual(roundTrip.history(), ["e4", "e5", "Nf3", "Nc6"]);
  assert.deepEqual(
    roundTrip.getComments().map(({ comment }) => comment),
    comments,
  );
});

test("pgnOf rejects line breaks in programmatic headers", () => {
  for (const lineBreak of ["\n", "\r", "\r\n"]) {
    const chess = new Chess();
    chess.setHeader("Event", `first${lineBreak}second`);
    chess.move("e4");
    assert.throws(
      () => pgnOf(chess),
      (error) => error instanceof ChessError && error.code === "INVALID_PGN",
    );
  }
});

test("pgnOf rejects invalid programmatic header names", () => {
  for (const name of ["1Bad", "_Bad"]) {
    assert.throws(
      () => parseImportedPgn(`[${name} "value"]\n\n1.e4 *`),
      (error) => error instanceof ChessError && error.code === "INVALID_PGN",
    );
  }
  for (const name of [
    "",
    "1Bad",
    "_Bad",
    "Bad Name",
    "Bad]Name",
    "Bad\\Name",
    'Bad"Name',
    "Bad\nName",
  ]) {
    const chess = new Chess();
    chess.setHeader(name, "value");
    chess.move("e4");
    assert.throws(
      () => pgnOf(chess),
      (error) => error instanceof ChessError && error.code === "INVALID_PGN",
    );
  }

  const valid = new Chess();
  valid.setHeader("Valid_Name0", "value");
  valid.move("e4");
  assert.equal(
    parseImportedPgn(pgnOf(valid)).getHeaders().Valid_Name0,
    "value",
  );
});

test("pgnOf enforces programmatic header contracts", () => {
  const duplicate = new Chess();
  duplicate.setHeader("event", "duplicate");
  assert.throws(
    () => pgnOf(duplicate),
    (error) => error instanceof ChessError && error.code === "INVALID_PGN",
  );

  const invalidResult = new Chess();
  invalidResult.setHeader("Result", "draw");
  assert.throws(
    () => pgnOf(invalidResult),
    (error) => error instanceof ChessError && error.code === "INVALID_PGN",
  );

  for (const headers of [
    { SetUp: "1" },
    { FEN: "4k3/8/8/8/8/8/P7/4K3 w - - 0 1" },
    { SetUp: "0", FEN: "4k3/8/8/8/8/8/P7/4K3 w - - 0 1" },
  ]) {
    const chess = new Chess();
    for (const [name, value] of Object.entries(headers)) {
      chess.setHeader(name, value);
    }
    assert.throws(
      () => pgnOf(chess),
      (error) => error instanceof ChessError && error.code === "INVALID_PGN",
    );
  }

  const invalidFen = new Chess();
  invalidFen.setHeader("SetUp", "1");
  invalidFen.setHeader("FEN", "invalid");
  assert.throws(
    () => pgnOf(invalidFen),
    (error) => error instanceof ChessError && error.code === "INVALID_FEN",
  );

  const mismatchedFen = new Chess();
  mismatchedFen.setHeader("SetUp", "1");
  mismatchedFen.setHeader("FEN", "4k3/8/8/8/8/8/P7/4K3 w - - 0 1");
  assert.throws(
    () => pgnOf(mismatchedFen),
    (error) => error instanceof ChessError && error.code === "INVALID_PGN",
  );

  const fen = "4k3/8/8/8/8/8/P7/4K3 w - - 0 1";
  const custom = new Chess(fen);
  custom.move("a3");
  const roundTrip = parseImportedPgn(pgnOf(custom));
  assert.deepEqual(roundTrip.history(), ["a3"]);
  assert.equal(roundTrip.getHeaders().FEN, fen);

  const stalemateFen = "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1";
  const lowercaseSetup = new Chess(stalemateFen);
  lowercaseSetup.removeHeader("SetUp");
  lowercaseSetup.removeHeader("FEN");
  lowercaseSetup.setHeader("setup", "1");
  lowercaseSetup.setHeader("fen", stalemateFen);
  const lowercaseRoundTrip = parseImportedPgn(pgnOf(lowercaseSetup));
  assert.equal(lowercaseRoundTrip.getHeaders().SetUp, "1");
  assert.equal(lowercaseRoundTrip.getHeaders().FEN, stalemateFen);
  assert.equal(lowercaseRoundTrip.getHeaders().Result, "1/2-1/2");

  lowercaseSetup.setHeader("SetUp", "1");
  assert.throws(
    () => pgnOf(lowercaseSetup),
    (error) => error instanceof ChessError && error.code === "INVALID_PGN",
  );
});

test("pgnOf bounds programmatic headers and comments", () => {
  const maximum = "a".repeat(MAX_PGN_TOKEN_BYTES);

  const valueAtLimit = new Chess();
  valueAtLimit.setHeader("Event", maximum);
  valueAtLimit.move("e4");
  assert.equal(
    parseImportedPgn(pgnOf(valueAtLimit)).getHeaders().Event,
    maximum,
  );

  const nameAtLimit = new Chess();
  const name = `H${"a".repeat(MAX_PGN_TOKEN_BYTES - 1)}`;
  nameAtLimit.setHeader(name, "value");
  nameAtLimit.move("e4");
  assert.equal(parseImportedPgn(pgnOf(nameAtLimit)).getHeaders()[name], "value");

  const commentAtLimit = new Chess();
  commentAtLimit.setComment(maximum);
  commentAtLimit.move("e4");
  assert.equal(
    parseImportedPgn(pgnOf(commentAtLimit)).getComments()[0]?.comment,
    maximum,
  );

  const excessive = `${maximum}a`;
  const oversizedValue = new Chess();
  oversizedValue.setHeader("Event", excessive);
  const oversizedName = new Chess();
  oversizedName.setHeader(excessive, "value");
  const oversizedComment = new Chess();
  oversizedComment.setComment(excessive);
  for (const chess of [oversizedValue, oversizedName, oversizedComment]) {
    assert.throws(
      () => pgnOf(chess),
      (error) => error instanceof ChessError && error.code === "PGN_TOO_COMPLEX",
    );
  }
});

test("pgnOf bounds aggregate headers and bytes", () => {
  const exactHeaders = new Chess();
  for (let index = 0; index < MAX_PGN_HEADERS - 7; index += 1) {
    exactHeaders.setHeader(`X${index}`, "value");
  }
  exactHeaders.move("e4");
  assert.equal(Object.keys(exactHeaders.getHeaders()).length, MAX_PGN_HEADERS);
  assert.doesNotThrow(() => parseImportedPgn(pgnOf(exactHeaders)));

  exactHeaders.setHeader("Excessive", "value");
  assert.throws(
    () => pgnOf(exactHeaders),
    (error) => error instanceof ChessError && error.code === "PGN_TOO_COMPLEX",
  );

  const exactBytes = new Chess();
  exactBytes.move("e4");
  for (let index = 0; index < 63; index += 1) {
    exactBytes.setHeader(`X${index}`, "a".repeat(MAX_PGN_TOKEN_BYTES));
  }
  exactBytes.setHeader("Tail", "");
  const remaining = MAX_PGN_BYTES - Buffer.byteLength(pgnOf(exactBytes), "utf8");
  assert.ok(remaining > 0 && remaining < MAX_PGN_TOKEN_BYTES);
  exactBytes.setHeader("Tail", "a".repeat(remaining));
  const exactPgn = pgnOf(exactBytes);
  assert.equal(Buffer.byteLength(exactPgn, "utf8"), MAX_PGN_BYTES);
  assert.doesNotThrow(() => parseImportedPgn(exactPgn));

  exactBytes.setHeader("Tail", "a".repeat(remaining + 1));
  assert.throws(
    () => pgnOf(exactBytes),
    (error) => error instanceof ChessError && error.code === "PGN_TOO_LARGE",
  );
});

test("parseImportedPgn accounts for canonical header expansion", () => {
  const lines: string[] = [];
  for (let index = 0; ; index += 1) {
    const prefix = `[X${index} "`;
    const suffix = `"]\n`;
    const used = Buffer.byteLength(`${lines.join("")}\n*`, "utf8");
    const available =
      MAX_PGN_BYTES -
      used -
      Buffer.byteLength(`${prefix}${suffix}`, "utf8");
    if (available < 0) break;
    const value = "a".repeat(Math.min(available, MAX_PGN_TOKEN_BYTES));
    lines.push(`${prefix}${value}${suffix}`);
    if (available <= MAX_PGN_TOKEN_BYTES) break;
  }
  const pgn = `${lines.join("")}\n*`;
  assert.equal(Buffer.byteLength(pgn, "utf8"), MAX_PGN_BYTES);
  assert.throws(
    () => parseImportedPgn(pgn),
    (error) => error instanceof ChessError && error.code === "PGN_TOO_LARGE",
  );
});

test("parseImportedPgn canonicalizes comments around move syntax", () => {
  for (const [pgn, comment] of [
    ["1. {between number and move} e4 *", "between number and move"],
    ["1.e4 {between move and nag} $1 e5 *", "between move and nag"],
    [
      "1.e4 a6 2.e5 d5 3.exd6 {before} e.p. $1 cxd6 *",
      "before",
    ],
    ["1.e4 {first} $1 {second} e5 *", "first second"],
    ["1.e4 {first} 1... {second} e5 *", "first second"],
    ["1.e4 {first}$1{second}$2{third}e5*", "first second third"],
  ] as const) {
    assert.equal(parseImportedPgn(pgn).getComments()[0]?.comment, comment);
  }
});

test("parseImportedPgn accepts actual mainline en-passant annotations", () => {
  const chess = parseImportedPgn(
    "1.e4 a6 2.e5 d5 3.exd6 e.p. cxd6 *",
  );
  assert.deepEqual(chess.history(), ["e4", "a6", "e5", "d5", "exd6", "cxd6"]);
  assert.doesNotThrow(() => parseImportedPgn(pgnOf(chess)));

  const attached = parseImportedPgn(
    "1.e4 a6 2.e5 d5 3.exd6 {before};between\n e.p. {after}*",
  );
  assert.deepEqual(attached.history(), ["e4", "a6", "e5", "d5", "exd6"]);
  assert.equal(attached.getComments().at(-1)?.comment, "before between after");
  assert.doesNotThrow(() => parseImportedPgn(pgnOf(attached)));

  for (const [suffix, history] of [
    ["e.p.$1 cxd6*", ["e4", "a6", "e5", "d5", "exd6", "cxd6"]],
    ["e.p.$1$2*", ["e4", "a6", "e5", "d5", "exd6"]],
  ] as const) {
    assert.deepEqual(
      parseImportedPgn(`1.e4 a6 2.e5 d5 3.exd6 ${suffix}`).history(),
      history,
    );
  }
});

test("parseImportedPgn accepts move numbers with additional periods", () => {
  for (const pgn of [
    "1.e4 1..e5 (1....c5) *",
    "1.e4 1. ... e5 (1. ... c5) *",
    "1.e4 1. ..e5 (1. ..c5) *",
  ]) {
    assert.deepEqual(parseImportedPgn(pgn).history(), ["e4", "e5"]);
  }
});

test("parseImportedPgn splits self-delimiting termination markers", () => {
  for (const pgn of ["1.e4*", "1.e40-1", "1.e4$1*"]) {
    assert.deepEqual(parseImportedPgn(pgn).history(), ["e4"]);
  }
  for (const pgn of [
    "1.e4 (1.d4*) *",
    "1.e4 (1.d4$1*) *",
    "1.f3 e5 2.g4 Qh4#1-0",
  ]) {
    assert.throws(
      () => parseImportedPgn(pgn),
      (error) => error instanceof ChessError && error.code === "INVALID_PGN",
    );
  }
});

test("parseImportedPgn splits self-delimiting move annotations", () => {
  for (const pgn of [
    "1.e4$1$2e5*",
    "1.e4$123e5*",
    "1.e4!?e5*",
    "1.e4+e5*",
  ]) {
    assert.deepEqual(parseImportedPgn(pgn).history(), ["e4", "e5"]);
  }
  assert.deepEqual(
    parseImportedPgn(`1.e4${"$1".repeat(8_190)}*`).history(),
    ["e4"],
  );
});

test("parseImportedPgn applies the ply cap across recursive variations", () => {
  const variations = Array.from(
    { length: MAX_PGN_PLIES },
    () => "(1. d4)",
  ).join(" ");

  assert.throws(
    () => parseImportedPgn(`1. e4 ${variations} *`),
    (error) =>
      error instanceof ChessError && error.code === "PGN_TOO_MANY_MOVES",
  );
});

test("parseImportedPgn rejects case-insensitive duplicate Result headers", () => {
  assert.throws(
    () =>
      parseImportedPgn(
        '[Result "1-0"]\n[result "1-0"]\n\n1. e4 1-0',
      ),
    (error) => error instanceof ChessError && error.code === "INVALID_PGN",
  );

  const lowercase = parseImportedPgn('[result "1-0"]\n\n1. e4 1-0');
  const exported = pgnOf(lowercase);
  assert.match(exported, /\[Result "1-0"\]/);
  assert.doesNotMatch(exported, /\[result /);
  assert.doesNotThrow(() => parseImportedPgn(exported));
});

test("parseImportedPgn rejects decisive results for drawn terminal positions", () => {
  for (const fen of [
    "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1",
    "8/8/8/8/8/8/K7/7k w - - 0 1",
  ]) {
    assert.throws(
      () =>
        parseImportedPgn(
          `[SetUp "1"]\n[FEN "${fen}"]\n[Result "1-0"]\n\n1-0`,
        ),
      (error) => error instanceof ChessError && error.code === "INVALID_PGN",
    );
  }
  assert.doesNotThrow(() =>
    parseImportedPgn(
      '[SetUp "1"]\n[FEN "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1"]\n[Result "1/2-1/2"]\n\n1/2-1/2',
    ),
  );

  for (const fen of [
    "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1",
    "8/8/8/8/8/8/K7/7k w - - 0 1",
  ]) {
    assert.throws(
      () =>
        parseImportedPgn(
          `[SetUp "1"]\n[FEN "${fen}"]\n[Result "*"]\n\n*`,
        ),
      (error) => error instanceof ChessError && error.code === "INVALID_PGN",
    );
  }
});

test("parseImportedPgn requires draw results for repetition terminals", () => {
  const moves = "1. Nf3 Nf6 2. Ng1 Ng8 3. Nf3 Nf6 4. Ng1 Ng8";
  for (const result of ["1-0", "0-1", "*"]) {
    assert.throws(
      () => parseImportedPgn(`[Result "${result}"]\n\n${moves} ${result}`),
      (error) => error instanceof ChessError && error.code === "INVALID_PGN",
    );
  }
  assert.doesNotThrow(() =>
    parseImportedPgn(
      `[Result "1/2-1/2"]\n\n${moves} 1/2-1/2`,
    ),
  );
});

test("parseImportedPgn enforces SetUp and FEN pairing", () => {
  for (const pgn of [
    '[SetUp "1"]\n\n*',
    '[SetUp "banana"]\n\n*',
    '[FEN "8/8/8/8/8/8/K7/7k w - - 0 1"]\n\n*',
    '[SetUp "0"]\n[FEN "8/8/8/8/8/8/K7/7k w - - 0 1"]\n\n*',
  ]) {
    assert.throws(
      () => parseImportedPgn(pgn),
      (error) => error instanceof ChessError && error.code === "INVALID_PGN",
    );
  }
  assert.doesNotThrow(() => parseImportedPgn('[SetUp "0"]\n\n*'));
});

test("parseImportedPgn canonicalizes SetUp and FEN header casing", () => {
  const imported = parseImportedPgn(
    '[setup "1"]\n[fen "4k3/8/8/8/8/8/P7/4K3 w - - 0 1"]\n\n*',
  );
  const exported = pgnOf(imported);

  assert.match(exported, /\[SetUp "1"\]/);
  assert.match(exported, /\[FEN "/);
  assert.doesNotMatch(exported, /\[(?:setup|fen) "/);
  assert.doesNotThrow(() => parseImportedPgn(exported));
});

test("parseImportedPgn rejects illegal setup positions", () => {
  assert.throws(
    () =>
      parseImportedPgn(
        '[SetUp "1"]\n[FEN "8/8/8/8/8/8/4k3/R3K3 w - - 0 1"]\n\n*',
      ),
    (error) => error instanceof ChessError && error.code === "INVALID_FEN",
  );
});

test("parseImportedPgn validates FEN counters in setup headers", () => {
  assert.throws(
    () =>
      parseImportedPgn(
        '[SetUp "1"]\n[FEN "8/8/8/8/8/8/K7/7k w - - 0 1e2"]\n\n*',
      ),
    (error) => error instanceof ChessError && error.code === "INVALID_FEN",
  );
});

test("parseImportedPgn rejects counter overflow while replaying moves", () => {
  assert.throws(
    () =>
      parseImportedPgn(
        '[SetUp "1"]\n[FEN "8/8/8/8/8/8/K7/7k b - - 0 9007199254740991"]\n\n9007199254740991... Kh2 *',
      ),
    (error) => error instanceof ChessError && error.code === "INVALID_FEN",
  );
});

test("pgnOf records terminal draws and preserves non-terminal declarations", () => {
  const stalemate = new Chess("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1");
  const exported = pgnOf(stalemate);
  assert.match(exported, /\[Result "1\/2-1\/2"\]/);
  assert.doesNotThrow(() => parseImportedPgn(exported));

  const claimed = parseImportedPgn(
    '[Termination "Black resigned"]\n[Result "1-0"]\n\n1. Nf3 Nf6 2. Ng1 Ng8 1-0',
  );
  assert.match(pgnOf(claimed), /\[Result "1-0"\]/);

  for (const move of ["Nf3", "Nf6", "Ng1", "Ng8"]) claimed.move(move);
  const repetition = pgnOf(claimed);
  assert.match(repetition, /\[Result "1\/2-1\/2"\]/);
  assert.doesNotThrow(() => parseImportedPgn(repetition));

  const stale = parseImportedPgn(
    '[SetUp "1"]\n[FEN "k7/2Q5/2K5/8/8/8/8/8 w - - 0 1"]\n[Result "1-0"]\n\n1-0',
  );
  playParsedMove(stale, parseMove(stale, "Qb6"));
  const normalized = pgnOf(stale);
  assert.match(normalized, /\[Result "1\/2-1\/2"\]/);
  assert.doesNotThrow(() => parseImportedPgn(normalized));
});
