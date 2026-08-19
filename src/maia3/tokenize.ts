import { Chess, type PieceSymbol } from "chess.js";

const PIECE_MAP: Record<PieceSymbol, number> = { p: 1, n: 2, b: 3, r: 4, q: 5, k: 6 };

export const HISTORY = 8;
export const TOKEN_DIM = 12;
export const INPUT_DIM = TOKEN_DIM * HISTORY;

function tokenizeBoard(chess: Chess): Float32Array {
  const tokens = new Float32Array(64 * TOKEN_DIM);
  const turn = chess.turn();
  const board = chess.board();
  for (let s = 0; s < 64; s++) {
    const rank = Math.floor(s / 8);
    const file = s % 8;
    let piece;
    if (turn === "w") {
      piece = board[7 - rank]?.[file];
    } else {
      const p = board[rank]?.[file];
      piece = p ? { type: p.type, color: p.color === "w" ? "b" : "w" } : null;
    }
    if (piece) {
      const mapped = PIECE_MAP[piece.type];
      const token = mapped + (piece.color === "b" ? 6 : 0);
      tokens[s * TOKEN_DIM + (token - 1)] = 1;
    }
  }
  return tokens;
}

function historyPositions(chess: Chess): Chess[] {
  const moves = chess.history({ verbose: true });
  if (moves.length >= HISTORY) return moves.slice(-HISTORY).map((move) => new Chess(move.after));
  const first = moves[0];
  if (first) return [new Chess(first.before), ...moves.map((move) => new Chess(move.after))];

  const headers = chess.getHeaders();
  const initialFen = headers.SetUp === "1" && headers.FEN ? headers.FEN : chess.fen();
  return [new Chess(initialFen)];
}

export function buildInput(chess: Chess): Float32Array {
  const positions = historyPositions(chess);
  const recent = positions.slice(-HISTORY);
  const boards = recent.map(tokenizeBoard);
  const first = boards[0];
  if (!first) throw new Error("Maia3 history must contain a position");
  const pad = HISTORY - boards.length;
  const input = new Float32Array(64 * INPUT_DIM);
  for (let s = 0; s < 64; s++) {
    for (let h = 0; h < HISTORY; h++) {
      const idx = h - pad;
      const board = idx < 0 ? first : (boards[idx] ?? first);
      const start = s * TOKEN_DIM;
      input.set(board.subarray(start, start + TOKEN_DIM), s * INPUT_DIM + h * TOKEN_DIM);
    }
  }
  return input;
}
