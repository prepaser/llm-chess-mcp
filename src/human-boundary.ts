import {
  HUMAN_PROBABILITY_TOLERANCE,
  MAX_HUMAN_MOVES,
} from "./domain.js";
import type { Maia3Move } from "./domain.js";

export function validateHumanMoves(
  moves: readonly Maia3Move[],
  topN: number,
  legal: ReadonlyMap<string, string>,
): void {
  if (
    !Number.isSafeInteger(topN) ||
    topN < 1 ||
    topN > MAX_HUMAN_MOVES
  ) {
    throw new RangeError("invalid human move limit");
  }
  if (!Array.isArray(moves) || moves.length > topN) {
    throw new RangeError("human move distribution exceeds top_n");
  }

  const ucis = new Set<string>();
  let probabilityMass = 0;
  for (const move of moves) {
    if (
      typeof move !== "object" ||
      move === null ||
      Array.isArray(move) ||
      typeof move.uci !== "string" ||
      legal.get(move.uci) !== move.san
    ) {
      throw new RangeError("invalid human move");
    }
    if (ucis.has(move.uci)) throw new RangeError("duplicate Maia move");
    ucis.add(move.uci);
    if (!Number.isFinite(move.prob) || move.prob < 0 || move.prob > 1) {
      throw new RangeError("Maia move probability must be between 0 and 1");
    }
    probabilityMass += move.prob;
  }
  if (probabilityMass > 1 + HUMAN_PROBABILITY_TOLERANCE) {
    throw new RangeError("human move probability mass exceeds 1");
  }
}
