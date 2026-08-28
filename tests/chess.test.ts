import assert from "node:assert/strict";
import test from "node:test";
import { Chess } from "chess.js";
import {
  assertLegalPosition,
  assertSafeFenCounters,
  drawResult,
  parseImportedPgn,
  parseMove,
  pgnOf,
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

test("snapshotChess preserves safe FEN counters exactly", () => {
  const fen = "8/8/8/8/8/8/K7/7k w - - 9007199254740991 9007199254740991";
  const chess = new Chess(fen);

  const snapshot = snapshotChess(chess);

  assert.equal(chess.fen(), fen);
  assert.equal(snapshot.fen(), fen);
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
