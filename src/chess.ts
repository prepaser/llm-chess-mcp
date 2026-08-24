import { Chess } from "chess.js";
import type { Move, PieceSymbol, Square } from "chess.js";
import { ChessError } from "./errors.js";
import type { ChessState, DrawResult } from "./types.js";

export const MAX_EVALUATED_MOVES = 10;
export const MAX_PGN_BYTES = 1024 * 1024;
export const MAX_PGN_PLIES = 4096;

const PGN_RESULTS = ["1-0", "0-1", "1/2-1/2", "*"] as const;

type PgnResult = (typeof PGN_RESULTS)[number];

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

export function drawResult(chess: Chess): DrawResult | null {
  if (!chess.isDraw()) return null;
  if (chess.isStalemate()) return "stalemate";
  if (chess.isInsufficientMaterial()) return "insufficient_material";
  if (chess.isThreefoldRepetition()) return "threefold_repetition";
  if (chess.isDrawByFiftyMoves()) return "fifty_move_rule";
  return "draw";
}

function withoutPgnComments(pgn: string): string {
  let result = "";
  let braceComment = false;
  let lineComment = false;
  let quoted = false;
  let escaped = false;

  for (const char of pgn) {
    if (braceComment) {
      if (char === "}") braceComment = false;
      result += char === "\n" || char === "\r" ? char : " ";
      continue;
    }
    if (lineComment) {
      if (char === "\n" || char === "\r") {
        lineComment = false;
        result += char;
      } else {
        result += " ";
      }
      continue;
    }
    if (quoted) {
      result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      result += char;
      continue;
    }
    if (char === "{") {
      braceComment = true;
      result += " ";
    } else if (char === ";") {
      lineComment = true;
      result += " ";
    } else {
      result += char;
    }
  }
  return result;
}

function isPgnResult(value: string): value is PgnResult {
  return (PGN_RESULTS as readonly string[]).includes(value);
}

function declaredPgnResult(pgn: string): PgnResult | undefined {
  const visiblePgn = withoutPgnComments(pgn);
  const headerResults = [
    ...visiblePgn.matchAll(
      /^\s*\[\s*Result\s+"((?:\\.|[^"\\])*)"\s*\]\s*$/gm,
    ),
  ].map((match) => match[1] ?? "");
  const movetext = visiblePgn.replace(/^\s*\[[^\r\n]*\]\s*$/gm, "");
  const markers = [
    ...movetext.matchAll(/(?:^|\s)(1-0|0-1|1\/2-1\/2|\*)(?=\s|$)/g),
  ].map((match) => match[1] ?? "");
  const results = [...headerResults, ...markers];

  if (!results.every(isPgnResult)) {
    throw new ChessError("INVALID_PGN", "invalid PGN result");
  }
  const result = results[0];
  if (results.some((value) => value !== result)) {
    throw new ChessError("INVALID_PGN", "PGN result header and marker disagree");
  }
  return result;
}

function validatePgnFenCounters(pgn: string): void {
  for (const match of withoutPgnComments(pgn).matchAll(
    /^\s*\[\s*FEN\s+"((?:\\.|[^"\\])*)"\s*\]\s*$/gim,
  )) {
    assertSafeFenCounters(match[1] ?? "");
  }
}

function validateResultForPosition(chess: Chess, result: PgnResult | undefined): void {
  if (result === undefined) return;

  if (chess.isCheckmate()) {
    const expected = chess.turn() === "w" ? "0-1" : "1-0";
    if (result === expected) return;
    throw new ChessError(
      "INVALID_PGN",
      `checkmate result must be ${expected}`,
    );
  }

  if (
    (chess.isStalemate() || chess.isInsufficientMaterial()) &&
    (result === "1-0" || result === "0-1")
  ) {
    throw new ChessError(
      "INVALID_PGN",
      "a drawn position cannot have a decisive result",
    );
  }
}

export function pgnOf(chess: Chess): string {
  const result = chess.isCheckmate()
    ? (chess.turn() === "w" ? "0-1" : "1-0")
    : chess.isDraw() && (!chess.getHeaders().Result || chess.getHeaders().Result === "*")
      ? "1/2-1/2"
      : undefined;
  if (result === undefined) return chess.pgn();

  const snapshot = snapshotChess(chess);
  snapshot.setHeader("Result", result);
  return snapshot.pgn();
}

export function parseImportedPgn(pgn: string): Chess {
  if (Buffer.byteLength(pgn, "utf8") > MAX_PGN_BYTES) {
    throw new ChessError(
      "PGN_TOO_LARGE",
      `PGN exceeds the ${MAX_PGN_BYTES}-byte limit`,
    );
  }
  validatePgnFenCounters(pgn);
  const result = declaredPgnResult(pgn);

  let chess: Chess;
  try {
    chess = new Chess();
    chess.loadPgn(pgn);
  } catch {
    throw new ChessError("INVALID_PGN", "invalid or illegal PGN");
  }
  assertSafeFenCounters(chess.fen());
  if (chess.history().length > MAX_PGN_PLIES) {
    throw new ChessError(
      "PGN_TOO_MANY_MOVES",
      `PGN exceeds the ${MAX_PGN_PLIES}-ply limit`,
    );
  }
  validateResultForPosition(chess, result);
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
