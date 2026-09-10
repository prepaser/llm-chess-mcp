import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [root, flavor] = process.argv.slice(2);
const { Stockfish } = await import(pathToFileURL(resolve(root, "dist/engines/stockfish.js")).href);
const engine = new Stockfish({ flavor });
try {
  const lines = await engine.analyze("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", 2, 1);
  assert.ok(lines.length > 0 && lines[0].pv.length > 0, "Stockfish returned no analysis");
} finally {
  await engine.quit();
}
