import type { Chess } from "chess.js";
import { ChessError } from "./errors.js";

export const MAX_PGN_PLIES = 4096;

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
