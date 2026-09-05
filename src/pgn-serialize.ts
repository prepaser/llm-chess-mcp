import {
  assertPgnSize,
  assertPgnTokenSize,
  encodePgnHeaderValue,
  MAX_PGN_BYTES,
  MAX_PGN_HEADERS,
} from "./pgn-shared.js";
import { ChessError } from "./errors.js";

type PgnHeader = readonly [name: string, value: string];

type CommentTrie = {
  comment?: string;
  next: Map<string, CommentTrie>;
};

function renderUnsafeComments(
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

/** Serialize the exact PGN representation used by both storage and export. */
export function serializePgn(
  raw: () => string,
  headers: readonly PgnHeader[],
  comments: readonly string[],
): string {
  if (headers.length > MAX_PGN_HEADERS) {
    throw new ChessError(
      "PGN_TOO_COMPLEX",
      `PGN exceeds the ${MAX_PGN_HEADERS}-header limit`,
    );
  }
  let lowerBoundBytes = 0;
  const encodedHeaders: string[] = [];
  for (const [name, value] of headers) {
    assertPgnTokenSize(name);
    const encoded = encodePgnHeaderValue(value);
    assertPgnTokenSize(encoded);
    const tag = `[${name} "${encoded}"]`;
    encodedHeaders.push(tag);
    if (encodedHeaders.length > 1) lowerBoundBytes += 1;
    lowerBoundBytes += Buffer.byteLength(tag, "utf8");
    assertPgnSizeBytes(lowerBoundBytes);
  }
  for (const comment of comments) {
    assertPgnTokenSize(comment);
    const normalized = /[{}]/.test(comment)
      ? comment.replace(/[\r\n]+/g, " ")
      : comment;
    lowerBoundBytes += Buffer.byteLength(normalized, "utf8");
    assertPgnSizeBytes(lowerBoundBytes);
  }

  const rawTags = headers
    .filter(([, value]) => value.length > 0)
    .map(([name, value]) => `[${name} "${value}"]\n`)
    .join("");
  const rawPgn = raw();
  if (!rawPgn.startsWith(rawTags)) {
    throw new ChessError("INVALID_PGN", "could not locate PGN movetext");
  }
  let movetext = rawPgn.slice(rawTags.length);
  if (movetext.startsWith("\n")) movetext = movetext.slice(1);
  movetext = renderUnsafeComments(movetext, comments);

  const tags = encodedHeaders.join("\n");
  const pgn = !headers.length
    ? movetext
    : movetext
      ? `${tags}\n\n${movetext}`
      : tags;
  assertPgnSize(pgn);
  return pgn;
}

function assertPgnSizeBytes(bytes: number): void {
  if (bytes > MAX_PGN_BYTES) {
    throw new ChessError(
      "PGN_TOO_LARGE",
      `PGN exceeds the ${MAX_PGN_BYTES}-byte limit`,
    );
  }
}
