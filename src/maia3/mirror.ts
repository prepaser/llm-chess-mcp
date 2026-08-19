const FILES = "abcdefgh";

export function mirrorSquare(sq: string): string {
  if (!/^[a-h][1-8]$/.test(sq)) throw new Error(`invalid square: ${sq}`);
  return sq.charAt(0) + String(9 - Number(sq.charAt(1)));
}

export function mirrorMove(uci: string): string {
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) {
    throw new Error(`invalid UCI move: ${uci}`);
  }
  return mirrorSquare(uci.slice(0, 2)) + mirrorSquare(uci.slice(2, 4)) + uci.slice(4);
}

export function squareName(rank: number, file: number): string {
  if (!Number.isInteger(rank) || rank < 0 || rank > 7) throw new Error(`invalid rank: ${rank}`);
  if (!Number.isInteger(file) || file < 0 || file > 7) throw new Error(`invalid file: ${file}`);
  return FILES.charAt(file) + String(rank + 1);
}
