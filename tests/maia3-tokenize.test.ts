import assert from "node:assert/strict";
import test from "node:test";
import { Chess, type PieceSymbol } from "chess.js";
import { buildInput, HISTORY, INPUT_DIM, TOKEN_DIM } from "../src/maia3/tokenize.js";

const PIECE_MAP: Record<PieceSymbol, number> = { p: 1, n: 2, b: 3, r: 4, q: 5, k: 6 };

function boardTokens(fen: string): Float32Array {
  const chess = new Chess(fen);
  const tokens = new Float32Array(64 * TOKEN_DIM);
  const turn = chess.turn();
  const board = chess.board();
  for (let square = 0; square < 64; square++) {
    const rank = Math.floor(square / 8);
    const file = square % 8;
    let piece;
    if (turn === "w") {
      piece = board[7 - rank]?.[file];
    } else {
      const source = board[rank]?.[file];
      piece = source && { type: source.type, color: source.color === "w" ? "b" : "w" };
    }
    if (piece) tokens[square * TOKEN_DIM + PIECE_MAP[piece.type] - 1 + (piece.color === "b" ? 6 : 0)] = 1;
  }
  return tokens;
}

function inputFor(fens: string[]): Float32Array {
  const boards = fens.slice(-HISTORY).map(boardTokens);
  const first = boards[0];
  if (!first) throw new Error("test input requires a position");
  const pad = HISTORY - boards.length;
  const input = new Float32Array(64 * INPUT_DIM);
  for (let square = 0; square < 64; square++) {
    for (let history = 0; history < HISTORY; history++) {
      const board = boards[history - pad] ?? first;
      input.set(board.subarray(square * TOKEN_DIM, (square + 1) * TOKEN_DIM), square * INPUT_DIM + history * TOKEN_DIM);
    }
  }
  return input;
}

function legacyInput(chess: Chess): Float32Array {
  const replay = new Chess();
  const fens = [replay.fen()];
  for (const move of chess.history({ verbose: true })) {
    const spec = move.promotion
      ? { from: move.from, to: move.to, promotion: move.promotion }
      : { from: move.from, to: move.to };
    replay.move(spec);
    fens.push(replay.fen());
  }
  return inputFor(fens);
}

test("preserves normal-game tokenization", () => {
  const games = [
    [],
    ["e4", "e5", "Nf3"],
    ["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Ba4", "Nf6", "O-O"],
  ];
  for (const moves of games) {
    const chess = new Chess();
    for (const move of moves) chess.move(move);

    assert.deepEqual(buildInput(chess), legacyInput(chess));
  }
});

test("uses a custom FEN as the initial position without move history", () => {
  const fen = "8/8/8/8/8/8/7k/K7 w - - 0 1";
  assert.deepEqual(buildInput(new Chess(fen)), inputFor([fen]));
});

test("uses SetUp PGN FEN and move history", () => {
  const fen = "8/8/8/8/8/8/7k/K7 w - - 0 1";
  const chess = new Chess();
  chess.loadPgn(`[SetUp "1"]\n[FEN "${fen}"]\n\n1. Ka2 Kg3 2. Kb3`);

  const moves = chess.history({ verbose: true });
  const first = moves[0];
  assert.ok(first);
  assert.deepEqual(buildInput(chess), inputFor([first.before, ...moves.map((move) => move.after)]));
});

test("uses SetUp PGN FEN even when the PGN has no moves", () => {
  const fen = "8/8/8/8/8/8/7k/K7 w - - 0 1";
  const chess = new Chess();
  chess.loadPgn(`[SetUp "1"]\n[FEN "${fen}"]\n\n*`);

  assert.deepEqual(buildInput(chess), inputFor([fen]));
});
