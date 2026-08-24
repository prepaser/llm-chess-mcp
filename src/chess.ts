import { Chess } from "chess.js";
import type { Move, PieceSymbol, Square } from "chess.js";
import { ChessError } from "./errors.js";
import type { ChessState, DrawResult } from "./types.js";

export const MAX_EVALUATED_MOVES = 10;
export const MAX_PGN_BYTES = 1024 * 1024;
export const MAX_PGN_PLIES = 4096;

type MoveDescriptor = {
  from: Square;
  to: Square;
  promotion?: PieceSymbol;
};

function moveDescriptor(move: Move): MoveDescriptor {
  const base = { from: move.from, to: move.to };
  return move.promotion ? { ...base, promotion: move.promotion } : base;
}

export function snapshotChess(chess: Chess): Chess {
  const history = chess.history({ verbose: true });
  const snapshot = new Chess(history[0]?.before ?? chess.fen());
  for (const move of history) snapshot.move(moveDescriptor(move));
  return snapshot;
}

export function drawResult(chess: Chess): DrawResult | null {
  if (!chess.isDraw()) return null;
  if (chess.isStalemate()) return "stalemate";
  if (chess.isInsufficientMaterial()) return "insufficient_material";
  if (chess.isThreefoldRepetition()) return "threefold_repetition";
  if (chess.isDrawByFiftyMoves()) return "fifty_move_rule";
  return "draw";
}

export function parseImportedPgn(pgn: string): Chess {
  if (Buffer.byteLength(pgn, "utf8") > MAX_PGN_BYTES) {
    throw new ChessError(
      "PGN_TOO_LARGE",
      `PGN exceeds the ${MAX_PGN_BYTES}-byte limit`,
    );
  }

  let chess: Chess;
  try {
    chess = new Chess();
    chess.loadPgn(pgn);
  } catch {
    throw new ChessError("INVALID_PGN", "invalid or illegal PGN");
  }
  if (chess.history().length > MAX_PGN_PLIES) {
    throw new ChessError(
      "PGN_TOO_MANY_MOVES",
      `PGN exceeds the ${MAX_PGN_PLIES}-ply limit`,
    );
  }
  return chess;
}

export function stateOf(chess: Chess, revision: number): ChessState {
  const last = chess.history({ verbose: true }).at(-1);
  return {
    fen: chess.fen(),
    turn: chess.turn(),
    revision,
    isCheck: chess.isCheck(),
    isCheckmate: chess.isCheckmate(),
    isStalemate: chess.isStalemate(),
    isDraw: chess.isDraw(),
    isGameOver: chess.isGameOver(),
    isInsufficientMaterial: chess.isInsufficientMaterial(),
    isThreefoldRepetition: chess.isThreefoldRepetition(),
    isDrawByFiftyMoves: chess.isDrawByFiftyMoves(),
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
  const san = move.replace(/[+#]$/, "");
  const found =
    legal.find((candidate) => candidate.san.replace(/[+#]$/, "") === san) ??
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
