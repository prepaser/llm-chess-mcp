import { Chess } from "chess.js";
import type { Color, Move, PieceSymbol, Square } from "chess.js";
import { ChessError } from "./errors.js";
import { assertPgnPlyLimit, replacePgnHeaders } from "./pgn-shared.js";

type MoveDescriptor = {
  from: Square;
  to: Square;
  promotion?: PieceSymbol;
};

const ORIGINAL_PIECES = {
  q: 1,
  r: 2,
  n: 2,
} as const;

const CHESS_STATE_KEYS = Reflect.ownKeys(new Chess());

type PawnRequirement =
  | { kind: "pawn"; file: number; advances: number }
  | { kind: "bishop"; color: 0 | 1 }
  | { kind: "promotion" };

function squareColor(square: Square): 0 | 1 {
  return ((square.charCodeAt(0) - 97 + Number(square[1])) % 2) as 0 | 1;
}

function minimumPawnCaptures(
  chess: Chess,
  color: Color,
  promotedPieces: number,
  promotedBishops: readonly [number, number],
): number {
  const requirements: PawnRequirement[] = chess
    .findPiece({ type: "p", color })
    .map((square) => ({
      kind: "pawn" as const,
      advances:
        color === "w" ? Number(square[1]) - 2 : 7 - Number(square[1]),
      file: square.charCodeAt(0) - 97,
    }));
  for (const bishopColor of [0, 1] as const) {
    for (let count = 0; count < promotedBishops[bishopColor]; count += 1) {
      requirements.push({ kind: "bishop", color: bishopColor });
    }
  }
  for (let count = 0; count < promotedPieces; count += 1) {
    requirements.push({ kind: "promotion" });
  }

  let costs = new Map<number, number>([[0, 0]]);
  for (const requirement of requirements) {
    const next = new Map<number, number>();
    for (const [mask, cost] of costs) {
      for (let original = 0; original < 8; original += 1) {
        const bit = 1 << original;
        if (mask & bit) continue;
        let captures = 0;
        if (requirement.kind === "pawn") {
          captures = Math.abs(original - requirement.file);
          if (captures > requirement.advances) continue;
        } else if (requirement.kind === "bishop") {
          const promotionRank = color === "w" ? 8 : 1;
          const promotionColor = ((original + promotionRank) % 2) as 0 | 1;
          captures = promotionColor === requirement.color ? 0 : 1;
        }
        const nextMask = mask | bit;
        next.set(nextMask, Math.min(next.get(nextMask) ?? Infinity, cost + captures));
      }
    }
    costs = next;
  }
  return Math.min(...costs.values());
}

function nonKingMaterial(chess: Chess, color: Color): number {
  return (["p", "q", "r", "b", "n"] as const).reduce(
    (total, type) => total + chess.findPiece({ type, color }).length,
    0,
  );
}

function clonedChess(chess: Chess): Chess {
  const state = Object.create(null) as Record<PropertyKey, unknown>;
  for (const key of CHESS_STATE_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(chess, key);
    if (!descriptor || !("value" in descriptor)) {
      throw new ChessError("INVALID_FEN", "chess state cannot be cloned");
    }
    Object.defineProperty(state, key, {
      configurable: true,
      enumerable: true,
      value: descriptor.value,
      writable: true,
    });
  }

  try {
    const clone = structuredClone(state) as unknown as Chess;
    Object.setPrototypeOf(clone, Chess.prototype);
    return clone;
  } catch {
    throw new ChessError("INVALID_FEN", "chess state cannot be cloned");
  }
}

function exactFen(chess: Chess): string {
  return chess.fen({ forceEnpassantSquare: true });
}

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
    fields[4] !== "0" ||
    (turn === "w" && fields[5] === "1")
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
    const promotedPieces = Object.entries(ORIGINAL_PIECES).reduce(
      (total, [type, original]) =>
        total +
        Math.max(
          0,
          chess.findPiece({ type: type as PieceSymbol, color }).length -
            original,
        ),
      0,
    );
    const promotedBishops = [0, 1].map((squareColorValue) =>
      Math.max(
        0,
        chess
          .findPiece({ type: "b", color })
          .filter((square) => squareColor(square) === squareColorValue)
          .length - 1,
      ),
    ) as [number, number];
    const promoted = promotedPieces + promotedBishops[0] + promotedBishops[1];
    if (promoted > 8 - pawns.length) {
      throw new ChessError(
        "INVALID_FEN",
        "FEN contains more promoted material than missing pawns allow",
      );
    }
    assertCastlingPosition(chess, color);

    const opponent: Color = color === "w" ? "b" : "w";
    const missingOpponentMaterial = 15 - nonKingMaterial(chess, opponent);
    if (
      minimumPawnCaptures(
        chess,
        color,
        promotedPieces,
        promotedBishops,
      ) > missingOpponentMaterial
    ) {
      throw new ChessError(
        "INVALID_FEN",
        "FEN pawn files require more captures than opposing material allows",
      );
    }
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

  const king = chess.findPiece({ type: "k", color: turn })[0];
  if (king) {
    const checkers = chess.attackers(king, previous);
    const leapers = checkers.filter((square) => {
      const type = chess.get(square)?.type;
      return type === "k" || type === "n" || type === "p";
    });
    if (checkers.length > 2 || leapers.length > 1) {
      throw new ChessError(
        "INVALID_FEN",
        "FEN contains an impossible check topology",
      );
    }
  }
}

function expectedInitialFen(
  headers: readonly (readonly [string, string])[],
): string {
  const values = new Map<string, string>();
  for (const [name, value] of headers) {
    const key = name.toLowerCase();
    if (values.has(key)) {
      throw new ChessError(
        "INVALID_PGN",
        `PGN must not repeat ${name} headers`,
      );
    }
    values.set(key, value);
  }

  const setup = values.get("setup");
  const fen = values.get("fen");
  if (setup !== undefined && setup !== "0" && setup !== "1") {
    throw new ChessError("INVALID_PGN", "PGN SetUp must be 0 or 1");
  }
  if ((setup === "1") !== (fen !== undefined)) {
    throw new ChessError(
      "INVALID_PGN",
      "PGN SetUp 1 and FEN headers must appear together",
    );
  }
  if (fen === undefined) return exactFen(new Chess());

  assertSafeFenCounters(fen);
  let initial: Chess;
  try {
    initial = new Chess(fen);
  } catch {
    throw new ChessError("INVALID_FEN", "invalid FEN");
  }
  assertLegalPosition(initial);
  return exactFen(initial);
}

function validatedHistory(chess: Chess): {
  history: Move[];
  initialFen: string;
  shadow: Chess;
  sourceHeaders: [string, string][];
} {
  const sourceFen = exactFen(chess);
  const sourceHeaders = Object.entries(chess.getHeaders());
  const shadow = clonedChess(chess);
  const history = Chess.prototype.history.call(shadow, {
    verbose: true,
  }) as Move[];
  if (history.some((move) => move.from === move.to)) {
    throw new ChessError("INVALID_PGN", "null moves are not supported");
  }
  if (exactFen(shadow) !== sourceFen) {
    throw new ChessError(
      "INVALID_FEN",
      "current position does not match move history",
    );
  }

  const initial = clonedChess(chess);
  while (Chess.prototype.undo.call(initial)) {}
  const initialFen = exactFen(initial);
  if (initialFen !== expectedInitialFen(sourceHeaders)) {
    throw new ChessError(
      "INVALID_PGN",
      "move history does not match PGN setup headers",
    );
  }
  return { history, initialFen, shadow, sourceHeaders };
}

export function snapshotChess(chess: Chess): Chess {
  assertLegalPosition(chess);
  const { history, initialFen, shadow, sourceHeaders } = validatedHistory(chess);
  assertPgnPlyLimit(history.length);
  assertSafeFenCounters(initialFen);
  const snapshot = new Chess(initialFen);
  assertLegalPosition(snapshot);
  const getComments = chess.getComments;
  const sourceComments =
    getComments === Chess.prototype.getComments
      ? Chess.prototype.getComments.call(shadow)
      : getComments.call(chess);
  const comments = new Map(
    sourceComments.map(({ fen, comment }) => [
      fen,
      /[{}]/.test(comment) ? comment.replace(/[\r\n]+/g, " ") : comment,
    ]),
  );
  const unsafeComments = [...comments.values()].some((comment) => /[{}]/.test(comment));
  let markerPrefix = "\uE000";
  if (unsafeComments) {
    const occupied = [...sourceHeaders.flat(), ...comments.values()].join("\u0000");
    while (occupied.includes(markerPrefix)) markerPrefix += "\uE001";
  }
  const markerComments: string[] = [];
  const restoreComment = () => {
    const comment = comments.get(snapshot.fen());
    if (comment === undefined) return;
    if (!unsafeComments || !/[{}]/.test(comment)) {
      snapshot.setComment(comment);
      return;
    }
    const marker = `${markerPrefix}${markerComments.length}${markerPrefix}`;
    markerComments.push(comment);
    snapshot.setComment(marker);
  };
  restoreComment();
  for (const move of history) {
    snapshot.move(moveDescriptor(move));
    restoreComment();
  }
  assertSafeFenCounters(snapshot.fen());
  if (!unsafeComments) {
    replacePgnHeaders(snapshot, sourceHeaders, { removeMissing: true });
    return snapshot;
  }

  const escapedPrefix = markerPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const marker = new RegExp(`\\{${escapedPrefix}(\\d+)${escapedPrefix}\\}`, "g");
  const pgn = snapshot.pgn().replace(marker, (_match, index: string) => {
    return `;${markerComments[Number(index)]}\n`;
  });
  const restored = new Chess();
  restored.loadPgn(pgn);
  const restoredHistory = restored.history({ verbose: true });
  while (restored.undo()) {}
  const restoreSafeComment = () => {
    const comment = comments.get(restored.fen());
    if (comment !== undefined && !/[{}]/.test(comment)) {
      restored.setComment(comment);
    }
  };
  restoreSafeComment();
  for (const move of restoredHistory) {
    restored.move(moveDescriptor(move));
    restoreSafeComment();
  }
  replacePgnHeaders(restored, sourceHeaders, { removeMissing: true });
  assertSafeFenCounters(restored.fen());
  return restored;
}
