import { Chess } from "chess.js";
import {
  assertLegalPosition,
  assertSafeFenCounters,
  snapshotChess,
} from "./chess-copy.js";
import { ChessError } from "./errors.js";
import { commentSpan, quotedSpan, wordSpan } from "./pgn-lex.js";
import {
  assertPgnSize,
  assertPgnTokenSize,
  assertPgnPlyLimit,
  canonicalPgnHeaderName,
  encodePgnHeaderValue,
  MAX_PGN_HEADERS,
  MAX_PGN_PLIES,
  pgnHeaderIndex,
  pgnSetupHeaders,
  replacePgnHeaders,
} from "./pgn-shared.js";

export { MAX_PGN_BYTES, MAX_PGN_HEADERS, MAX_PGN_TOKEN_BYTES } from "./pgn-shared.js";
export { MAX_PGN_PLIES } from "./pgn-shared.js";
const MAX_PGN_ELEMENTS = MAX_PGN_PLIES * 8;

const PGN_RESULTS = ["1-0", "0-1", "1/2-1/2", "*"] as const;

type PgnResult = (typeof PGN_RESULTS)[number];

type PgnHeader = { name: string; value: string };

const HEADER_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const TAG_LINE = /^(\s*\[\s*)([A-Za-z][A-Za-z0-9_]*)(\s+")((?:\\.|[^"\\])*)("\s*\]\s*)$/;

function splitPgnWord(value: string, emit: (token: string) => void): void {
  const annotated = (part: string): void => {
    let start = 0;
    for (let index = 0; index < part.length; index += 1) {
      const char = part[index]!;
      if (char !== "!" && char !== "?" && char !== "+" && char !== "#") {
        continue;
      }
      let end = index + 1;
      if (char === "!" || char === "?") {
        if (part[end] === "!" || part[end] === "?") end += 1;
      } else {
        while (
          end < index + 3 &&
          (part[end] === "!" || part[end] === "?")
        ) {
          end += 1;
        }
      }
      if (end === part.length) break;
      emit(part.slice(start, end));
      start = end;
      index = end - 1;
    }
    if (start < part.length) emit(part.slice(start));
  };
  const body = (part: string): void => {
    let start = 0;
    for (let index = 0; index < part.length; index += 1) {
      if (part[index] !== "$") continue;
      if (index > start) annotated(part.slice(start, index));
      let end = index + 1;
      while (end < part.length && /\d/.test(part[end]!)) end += 1;
      if (end === index + 1) {
        annotated(part.slice(index));
        return;
      }
      emit(part.slice(index, end));
      start = end;
      index = end - 1;
    }
    if (start < part.length) annotated(part.slice(start));
  };
  const result = PGN_RESULTS.find(
    (candidate) => value.length > candidate.length && value.endsWith(candidate),
  );
  if (result) {
    body(value.slice(0, -result.length));
    emit(result);
  } else {
    body(value);
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
      const span = quotedSpan(pgn, index);
      assertPgnTokenSize(pgn.slice(span.contentStart, span.contentEnd));
      index = span.end;
      continue;
    }
    const comment = commentSpan(pgn, index);
    if (comment) {
      if (!comment.closed) return;
      assertPgnTokenSize(pgn.slice(comment.contentStart, comment.contentEnd));
      index = comment.end;
      continue;
    }
    if (char === "[" || char === "]") {
      index += 1;
      continue;
    }
    const word = wordSpan(pgn, index + 1, /[\s[\]{}();"]/);
    splitPgnWord(pgn.slice(index, word.end), assertPgnTokenSize);
    index = word.end;
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

type CommentTrie = {
  comment?: string;
  next: Map<string, CommentTrie>;
};

function renderUnsafePgnComments(
  movetext: string,
  comments: readonly string[],
): string {
  const root: CommentTrie = { next: new Map() };
  for (const comment of new Set(comments.filter((value) => value.includes("}")))) {
    let node = root;
    const serialized = `{${comment}}`;
    for (let index = 0; index < serialized.length; index += 1) {
      const char = serialized[index]!;
      let next = node.next.get(char);
      if (!next) {
        next = { next: new Map() };
        node.next.set(char, next);
      }
      node = next;
    }
    node.comment = comment;
  }
  if (root.next.size === 0) return movetext;

  const chunks: string[] = [];
  let copied = 0;
  let index = 0;
  while (index < movetext.length) {
    if (movetext[index] !== "{") {
      index += 1;
      continue;
    }
    let node: CommentTrie | undefined = root;
    let cursor = index;
    let match: { comment: string; end: number } | undefined;
    while (cursor < movetext.length) {
      node = node.next.get(movetext[cursor]!);
      if (!node) break;
      cursor += 1;
      if (node.comment !== undefined) {
        match = { comment: node.comment, end: cursor };
      }
    }
    if (!match) {
      index += 1;
      continue;
    }
    chunks.push(
      movetext.slice(copied, index),
      `;${match.comment.replace(/[\r\n]+/g, " ")}\n`,
    );
    index = match.end;
    copied = index;
  }
  chunks.push(movetext.slice(copied));
  return chunks.join("");
}

function prepareHeaders(pgn: string): {
  headers: PgnHeader[];
  headerIndex: Map<string, string>;
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
        key === "setup" || key === "fen" || key === "result"
          ? canonicalPgnHeaderName(name)
          : null;
      loaderPgn += canonical
        ? `[${canonical} "${encodePgnHeaderValue(value)}"]${ending}`
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
  return {
    headers,
    headerIndex: pgnHeaderIndex(
      headers.map(({ name, value }) => [name, value] as const),
    ),
    loaderPgn,
    movetextPgn,
  };
}

function withoutPgnEscapeLines(pgn: string): string {
  return pgn.replace(/^%[^\r\n]*(?:\r\n|\r|\n|$)/gm, "");
}

type PgnExportContext = {
  initialFen: string;
};

function pgnExportContext(chess: Chess): PgnExportContext {
  const history = chess.history({ verbose: true });
  return { initialFen: history[0]?.before ?? chess.fen() };
}

function assertPgnExportHeaders(
  chess: Chess,
  context: PgnExportContext,
): {
  headers: [string, string][];
  result: PgnResult | undefined;
} {
  const headers = Object.entries(chess.getHeaders());
  if (headers.length > MAX_PGN_HEADERS) {
    throw new ChessError(
      "PGN_TOO_COMPLEX",
      `PGN exceeds the ${MAX_PGN_HEADERS}-header limit`,
    );
  }
  for (const [name, value] of headers) {
    assertPgnTokenSize(name);
    assertPgnTokenSize(encodePgnHeaderValue(value));
    if (!HEADER_NAME.test(name)) {
      throw new ChessError("INVALID_PGN", "invalid PGN header name");
    }
  }
  const values = pgnHeaderIndex(headers);
  if (
    headers.some(
      ([name, value]) => /[\r\n]/.test(name) || /[\r\n]/.test(value),
    )
  ) {
    throw new ChessError("INVALID_PGN", "PGN headers cannot contain line breaks");
  }
  const result = pgnHeaderResult(values.get("result"));
  const { fen } = pgnSetupHeaders(values);
  let expectedInitialFen = new Chess().fen();
  if (fen !== undefined) {
    assertSafeFenCounters(fen);
    let setupChess: Chess;
    try {
      setupChess = new Chess(fen);
    } catch {
      throw new ChessError("INVALID_FEN", "invalid FEN");
    }
    assertLegalPosition(setupChess);
    expectedInitialFen = setupChess.fen();
  }
  if (context.initialFen !== expectedInitialFen) {
    throw new ChessError(
      "INVALID_PGN",
      "PGN setup headers do not match the initial position",
    );
  }
  return { headers, result };
}

function pgnText(chess: Chess, context: PgnExportContext): string {
  const { headers, result } = assertPgnExportHeaders(chess, context);
  validateResultForPosition(chess, result);
  const comments = chess.getComments();
  for (const { comment } of comments) assertPgnTokenSize(comment);
  const raw = chess.pgn();
  assertPgnSize(raw);
  const rawTags = headers
    .filter(([, value]) => value.length > 0)
    .map(([name, value]) => `[${name} "${value}"]\n`)
    .join("");
  if (!raw.startsWith(rawTags)) {
    throw new ChessError("INVALID_PGN", "could not locate PGN movetext");
  }
  let movetext = raw.slice(rawTags.length);
  if (movetext.startsWith("\n")) movetext = movetext.slice(1);
  movetext = renderUnsafePgnComments(
    movetext,
    comments.map(({ comment }) => comment),
  );
  const tags = headers
    .map(([name, value]) => `[${name} "${encodePgnHeaderValue(value)}"]`)
    .join("\n");
  const pgn = !headers.length
    ? movetext
    : movetext
      ? `${tags}\n\n${movetext}`
      : tags;
  assertPgnSize(pgn);
  return pgn;
}

function isPgnResult(value: string): value is PgnResult {
  return (PGN_RESULTS as readonly string[]).includes(value);
}

function pgnHeaderResult(value: string | undefined): PgnResult | undefined {
  if (value !== undefined && !isPgnResult(value)) {
    throw new ChessError("INVALID_PGN", "invalid PGN result");
  }
  return value;
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
  const pushWord = (value: string): void => {
    splitPgnWord(value, (word) => {
      assertPgnTokenSize(word);
      push(
        { kind: "word", value: word },
        isPgnResult(word) ? 1 : wordWeight(word),
      );
    });
  };
  for (let index = 0; index < movetext.length; ) {
    const char = movetext[index]!;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    const comment = commentSpan(movetext, index);
    if (comment) {
      if (!comment.closed) {
        throw new ChessError("INVALID_PGN", "unterminated PGN comment");
      }
      assertPgnTokenSize(
        movetext.slice(comment.contentStart, comment.contentEnd),
      );
      push({ kind: "comment" });
      index = comment.end;
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
    const word = wordSpan(movetext, index + 1, /[\s{}();]/);
    pushWord(movetext.slice(index, word.end));
    index = word.end;
  }
  return tokens;
}

function movetextResultMarkers(pgn: string): PgnResult[] {
  const results: PgnResult[] = [];
  for (let index = 0; index < pgn.length; ) {
    const char = pgn[index]!;
    if (/\s/.test(char) || char === "(" || char === ")") {
      index += 1;
      continue;
    }
    const comment = commentSpan(pgn, index);
    if (comment) {
      index = comment.end;
      continue;
    }
    const word = wordSpan(pgn, index + 1, /[\s{}();]/);
    const boundary = pgn[word.end];
    if (
      boundary === undefined ||
      /\s/.test(boundary) ||
      boundary === "{" ||
      boundary === ";"
    ) {
      splitPgnWord(pgn.slice(index, word.end), (value) => {
        if (isPgnResult(value)) results.push(value);
      });
    }
    index = word.end;
  }
  return results;
}

function declaredPgnResult(
  headerResult: PgnResult | undefined,
  markers: readonly PgnResult[],
): PgnResult | undefined {
  const results = [
    ...(headerResult === undefined ? [] : [headerResult]),
    ...markers,
  ];
  const result = results[0];
  if (results.some((value) => value !== result)) {
    throw new ChessError("INVALID_PGN", "PGN result header and marker disagree");
  }
  return result;
}

function validatePgnMoves(
  tokens: readonly MovetextToken[],
  initialFen: string,
): void {
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
    assertSafeFenCounters(frame.chess.fen());
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
  for (let index = 0; index < pgn.length; ) {
    const char = pgn[index]!;
    const span =
      char === '"' ? quotedSpan(pgn, index) : commentSpan(pgn, index);
    if (span) {
      if (depth === 0) result += pgn.slice(index, span.end);
      index = span.end;
    } else if (char === "(") {
      if (depth === 0) result += " ";
      depth += 1;
      index += 1;
    } else if (char === ")") {
      depth -= 1;
      index += 1;
    } else if (depth === 0) {
      result += char;
      index += 1;
    } else {
      index += 1;
    }
  }
  return result;
}

function withoutMainlineEnPassant(pgn: string): string {
  let result = "";
  let index = 0;
  while (index < pgn.length) {
    const char = pgn[index]!;
    if (char === '"') {
      const span = quotedSpan(pgn, index);
      result += pgn.slice(index, span.end);
      index = span.end;
      continue;
    }
    const comment = commentSpan(pgn, index);
    if (comment) {
      result += pgn.slice(index, comment.end);
      index = comment.end;
      continue;
    }
    if (/\s/.test(char)) {
      result += char;
      index += 1;
      continue;
    }
    const span = wordSpan(pgn, index + 1, /[\s{}();"]/);
    const word = pgn.slice(index, span.end);
    if (word.startsWith("e.p.")) result += word.slice("e.p.".length);
    else result += word;
    index = span.end;
  }
  return result;
}

function normalizeCommentCluster(
  pgn: string,
  start: number,
  output: string,
): { output: string; end: number } {
  const moveNumber = /(^|\s)(\d+\.+(?:\s*\.+)*)\s*$/.exec(output);
  let deferredNumber = moveNumber?.[2] ?? "";
  let result = moveNumber
    ? output.slice(0, moveNumber.index + moveNumber[1]!.length)
    : output;
  const comments: string[] = [];
  const nags: string[] = [];
  let trailing = "";
  let index = start;
  while (index < pgn.length) {
    const comment = commentSpan(pgn, index);
    if (comment) {
      let value = pgn.slice(comment.contentStart, comment.contentEnd);
      if (pgn[index] === "{") value = value.replace(/[\r\n]+/g, " ");
      else value = value.trim();
      comments.push(value);
      index = comment.end;
    } else {
      let end = wordSpan(pgn, index, /[\s{}();"]/).end;
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
  return { output: result, end: index };
}

function normalizeMainlinePgn(input: string): string {
  const pgn = withoutMainlineEnPassant(input);
  let result = "";
  let index = 0;
  while (index < pgn.length) {
    const char = pgn[index]!;
    if (char === '"') {
      const span = quotedSpan(pgn, index);
      result += pgn.slice(index, span.end);
      index = span.end;
      continue;
    }
    if (char === "{" || char === ";") {
      const cluster = normalizeCommentCluster(pgn, index, result);
      result = cluster.output;
      index = cluster.end;
      continue;
    }
    if (/\s/.test(char)) {
      result += char;
      index += 1;
      continue;
    }
    const word = wordSpan(pgn, index + 1, /[\s{}();"]/);
    result += pgn.slice(index, word.end);
    index = word.end;
  }
  return result;
}

function validatePgnSetupFen(fen: string | undefined): void {
  if (fen === undefined) return;
  assertSafeFenCounters(fen);
  let chess: Chess;
  try {
    chess = new Chess(fen);
  } catch {
    throw new ChessError("INVALID_FEN", "invalid FEN");
  }
  assertLegalPosition(chess);
}

function restoreHeaders(
  chess: Chess,
  headersToRestore: PgnHeader[],
  result: PgnResult | undefined,
): void {
  replacePgnHeaders(
    chess,
    headersToRestore.map(({ name, value }) => [name, value]),
    { overrides: result === undefined ? [] : [["Result", result]] },
  );
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
  const snapshot = snapshotChess(chess);
  const context = pgnExportContext(snapshot);
  const result = snapshot.isCheckmate()
    ? (snapshot.turn() === "w" ? "0-1" : "1-0")
    : snapshot.isDraw()
      ? "1/2-1/2"
      : undefined;
  if (result === undefined) return pgnText(snapshot, context);

  assertPgnExportHeaders(snapshot, context);
  snapshot.setHeader("Result", result);
  return pgnText(snapshot, context);
}

export function parseImportedPgn(pgn: string): Chess {
  assertPgnSize(pgn);
  const normalizedPgn = withoutPgnEscapeLines(stripBom(pgn));
  assertPgnLexicalSizes(normalizedPgn);
  const { headers, headerIndex, loaderPgn, movetextPgn } =
    prepareHeaders(normalizedPgn);
  const { setup, fen } = pgnSetupHeaders(headerIndex);
  validatePgnSetupFen(fen);
  const headerResult = pgnHeaderResult(headerIndex.get("result"));
  const initialFen = setup === "1" && fen ? fen : new Chess().fen();
  const result = declaredPgnResult(
    headerResult,
    movetextResultMarkers(movetextPgn),
  );
  const tokens = movetextTokens(movetextPgn);
  validatePgnMoves(tokens, initialFen);

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
  assertPgnPlyLimit(chess.history().length);
  validateResultForPosition(chess, result);
  pgnOf(chess);
  return chess;
}
