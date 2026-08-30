import type { PieceSymbol, Square } from "chess.js";

export type MoveDescriptor = {
  from: Square;
  to: Square;
  promotion?: PieceSymbol;
};

export function materializeMove(move: MoveDescriptor): MoveDescriptor {
  const { from, to, promotion } = move;
  return promotion ? { from, to, promotion } : { from, to };
}
