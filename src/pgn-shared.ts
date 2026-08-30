import type { Chess } from "chess.js";
import { ChessError } from "./errors.js";

export const MAX_PGN_PLIES = 4096;
export const MAX_PGN_BYTES = 1024 * 1024;
export const MAX_PGN_HEADERS = 256;
export const MAX_PGN_TOKEN_BYTES = 16 * 1024;

export function assertPgnTokenSize(value: string): void {
  if (Buffer.byteLength(value, "utf8") > MAX_PGN_TOKEN_BYTES) {
    throw new ChessError(
      "PGN_TOO_COMPLEX",
      `PGN token exceeds the ${MAX_PGN_TOKEN_BYTES}-byte limit`,
    );
  }
}

export function assertPgnSize(pgn: string): void {
  if (Buffer.byteLength(pgn, "utf8") > MAX_PGN_BYTES) {
    throw new ChessError(
      "PGN_TOO_LARGE",
      `PGN exceeds the ${MAX_PGN_BYTES}-byte limit`,
    );
  }
}

export function assertPgnBytes(bytes: number): void {
  if (bytes > MAX_PGN_BYTES) {
    throw new ChessError(
      "PGN_TOO_LARGE",
      `PGN exceeds the ${MAX_PGN_BYTES}-byte limit`,
    );
  }
}

export function encodePgnHeaderValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function terminalPgnResult(
  chess: Chess,
): "1-0" | "0-1" | "1/2-1/2" | undefined {
  if (chess.isCheckmate()) return chess.turn() === "w" ? "0-1" : "1-0";
  return chess.isDraw() ? "1/2-1/2" : undefined;
}

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

export function canonicalPgnHeaderName(name: string): string {
  return CANONICAL_HEADERS.get(name.toLowerCase()) ?? name;
}

export type PgnHeaderSource = Iterable<readonly [name: string, value: string]>;

export function pgnHeaderIndex(headers: PgnHeaderSource): Map<string, string> {
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
  return values;
}

export function pgnSetupHeaders(headers: ReadonlyMap<string, string>): {
  setup: string | undefined;
  fen: string | undefined;
} {
  const setup = headers.get("setup");
  const fen = headers.get("fen");
  if (setup !== undefined && setup !== "0" && setup !== "1") {
    throw new ChessError("INVALID_PGN", "PGN SetUp must be 0 or 1");
  }
  if ((setup === "1") !== (fen !== undefined)) {
    throw new ChessError(
      "INVALID_PGN",
      "PGN SetUp 1 and FEN headers must appear together",
    );
  }
  return { setup, fen };
}

export function replacePgnHeaders(
  chess: Chess,
  source: readonly (readonly [string, string])[],
  options: {
    overrides?: readonly (readonly [string, string])[];
    removeMissing?: boolean;
  } = {},
): void {
  const headers = [...source, ...(options.overrides ?? [])];
  const sourceNames = new Set(headers.map(([name]) => name.toLowerCase()));
  if (options.removeMissing) {
    for (const name of Object.keys(chess.getHeaders())) {
      if (!sourceNames.has(name.toLowerCase())) chess.removeHeader(name);
    }
  }

  const names = new Map<string, string[]>();
  for (const name of Object.keys(chess.getHeaders())) {
    const existing = names.get(name.toLowerCase());
    if (existing) existing.push(name);
    else names.set(name.toLowerCase(), [name]);
  }
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    const canonical = canonicalPgnHeaderName(name);
    for (const existing of names.get(lower) ?? []) {
      if (existing !== canonical) chess.removeHeader(existing);
    }
    chess.setHeader(canonical, value);
    names.set(lower, [canonical]);
  }
}

export function assertPgnPlyLimit(plies: number): void {
  if (plies > MAX_PGN_PLIES) {
    throw new ChessError(
      "PGN_TOO_MANY_MOVES",
      `PGN exceeds the ${MAX_PGN_PLIES}-ply limit`,
    );
  }
}
