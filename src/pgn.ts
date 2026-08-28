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

type PgnHeader = { name: string; value: string };

const CANONICAL_HEADERS = new Map(
  [
    "Event",
    "Site",
    "Date",
    "Round",
    "White",
    "Black",
    "Result",
    "SetUp",
    "FEN",
  ].map((name) => [name.toLowerCase(), name]),
);

const TAG_LINE = /^(\s*\[\s*)([A-Za-z0-9_]+)(\s+")((?:\\.|[^"\\])*)("\s*\]\s*)$/;

function stripBom(pgn: string): string {
  return pgn.startsWith("\uFEFF") ? pgn.slice(1) : pgn;
}

function decodeHeaderValue(value: string): string {
  let decoded = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (char !== "\\") {
      decoded += char;
      continue;
    }
    const escaped = value[index + 1];
    if (escaped !== '"' && escaped !== "\\") {
      throw new ChessError("INVALID_PGN", "invalid PGN header escape");
    }
    decoded += escaped;
    index += 1;
  }
  return decoded;
}

function encodeHeaderValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function prepareHeaders(pgn: string): {
  headers: PgnHeader[];
  loaderPgn: string;
  movetextPgn: string;
} {
  const headers: PgnHeader[] = [];
  const names = new Set<string>();
  let loaderPgn = "";
  let movetextPgn = "";
  let headerSection = true;
  let sawHeader = false;
  const lines = pgn.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? [];
  for (const line of lines) {
    if (!line) continue;
    const ending = line.endsWith("\r\n")
      ? "\r\n"
      : line.endsWith("\r")
        ? "\r"
        : line.endsWith("\n")
          ? "\n"
          : "";
    const content = ending ? line.slice(0, -ending.length) : line;
    const match = headerSection ? TAG_LINE.exec(content) : null;
    if (match) {
      sawHeader = true;
      const [, , name = "", , raw = ""] = match;
      const key = name.toLowerCase();
      if (names.has(key)) {
        throw new ChessError(
          "INVALID_PGN",
          `PGN must not repeat ${name} headers`,
        );
      }
      names.add(key);
      const value = decodeHeaderValue(raw);
      headers.push({ name, value });
      const canonical =
        key === "setup"
          ? "SetUp"
          : key === "fen"
            ? "FEN"
            : key === "result"
              ? "Result"
              : null;
      loaderPgn += canonical
        ? `[${canonical} "${encodeHeaderValue(value)}"]${ending}`
        : ending;
      movetextPgn += ending;
      continue;
    }
    if (headerSection && sawHeader && /^\s*$/.test(content)) {
      headerSection = false;
    } else if (headerSection && !/^\s*$/.test(content)) {
      headerSection = false;
    }
    loaderPgn += line;
    movetextPgn += line;
  }
  return { headers, loaderPgn, movetextPgn };
}

function withoutPgnEscapeLines(pgn: string): string {
  return pgn.replace(/^%[^\r\n]*(?:\r\n|\r|\n|$)/gm, "");
}

function pgnText(chess: Chess): string {
  const raw = chess.pgn();
  const headers = Object.entries(chess.getHeaders());
  if (!headers.length) return raw;
  const separator = raw.indexOf("\n\n");
  const movetext = separator < 0 ? "" : raw.slice(separator + 2);
  const tags = headers
    .map(([name, value]) => `[${name} "${encodeHeaderValue(value)}"]`)
    .join("\n");
  return movetext ? `${tags}\n\n${movetext}` : tags;
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
      /^\s*\[\s*Result\s+"((?:\\.|[^"\\])*)"\s*\]\s*$/gim,
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

function movetextTokens(pgn: string): string[] {
  const movetext = pgn;
  const tokens: string[] = [];
  for (let index = 0; index < movetext.length; ) {
    const char = movetext[index]!;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "{") {
      const end = movetext.indexOf("}", index + 1);
      if (end < 0) {
        throw new ChessError("INVALID_PGN", "unterminated PGN comment");
      }
      index = end + 1;
      continue;
    }
    if (char === ";") {
      while (index < movetext.length && !/[\r\n]/.test(movetext[index]!)) {
        index += 1;
      }
      continue;
    }
    if (char === "(" || char === ")") {
      tokens.push(char);
      index += 1;
      continue;
    }
    let end = index + 1;
    while (
      end < movetext.length &&
      !/[\s{}();]/.test(movetext[end]!)
    ) {
      end += 1;
    }
    tokens.push(movetext.slice(index, end));
    index = end;
  }
  return tokens;
}

function validatePgnMoves(pgn: string, initialFen: string): void {
  const tokens = movetextTokens(pgn);
  let plies = 0;
  for (let token of tokens) {
    if (
      token === "(" ||
      token === ")" ||
      /^\$\d+$/.test(token) ||
      token === "e.p."
    ) {
      continue;
    }
    token = token.replace(/^\d+\.+/, "");
    if (!token || (PGN_RESULTS as readonly string[]).includes(token)) continue;
    const nag = token.indexOf("$");
    if (nag >= 0) token = token.slice(0, nag);
    token = token.replace(/[!?]+$/, "");
    if (!token) continue;
    plies += 1;
    if (plies > MAX_PGN_PLIES) {
      throw new ChessError(
        "PGN_TOO_MANY_MOVES",
        `PGN exceeds the ${MAX_PGN_PLIES}-ply limit`,
      );
    }
  }
  let index = 0;
  const sequence = (chess: Chess, variation: boolean): void => {
    let beforeLastFen: string | null = null;
    while (index < tokens.length) {
      let token = tokens[index++]!;
      if (token === ")") {
        if (!variation) {
          throw new ChessError("INVALID_PGN", "unexpected PGN variation end");
        }
        return;
      }
      if (token === "(") {
        if (!beforeLastFen) {
          throw new ChessError("INVALID_PGN", "PGN variation has no parent move");
        }
        sequence(new Chess(beforeLastFen), true);
        continue;
      }
      if (/^\$\d+$/.test(token) || token === "e.p.") continue;
      token = token.replace(/^\d+\.+/, "");
      if (!token) continue;
      const result = (PGN_RESULTS as readonly string[]).includes(token);
      if (result) {
        if (variation) {
          throw new ChessError(
            "INVALID_PGN",
            "PGN variation cannot contain a result",
          );
        }
        if (index !== tokens.length) {
          throw new ChessError("INVALID_PGN", "moves follow the PGN result");
        }
        return;
      }
      const nag = token.indexOf("$");
      if (nag >= 0) token = token.slice(0, nag);
      token = token.replace(/[!?]+$/, "").replaceAll("0", "O");
      beforeLastFen = chess.fen();
      try {
        chess.move(token);
      } catch {
        throw new ChessError("INVALID_PGN", `illegal PGN move: ${token}`);
      }
    }
    if (variation) {
      throw new ChessError("INVALID_PGN", "unterminated PGN variation");
    }
  };
  sequence(new Chess(initialFen), false);
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

function restoreHeaders(
  chess: Chess,
  headersToRestore: PgnHeader[],
  result: PgnResult | undefined,
): void {
  for (const { name, value } of headersToRestore) {
    const canonical = CANONICAL_HEADERS.get(name.toLowerCase()) ?? name;
    for (const existing of Object.keys(chess.getHeaders())) {
      if (existing.toLowerCase() === name.toLowerCase()) {
        chess.removeHeader(existing);
      }
    }
    chess.setHeader(canonical, value);
  }
  const headers = chess.getHeaders();
  for (const canonical of ["SetUp", "FEN", "Result"] as const) {
    const entry = Object.entries(headers).find(
      ([key]) => key.toLowerCase() === canonical.toLowerCase(),
    );
    for (const key of Object.keys(headers)) {
      if (key !== canonical && key.toLowerCase() === canonical.toLowerCase()) {
        chess.removeHeader(key);
      }
    }
    if (canonical === "Result" && result !== undefined) {
      chess.setHeader(canonical, result);
    } else if (entry) {
      chess.setHeader(canonical, entry[1]);
    }
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
  if (result === undefined) return pgnText(chess);

  const snapshot = snapshotChess(chess);
  snapshot.setHeader("Result", result);
  return pgnText(snapshot);
}

export function parseImportedPgn(pgn: string): Chess {
  if (Buffer.byteLength(pgn, "utf8") > MAX_PGN_BYTES) {
    throw new ChessError(
      "PGN_TOO_LARGE",
      `PGN exceeds the ${MAX_PGN_BYTES}-byte limit`,
    );
  }
  const normalizedPgn = withoutPgnEscapeLines(stripBom(pgn));
  const { headers, loaderPgn, movetextPgn } = prepareHeaders(normalizedPgn);
  validatePgnSetup(normalizedPgn);
  const result = declaredPgnResult(normalizedPgn);

  let chess: Chess;
  try {
    chess = new Chess();
    chess.loadPgn(loaderPgn);
  } catch {
    throw new ChessError("INVALID_PGN", "invalid or illegal PGN");
  }
  restoreHeaders(chess, headers, result);
  assertSafeFenCounters(chess.fen());
  assertLegalPosition(chess);
  const initialFen = chess.history({ verbose: true })[0]?.before ?? chess.fen();
  validatePgnMoves(movetextPgn, initialFen);
  if (chess.history().length > MAX_PGN_PLIES) {
    throw new ChessError(
      "PGN_TOO_MANY_MOVES",
      `PGN exceeds the ${MAX_PGN_PLIES}-ply limit`,
    );
  }
  validateResultForPosition(chess, result);
  return chess;
}
