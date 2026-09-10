import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const FLAVORS = new Set(["full", "single", "lite", "lite-single", "single-lite", "asm"]);
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function validateStockfishConfig(config) {
  if (!config || typeof config !== "object" || Array.isArray(config) ||
      Object.keys(config).sort().join(",") !== "flavor,version" ||
      typeof config.version !== "string" || config.version.trim() !== config.version || !VERSION.test(config.version) ||
      !FLAVORS.has(config.flavor)) {
    throw new Error("invalid stockfish config: expected an exact stable version and a supported flavor");
  }
  return config;
}

export async function installedStockfish(root) {
  const require = createRequire(join(root, "package.json"));
  return JSON.parse(await readFile(require.resolve("stockfish/package.json"), "utf8"));
}

export async function checkStockfishConfig({ root, config }) {
  validateStockfishConfig(config);
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (pkg.dependencies?.stockfish !== config.version) {
    throw new Error("Stockfish dependency does not match config; run pnpm stockfish:prepare");
  }
  if (!pkg.stockfish || Object.keys(pkg.stockfish).sort().join(",") !== "flavor" || pkg.stockfish.flavor !== config.flavor) {
    throw new Error("Stockfish default flavor does not match config; run pnpm stockfish:prepare");
  }
  const installed = await installedStockfish(root);
  if (installed.version !== config.version) {
    throw new Error(`Stockfish installed version ${installed.version} does not match ${config.version}`);
  }
  return installed;
}
