import { Chess } from "chess.js";
import type { Color, PieceSymbol, Square } from "chess.js";
import { materializeMove, type MoveDescriptor } from "./chess-move.js";
import { ChessError } from "./errors.js";

const ORIGINAL_PIECES = {
  q: 1,
  r: 2,
  n: 2,
} as const;
const FILES = "abcdefgh";
const CAPTURED_PIECES = ["p", "n", "b", "r", "q"] as const;

type PawnRequirement =
  | { kind: "pawn"; file: number; advances: number }
  | { kind: "bishop"; color: 0 | 1 }
  | { kind: "promotion" };

type PredecessorContext = {
  active: Color;
  currentFen: string;
  currentHalfmove: number;
  fields: string[];
  fullmove: number | null;
  previous: Color;
};

function exactFen(chess: Chess): string {
  return chess.fen({ forceEnpassantSquare: true });
}

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

function squareAt(file: number, rank: number): Square {
  return `${FILES[file]}${rank}` as Square;
}

function squareCoordinates(square: Square): [number, number] {
  return [square.charCodeAt(0) - 97, Number(square[1])];
}

function squaresBetween(from: Square, to: Square): Square[] {
  const [fromFile, fromRank] = squareCoordinates(from);
  const [toFile, toRank] = squareCoordinates(to);
  const fileDistance = toFile - fromFile;
  const rankDistance = toRank - fromRank;
  if (
    fileDistance !== 0 &&
    rankDistance !== 0 &&
    Math.abs(fileDistance) !== Math.abs(rankDistance)
  ) {
    return [];
  }
  const fileStep = Math.sign(fileDistance);
  const rankStep = Math.sign(rankDistance);
  const squares: Square[] = [];
  let file = fromFile + fileStep;
  let rank = fromRank + rankStep;
  while (file !== toFile || rank !== toRank) {
    squares.push(squareAt(file, rank));
    file += fileStep;
    rank += rankStep;
  }
  return squares;
}

function isSafeDecimal(value: string, minimum: number): boolean {
  return (
    /^(?:0|[1-9]\d*)$/.test(value) &&
    Number.isSafeInteger(Number(value)) &&
    Number(value) >= minimum
  );
}

function priorFullmove(fields: string[], previous: Color): number | null {
  const fullmove = fields[5] ?? "";
  if (!isSafeDecimal(fullmove, 1)) return null;
  const value = Number(fullmove) - (previous === "b" ? 1 : 0);
  return value >= 1 ? value : null;
}

function predecessorContext(chess: Chess): PredecessorContext {
  const currentFen = exactFen(chess);
  const fields = currentFen.split(" ");
  const active = chess.turn();
  const previous: Color = active === "w" ? "b" : "w";
  return {
    active,
    currentFen,
    currentHalfmove: Number(fields[4]),
    fields,
    fullmove: priorFullmove(fields, previous),
    previous,
  };
}

function priorChess(
  setup: Chess,
  previous: Color,
  castling: string,
  enPassant: string,
  halfmove: number,
  fullmove: number,
): Chess | null {
  try {
    return new Chess(
      [
        setup.fen().split(" ")[0],
        previous,
        castling,
        enPassant,
        String(halfmove),
        String(fullmove),
      ].join(" "),
    );
  } catch {
    return null;
  }
}

function reachesPosition(
  prior: Chess | null,
  move: MoveDescriptor,
  currentFen: string,
): boolean {
  if (!prior) return false;
  try {
    assertLegalPositionInternal(prior, false);
    prior.move(materializeMove(move));
    return exactFen(prior) === currentFen;
  } catch {
    return false;
  }
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
  const fields = exactFen(chess).split(" ");
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

  const fullmove = fields[5] ?? "";
  if (!isSafeDecimal(fullmove, 1)) {
    throw new ChessError(
      "INVALID_FEN",
      "FEN fullmove number must be a positive safe decimal integer",
    );
  }
  const setup = new Chess(fields.join(" "));
  setup.remove(pawnSquare);
  setup.put({ type: "p", color: pawnColor }, originSquare);
  const previousFullmove = turn === "w" ? Number(fullmove) - 1 : Number(fullmove);
  const prior = new Chess(
    [
      setup.fen().split(" ")[0],
      pawnColor,
      fields[2],
      "-",
      "0",
      String(previousFullmove),
    ].join(" "),
  );
  assertLegalPosition(prior);
  try {
    prior.move(materializeMove({ from: originSquare, to: pawnSquare }));
  } catch {
    throw new ChessError(
      "INVALID_FEN",
      "FEN en passant target does not follow a legal double pawn move",
    );
  }
  const transitioned = exactFen(prior).split(" ");
  transitioned[3] = target;
  if (transitioned.join(" ") !== fields.join(" ")) {
    throw new ChessError(
      "INVALID_FEN",
      "FEN en passant target does not match the previous position",
    );
  }
}

function ordinaryDoubleCheckPredecessor(
  chess: Chess,
  king: Square,
  checkers: Square[],
  context: PredecessorContext,
): boolean {
  const {
    active,
    currentFen,
    currentHalfmove,
    fields,
    fullmove,
    previous,
  } = context;
  if (fullmove === null || !Number.isSafeInteger(currentHalfmove)) return false;

  for (let movedIndex = 0; movedIndex < 2; movedIndex += 1) {
    const to = checkers[movedIndex]!;
    const other = checkers[1 - movedIndex]!;
    const moved = chess.get(to);
    const otherType = chess.get(other)?.type;
    if (
      !moved ||
      moved.color !== previous ||
      (otherType !== "b" && otherType !== "r" && otherType !== "q")
    ) {
      continue;
    }
    for (const from of squaresBetween(other, king)) {
      if (chess.get(from) !== undefined) continue;
      for (const captured of [undefined, ...CAPTURED_PIECES] as const) {
        if (captured === "p" && (to[1] === "1" || to[1] === "8")) continue;
        const halfmove = moved.type === "p" || captured ? 0 : currentHalfmove - 1;
        if (
          halfmove < 0 ||
          ((moved.type === "p" || captured) && currentHalfmove !== 0)
        ) {
          continue;
        }
        const setup = new Chess(currentFen);
        setup.remove(to);
        setup.put(moved, from);
        if (captured) setup.put({ type: captured, color: active }, to);
        const prior = priorChess(
          setup,
          previous,
          fields[2]!,
          "-",
          halfmove,
          fullmove,
        );
        if (reachesPosition(prior, { from, to }, currentFen)) return true;

        const promotionRank = previous === "w" ? "8" : "1";
        const pawnRank = previous === "w" ? "7" : "2";
        if (
          moved.type !== "p" &&
          moved.type !== "k" &&
          to[1] === promotionRank &&
          from[1] === pawnRank
        ) {
          const promotedSetup = new Chess(currentFen);
          promotedSetup.remove(to);
          promotedSetup.put({ type: "p", color: previous }, from);
          if (captured) promotedSetup.put({ type: captured, color: active }, to);
          const promotionPrior = priorChess(
            promotedSetup,
            previous,
            fields[2]!,
            "-",
            0,
            fullmove,
          );
          if (
            currentHalfmove === 0 &&
            reachesPosition(
              promotionPrior,
              { from, to, promotion: moved.type },
              currentFen,
            )
          ) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

function enPassantDoubleCheckPredecessor(
  chess: Chess,
  context: PredecessorContext,
): boolean {
  const { active, currentFen, fields, fullmove, previous } = context;
  if (fields[3] !== "-" || fields[4] !== "0" || fullmove === null) return false;
  const destinationRank = previous === "w" ? 6 : 3;
  const originRank = previous === "w" ? 5 : 4;
  for (const to of chess.findPiece({ type: "p", color: previous })) {
    if (Number(to[1]) !== destinationRank) continue;
    const [toFile] = squareCoordinates(to);
    const capturedSquare = squareAt(toFile, originRank);
    if (chess.get(capturedSquare) !== undefined) continue;
    for (const originFile of [toFile - 1, toFile + 1]) {
      if (originFile < 0 || originFile > 7) continue;
      const from = squareAt(originFile, originRank);
      if (chess.get(from) !== undefined) continue;
      const setup = new Chess(currentFen);
      setup.remove(to);
      setup.put({ type: "p", color: previous }, from);
      setup.put({ type: "p", color: active }, capturedSquare);
      const prior = priorChess(
        setup,
        previous,
        fields[2]!,
        to,
        0,
        fullmove,
      );
      if (reachesPosition(prior, { from, to }, currentFen)) return true;
    }
  }
  return false;
}

function hasDoubleCheckPredecessor(
  chess: Chess,
  king: Square,
  checkers: Square[],
): boolean {
  const context = predecessorContext(chess);
  if (context.fields[3] !== "-") return true;
  return (
    ordinaryDoubleCheckPredecessor(chess, king, checkers, context) ||
    enPassantDoubleCheckPredecessor(chess, context)
  );
}

function assertMaterialPosition(chess: Chess, color: Color): void {
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
        chess.findPiece({ type: type as PieceSymbol, color }).length - original,
      ),
    0,
  );
  const promotedBishops = [0, 1].map((squareColorValue) =>
    Math.max(
      0,
      chess
        .findPiece({ type: "b", color })
        .filter((square) => squareColor(square) === squareColorValue).length - 1,
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
    minimumPawnCaptures(chess, color, promotedPieces, promotedBishops) >
    missingOpponentMaterial
  ) {
    throw new ChessError(
      "INVALID_FEN",
      "FEN pawn files require more captures than opposing material allows",
    );
  }
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
  assertLegalPositionInternal(chess, true);
}

function assertLegalPositionInternal(
  chess: Chess,
  validateDoubleCheck: boolean,
): void {
  for (const color of ["w", "b"] as const) {
    if (chess.findPiece({ type: "k", color }).length !== 1) {
      throw new ChessError(
        "INVALID_FEN",
        "FEN must contain exactly one king per side",
      );
    }
    assertMaterialPosition(chess, color);
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
  if (!king) return;
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
  if (
    validateDoubleCheck &&
    checkers.length === 2 &&
    !hasDoubleCheckPredecessor(chess, king, checkers)
  ) {
    throw new ChessError(
      "INVALID_FEN",
      "FEN double check has no legal previous move",
    );
  }
}
