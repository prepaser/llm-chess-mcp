import { Chess } from "chess.js";
import {
  assertLegalPosition,
  assertSafeFenCounters,
  snapshotChess,
} from "./chess-copy.js";
import { ChessError } from "./errors.js";

export const MAX_PGN_BYTES = 1024 * 1024;
export const MAX_PGN_PLIES = 4096;

const PGN_RESULTS = ["1-0", "0-1", "1/2-1/2", "*"] as const;

type PgnResult = (typeof PGN_RESULTS)[number];

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

function headerValues(pgn: string, name: string): string[] {
  const visiblePgn = withoutPgnComments(pgn);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    ...visiblePgn.matchAll(
      new RegExp(
        `^\\s*\\[\\s*${escaped}\\s+"((?:\\\\.|[^"\\\\])*)"\\s*\\]\\s*$`,
        "gim",
      ),
    ),
  ].map((match) => match[1] ?? "");
}

function validatePgnSetup(pgn: string): void {
  const setup = headerValues(pgn, "SetUp");
  const fens = headerValues(pgn, "FEN");
  if (setup.length > 1 || fens.length > 1) {
    throw new ChessError(
      "INVALID_PGN",
      "PGN must not repeat SetUp or FEN headers",
    );
  }

  const setupValue = setup[0];
  if (setupValue !== undefined && setupValue !== "0" && setupValue !== "1") {
    throw new ChessError("INVALID_PGN", "PGN SetUp must be 0 or 1");
  }
  if ((setupValue === "1") !== (fens.length === 1)) {
    throw new ChessError(
      "INVALID_PGN",
      "PGN SetUp 1 and FEN headers must appear together",
    );
  }

  const fen = fens[0];
  if (fen !== undefined) {
    assertSafeFenCounters(fen);
    let chess: Chess;
    try {
      chess = new Chess(fen);
    } catch {
      throw new ChessError("INVALID_FEN", "invalid FEN");
    }
    assertLegalPosition(chess);
  }
}

function canonicalizeSetupHeaders(chess: Chess): void {
  const headers = chess.getHeaders();
  for (const canonical of ["SetUp", "FEN"] as const) {
    const entry = Object.entries(headers).find(
      ([key]) => key.toLowerCase() === canonical.toLowerCase(),
    );
    for (const key of Object.keys(headers)) {
      if (key !== canonical && key.toLowerCase() === canonical.toLowerCase()) {
        chess.removeHeader(key);
      }
    }
    if (entry) chess.setHeader(canonical, entry[1]);
  }
}

function validateResultForPosition(chess: Chess, result: PgnResult | undefined): void {
  if (result === undefined) return;

  if (chess.isCheckmate()) {
    const expected = chess.turn() === "w" ? "0-1" : "1-0";
    if (result === expected) return;
    throw new ChessError("INVALID_PGN", `checkmate result must be ${expected}`);
  }

  if (chess.isDraw() && result !== "1/2-1/2") {
    throw new ChessError(
      "INVALID_PGN",
      "a terminal draw must have result 1/2-1/2",
    );
  }
}

export function pgnOf(chess: Chess): string {
  const result = chess.isCheckmate()
    ? (chess.turn() === "w" ? "0-1" : "1-0")
    : chess.isDraw()
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
  validatePgnSetup(pgn);
  const result = declaredPgnResult(pgn);

  let chess: Chess;
  try {
    chess = new Chess();
    chess.loadPgn(pgn);
  } catch {
    throw new ChessError("INVALID_PGN", "invalid or illegal PGN");
  }
  canonicalizeSetupHeaders(chess);
  assertSafeFenCounters(chess.fen());
  assertLegalPosition(chess);
  if (chess.history().length > MAX_PGN_PLIES) {
    throw new ChessError(
      "PGN_TOO_MANY_MOVES",
      `PGN exceeds the ${MAX_PGN_PLIES}-ply limit`,
    );
  }
  validateResultForPosition(chess, result);
  return chess;
}
