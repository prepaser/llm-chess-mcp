import { Chess } from "chess.js";
import type { Move } from "chess.js";
import { materializeMove } from "./chess-move.js";
import { ChessError } from "./errors.js";
import {
  assertPgnPlyLimit,
  pgnHeaderIndex,
  pgnSetupHeaders,
  replacePgnHeaders,
  terminalPgnResult,
} from "./pgn-shared.js";
import { serializePgn } from "./pgn-serialize.js";
import {
  assertLegalPosition,
  assertSafeFenCounters,
} from "./position-validation.js";

export {
  assertLegalPosition,
  assertSafeFenCounters,
} from "./position-validation.js";

const CHESS_STATE_KEYS = Reflect.ownKeys(new Chess());

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

function expectedInitialFen(
  headers: readonly (readonly [string, string])[],
): string {
  const { fen } = pgnSetupHeaders(pgnHeaderIndex(headers));
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

function commentsByFen(chess: Chess, shadow: Chess): Map<string, string> {
  const getComments = chess.getComments;
  const sourceComments =
    getComments === Chess.prototype.getComments
      ? Chess.prototype.getComments.call(shadow)
      : getComments.call(chess);
  return new Map(
    sourceComments.map(({ fen, comment }) => [
      fen,
      /[{}]/.test(comment) ? comment.replace(/[\r\n]+/g, " ") : comment,
    ]),
  );
}

function replayHistory(
  chess: Chess,
  history: readonly Move[],
  restoreComment: () => void,
): void {
  restoreComment();
  for (const move of history) {
    chess.move(materializeMove(move));
    restoreComment();
  }
}

function assertSnapshotStorageLimits(chess: Chess): void {
  const result = terminalPgnResult(chess);
  const originalResult = chess.getHeaders().Result;
  if (result !== undefined) chess.setHeader("Result", result);
  try {
    const headers = Object.entries(chess.getHeaders());
    serializePgn(
      Chess.prototype.pgn.call(chess),
      headers,
      Chess.prototype.getComments.call(chess).map(({ comment }) => comment),
    );
  } finally {
    if (result !== undefined) {
      if (originalResult === undefined) chess.removeHeader("Result");
      else chess.setHeader("Result", originalResult);
    }
  }
}

function restoreUnsafeComments(
  snapshot: Chess,
  comments: ReadonlyMap<string, string>,
  markerPrefix: string,
  markerComments: readonly string[],
  sourceHeaders: readonly (readonly [string, string])[],
): Chess {
  const escapedPrefix = markerPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const marker = new RegExp(`\\{${escapedPrefix}(\\d+)${escapedPrefix}\\}`, "g");
  const pgn = snapshot.pgn().replace(marker, (_match, index: string) => {
    return `;${markerComments[Number(index)]}\n`;
  });
  const restored = new Chess();
  restored.loadPgn(pgn);
  const restoredHistory = restored.history({ verbose: true });
  while (restored.undo()) {}
  replayHistory(restored, restoredHistory, () => {
    const comment = comments.get(restored.fen());
    if (comment !== undefined && !/[{}]/.test(comment)) {
      restored.setComment(comment);
    }
  });
  replacePgnHeaders(restored, sourceHeaders, { removeMissing: true });
  assertSafeFenCounters(restored.fen());
  return restored;
}

export function snapshotChess(chess: Chess): Chess {
  assertLegalPosition(chess);
  const { history, initialFen, shadow, sourceHeaders } = validatedHistory(chess);
  assertPgnPlyLimit(history.length);
  assertSafeFenCounters(initialFen);
  const snapshot = new Chess(initialFen);
  assertLegalPosition(snapshot);
  const comments = commentsByFen(chess, shadow);
  const unsafeComments = [...comments.values()].some((comment) => /[{}]/.test(comment));
  let markerPrefix = "\uE000";
  if (unsafeComments) {
    const occupied = [...sourceHeaders.flat(), ...comments.values()].join("\u0000");
    while (occupied.includes(markerPrefix)) markerPrefix += "\uE001";
  }
  const markerComments: string[] = [];
  replayHistory(snapshot, history, () => {
    const comment = comments.get(snapshot.fen());
    if (comment === undefined) return;
    if (!unsafeComments || !/[{}]/.test(comment)) {
      snapshot.setComment(comment);
      return;
    }
    const marker = `${markerPrefix}${markerComments.length}${markerPrefix}`;
    markerComments.push(comment);
    snapshot.setComment(marker);
  });
  assertSafeFenCounters(snapshot.fen());
  if (!unsafeComments) {
    replacePgnHeaders(snapshot, sourceHeaders, { removeMissing: true });
    assertSnapshotStorageLimits(snapshot);
    return snapshot;
  }
  const restored = restoreUnsafeComments(
    snapshot,
    comments,
    markerPrefix,
    markerComments,
    sourceHeaders,
  );
  assertSnapshotStorageLimits(restored);
  return restored;
}
