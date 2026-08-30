import type { Chess } from "chess.js";

export type MoveIdentity = { uci: string; san: string };
export type LegalMoveMap = ReadonlyMap<string, string>;

export function legalMoveMap(chess: Chess): LegalMoveMap {
  return new Map(
    chess.moves({ verbose: true }).map((move) => [move.lan, move.san]),
  );
}

export function validateMoveIdentities(
  moves: readonly MoveIdentity[],
  legal: LegalMoveMap,
): void {
  const seen = new Set<string>();
  for (const move of moves) {
    if (seen.has(move.uci)) throw new RangeError("duplicate move");
    seen.add(move.uci);
    if (legal.get(move.uci) !== move.san) throw new RangeError("invalid move");
  }
}
