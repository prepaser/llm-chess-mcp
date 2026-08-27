import { Chess } from "chess.js";
import type { Color, Move, PieceSymbol, Square } from "chess.js";
import { ChessError } from "./errors.js";

type MoveDescriptor = {
  from: Square;
  to: Square;
  promotion?: PieceSymbol;
};

const ORIGINAL_PIECES = {
  q: 1,
  r: 2,
  b: 2,
  n: 2,
} as const;

function hasPiece(
  chess: Chess,
  square: Square,
  type: PieceSymbol,
  color: Color,
): boolean {
  const piece = chess.get(square);
  return piece?.type === type && piece.color === color;
}

function assertCastlingPosition(chess: Chess, color: Color): void {
  const rank = color === "w" ? "1" : "8";
  const rights = chess.getCastlingRights(color);
  if (
    (rights.k || rights.q) &&
    !hasPiece(chess, `e${rank}` as Square, "k", color)
  ) {
    throw new ChessError(
      "INVALID_FEN",
      "FEN castling rights require a home king",
    );
  }
  if (rights.k && !hasPiece(chess, `h${rank}` as Square, "r", color)) {
    throw new ChessError(
      "INVALID_FEN",
      "FEN kingside castling rights require a home rook",
    );
  }
  if (rights.q && !hasPiece(chess, `a${rank}` as Square, "r", color)) {
    throw new ChessError(
      "INVALID_FEN",
      "FEN queenside castling rights require a home rook",
    );
  }
}

function assertEnPassantPosition(chess: Chess): void {
  const fields = chess.fen({ forceEnpassantSquare: true }).split(" ");
  const target = fields[3];
  if (!target || target === "-") return;

  const turn = chess.turn();
  const file = target[0];
  const targetRank = turn === "w" ? "6" : "3";
  const pawnRank = turn === "w" ? "5" : "4";
  const originRank = turn === "w" ? "7" : "2";
  const pawnColor: Color = turn === "w" ? "b" : "w";
  const targetSquare = target as Square;
  const pawnSquare = `${file}${pawnRank}` as Square;
  const originSquare = `${file}${originRank}` as Square;
  if (
    target[1] !== targetRank ||
    chess.get(targetSquare) !== undefined ||
    !hasPiece(chess, pawnSquare, "p", pawnColor) ||
    chess.get(originSquare) !== undefined ||
    fields[4] !== "0"
  ) {
    throw new ChessError(
      "INVALID_FEN",
      "FEN en passant target does not match a double pawn move",
    );
  }
}

function moveDescriptor(move: Move): MoveDescriptor {
  const base = { from: move.from, to: move.to };
  return move.promotion ? { ...base, promotion: move.promotion } : base;
}

function isSafeDecimal(value: string, minimum: number): boolean {
  return (
    /^(?:0|[1-9]\d*)$/.test(value) &&
    Number.isSafeInteger(Number(value)) &&
    Number(value) >= minimum
  );
}

export function assertSafeFenCounters(fen: string): void {
  const fields = fen.split(/\s+/);
  if (fields.length >= 5 && !isSafeDecimal(fields[4] ?? "", 0)) {
    throw new ChessError(
      "INVALID_FEN",
      "FEN halfmove clock must be a non-negative safe decimal integer",
    );
  }
  if (fields.length >= 6 && !isSafeDecimal(fields[5] ?? "", 1)) {
    throw new ChessError(
      "INVALID_FEN",
      "FEN fullmove number must be a positive safe decimal integer",
    );
  }
}

export function assertLegalPosition(chess: Chess): void {
  for (const color of ["w", "b"] as const) {
    if (chess.findPiece({ type: "k", color }).length !== 1) {
      throw new ChessError(
        "INVALID_FEN",
        "FEN must contain exactly one king per side",
      );
    }
    const pawns = chess.findPiece({ type: "p", color });
    if (pawns.some((square) => square[1] === "1" || square[1] === "8")) {
      throw new ChessError(
        "INVALID_FEN",
        "FEN pawns cannot occupy the first or eighth rank",
      );
    }
    if (pawns.length > 8) {
      throw new ChessError(
        "INVALID_FEN",
        "FEN cannot contain more than eight pawns per side",
      );
    }
    const promoted = Object.entries(ORIGINAL_PIECES).reduce(
      (total, [type, original]) =>
        total +
        Math.max(
          0,
          chess.findPiece({ type: type as PieceSymbol, color }).length -
            original,
        ),
      0,
    );
    if (promoted > 8 - pawns.length) {
      throw new ChessError(
        "INVALID_FEN",
        "FEN contains more promoted material than missing pawns allow",
      );
    }
    assertCastlingPosition(chess, color);
  }

  assertEnPassantPosition(chess);

  const turn = chess.turn();
  const previous: Color = turn === "w" ? "b" : "w";
  const previousKing = chess.findPiece({ type: "k", color: previous })[0];
  if (previousKing && chess.isAttacked(previousKing, turn)) {
    throw new ChessError(
      "INVALID_FEN",
      "FEN cannot leave the side that just moved in check",
    );
  }
}

export function snapshotChess(chess: Chess): Chess {
  const history = chess.history({ verbose: true });
  const initialFen = history[0]?.before ?? chess.fen();
  assertSafeFenCounters(initialFen);
  const snapshot = new Chess(initialFen);
  const comments = new Map(
    chess.getComments().map(({ fen, comment }) => [fen, comment]),
  );
  for (const [key, value] of Object.entries(chess.getHeaders())) {
    snapshot.setHeader(key, value);
  }
  const restoreComment = () => {
    const comment = comments.get(snapshot.fen());
    if (comment !== undefined) snapshot.setComment(comment);
  };
  restoreComment();
  for (const move of history) {
    snapshot.move(moveDescriptor(move));
    restoreComment();
  }
  assertSafeFenCounters(snapshot.fen());
  return snapshot;
}
