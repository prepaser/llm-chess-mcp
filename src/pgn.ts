import { Chess } from "chess.js";
import {
  assertLegalPosition,
  assertSafeFenCounters,
  snapshotChess,
} from "./chess-copy.js";
import { ChessError } from "./errors.js";

export const MAX_PGN_BYTES = 1024 * 1024;
export const MAX_PGN_PLIES = 4096;
const MAX_PGN_ELEMENTS = MAX_PGN_PLIES * 8;

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
  const push = (token: string): void => {
    tokens.push(token);
    if (tokens.length > MAX_PGN_ELEMENTS) {
      throw new ChessError(
        "PGN_TOO_COMPLEX",
        `PGN exceeds the ${MAX_PGN_ELEMENTS}-element limit`,
      );
    }
  };
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
      push(char);
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
    push(movetext.slice(index, end));
    index = end;
  }
  return tokens;
}

function validatePgnMoves(pgn: string, initialFen: string): void {
  const tokens = movetextTokens(pgn);
  type Frame = {
    beforeLastFen: string | null;
    chess: Chess;
    moveNumberOpen: boolean;
    moves: number;
  };
  const stack: Frame[] = [
    {
      beforeLastFen: null,
      chess: new Chess(initialFen),
      moveNumberOpen: false,
      moves: 0,
    },
  ];
  let plies = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    let token = tokens[index]!;
    const frame = stack.at(-1)!;
    if (token === "(") {
      if (!frame.beforeLastFen) {
        throw new ChessError("INVALID_PGN", "PGN variation has no parent move");
      }
      stack.push({
        beforeLastFen: null,
        chess: new Chess(frame.beforeLastFen),
        moveNumberOpen: false,
        moves: 0,
      });
      continue;
    }
    if (token === ")") {
      if (stack.length === 1) {
        throw new ChessError("INVALID_PGN", "unexpected PGN variation end");
      }
      if (frame.moves === 0) {
        throw new ChessError("INVALID_PGN", "PGN variation must contain a move");
      }
      stack.pop();
      continue;
    }
    if (/^(?:\$\d+)+$/.test(token) || token === "e.p.") continue;

    const moveNumber = /^(\d+)(\.+)(.*)$/.exec(token);
    if (moveNumber) {
      token = moveNumber[3] ?? "";
      frame.moveNumberOpen = token.length === 0;
      if (!token) continue;
    } else if (frame.moveNumberOpen) {
      const dots = /^(\.+)(.*)$/.exec(token);
      if (dots) {
        token = dots[2] ?? "";
        frame.moveNumberOpen = false;
        if (!token) continue;
      }
      frame.moveNumberOpen = false;
    }

    if ((PGN_RESULTS as readonly string[]).includes(token)) {
      if (stack.length !== 1) {
        throw new ChessError(
          "INVALID_PGN",
          "PGN variation cannot contain a result",
        );
      }
      if (index + 1 !== tokens.length) {
        throw new ChessError("INVALID_PGN", "moves follow the PGN result");
      }
      continue;
    }
    const nag = token.indexOf("$");
    if (nag >= 0) {
      if (!/^(?:\$\d+)+$/.test(token.slice(nag))) {
        throw new ChessError("INVALID_PGN", "invalid PGN annotation");
      }
      token = token.slice(0, nag);
    }
    const suffix = /[!?]+$/.exec(token)?.[0] ?? "";
    if (suffix.length > 2 || suffix.length === token.length) {
      throw new ChessError("INVALID_PGN", "invalid PGN annotation");
    }
    token = token.slice(0, token.length - suffix.length).replaceAll("0", "O");
    if (!token) continue;
    plies += 1;
    if (plies > MAX_PGN_PLIES) {
      throw new ChessError(
        "PGN_TOO_MANY_MOVES",
        `PGN exceeds the ${MAX_PGN_PLIES}-ply limit`,
      );
    }
    frame.beforeLastFen = frame.chess.fen();
    try {
      frame.chess.move(token);
    } catch {
      throw new ChessError("INVALID_PGN", `illegal PGN move: ${token}`);
    }
    frame.moves += 1;
    frame.moveNumberOpen = false;
  }
  if (stack.length !== 1) {
    throw new ChessError("INVALID_PGN", "unterminated PGN variation");
  }
}

function withoutVariations(pgn: string): string {
  let result = "";
  let depth = 0;
  let braceComment = false;
  let lineComment = false;
  let quoted = false;
  let escaped = false;
  for (const char of pgn) {
    if (braceComment) {
      if (depth === 0) result += char;
      if (char === "}") braceComment = false;
      continue;
    }
    if (lineComment) {
      if (depth === 0) result += char;
      if (char === "\r" || char === "\n") lineComment = false;
      continue;
    }
    if (quoted) {
      if (depth === 0) result += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === "{") {
      braceComment = true;
      if (depth === 0) result += char;
    } else if (char === ";") {
      lineComment = true;
      if (depth === 0) result += char;
    } else if (char === '"') {
      quoted = true;
      if (depth === 0) result += char;
    } else if (char === "(") {
      if (depth === 0) result += " ";
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
    } else if (depth === 0) {
      result += char;
    }
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
  const setup = headers.find(({ name }) => name.toLowerCase() === "setup")?.value;
  const fen = headers.find(({ name }) => name.toLowerCase() === "fen")?.value;
  const initialFen = setup === "1" && fen ? fen : new Chess().fen();
  validatePgnMoves(movetextPgn, initialFen);

  let chess: Chess;
  try {
    chess = new Chess();
    chess.loadPgn(withoutVariations(loaderPgn));
  } catch {
    throw new ChessError("INVALID_PGN", "invalid or illegal PGN");
  }
  restoreHeaders(chess, headers, result);
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
