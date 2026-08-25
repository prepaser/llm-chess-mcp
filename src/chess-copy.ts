import { Chess } from "chess.js";
import type { Move, PieceSymbol, Square } from "chess.js";
import { ChessError } from "./errors.js";

type MoveDescriptor = {
  from: Square;
  to: Square;
  promotion?: PieceSymbol;
};

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
