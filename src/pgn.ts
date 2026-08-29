import { Chess } from "chess.js";
import {
  assertLegalPosition,
  assertSafeFenCounters,
  snapshotChess,
} from "./chess-copy.js";
import { ChessError } from "./errors.js";

export const MAX_PGN_BYTES = 1024 * 1024;
export const MAX_PGN_HEADERS = 256;
export const MAX_PGN_PLIES = 4096;
export const MAX_PGN_TOKEN_BYTES = 16 * 1024;
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

const HEADER_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const TAG_LINE = /^(\s*\[\s*)([A-Za-z][A-Za-z0-9_]*)(\s+")((?:\\.|[^"\\])*)("\s*\]\s*)$/;

function assertPgnTokenSize(value: string): void {
  if (Buffer.byteLength(value, "utf8") > MAX_PGN_TOKEN_BYTES) {
    throw new ChessError(
      "PGN_TOO_COMPLEX",
      `PGN token exceeds the ${MAX_PGN_TOKEN_BYTES}-byte limit`,
    );
  }
}

function assertPgnLexicalSizes(pgn: string): void {
  for (let index = 0; index < pgn.length; ) {
    const char = pgn[index]!;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === '"') {
      const start = ++index;
      let escaped = false;
      let end = pgn.length;
      while (index < pgn.length) {
        const current = pgn[index++]!;
        if (escaped) escaped = false;
        else if (current === "\\") escaped = true;
        else if (current === '"') {
          end = index - 1;
          break;
        }
      }
      assertPgnTokenSize(pgn.slice(start, end));
      continue;
    }
    if (char === "{") {
      const end = pgn.indexOf("}", index + 1);
      if (end < 0) return;
      assertPgnTokenSize(pgn.slice(index + 1, end));
      index = end + 1;
      continue;
    }
    if (char === ";") {
      const start = ++index;
      while (index < pgn.length && !/[\r\n]/.test(pgn[index]!)) index += 1;
      assertPgnTokenSize(pgn.slice(start, index));
      continue;
    }
    if (char === "[" || char === "]") {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < pgn.length && !/[\s[\]{}();"]/.test(pgn[end]!)) end += 1;
    assertPgnTokenSize(pgn.slice(index, end));
    index = end;
  }
}

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
      if (headers.length >= MAX_PGN_HEADERS) {
        throw new ChessError(
          "PGN_TOO_COMPLEX",
          `PGN exceeds the ${MAX_PGN_HEADERS}-header limit`,
        );
      }
      assertPgnTokenSize(name);
      assertPgnTokenSize(raw);
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
  const headers = Object.entries(chess.getHeaders());
  for (const [name, value] of headers) {
    assertPgnTokenSize(name);
    assertPgnTokenSize(encodeHeaderValue(value));
    if (!HEADER_NAME.test(name)) {
      throw new ChessError("INVALID_PGN", "invalid PGN header name");
    }
  }
  const comments = chess.getComments();
  for (const { comment } of comments) assertPgnTokenSize(comment);
  if (
    headers.some(
      ([name, value]) => /[\r\n]/.test(name) || /[\r\n]/.test(value),
    )
  ) {
    throw new ChessError("INVALID_PGN", "PGN headers cannot contain line breaks");
  }
  const raw = chess.pgn();
  const separator = raw.indexOf("\n\n");
  let movetext =
    headers.length === 0
      ? raw
      : separator < 0
        ? ""
        : raw.slice(separator + 2);
  const unsafeComments = [
    ...new Set(
      comments
        .map(({ comment }) => comment)
        .filter((comment) => comment.includes("}")),
    ),
  ].sort((left, right) => right.length - left.length);
  for (const comment of unsafeComments) {
    movetext = movetext.replaceAll(
      `{${comment}}`,
      () => `;${comment.replace(/[\r\n]+/g, " ")}\n`,
    );
  }
  if (!headers.length) return movetext;
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
    ...movetext.matchAll(/(1-0|0-1|1\/2-1\/2|\*)(?=\s|$)/g),
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

type MovetextToken =
  | { kind: "comment" }
  | { kind: "variationEnd" }
  | { kind: "variationStart" }
  | { kind: "word"; value: string };

function movetextTokens(pgn: string): MovetextToken[] {
  const movetext = pgn;
  const tokens: MovetextToken[] = [];
  let elements = 0;
  const push = (token: MovetextToken, weight = 1): void => {
    tokens.push(token);
    elements += weight;
    if (elements > MAX_PGN_ELEMENTS) {
      throw new ChessError(
        "PGN_TOO_COMPLEX",
        `PGN exceeds the ${MAX_PGN_ELEMENTS}-element limit`,
      );
    }
  };
  const wordWeight = (value: string): number => {
    let syntax = 0;
    for (const char of value) {
      if (char === "." || (char >= "0" && char <= "9")) syntax += 1;
    }
    return Math.max(1, syntax);
  };
  const pushAnnotated = (value: string): void => {
    let start = 0;
    for (let index = 0; index < value.length; index += 1) {
      const char = value[index]!;
      if (char !== "!" && char !== "?" && char !== "+" && char !== "#") {
        continue;
      }
      let end = index + 1;
      if (char === "!" || char === "?") {
        if (value[end] === "!" || value[end] === "?") end += 1;
      } else {
        while (
          end < index + 3 &&
          (value[end] === "!" || value[end] === "?")
        ) {
          end += 1;
        }
      }
      if (end === value.length) break;
      push(
        { kind: "word", value: value.slice(start, end) },
        wordWeight(value.slice(start, end)),
      );
      start = end;
      index = end - 1;
    }
    if (start < value.length) {
      const word = value.slice(start);
      push(
        { kind: "word", value: word },
        wordWeight(word),
      );
    }
  };
  const pushBody = (value: string): void => {
    let start = 0;
    for (let index = 0; index < value.length; index += 1) {
      if (value[index] !== "$") continue;
      if (index > start) pushAnnotated(value.slice(start, index));
      let end = index + 1;
      while (end < value.length && /\d/.test(value[end]!)) end += 1;
      if (end === index + 1) {
        pushAnnotated(value.slice(index));
        return;
      }
      const nag = value.slice(index, end);
      push({ kind: "word", value: nag }, wordWeight(nag));
      start = end;
      index = end - 1;
    }
    if (start < value.length) pushAnnotated(value.slice(start));
  };
  const pushWord = (value: string): void => {
    assertPgnTokenSize(value);
    const result = PGN_RESULTS.find(
      (candidate) => value.length > candidate.length && value.endsWith(candidate),
    );
    if (result) {
      pushBody(value.slice(0, -result.length));
      push({ kind: "word", value: result });
    } else {
      pushBody(value);
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
      assertPgnTokenSize(movetext.slice(index + 1, end));
      push({ kind: "comment" });
      index = end + 1;
      continue;
    }
    if (char === ";") {
      const start = index + 1;
      while (index < movetext.length && !/[\r\n]/.test(movetext[index]!)) {
        index += 1;
      }
      assertPgnTokenSize(movetext.slice(start, index));
      push({ kind: "comment" });
      continue;
    }
    if (char === "(") {
      push({ kind: "variationStart" });
      index += 1;
      continue;
    }
    if (char === ")") {
      push({ kind: "variationEnd" });
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
    pushWord(movetext.slice(index, end));
    index = end;
  }
  return tokens;
}

function validatePgnMoves(pgn: string, initialFen: string): void {
  const tokens = movetextTokens(pgn);
  type Phase =
    | "after-en-passant"
    | "after-move"
    | "after-nag"
    | "after-number"
    | "after-result"
    | "after-variation"
    | "start";
  type Frame = {
    beforeLastFen: string | null;
    chess: Chess;
    lastMoveEnPassant: boolean;
    moves: number;
    phase: Phase;
  };
  const stack: Frame[] = [
    {
      beforeLastFen: null,
      chess: new Chess(initialFen),
      lastMoveEnPassant: false,
      moves: 0,
      phase: "start",
    },
  ];
  const canStartMove = (phase: Phase): boolean =>
    phase === "start" ||
    phase === "after-move" ||
    phase === "after-en-passant" ||
    phase === "after-nag" ||
    phase === "after-variation";
  const canEndLine = (phase: Phase): boolean =>
    phase === "after-move" ||
    phase === "after-en-passant" ||
    phase === "after-nag" ||
    phase === "after-variation";
  const invalidOrder = (): never => {
    throw new ChessError("INVALID_PGN", "invalid PGN token order");
  };
  let plies = 0;
  for (const current of tokens) {
    const frame = stack.at(-1)!;
    if (current.kind === "comment") {
      continue;
    }
    if (current.kind === "variationStart") {
      if (!frame.beforeLastFen || !canEndLine(frame.phase)) {
        throw new ChessError("INVALID_PGN", "PGN variation has no parent move");
      }
      frame.phase = "after-variation";
      stack.push({
        beforeLastFen: null,
        chess: new Chess(frame.beforeLastFen),
        lastMoveEnPassant: false,
        moves: 0,
        phase: "start",
      });
      continue;
    }
    if (current.kind === "variationEnd") {
      if (stack.length === 1) {
        throw new ChessError("INVALID_PGN", "unexpected PGN variation end");
      }
      if (frame.moves === 0 || !canEndLine(frame.phase)) {
        throw new ChessError("INVALID_PGN", "PGN variation must contain a move");
      }
      stack.pop();
      continue;
    }
    let token = current.value;
    if (token === "e.p.") {
      if (frame.phase !== "after-move" || !frame.lastMoveEnPassant) {
        invalidOrder();
      }
      frame.phase = "after-en-passant";
      continue;
    }
    if (/^(?:\$\d+)+$/.test(token)) {
      if (
        frame.phase !== "after-move" &&
        frame.phase !== "after-en-passant" &&
        frame.phase !== "after-nag"
      ) {
        invalidOrder();
      }
      frame.phase = "after-nag";
      continue;
    }

    if ((PGN_RESULTS as readonly string[]).includes(token)) {
      if (
        stack.length !== 1 ||
        frame.phase === "after-number" ||
        frame.phase === "after-result"
      ) {
        invalidOrder();
      }
      frame.phase = "after-result";
      continue;
    }

    if (frame.phase === "after-number") {
      const dots = /^(\.+)(.*)$/.exec(token);
      if (dots) {
        token = dots[2] ?? "";
        if (!token) continue;
      }
    } else {
      if (!canStartMove(frame.phase)) invalidOrder();
      const moveNumber = /^(\d+)(\.+)(.*)$/.exec(token);
      if (moveNumber) {
        token = moveNumber[3] ?? "";
        frame.phase = "after-number";
        if (!token) continue;
      }
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
    if (token.replace(/=/, "").replace(/[+#]?[?!]*$/, "") === "--") {
      throw new ChessError("INVALID_PGN", "PGN variations cannot contain null moves");
    }
    plies += 1;
    if (plies > MAX_PGN_PLIES) {
      throw new ChessError(
        "PGN_TOO_MANY_MOVES",
        `PGN exceeds the ${MAX_PGN_PLIES}-ply limit`,
      );
    }
    frame.beforeLastFen = frame.chess.fen();
    try {
      const move = frame.chess.move(token);
      frame.lastMoveEnPassant = move.isEnPassant();
    } catch {
      throw new ChessError("INVALID_PGN", `illegal PGN move: ${token}`);
    }
    frame.moves += 1;
    frame.phase = nag >= 0 ? "after-nag" : "after-move";
  }
  if (stack.length !== 1) {
    throw new ChessError("INVALID_PGN", "unterminated PGN variation");
  }
  if (stack[0]!.phase === "after-number") invalidOrder();
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

function withoutMainlineEnPassant(pgn: string): string {
  let result = "";
  let index = 0;
  let quoted = false;
  let escaped = false;
  while (index < pgn.length) {
    const char = pgn[index]!;
    if (quoted) {
      result += char;
      index += 1;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      result += char;
      index += 1;
      continue;
    }
    if (char === "{") {
      const end = pgn.indexOf("}", index + 1) + 1;
      result += pgn.slice(index, end);
      index = end;
      continue;
    }
    if (char === ";") {
      let end = index + 1;
      while (end < pgn.length && !/[\r\n]/.test(pgn[end]!)) end += 1;
      result += pgn.slice(index, end);
      index = end;
      continue;
    }
    if (/\s/.test(char)) {
      result += char;
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < pgn.length && !/[\s{}();"]/.test(pgn[end]!)) end += 1;
    const word = pgn.slice(index, end);
    if (word.startsWith("e.p.")) result += word.slice("e.p.".length);
    else result += word;
    index = end;
  }
  return result;
}

function normalizeMainlinePgn(input: string): string {
  const pgn = withoutMainlineEnPassant(input);
  let result = "";
  let index = 0;
  let quoted = false;
  let escaped = false;
  const comment = (): string => {
    if (pgn[index] === "{") {
      const end = pgn.indexOf("}", index + 1);
      const value = pgn.slice(index + 1, end).replace(/[\r\n]+/g, " ");
      index = end + 1;
      return value;
    }
    let end = index + 1;
    while (end < pgn.length && !/[\r\n]/.test(pgn[end]!)) end += 1;
    const value = pgn.slice(index + 1, end).trim();
    index = end;
    return value;
  };
  while (index < pgn.length) {
    const char = pgn[index]!;
    if (quoted) {
      result += char;
      index += 1;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      result += char;
      index += 1;
      continue;
    }
    if (char === "{" || char === ";") {
      const moveNumber = /(^|\s)(\d+\.+(?:\s*\.+)*)\s*$/.exec(result);
      let deferredNumber = moveNumber?.[2] ?? "";
      if (moveNumber) result = result.slice(0, moveNumber.index + moveNumber[1]!.length);
      const comments: string[] = [];
      const nags: string[] = [];
      let trailing = "";
      while (index < pgn.length) {
        if (pgn[index] === "{" || pgn[index] === ";") {
          comments.push(comment());
        } else {
          let end = index;
          while (end < pgn.length && !/[\s{}();"]/.test(pgn[end]!)) end += 1;
          const word = pgn.slice(index, end);
          const nag = /^(?:\$\d+)+/.exec(word)?.[0];
          if (!deferredNumber && nag) {
            nags.push(nag);
            end = index + nag.length;
          } else if (!deferredNumber && /^\d+\.+$/.test(word)) {
            deferredNumber = word;
          } else if (deferredNumber && /^\.+$/.test(word)) {
            deferredNumber += ` ${word}`;
          } else {
            break;
          }
          index = end;
        }
        const whitespaceStart = index;
        while (index < pgn.length && /\s/.test(pgn[index]!)) index += 1;
        trailing = pgn.slice(whitespaceStart, index);
      }
      const value = comments.join(" ");
      if (nags.length) result += `${nags.join(" ")} `;
      result += value.includes("}") ? `;${value}\n` : `{${value}}`;
      if (deferredNumber) result += ` ${deferredNumber}`;
      result += trailing;
      continue;
    }
    if (/\s/.test(char)) {
      result += char;
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < pgn.length && !/[\s{}();"]/.test(pgn[end]!)) end += 1;
    result += pgn.slice(index, end);
    index = end;
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
  const names = new Map<string, string[]>();
  const values = new Map<string, string>();
  for (const [name, value] of Object.entries(chess.getHeaders())) {
    const key = name.toLowerCase();
    const existing = names.get(key);
    if (existing) existing.push(name);
    else names.set(key, [name]);
    values.set(key, value);
  }
  const setCanonical = (name: string, value: string): void => {
    const key = name.toLowerCase();
    for (const existing of names.get(key) ?? []) {
      if (existing !== name) chess.removeHeader(existing);
    }
    chess.setHeader(name, value);
    names.set(key, [name]);
    values.set(key, value);
  };
  for (const { name, value } of headersToRestore) {
    const canonical = CANONICAL_HEADERS.get(name.toLowerCase()) ?? name;
    setCanonical(canonical, value);
  }
  for (const canonical of ["SetUp", "FEN", "Result"] as const) {
    if (canonical === "Result" && result !== undefined) {
      setCanonical(canonical, result);
    } else {
      const value = values.get(canonical.toLowerCase());
      if (value !== undefined) setCanonical(canonical, value);
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
  assertPgnLexicalSizes(normalizedPgn);
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
    chess.loadPgn(normalizeMainlinePgn(withoutVariations(loaderPgn)));
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
