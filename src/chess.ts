import { Chess } from "chess.js";
import type { Move, PieceSymbol, Square } from "chess.js";
export {
  assertLegalPosition,
  assertSafeFenCounters,
  snapshotChess,
} from "./chess-copy.js";
export { MAX_PGN_BYTES, MAX_PGN_PLIES, parseImportedPgn, pgnOf } from "./pgn.js";
import { ChessError } from "./errors.js";
import type { ChessState, DrawResult } from "./domain.js";

export const MAX_EVALUATED_MOVES = 10;

type MoveDescriptor = {
  from: Square;
  to: Square;
  promotion?: PieceSymbol;
};

function moveDescriptor(move: Move): MoveDescriptor {
  const base = { from: move.from, to: move.to };
  return move.promotion ? { ...base, promotion: move.promotion } : base;
}

export function drawResult(chess: Chess): DrawResult | null {
  if (chess.isCheckmate() || !chess.isDraw()) return null;
  if (chess.isStalemate()) return "stalemate";
  if (chess.isInsufficientMaterial()) return "insufficient_material";
  if (chess.isThreefoldRepetition()) return "threefold_repetition";
  if (chess.isDrawByFiftyMoves()) return "fifty_move_rule";
  return "draw";
}

export function stateOf<Revision extends number>(
  chess: Chess,
  revision: Revision,
): ChessState & { revision: Revision } {
  const last = chess.history({ verbose: true }).at(-1);
  const isCheckmate = chess.isCheckmate();
  return {
    fen: chess.fen(),
    turn: chess.turn(),
    revision,
    isCheck: chess.isCheck(),
    isCheckmate,
    isStalemate: chess.isStalemate(),
    isDraw: !isCheckmate && chess.isDraw(),
    isGameOver: chess.isGameOver(),
    isInsufficientMaterial: !isCheckmate && chess.isInsufficientMaterial(),
    isThreefoldRepetition: !isCheckmate && chess.isThreefoldRepetition(),
    isDrawByFiftyMoves: !isCheckmate && chess.isDrawByFiftyMoves(),
    moveNumber: chess.moveNumber(),
    history: chess.history(),
    lastMove: last ? { san: last.san, uci: last.lan } : null,
    castling: {
      whiteKingside: chess.getCastlingRights("w").k,
      whiteQueenside: chess.getCastlingRights("w").q,
      blackKingside: chess.getCastlingRights("b").k,
      blackQueenside: chess.getCastlingRights("b").q,
    },
  };
}

export function parseMove(chess: Chess, move: string): Move {
  const legal = chess.moves({ verbose: true });
  const found =
    legal.find((candidate) => candidate.san === move) ??
    (!/[+#]$/.test(move)
      ? legal.find(
          (candidate) => candidate.san.replace(/[+#]$/, "") === move,
        )
      : undefined) ??
    legal.find((candidate) => candidate.lan === move);
  if (!found) throw new ChessError("ILLEGAL_MOVE", `illegal move: ${move}`);
  return found;
}

export function playParsedMove(chess: Chess, move: Move): Move {
  return chess.move(moveDescriptor(move));
}

export function pvToSan(chess: Chess, pv: readonly string[]): string[] {
  const copy = new Chess(chess.fen());
  const san: string[] = [];
  for (const uci of pv) {
    try {
      const move = parseMove(copy, uci);
      san.push(move.san);
      playParsedMove(copy, move);
    } catch (error) {
      if (!(error instanceof ChessError)) throw error;
      break;
    }
  }
  return san;
}
