import { squareName } from "./mirror.js";

const FILES = "abcdefgh";
const PROMO = ["q", "r", "b", "n"];

export const VOCAB_SIZE = 4352;

export const MOVE_VOCAB: string[] = (() => {
  const moves: string[] = [];
  for (let fromRank = 0; fromRank < 8; fromRank++) {
    for (let fromFile = 0; fromFile < 8; fromFile++) {
      const from = squareName(fromRank, fromFile);
      for (let toRank = 0; toRank < 8; toRank++) {
        for (let toFile = 0; toFile < 8; toFile++) {
          moves.push(from + squareName(toRank, toFile));
        }
      }
    }
  }
  for (let fromFile = 0; fromFile < 8; fromFile++) {
    for (let toFile = 0; toFile < 8; toFile++) {
      for (const piece of PROMO) {
        moves.push(FILES[fromFile] + "7" + FILES[toFile] + "8" + piece);
      }
    }
  }
  return moves;
})();

const VOCAB_INDEX = new Map<string, number>(
  MOVE_VOCAB.map((m, i) => [m, i]),
);

export function vocabIndex(uci: string): number {
  const i = VOCAB_INDEX.get(uci);
  if (i === undefined) throw new Error(`move not in vocab: ${uci}`);
  return i;
}
